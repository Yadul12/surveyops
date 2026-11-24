import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Edit3,
  History,
  Lock,
  MapPin,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatDuration, humanizeKey } from '@/lib/format';
import type { ResponseAnswerDetail, ResponseDetail } from '@/types';

function formatValue(val: unknown): string {
  if (val === null || val === undefined || val === '') return '—';
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export function ResponseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [reviewNotes, setReviewNotes] = useState('');
  const [editingAnswer, setEditingAnswer] = useState<ResponseAnswerDetail | null>(null);
  const [correctionValue, setCorrectionValue] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [activeTab, setActiveTab] = useState<'answers' | 'payloads' | 'audit'>('answers');

  const responseQ = useQuery({
    queryKey: ['responses', id],
    queryFn: () => apiRequest<ResponseDetail>(`/responses/${id}`),
    enabled: Boolean(id),
  });

  const decisionMutation = useMutation({
    mutationFn: (decision: 'approve' | 'reject' | 'flag') =>
      apiRequest(`/quality/responses/${id}/decision`, {
        method: 'POST',
        body: { decision, review_notes: reviewNotes, resolve_open_issues: true },
      }),
    onSuccess: (_, decision) => {
      queryClient.invalidateQueries({ queryKey: ['responses', id] });
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setReviewNotes('');
      pushToast({ tone: 'success', title: `Record ${decision}d`, detail: 'Audit event recorded and dataset updated.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Action failed', detail: err.message }),
  });

  const correctMutation = useMutation({
    mutationFn: () => {
      let parsed: unknown = correctionValue;
      if (editingAnswer?.question_type === 'number' || editingAnswer?.question_type === 'rating') {
        parsed = Number(correctionValue);
      } else if (editingAnswer?.question_type === 'boolean') {
        parsed = correctionValue === 'true';
      } else if (editingAnswer?.question_type === 'multi_choice') {
        parsed = correctionValue.split(',').map((s) => s.trim()).filter(Boolean);
      }
      return apiRequest(`/quality/responses/${id}/answers/${editingAnswer!.question_key}`, {
        method: 'PATCH',
        body: {
          corrected_value: parsed,
          correction_reason: correctionReason,
          reprocess: true,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['responses', id] });
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      setEditingAnswer(null);
      setCorrectionReason('');
      pushToast({
        tone: 'success',
        title: 'Analyst correction recorded',
        detail: 'Raw source payload preserved intact; pipeline re-scored the effective value.',
      });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Correction failed', detail: err.message }),
  });

  const reprocessMutation = useMutation({
    mutationFn: () => apiRequest(`/pipeline/responses/${id}/reprocess`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['responses', id] });
      pushToast({ tone: 'info', title: 'Response reprocessed', detail: 'All 9 pipeline stages re-evaluated.' });
    },
  });

  const issueActionMutation = useMutation({
    mutationFn: ({ issueId, status }: { issueId: string; status: 'resolved' | 'dismissed' }) =>
      apiRequest(`/quality/issues/${issueId}`, {
        method: 'PATCH',
        body: { status, resolution_note: `Marked ${status} from Record Inspector` },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['responses', id] });
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      pushToast({ tone: 'info', title: 'Quality issue updated' });
    },
  });

  if (responseQ.isLoading) return <LoadingState message="Loading response record and audit trail..." />;
  if (responseQ.isError || !responseQ.data) {
    return <ErrorState message={(responseQ.error as Error)?.message || 'Not found'} onRetry={() => responseQ.refetch()} />;
  }

  const r = responseQ.data;
  const canReview = hasRole('admin', 'analyst');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-[12px] text-navy-500">
        <Link to="/quality" className="inline-flex items-center gap-1 hover:text-navy">
          <ArrowLeft className="h-3.5 w-3.5" /> Quality Console
        </Link>
        <span>/</span>
        <Link to="/responses" className="hover:text-navy">
          Response Registry
        </Link>
      </div>

      <PageHeader
        title={`Record ${r.client_submission_id}`}
        subtitle={`${r.survey_code} — ${r.survey_title} (v${r.version_number}) · ${r.district}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.processing_status} />
            {canReview && (
              <>
                <button
                  onClick={() => reprocessMutation.mutate()}
                  disabled={reprocessMutation.isPending}
                  className="ops-btn-secondary"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Reprocess
                </button>
                <button
                  type="button"
                  onClick={() => decisionMutation.mutate('approve')}
                  disabled={decisionMutation.isPending || r.processing_status === 'approved'}
                  className="ops-btn-primary"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {r.processing_status === 'approved' ? 'Approved' : 'Approve Dataset'}
                </button>
                <button
                  type="button"
                  onClick={() => decisionMutation.mutate('reject')}
                  disabled={decisionMutation.isPending || r.processing_status === 'rejected'}
                  className="ops-btn-danger"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {r.processing_status === 'rejected' ? 'Rejected' : 'Reject Record'}
                </button>
              </>
            )}
          </div>
        }
      />

      {/* Immutability Policy Notice */}
      <div className="flex items-center justify-between gap-3 rounded-sm border border-teal-border/60 bg-teal-tint/40 px-3.5 py-2 text-[12px] text-navy">
        <div className="flex items-center gap-2">
          <Lock className="h-3.5 w-3.5 shrink-0 text-teal-accent" />
          <span>
            <strong>Source Immutability Enforced:</strong> Raw submission payloads are write-once. All normalisations and analyst corrections are versioned in separate columns with full audit lineage.
          </span>
        </div>
        <span className="hidden font-mono text-[11px] text-navy-500 md:inline">
          SHA256: {r.fingerprint_hash?.slice(0, 14) || '—'}
        </span>
      </div>

      {/* Summary Metadata Grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Quality Score</div>
          <div className="mt-1 font-mono text-[20px] font-semibold text-navy tabular-nums">
            {r.quality_score !== null ? `${r.quality_score.toFixed(1)}/100` : '—'}
          </div>
        </div>
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Pipeline Stage</div>
          <div className="mt-1 text-[12.5px] font-semibold text-navy">{humanizeKey(r.pipeline_stage)}</div>
        </div>
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Duration</div>
          <div className="mt-1 font-mono text-[16px] font-semibold text-navy tabular-nums">
            {formatDuration(r.duration_seconds)}
          </div>
        </div>
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Enumerator</div>
          <div className="mt-1 truncate text-[12.5px] font-semibold text-navy">{r.agent_name}</div>
          <div className="text-[11px] text-navy-500">{humanizeKey(r.source_channel)}</div>
        </div>
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Consent & GPS</div>
          <div className="mt-1 text-[12px] font-medium text-navy">
            Consent: <span className={r.consent_given ? 'text-teal-accent' : 'text-crimson-err'}>{r.consent_given ? 'Yes' : 'No'}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11px] text-navy-500">
            <MapPin className="h-3 w-3" />
            {r.location_consent_given && r.latitude !== null
              ? `${r.latitude.toFixed(4)}, ${r.longitude?.toFixed(4)}`
              : 'No GPS recorded'}
          </div>
        </div>
        <div className="ops-surface p-3">
          <div className="text-[10.5px] font-semibold uppercase text-navy-500">Submitted</div>
          <div className="mt-1 text-[12px] font-medium text-navy tabular-nums">{formatDateTime(r.submitted_at)}</div>
          {r.reviewed_by_name && (
            <div className="mt-0.5 truncate text-[11px] text-teal-accent">Reviewed: {r.reviewed_by_name}</div>
          )}
        </div>
      </div>

      {/* Analyst Review Notes Bar */}
      {canReview && (
        <div className="ops-surface flex flex-wrap items-center gap-2.5 p-3">
          <input
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            placeholder="Optional analyst review rationale (recorded in Audit Trail on Approve / Reject)..."
            className="ops-input flex-1"
          />
          {r.review_notes && (
            <span className="text-[11.5px] text-navy-500">
              Latest note: <strong className="text-navy-700">{r.review_notes}</strong>
            </span>
          )}
        </div>
      )}

      {/* Detected Quality Issues */}
      {r.quality_issues.length > 0 && (
        <div className="ops-surface overflow-hidden">
          <div className="flex items-center gap-2 border-b border-hairline bg-amber-tint/25 px-4 py-2.5">
            <AlertTriangle className="h-4 w-4 text-amber-warn" />
            <span className="text-[13px] font-semibold text-navy">
              Quality Issues ({r.quality_issues.length})
            </span>
          </div>
          <div className="divide-y divide-hairline">
            {r.quality_issues.map((qi) => (
              <div key={qi.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={qi.severity} />
                    <StatusBadge status={qi.status} />
                    <span className="font-mono text-[11.5px] font-semibold text-navy">{qi.rule_code}</span>
                    {qi.question_key && (
                      <span className="font-mono text-[11px] text-teal-accent">field: {qi.question_key}</span>
                    )}
                  </div>
                  <p className="mt-1 text-[12.5px] text-navy-700">{qi.message}</p>
                  {qi.resolution_note && (
                    <p className="mt-0.5 text-[11.5px] text-teal-accent">Resolution: {qi.resolution_note}</p>
                  )}
                </div>
                {canReview && qi.status === 'open' && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => issueActionMutation.mutate({ issueId: qi.id, status: 'resolved' })}
                      className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                    >
                      Mark Resolved
                    </button>
                    <button
                      onClick={() => issueActionMutation.mutate({ issueId: qi.id, status: 'dismissed' })}
                      className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                    >
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detail Tabs */}
      <div className="flex items-center gap-1 border-b border-hairline">
        {[
          { id: 'answers' as const, label: `Field Values & Corrections (${r.answers.length})` },
          { id: 'payloads' as const, label: 'Immutable Raw vs Normalized JSON' },
          { id: 'audit' as const, label: `Audit & Pipeline Lineage (${r.audit_history.length})` },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`border-b-2 px-3.5 py-2 text-[12.5px] font-medium ${
              activeTab === t.id
                ? 'border-teal-accent text-teal-accent'
                : 'border-transparent text-navy-500 hover:text-navy'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab 1: Field-by-field Raw vs Normalized vs Corrected */}
      {activeTab === 'answers' && (
        <div className="ops-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">Question</th>
                  <th className="ops-th">Raw Source (Immutable)</th>
                  <th className="ops-th">Normalized Value</th>
                  <th className="ops-th">Effective / Corrected</th>
                  <th className="ops-th">Flags</th>
                  {canReview && <th className="ops-th text-right">Override</th>}
                </tr>
              </thead>
              <tbody>
                {r.answers.map((ans) => (
                  <tr key={ans.id} className="hover:bg-canvas/50">
                    <td className="ops-td max-w-xs">
                      <div className="font-mono text-[11px] font-semibold text-teal-accent">{ans.question_key}</div>
                      <div className="mt-0.5 text-[12px] text-navy-700">{ans.prompt}</div>
                    </td>
                    <td className="ops-td font-mono text-[12px] text-navy-600 bg-canvas/40">
                      {formatValue(ans.raw_value)}
                    </td>
                    <td className="ops-td font-mono text-[12px] text-navy">
                      {formatValue(ans.normalized_value)}
                    </td>
                    <td className="ops-td">
                      <div className={`font-mono text-[12.5px] font-semibold ${ans.corrected_value !== null ? 'text-teal-accent' : 'text-navy'}`}>
                        {formatValue(ans.effective_value)}
                      </div>
                      {ans.correction_reason && (
                        <div className="mt-0.5 text-[11px] text-navy-500">
                          Override reason: {ans.correction_reason}
                        </div>
                      )}
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <div className="flex flex-wrap gap-1">
                        {ans.corrected_value !== null && <StatusBadge status="resolved" label="Corrected" />}
                        {ans.is_outlier && <StatusBadge status="warning" label="Outlier" />}
                        {ans.is_skipped && ans.is_missing && <StatusBadge status="retired" label="Skipped (Branch)" />}
                        {!ans.is_skipped && ans.is_missing && <StatusBadge status="draft" label="Not Answered" />}
                        {!ans.is_valid && <StatusBadge status="critical" label="Invalid" />}
                        {ans.is_valid && !ans.is_outlier && !ans.is_missing && ans.corrected_value === null && (
                          <StatusBadge status="approved" label="Clean" />
                        )}
                      </div>
                    </td>
                    {canReview && (
                      <td className="ops-td text-right">
                        <button
                          onClick={() => {
                            setEditingAnswer(ans);
                            setCorrectionValue(
                              Array.isArray(ans.effective_value)
                                ? ans.effective_value.join(', ')
                                : ans.effective_value !== null && ans.effective_value !== undefined
                                ? String(ans.effective_value)
                                : ''
                            );
                            setCorrectionReason(ans.correction_reason || '');
                          }}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                        >
                          <Edit3 className="h-3 w-3" /> Correct
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 2: Raw vs Normalized JSON */}
      {activeTab === 'payloads' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="ops-surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-hairline bg-canvas px-4 py-2.5">
              <span className="text-[12.5px] font-semibold text-navy">Immutable Raw Source Payload</span>
              <StatusBadge status="draft" label="Read-Only" />
            </div>
            <pre className="max-h-[460px] overflow-auto p-4 font-mono text-[11.5px] text-navy-700 leading-relaxed">
              {JSON.stringify(r.raw_payload, null, 2)}
            </pre>
          </div>
          <div className="ops-surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-hairline bg-teal-tint/30 px-4 py-2.5">
              <span className="text-[12.5px] font-semibold text-navy">Normalized / Effective Analytical Payload</span>
              <StatusBadge status={r.processing_status} />
            </div>
            <pre className="max-h-[460px] overflow-auto p-4 font-mono text-[11.5px] text-navy-700 leading-relaxed">
              {JSON.stringify(r.normalized_payload, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Tab 3: Complete Audit & Stage Lineage */}
      {activeTab === 'audit' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="ops-surface p-4 lg:col-span-7">
            <div className="mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-teal-accent" />
              <h3 className="text-[13px] font-semibold text-navy">Immutable Audit History</h3>
            </div>
            <div className="divide-y divide-hairline">
              {r.audit_history.map((ae) => (
                <div key={ae.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="font-mono font-semibold text-navy">{ae.action}</span>
                    <span className="text-navy-400 tabular-nums">{formatDateTime(ae.created_at)}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] text-navy-700">{ae.summary}</p>
                  <div className="mt-0.5 text-[11px] text-navy-500">Actor: {ae.actor_name} ({ae.actor_type})</div>
                </div>
              ))}
            </div>
          </div>

          <div className="ops-surface p-4 lg:col-span-5">
            <h3 className="mb-3 text-[13px] font-semibold text-navy">Pipeline Execution Runs</h3>
            {r.processing_jobs.length === 0 ? (
              <div className="text-[12px] text-navy-500">No recorded job runs.</div>
            ) : (
              <div className="space-y-3">
                {r.processing_jobs.map((job) => (
                  <div key={job.id} className="rounded-sm border border-hairline bg-canvas/50 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[11.5px] font-semibold">{job.id.slice(0, 10)}</span>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="mt-1 text-[11px] text-navy-500 tabular-nums">
                      Total: {job.duration_ms ?? 0}ms · Attempt #{job.attempt_count} · {formatDateTime(job.created_at)}
                    </div>
                    <div className="mt-2 space-y-1">
                      {(job.stages_completed || []).map((st, idx) => (
                        <div key={idx} className="flex items-center justify-between text-[11px]">
                          <span className="font-mono text-navy-700">{st.stage}</span>
                          <span className="font-mono text-navy-500 tabular-nums">{st.duration_ms}ms</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Analyst Answer Correction Modal */}
      <Modal
        open={Boolean(editingAnswer)}
        title={`Apply Tracked Correction — ${editingAnswer?.question_key || ''}`}
        subtitle="Raw source value remains immutable. Correction updates effective analytical value and triggers pipeline re-scoring."
        onClose={() => setEditingAnswer(null)}
      >
        {editingAnswer && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              correctMutation.mutate();
            }}
            className="space-y-3.5"
          >
            <div className="rounded-sm border border-hairline bg-canvas p-3 text-[12px]">
              <div className="font-medium text-navy">{editingAnswer.prompt}</div>
              <div className="mt-1.5 flex gap-4 font-mono text-[11.5px] text-navy-600">
                <span>Raw (Immutable): <strong>{formatValue(editingAnswer.raw_value)}</strong></span>
                <span>Normalized: <strong>{formatValue(editingAnswer.normalized_value)}</strong></span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Corrected Value *</label>
              {editingAnswer.question_type === 'single_choice' && editingAnswer.options.length > 0 ? (
                <select
                  value={correctionValue}
                  onChange={(e) => setCorrectionValue(e.target.value)}
                  className="ops-input"
                >
                  {editingAnswer.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} ({o.value})
                    </option>
                  ))}
                </select>
              ) : editingAnswer.question_type === 'boolean' ? (
                <select
                  value={correctionValue}
                  onChange={(e) => setCorrectionValue(e.target.value)}
                  className="ops-input"
                >
                  <option value="true">Yes (true)</option>
                  <option value="false">No (false)</option>
                </select>
              ) : (
                <input
                  required
                  type={editingAnswer.question_type === 'number' || editingAnswer.question_type === 'rating' ? 'number' : 'text'}
                  step="any"
                  value={correctionValue}
                  onChange={(e) => setCorrectionValue(e.target.value)}
                  className="ops-input"
                />
              )}
            </div>

            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">
                Mandatory Audit Justification *
              </label>
              <textarea
                required
                minLength={3}
                rows={3}
                value={correctionReason}
                onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="e.g. Verified decimal entry typo with field enumerator shift log."
                className="ops-input"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-hairline pt-3">
              <button type="button" onClick={() => setEditingAnswer(null)} className="ops-btn-secondary">
                Cancel
              </button>
              <button type="submit" disabled={correctMutation.isPending} className="ops-btn-primary">
                {correctMutation.isPending ? 'Saving...' : 'Apply Correction & Re-score'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
