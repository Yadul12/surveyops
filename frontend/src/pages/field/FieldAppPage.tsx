import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardList,
  Clock,
  CloudOff,
  CloudUpload,
  FileEdit,
  LogOut,
  MapPin,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { DynamicQuestionnaireForm } from '@/components/survey/DynamicQuestionnaireForm';
import { ConfirmModal, StatusBadge, useToast } from '@/components/ui/Primitives';
import { evaluateConditionalLogic } from '@/lib/conditionalLogic';
import { formatDateTime, formatDuration, formatShortDate } from '@/lib/format';
import {
  cacheAssignmentsOffline,
  deleteFieldDraft,
  deleteQueuedSubmission,
  getCachedAssignmentsOffline,
  getFieldDraft,
  listFieldDrafts,
  listQueuedSubmissions,
  putQueuedSubmission,
  saveFieldDraft,
  type OfflineDraftRecord,
  type OfflineQueuedSubmission,
} from '@/lib/offlineDb';
import type { SurveyAssignmentItem } from '@/types';

const DISTRICT_COORDS: Record<string, { lat: number; lng: number }> = {
  'Metro Central': { lat: 40.758, lng: -73.9855 },
  'North Metro': { lat: 40.824, lng: -73.942 },
  'East River': { lat: 40.741, lng: -73.928 },
  'South Harbor': { lat: 40.682, lng: -73.991 },
  'West Highlands': { lat: 40.779, lng: -74.021 },
};

function generateClientId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 12)
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `fld-${rand}`;
}

export function FieldAppPage() {
  const { user, logout, hasRole } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [simulatedOffline, setSimulatedOffline] = useState(false);
  const isOnline = browserOnline && !simulatedOffline;

  const [tab, setTab] = useState<'surveys' | 'drafts' | 'queue'>('surveys');
  const [assignments, setAssignments] = useState<SurveyAssignmentItem[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(true);
  const [usingCachedData, setUsingCachedData] = useState(false);

  const [drafts, setDrafts] = useState<OfflineDraftRecord[]>([]);
  const [queue, setQueue] = useState<OfflineQueuedSubmission[]>([]);
  const [syncingAll, setSyncingAll] = useState(false);

  // Active interview state
  const [activeAssignment, setActiveAssignment] = useState<SurveyAssignmentItem | null>(null);
  const [step, setStep] = useState<'briefing' | 'questionnaire'>('briefing');
  const [consentGiven, setConsentGiven] = useState(false);
  const [locationConsent, setLocationConsent] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [capturingGps, setCapturingGps] = useState(false);
  const [respondentRef, setRespondentRef] = useState('');
  const [respondentWard, setRespondentWard] = useState('Ward 1');
  const [respondentAge, setRespondentAge] = useState('30-44');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [startedAtIso, setStartedAtIso] = useState<string>(new Date().toISOString());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [zoneFilter, setZoneFilter] = useState('all');
  const [confirmLocalDelete, setConfirmLocalDelete] = useState<{ kind: 'draft' | 'queue'; id: string; label: string } | null>(null);

  const refreshLocalStores = useCallback(async () => {
    const [d, q] = await Promise.all([listFieldDrafts(), listQueuedSubmissions()]);
    setDrafts(d);
    setQueue(q);
  }, []);

  const loadAssignments = useCallback(async () => {
    setLoadingAssignments(true);
    if (isOnline) {
      try {
        const res = await apiRequest<{ items: SurveyAssignmentItem[] }>('/assignments/my-field-assignments');
        setAssignments(res.items);
        setUsingCachedData(false);
        await cacheAssignmentsOffline(res.items);
        setLoadingAssignments(false);
        return;
      } catch {
        // Fallback to IndexedDB cache
      }
    }
    const cached = await getCachedAssignmentsOffline();
    setAssignments(cached);
    setUsingCachedData(true);
    setLoadingAssignments(false);
  }, [isOnline]);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    loadAssignments();
    refreshLocalStores();
  }, [loadAssignments, refreshLocalStores]);

  // Synchronise single queued submission idempotently
  const syncSingleItem = useCallback(
    async (item: OfflineQueuedSubmission): Promise<boolean> => {
      if (!isOnline) return false;
      const syncingRecord: OfflineQueuedSubmission = {
        ...item,
        sync_status: 'syncing',
        attempt_count: item.attempt_count + 1,
        last_error: null,
      };
      await putQueuedSubmission(syncingRecord);
      await refreshLocalStores();

      try {
        const res = await apiRequest<{
          id: string;
          processing_status: string;
          idempotent_replay?: boolean;
        }>('/responses', {
          method: 'POST',
          body: {
            client_submission_id: item.client_submission_id,
            survey_id: item.survey_id,
            survey_version_id: item.survey_version_id,
            assignment_id: item.assignment_id,
            answers: item.answers,
            consent_given: item.consent_given,
            location_consent_given: item.location_consent_given,
            latitude: item.location_consent_given ? item.latitude : null,
            longitude: item.location_consent_given ? item.longitude : null,
            location_accuracy_m: item.location_consent_given ? item.location_accuracy_m : null,
            district: item.district,
            started_at: item.started_at,
            submitted_at: item.submitted_at,
            duration_seconds: item.duration_seconds,
            source_channel: item.source_channel,
            device_info: {
              platform: 'SurveyOps Mobile Field PWA',
              indexeddb_queue: true,
              offline_collected: item.source_channel === 'mobile_offline',
            },
            respondent: item.respondent,
          },
        });

        await putQueuedSubmission({
          ...syncingRecord,
          sync_status: 'synced',
          server_response_id: res.id,
          server_processing_status: res.processing_status,
          synced_at: new Date().toISOString(),
          last_error: null,
        });
        await refreshLocalStores();
        return true;
      } catch (err: unknown) {
        await putQueuedSubmission({
          ...syncingRecord,
          sync_status: 'failed',
          last_error: err instanceof Error ? err.message : 'Network error during synchronisation',
        });
        await refreshLocalStores();
        return false;
      }
    },
    [isOnline, refreshLocalStores]
  );

  const syncAllPending = useCallback(async () => {
    if (!isOnline) {
      pushToast({ tone: 'warning', title: 'Device offline', detail: 'Disable offline mode or reconnect to sync queued responses.' });
      return;
    }
    const pending = queue.filter((q) => q.sync_status === 'local_saved' || q.sync_status === 'failed');
    if (pending.length === 0) return;

    setSyncingAll(true);
    let okCount = 0;
    let failCount = 0;
    for (const item of pending) {
      const ok = await syncSingleItem(item);
      if (ok) okCount++;
      else failCount++;
    }
    setSyncingAll(false);
    await loadAssignments();
    pushToast({
      tone: failCount === 0 ? 'success' : 'warning',
      title: `Synchronised ${okCount} of ${pending.length} responses`,
      detail: failCount > 0 ? `${failCount} item(s) failed and remain queued for retry.` : 'All queued records entered the processing pipeline.',
    });
  }, [isOnline, queue, syncSingleItem, loadAssignments, pushToast]);

  const startInterview = async (assignment: SurveyAssignmentItem) => {
    const existingDraft = await getFieldDraft(assignment.id);
    setActiveAssignment(assignment);
    setFormErrors({});
    if (existingDraft) {
      setConsentGiven(existingDraft.consent_given);
      setLocationConsent(existingDraft.location_consent_given);
      setCoords(
        existingDraft.latitude !== null && existingDraft.longitude !== null
          ? {
              lat: existingDraft.latitude,
              lng: existingDraft.longitude,
              accuracy: existingDraft.location_accuracy_m || 15,
            }
          : null
      );
      setRespondentRef(existingDraft.respondent_ref);
      setRespondentWard(existingDraft.respondent_ward);
      setRespondentAge(existingDraft.respondent_age_bracket);
      setAnswers(existingDraft.answers || {});
      setStartedAtIso(existingDraft.started_at);
      setStep(existingDraft.consent_given ? 'questionnaire' : 'briefing');
      pushToast({ tone: 'info', title: 'Resumed saved local draft', detail: `Last saved ${formatDateTime(existingDraft.updated_at)}` });
    } else {
      setConsentGiven(false);
      setLocationConsent(false);
      setCoords(null);
      setRespondentRef(`HH-${assignment.region.slice(0, 3).toUpperCase()}-${Math.floor(1000 + Math.random() * 8999)}`);
      setRespondentWard('Ward 1');
      setRespondentAge('30-44');
      setAnswers({});
      setStartedAtIso(new Date().toISOString());
      setStep('briefing');
    }
  };

  const handleCaptureLocation = () => {
    if (!locationConsent || !activeAssignment?.survey_schema?.allow_location_capture) return;
    setCapturingGps(true);
    const fallback = DISTRICT_COORDS[activeAssignment.region] || { lat: 40.758, lng: -73.9855 };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setCoords({
            lat: Number(pos.coords.latitude.toFixed(6)),
            lng: Number(pos.coords.longitude.toFixed(6)),
            accuracy: Math.round(pos.coords.accuracy),
          });
          setCapturingGps(false);
        },
        () => {
          setCoords({
            lat: Number((fallback.lat + (Math.random() - 0.5) * 0.01).toFixed(6)),
            lng: Number((fallback.lng + (Math.random() - 0.5) * 0.01).toFixed(6)),
            accuracy: 16,
          });
          setCapturingGps(false);
          pushToast({ tone: 'info', title: 'District GPS benchmark captured', detail: 'Browser geolocation unavailable; recorded zone coordinates.' });
        },
        { timeout: 4000 }
      );
    } else {
      setCoords({ lat: fallback.lat, lng: fallback.lng, accuracy: 20 });
      setCapturingGps(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!activeAssignment) return;
    await saveFieldDraft({
      assignment_id: activeAssignment.id,
      survey_id: activeAssignment.survey_id,
      survey_title: activeAssignment.survey_title || activeAssignment.survey_schema?.title || 'Survey',
      district: activeAssignment.region,
      consent_given: consentGiven,
      location_consent_given: locationConsent,
      latitude: locationConsent && coords ? coords.lat : null,
      longitude: locationConsent && coords ? coords.lng : null,
      location_accuracy_m: locationConsent && coords ? coords.accuracy : null,
      respondent_ref: respondentRef,
      respondent_ward: respondentWard,
      respondent_age_bracket: respondentAge,
      answers,
      started_at: startedAtIso,
      updated_at: new Date().toISOString(),
    });
    await refreshLocalStores();
    pushToast({ tone: 'success', title: 'Progress saved to IndexedDB', detail: 'You can safely resume this interview offline.' });
  };

  const validateBeforeSubmit = (): boolean => {
    const schema = activeAssignment?.survey_schema;
    if (!schema) return false;
    const errs: Record<string, string> = {};
    schema.questions.forEach((q) => {
      const visible = evaluateConditionalLogic(q.conditional_logic, answers);
      if (!visible) return;
      const val = answers[q.question_key];
      const empty =
        val === undefined ||
        val === null ||
        val === '' ||
        (Array.isArray(val) && val.length === 0);
      if (q.is_required && empty) {
        errs[q.question_key] = 'This question is required.';
      }
    });
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmitResponse = async () => {
    if (submittingRef.current || !activeAssignment?.survey_schema) return;
    if (activeAssignment.survey_schema.requires_consent && !consentGiven) {
      pushToast({ tone: 'error', title: 'Respondent consent required', detail: 'Record explicit consent before submitting.' });
      setStep('briefing');
      return;
    }
    if (!validateBeforeSubmit()) {
      pushToast({ tone: 'warning', title: 'Missing required fields', detail: 'Review highlighted questions before submitting.' });
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const nowIso = new Date().toISOString();
      const durationSec = Math.max(5, Math.round((new Date(nowIso).getTime() - new Date(startedAtIso).getTime()) / 1000));
      const clientSubId = generateClientId();

      const record: OfflineQueuedSubmission = {
        client_submission_id: clientSubId,
        assignment_id: activeAssignment.id,
        survey_id: activeAssignment.survey_id,
        survey_version_id: activeAssignment.survey_schema.version_id,
        survey_code: activeAssignment.survey_schema.code,
        survey_title: activeAssignment.survey_schema.title,
        district: activeAssignment.region,
        consent_given: consentGiven,
        location_consent_given: locationConsent && activeAssignment.survey_schema.allow_location_capture,
        latitude: locationConsent && coords ? coords.lat : null,
        longitude: locationConsent && coords ? coords.lng : null,
        location_accuracy_m: locationConsent && coords ? coords.accuracy : null,
        respondent: {
          external_ref: respondentRef || 'ANON',
          district: activeAssignment.region,
          ward: respondentWard,
          age_bracket: respondentAge || null,
        },
        answers,
        started_at: startedAtIso,
        submitted_at: nowIso,
        duration_seconds: durationSec,
        source_channel: isOnline ? 'mobile_online' : 'mobile_offline',
        sync_status: 'local_saved',
        attempt_count: 0,
        last_error: null,
        server_response_id: null,
        server_processing_status: null,
        synced_at: null,
      };

      // Always write to IndexedDB first for crash/disconnect safety
      await putQueuedSubmission(record);
      await deleteFieldDraft(activeAssignment.id);
      await refreshLocalStores();

      if (isOnline) {
        const synced = await syncSingleItem(record);
        if (synced) {
          pushToast({
            tone: 'success',
            title: 'Response synchronised',
            detail: `Submission ${clientSubId} entered the processing pipeline.`,
          });
          await loadAssignments();
        } else {
          pushToast({
            tone: 'warning',
            title: 'Saved locally — sync failed',
            detail: 'Stored safely in IndexedDB queue for retry.',
          });
        }
      } else {
        pushToast({
          tone: 'info',
          title: 'Saved locally (Offline)',
          detail: `${clientSubId} stored in IndexedDB queue until connectivity returns.`,
        });
      }

      setActiveAssignment(null);
      setTab('queue');
    } catch (err: unknown) {
      pushToast({
        tone: 'error',
        title: 'Local storage error',
        detail: err instanceof Error ? err.message : 'Unable to save submission locally.',
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const pendingCount = queue.filter((q) => q.sync_status === 'local_saved' || q.sync_status === 'failed').length;

  return (
    <div className="min-h-screen bg-canvas text-navy pb-20">
      {/* Compact Mobile-First Header */}
      <header className="sticky top-0 z-30 border-b border-hairline bg-navy text-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-3.5 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {activeAssignment ? (
              <button
                type="button"
                onClick={() => setActiveAssignment(null)}
                aria-label="Back to assigned surveys"
                className="shrink-0 rounded-sm p-1 text-slate-300 hover:bg-white/10 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-teal-accent text-white">
                <Activity className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-semibold leading-none">
                {activeAssignment ? activeAssignment.survey_code : 'SurveyOps Field'}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-slate-300">
                {user?.full_name} · {user?.region}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* Offline Simulator Toggle */}
            <button
              type="button"
              onClick={() => setSimulatedOffline((v) => !v)}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-[11px] font-medium whitespace-nowrap transition-colors ${
                isOnline
                  ? 'border-teal-border/40 bg-teal-accent/25 text-teal-border'
                  : 'border-amber-border bg-amber-warn/30 text-amber-tint'
              }`}
              title="Toggle simulated offline mode to test IndexedDB storage & sync queue"
            >
              {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {isOnline ? 'Online' : 'Offline'}
            </button>

            {hasRole('admin', 'analyst') && (
              <Link
                to="/"
                className="shrink-0 rounded-sm border border-white/20 px-2 py-1 text-[11px] text-slate-200 whitespace-nowrap hover:bg-white/10"
              >
                Ops
              </Link>
            )}

            <button
              type="button"
              onClick={() => {
                logout();
                navigate('/login');
              }}
              aria-label="Sign out"
              className="shrink-0 rounded-sm p-1 text-slate-300 hover:bg-white/10 hover:text-white"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Offline Banner */}
        {!isOnline && (
          <div className="border-t border-amber-border/40 bg-amber-warn px-4 py-1.5 text-center text-[11.5px] font-medium text-white">
            Offline collection active — responses save to local IndexedDB and synchronise once online.
          </div>
        )}
      </header>

      {/* Main Mobile Container */}
      <main className="mx-auto max-w-2xl px-4 py-4">
        {/* ACTIVE INTERVIEW MODE */}
        {activeAssignment && activeAssignment.survey_schema ? (
          <div className="space-y-4">
            {/* Progress Stepper */}
            <div className="ops-surface flex items-center justify-between px-4 py-2.5 text-[12px]">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep('briefing')}
                  className={`font-semibold ${step === 'briefing' ? 'text-teal-accent' : 'text-navy-500'}`}
                >
                  1. Consent & Context
                </button>
                <span className="text-navy-400">→</span>
                <button
                  onClick={() => {
                    if (activeAssignment.survey_schema?.requires_consent && !consentGiven) {
                      pushToast({ tone: 'warning', title: 'Consent required first' });
                      return;
                    }
                    setStep('questionnaire');
                  }}
                  className={`font-semibold ${step === 'questionnaire' ? 'text-teal-accent' : 'text-navy-500'}`}
                >
                  2. Questionnaire ({activeAssignment.survey_schema.questions.length} Qs)
                </button>
              </div>
              <button onClick={handleSaveDraft} className="ops-btn-secondary px-2 py-1 text-[11.5px]">
                <Save className="h-3 w-3" /> Save Draft
              </button>
            </div>

            {step === 'briefing' && (
              <div className="space-y-3.5">
                <div className="ops-surface p-4">
                  <div className="font-mono text-[11px] font-semibold text-teal-accent">
                    {activeAssignment.survey_schema.code} · v{activeAssignment.survey_schema.version_number}
                  </div>
                  <h1 className="mt-1 text-[16px] font-semibold text-navy">
                    {activeAssignment.survey_schema.title}
                  </h1>
                  <p className="mt-1.5 text-[12.5px] text-navy-600 leading-relaxed">
                    {activeAssignment.survey_schema.instructions || activeAssignment.notes}
                  </p>
                </div>

                {/* Respondent Context */}
                <div className="ops-surface p-4 space-y-3">
                  <div className="text-[12px] font-semibold uppercase tracking-wider text-navy-500">
                    Anonymized Respondent Metadata
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Reference Code</label>
                      <input
                        value={respondentRef}
                        onChange={(e) => setRespondentRef(e.target.value)}
                        className="ops-input font-mono"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Ward / Sector</label>
                      <input
                        value={respondentWard}
                        onChange={(e) => setRespondentWard(e.target.value)}
                        className="ops-input"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Age Bracket</label>
                      <select
                        value={respondentAge}
                        onChange={(e) => setRespondentAge(e.target.value)}
                        className="ops-input"
                      >
                        <option value="18-29">18–29</option>
                        <option value="30-44">30–44</option>
                        <option value="45-59">45–59</option>
                        <option value="60-74">60–74</option>
                        <option value="75+">75+</option>
                      </select>
                    </div>
                  </div>
                </div>

                {/* Explicit Respondent Consent */}
                <div className="ops-surface border-l-[3px] border-l-teal-accent p-4 space-y-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-navy">
                    <ShieldCheck className="h-4 w-4 text-teal-accent" />
                    Respondent Informed Consent
                  </div>
                  <p className="rounded-sm bg-canvas p-3 text-[12.5px] text-navy-700 leading-relaxed">
                    {activeAssignment.survey_schema.consent_text}
                  </p>
                  <label className="flex cursor-pointer items-start gap-2.5 text-[12.5px] font-medium text-navy">
                    <input
                      type="checkbox"
                      checked={consentGiven}
                      onChange={(e) => setConsentGiven(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-teal-accent"
                    />
                    <span>I confirm the respondent read or heard the statement above and gave informed consent.</span>
                  </label>
                </div>

                {/* Optional Consented Location Capture */}
                {activeAssignment.survey_schema.allow_location_capture && (
                  <div className="ops-surface p-4 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-navy">
                        <MapPin className="h-4 w-4 text-navy-500" />
                        Optional Location Capture
                      </div>
                      <span className="text-[11px] text-navy-500">Captured only with opt-in</span>
                    </div>
                    <label className="flex cursor-pointer items-center gap-2.5 text-[12.5px] text-navy-700">
                      <input
                        type="checkbox"
                        checked={locationConsent}
                        onChange={(e) => {
                          setLocationConsent(e.target.checked);
                          if (!e.target.checked) setCoords(null);
                        }}
                        className="h-4 w-4 accent-teal-accent"
                      />
                      <span>Respondent consents to recording approximate neighbourhood GPS coordinates.</span>
                    </label>
                    {locationConsent && (
                      <div className="flex flex-wrap items-center gap-3 pt-1">
                        <button
                          type="button"
                          onClick={handleCaptureLocation}
                          disabled={capturingGps}
                          className="ops-btn-secondary text-[12px]"
                        >
                          <MapPin className="h-3.5 w-3.5 text-teal-accent" />
                          {capturingGps ? 'Locating...' : coords ? 'Refresh Coordinates' : 'Capture GPS Coordinates'}
                        </button>
                        {coords && (
                          <span className="font-mono text-[11.5px] text-teal-accent">
                            {coords.lat}, {coords.lng} (±{coords.accuracy}m)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={handleSaveDraft} className="ops-btn-secondary">
                    Save Progress
                  </button>
                  <button
                    onClick={() => {
                      if (activeAssignment.survey_schema?.requires_consent && !consentGiven) {
                        pushToast({ tone: 'error', title: 'Consent required', detail: 'Confirm respondent consent to proceed.' });
                        return;
                      }
                      setStep('questionnaire');
                    }}
                    className="ops-btn-primary"
                  >
                    Begin Questionnaire →
                  </button>
                </div>
              </div>
            )}

            {step === 'questionnaire' && (
              <div className="space-y-4">
                <DynamicQuestionnaireForm
                  questions={activeAssignment.survey_schema.questions}
                  answers={answers}
                  errors={formErrors}
                  onChange={(k, v) => {
                    setAnswers((prev) => ({ ...prev, [k]: v }));
                    setFormErrors((prev) => {
                      if (!prev[k]) return prev;
                      const next = { ...prev };
                      delete next[k];
                      return next;
                    });
                  }}
                />

                <div className="ops-surface flex flex-wrap items-center justify-between gap-2 p-3.5">
                  <button onClick={() => setStep('briefing')} className="ops-btn-secondary">
                    ← Consent
                  </button>
                  <div className="flex items-center gap-2">
                    <button onClick={handleSaveDraft} className="ops-btn-secondary">
                      <Save className="h-3.5 w-3.5" /> Save Progress
                    </button>
                    <button
                      onClick={handleSubmitResponse}
                      disabled={submitting}
                      className="ops-btn-primary"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {submitting
                        ? 'Saving...'
                        : isOnline
                        ? 'Submit & Sync Response'
                        : 'Save to Offline Queue'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* HOME TABS: SURVEYS / DRAFTS / SYNC QUEUE */
          <>
            {tab === 'surveys' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-[16px] font-semibold text-navy">Assigned Field Surveys</h1>
                    <p className="text-[12px] text-navy-500">
                      {usingCachedData
                        ? 'Loaded from local IndexedDB offline cache'
                        : 'Synchronised with central registry · schemas cached offline'}
                    </p>
                  </div>
                  <button onClick={loadAssignments} className="ops-btn-secondary px-2.5 py-1 text-[12px]">
                    <RefreshCw className="h-3.5 w-3.5" /> Refresh
                  </button>
                </div>

                {hasRole('admin', 'analyst') && assignments.length > 3 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {['all', ...Array.from(new Set(assignments.map((a) => a.region))).sort()].map((zone) => (
                      <button
                        key={zone}
                        type="button"
                        onClick={() => setZoneFilter(zone)}
                        className={`rounded-sm border px-2 py-1 text-[11px] font-medium ${
                          zoneFilter === zone
                            ? 'border-teal-accent bg-teal-tint text-teal-accent'
                            : 'border-hairline bg-surface text-navy-600'
                        }`}
                      >
                        {zone === 'all' ? `All Zones (${assignments.length})` : zone}
                      </button>
                    ))}
                  </div>
                )}

                {loadingAssignments ? (
                  <div className="ops-surface p-8 text-center text-[13px] text-navy-500">
                    Loading field assignments...
                  </div>
                ) : assignments.length === 0 ? (
                  <div className="ops-surface p-8 text-center text-[13px] text-navy-500">
                    No active survey assignments available for this account.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {assignments
                      .filter((a) => zoneFilter === 'all' || a.region === zoneFilter)
                      .map((a) => {
                      const pct = Math.min(100, Math.round((a.collected_count / Math.max(1, a.target_count)) * 100));
                      const hasDraft = drafts.some((d) => d.assignment_id === a.id);
                      return (
                        <div key={a.id} className="ops-surface p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[11.5px] font-semibold text-teal-accent">
                                  {a.survey_code}
                                </span>
                                <span className="text-[11px] text-navy-500">v{a.version_number}</span>
                                <StatusBadge status={a.status} />
                                {hasDraft && <StatusBadge status="local_saved" label="Draft Saved" />}
                              </div>
                              <h2 className="mt-1 text-[14.5px] font-semibold text-navy">{a.survey_title}</h2>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-navy-500">
                                <span>Zone: <strong className="text-navy-700">{a.region}</strong></span>
                                <span>Agent: {a.agent_name}</span>
                                {a.due_date && <span>Due: {formatShortDate(a.due_date)}</span>}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3">
                            <div className="flex items-center justify-between text-[11.5px] tabular-nums">
                              <span className="text-navy-500">Collection Target</span>
                              <span className="font-semibold text-navy">
                                {a.collected_count} / {a.target_count} ({pct}%)
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-recessed">
                              <div className="h-full bg-teal-accent" style={{ width: `${pct}%` }} />
                            </div>
                          </div>

                          <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2.5">
                            <span className="text-[11.5px] text-navy-500">
                              {a.survey_schema?.questions?.length || 0} questions · Offline ready
                            </span>
                            <button
                              onClick={() => startInterview(a)}
                              className="ops-btn-primary px-3 py-1.5 text-[12px]"
                            >
                              {hasDraft ? 'Resume Draft' : 'Start New Response'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {tab === 'drafts' && (
              <div className="space-y-3">
                <div>
                  <h1 className="text-[16px] font-semibold text-navy">Saved In-Progress Drafts (IndexedDB)</h1>
                  <p className="text-[12px] text-navy-500">Incomplete interviews stored locally on this device</p>
                </div>

                {drafts.length === 0 ? (
                  <div className="ops-surface p-8 text-center text-[13px] text-navy-500">
                    No saved drafts. Use &ldquo;Save Progress&rdquo; inside any interview to pause and resume later.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {drafts.map((d) => (
                      <div key={d.assignment_id} className="ops-surface flex items-center justify-between p-4">
                        <div>
                          <div className="text-[13.5px] font-semibold text-navy">{d.survey_title}</div>
                          <div className="mt-0.5 text-[11.5px] text-navy-500">
                            {d.district} · Ref {d.respondent_ref} · {Object.keys(d.answers || {}).length} answers recorded
                          </div>
                          <div className="mt-0.5 text-[11px] text-navy-400">
                            Saved {formatDateTime(d.updated_at)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => {
                              const found = assignments.find((a) => a.id === d.assignment_id);
                              if (found) startInterview(found);
                            }}
                            className="ops-btn-primary text-[12px]"
                          >
                            Resume
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmLocalDelete({ kind: 'draft', id: d.assignment_id, label: d.survey_title })
                            }
                            aria-label="Discard saved draft"
                            className="ops-btn-secondary p-1.5 text-navy-500 hover:text-crimson-err"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'queue' && (
              <div className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h1 className="text-[16px] font-semibold text-navy">Synchronisation Queue (IndexedDB)</h1>
                    <p className="text-[12px] text-navy-500">
                      Tracks local offline records, active sync attempts, failures, and verified server ingestion
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={syncAllPending}
                    disabled={syncingAll || pendingCount === 0}
                    className="ops-btn-primary shrink-0 self-start whitespace-nowrap text-[12px] sm:self-auto"
                  >
                    <CloudUpload className="h-3.5 w-3.5" />
                    {syncingAll ? 'Syncing...' : `Sync Pending (${pendingCount})`}
                  </button>
                </div>

                {/* Sync Summary Strip */}
                <div className="grid grid-cols-3 gap-2.5">
                  <div className="ops-surface p-3">
                    <div className="text-[10.5px] font-semibold uppercase text-navy-500">Saved Locally</div>
                    <div className="mt-0.5 text-[18px] font-semibold text-amber-warn tabular-nums">
                      {queue.filter((q) => q.sync_status === 'local_saved').length}
                    </div>
                  </div>
                  <div className="ops-surface p-3">
                    <div className="text-[10.5px] font-semibold uppercase text-navy-500">Synchronised</div>
                    <div className="mt-0.5 text-[18px] font-semibold text-teal-accent tabular-nums">
                      {queue.filter((q) => q.sync_status === 'synced').length}
                    </div>
                  </div>
                  <div className="ops-surface p-3">
                    <div className="text-[10.5px] font-semibold uppercase text-navy-500">Failed</div>
                    <div className="mt-0.5 text-[18px] font-semibold text-crimson-err tabular-nums">
                      {queue.filter((q) => q.sync_status === 'failed').length}
                    </div>
                  </div>
                </div>

                {queue.length === 0 ? (
                  <div className="ops-surface p-8 text-center text-[13px] text-navy-500">
                    No submissions in local device queue yet. Complete an assigned survey online or offline to verify synchronisation status.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {queue.map((item) => (
                      <div key={item.client_submission_id} className="ops-surface p-3.5">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-[11.5px] font-semibold text-navy">
                                {item.client_submission_id}
                              </span>
                              <StatusBadge
                                status={item.sync_status}
                                label={
                                  item.sync_status === 'local_saved'
                                    ? 'Saved Locally'
                                    : item.sync_status === 'synced'
                                    ? 'Synchronised'
                                    : item.sync_status === 'syncing'
                                    ? 'Syncing...'
                                    : 'Sync Failed'
                                }
                              />
                              {item.server_processing_status && (
                                <StatusBadge status={item.server_processing_status} />
                              )}
                            </div>
                            <div className="mt-1 text-[13px] font-medium text-navy">
                              {item.survey_code} · {item.survey_title}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11.5px] text-navy-500 tabular-nums">
                              <span>{item.district}</span>
                              <span>Duration: {formatDuration(item.duration_seconds)}</span>
                              <span>Captured: {formatDateTime(item.submitted_at)}</span>
                              {item.synced_at && <span>Synced: {formatDateTime(item.synced_at)}</span>}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {(item.sync_status === 'local_saved' || item.sync_status === 'failed') && (
                              <button
                                onClick={() => syncSingleItem(item)}
                                disabled={!isOnline}
                                className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                              >
                                <RefreshCw className="h-3 w-3" /> Sync
                              </button>
                            )}
                            {item.sync_status === 'synced' && item.server_response_id && hasRole('admin', 'analyst') && (
                              <Link
                                to={`/responses/${item.server_response_id}`}
                                className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                              >
                                Inspect
                              </Link>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmLocalDelete({
                                  kind: 'queue',
                                  id: item.client_submission_id,
                                  label: item.client_submission_id,
                                })
                              }
                              aria-label={`Remove ${item.client_submission_id} from local device history`}
                              className="p-1 text-navy-400 hover:text-crimson-err"
                              title="Remove from local device history"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        {item.last_error && (
                          <div className="mt-2 flex items-center gap-1.5 rounded-sm bg-crimson-tint/60 px-2.5 py-1.5 text-[11.5px] text-crimson-err">
                            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                            <span>{item.last_error}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Navigation Bar */}
      {!activeAssignment && (
        <nav className="fixed bottom-0 inset-x-0 z-30 border-t border-hairline bg-surface">
          <div className="mx-auto grid max-w-2xl grid-cols-3">
            {[
              { id: 'surveys' as const, label: 'Assigned', icon: ClipboardList, count: assignments.length },
              { id: 'drafts' as const, label: 'Drafts', icon: FileEdit, count: drafts.length },
              { id: 'queue' as const, label: 'Sync Queue', icon: pendingCount > 0 ? CloudOff : CheckCircle2, count: pendingCount || queue.length },
            ].map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`flex flex-col items-center justify-center py-2.5 text-[11.5px] font-medium transition-colors ${
                    active ? 'text-teal-accent border-t-2 border-teal-accent -mt-[1px]' : 'text-navy-500'
                  }`}
                >
                  <div className="relative">
                    <Icon className="h-4 w-4" />
                    {item.id === 'queue' && pendingCount > 0 && (
                      <span className="absolute -right-2.5 -top-1.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-warn px-1 text-[9.5px] font-semibold text-white">
                        {pendingCount}
                      </span>
                    )}
                  </div>
                  <span className="mt-0.5">{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
      <ConfirmModal
        open={Boolean(confirmLocalDelete)}
        title={confirmLocalDelete?.kind === 'draft' ? 'Discard Local Draft?' : 'Remove Local Queue Record?'}
        message={
          confirmLocalDelete?.kind === 'draft'
            ? `Discard saved in-progress answers for "${confirmLocalDelete.label}"? This removes the local IndexedDB draft.`
            : `Remove "${confirmLocalDelete?.label}" from local device IndexedDB history? Records already synchronised remain in the central database.`
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!confirmLocalDelete) return;
          if (confirmLocalDelete.kind === 'draft') {
            await deleteFieldDraft(confirmLocalDelete.id);
          } else {
            await deleteQueuedSubmission(confirmLocalDelete.id);
          }
          setConfirmLocalDelete(null);
          await refreshLocalStores();
          pushToast({ tone: 'info', title: 'Local IndexedDB record removed' });
        }}
        onCancel={() => setConfirmLocalDelete(null)}
      />
    </div>
  );
}
