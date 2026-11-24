import React, { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CopyPlus,
  Eye,
  GitBranch,
  Monitor,
  Plus,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
} from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { DynamicQuestionnaireForm } from '@/components/survey/DynamicQuestionnaireForm';
import {
  ConfirmModal,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatShortDate } from '@/lib/format';
import type {
  ConditionalRule,
  Question,
  QuestionType,
  SurveyDetail,
  User,
  ValidationRule,
} from '@/types';

const QUESTION_TYPES: Array<{ value: QuestionType; label: string }> = [
  { value: 'single_choice', label: 'Single Choice' },
  { value: 'multi_choice', label: 'Multiple Choice' },
  { value: 'number', label: 'Numeric Value' },
  { value: 'rating', label: 'Rating Scale (1–5)' },
  { value: 'boolean', label: 'Yes / No Boolean' },
  { value: 'short_text', label: 'Short Text' },
  { value: 'long_text', label: 'Long Text / Notes' },
  { value: 'date', label: 'Date Picker' },
  { value: 'location', label: 'Location Coordinates' },
];

const DISTRICTS = ['Metro Central', 'North Metro', 'East River', 'South Harbor', 'West Highlands'];

export function SurveyBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const activeTab = (searchParams.get('tab') as 'builder' | 'preview' | 'assignments' | 'settings') || 'builder';
  const setTab = (tab: string) => setSearchParams({ tab }, { replace: true });

  const surveyQ = useQuery({
    queryKey: ['surveys', id],
    queryFn: () => apiRequest<SurveyDetail>(`/surveys/${id}`),
    enabled: Boolean(id),
  });

  const agentsQ = useQuery({
    queryKey: ['users', 'field_agent'],
    queryFn: () => apiRequest<User[]>('/auth/users', { params: { role: 'field_agent' } }),
    enabled: hasRole('admin', 'analyst'),
  });

  const [selectedVersionId, setSelectedVersionId] = useState<string>('');
  const [draftQuestions, setDraftQuestions] = useState<Question[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [changeNotes, setChangeNotes] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [confirmDeleteAsgn, setConfirmDeleteAsgn] = useState<{ id: string; agent_name: string } | null>(null);

  // Preview state
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('mobile');
  const [previewAnswers, setPreviewAnswers] = useState<Record<string, unknown>>({});

  // Settings form state
  const [metaForm, setMetaForm] = useState({
    title: '',
    description: '',
    category: '',
    target_responses: 250,
    requires_consent: true,
    allow_location_capture: true,
    instructions: '',
    consent_text: '',
  });

  // New assignment form
  const [asgnForm, setAsgnForm] = useState({
    agent_id: '',
    region: 'Metro Central',
    target_count: 50,
    due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    notes: '',
  });

  const survey = surveyQ.data;
  const activeVersion = useMemo(() => {
    if (!survey?.versions?.length) return null;
    if (selectedVersionId) {
      return survey.versions.find((v) => v.id === selectedVersionId) || survey.versions[0];
    }
    return survey.versions.find((v) => v.status === 'draft') || survey.versions[0];
  }, [survey, selectedVersionId]);

  useEffect(() => {
    if (survey) {
      setMetaForm({
        title: survey.title,
        description: survey.description,
        category: survey.category,
        target_responses: survey.target_responses,
        requires_consent: survey.requires_consent,
        allow_location_capture: survey.allow_location_capture,
        instructions: survey.instructions,
        consent_text: survey.consent_text,
      });
      if (!selectedVersionId && survey.versions.length > 0) {
        const draftV = survey.versions.find((v) => v.status === 'draft') || survey.versions[0];
        setSelectedVersionId(draftV.id);
      }
    }
  }, [survey, selectedVersionId]);

  useEffect(() => {
    if (activeVersion) {
      setDraftQuestions(JSON.parse(JSON.stringify(activeVersion.questions || [])));
      setChangeNotes(activeVersion.change_notes || '');
      setSelectedIdx(0);
      setHasUnsavedChanges(false);
    }
  }, [activeVersion]);

  useEffect(() => {
    if (agentsQ.data?.length && !asgnForm.agent_id) {
      setAsgnForm((prev) => ({
        ...prev,
        agent_id: agentsQ.data![0].id,
        region: agentsQ.data![0].region || 'Metro Central',
      }));
    }
  }, [agentsQ.data, asgnForm.agent_id]);

  const isEditable = hasRole('admin') && activeVersion?.status === 'draft';

  const saveQuestionsMutation = useMutation({
    mutationFn: () =>
      apiRequest<SurveyDetail>(`/surveys/${id}/versions/${activeVersion!.id}/questions`, {
        method: 'PUT',
        body: {
          change_notes: changeNotes,
          questions: draftQuestions.map((q, idx) => ({
            question_key: q.question_key,
            section_title: q.section_title,
            prompt: q.prompt,
            help_text: q.help_text,
            question_type: q.question_type,
            order_index: idx,
            is_required: q.is_required,
            options: q.options || [],
            conditional_logic: q.conditional_logic && q.conditional_logic.rules.length > 0 ? q.conditional_logic : null,
            config: q.config || {},
            validation_rules: (q.validation_rules || []).map((r) => ({
              rule_type: r.rule_type,
              rule_config: r.rule_config,
              severity: r.severity,
              error_message: r.error_message,
              is_active: r.is_active,
            })),
          })),
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      setHasUnsavedChanges(false);
      pushToast({ tone: 'success', title: 'Draft questions saved', detail: `${draftQuestions.length} questions stored.` });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Failed to save questions', detail: err.message }),
  });

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (hasUnsavedChanges && isEditable) {
        await saveQuestionsMutation.mutateAsync();
      }
      return apiRequest<SurveyDetail>(`/surveys/${id}/publish`, {
        method: 'POST',
        body: { version_id: activeVersion?.id, change_notes: changeNotes || undefined },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      pushToast({ tone: 'success', title: 'Survey version published', detail: 'Schema locked and ready for field collection.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Publish failed', detail: err.message }),
  });

  const createNewVersionMutation = useMutation({
    mutationFn: () =>
      apiRequest<SurveyDetail>(`/surveys/${id}/versions`, {
        method: 'POST',
        params: { change_notes: 'Revision draft created from published version' },
      }),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      const newDraft = updated.versions.find((v) => v.status === 'draft');
      if (newDraft) setSelectedVersionId(newDraft.id);
      pushToast({ tone: 'success', title: 'New draft version created', detail: `Editing v${newDraft?.version_number}.` });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Could not create draft', detail: err.message }),
  });

  const updateMetaMutation = useMutation({
    mutationFn: () => apiRequest<SurveyDetail>(`/surveys/${id}`, { method: 'PATCH', body: metaForm }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      pushToast({ tone: 'success', title: 'Survey metadata updated' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Update failed', detail: err.message }),
  });

  const createAssignmentMutation = useMutation({
    mutationFn: () =>
      apiRequest('/assignments', {
        method: 'POST',
        body: {
          survey_id: id,
          agent_id: asgnForm.agent_id,
          region: asgnForm.region,
          target_count: asgnForm.target_count,
          due_date: asgnForm.due_date ? new Date(asgnForm.due_date).toISOString() : null,
          notes: asgnForm.notes,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      queryClient.invalidateQueries({ queryKey: ['assignments'] });
      setAsgnForm((prev) => ({ ...prev, notes: '' }));
      pushToast({ tone: 'success', title: 'Field agent assigned', detail: 'Survey is now visible in the agent mobile app.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Assignment failed', detail: err.message }),
  });

  const updateAssignmentStatusMutation = useMutation({
    mutationFn: ({ assignmentId, status }: { assignmentId: string; status: string }) =>
      apiRequest(`/assignments/${assignmentId}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      pushToast({ tone: 'info', title: 'Assignment status updated' });
    },
  });

  const deleteAssignmentMutation = useMutation({
    mutationFn: (assignmentId: string) => apiRequest(`/assignments/${assignmentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDeleteAsgn(null);
      queryClient.invalidateQueries({ queryKey: ['surveys', id] });
      pushToast({ tone: 'info', title: 'Assignment removed' });
    },
  });

  if (surveyQ.isLoading) return <LoadingState message="Loading survey definition..." />;
  if (surveyQ.isError || !survey) {
    return <ErrorState message={(surveyQ.error as Error)?.message || 'Survey not found'} onRetry={() => surveyQ.refetch()} />;
  }

  const updateQuestion = (idx: number, patch: Partial<Question>) => {
    setDraftQuestions((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
    setHasUnsavedChanges(true);
  };

  const addQuestion = (type: QuestionType) => {
    const nextNum = draftQuestions.length + 1;
    const base: Question = {
      question_key: `q${nextNum}_${type}`,
      section_title: draftQuestions[selectedIdx]?.section_title || 'General',
      prompt: `Untitled ${type.replace('_', ' ')} question ${nextNum}`,
      help_text: '',
      question_type: type,
      order_index: draftQuestions.length,
      is_required: true,
      options:
        type === 'single_choice' || type === 'multi_choice'
          ? [
              { value: 'option_1', label: 'Option 1' },
              { value: 'option_2', label: 'Option 2' },
            ]
          : [],
      conditional_logic: null,
      config: type === 'rating' ? { min: 1, max: 5 } : {},
      validation_rules: [],
    };
    setDraftQuestions((prev) => [...prev, base]);
    setSelectedIdx(draftQuestions.length);
    setHasUnsavedChanges(true);
  };

  const moveQuestion = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= draftQuestions.length) return;
    setDraftQuestions((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((q, i) => ({ ...q, order_index: i }));
    });
    setSelectedIdx(target);
    setHasUnsavedChanges(true);
  };

  const removeQuestion = (idx: number) => {
    setDraftQuestions((prev) => prev.filter((_, i) => i !== idx).map((q, i) => ({ ...q, order_index: i })));
    setSelectedIdx(Math.max(0, idx - 1));
    setHasUnsavedChanges(true);
  };

  const selectedQ = draftQuestions[selectedIdx];
  const hasDraftVersion = survey.versions.some((v) => v.status === 'draft');

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${survey.code} — ${survey.title}`}
        subtitle={`${survey.category} · Target ${survey.target_responses.toLocaleString()} responses · Created by ${survey.created_by_name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={survey.status} />
            <select
              value={activeVersion?.id || ''}
              onChange={(e) => setSelectedVersionId(e.target.value)}
              className="ops-input w-44 py-1 text-[12px]"
            >
              {survey.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version_number} ({v.status}) — {v.question_count} Qs
                </option>
              ))}
            </select>

            {hasRole('admin') && !hasDraftVersion && survey.status !== 'archived' && (
              <button
                onClick={() => createNewVersionMutation.mutate()}
                disabled={createNewVersionMutation.isPending}
                className="ops-btn-secondary"
              >
                <CopyPlus className="h-3.5 w-3.5" />
                New Draft Version
              </button>
            )}

            {isEditable && (
              <>
                <button
                  onClick={() => saveQuestionsMutation.mutate()}
                  disabled={saveQuestionsMutation.isPending}
                  className="ops-btn-secondary"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saveQuestionsMutation.isPending ? 'Saving...' : hasUnsavedChanges ? 'Save Draft*' : 'Saved'}
                </button>
                <button
                  onClick={() => publishMutation.mutate()}
                  disabled={publishMutation.isPending || draftQuestions.length === 0}
                  className="ops-btn-primary"
                >
                  <Send className="h-3.5 w-3.5" />
                  Publish v{activeVersion?.version_number}
                </button>
              </>
            )}
          </div>
        }
      />

      {/* Module Sub-Tabs */}
      <div className="flex items-center gap-1 border-b border-hairline">
        {[
          { id: 'builder', label: `Question Builder (${draftQuestions.length})`, icon: GitBranch },
          { id: 'preview', label: 'Interactive Preview', icon: Eye },
          { id: 'assignments', label: `Field Assignments (${survey.assignments.length})`, icon: Users },
          { id: 'settings', label: 'Metadata & Privacy', icon: Settings2 },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setTab(tab.id)}
              className={`inline-flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-[12.5px] font-medium transition-colors ${
                active
                  ? 'border-teal-accent text-teal-accent'
                  : 'border-transparent text-navy-500 hover:text-navy'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: QUESTION BUILDER */}
      {activeTab === 'builder' && (
        <div className="space-y-3">
          {!isEditable && (
            <div className="flex items-center justify-between rounded-sm border border-amber-border/50 bg-amber-tint/40 px-3.5 py-2 text-[12px] text-amber-warn">
              <span>
                Version <strong>v{activeVersion?.version_number}</strong> is{' '}
                <strong>{activeVersion?.status}</strong> and immutable so historical responses remain schema-consistent.
                {hasRole('admin') && ' Create a new draft version to edit questions.'}
              </span>
              {hasRole('admin') && !hasDraftVersion && survey.status !== 'archived' && (
                <button onClick={() => createNewVersionMutation.mutate()} className="ops-btn-secondary text-[11.5px]">
                  Create Draft v{(activeVersion?.version_number || 1) + 1}
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* Left Outline */}
            <div className="ops-surface flex flex-col lg:col-span-5">
              <div className="flex items-center justify-between border-b border-hairline px-3.5 py-2.5">
                <span className="text-[12.5px] font-semibold text-navy">Questionnaire Outline</span>
                {isEditable && (
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) {
                        addQuestion(e.target.value as QuestionType);
                        e.target.value = '';
                      }
                    }}
                    className="ops-input w-40 py-1 text-[11.5px]"
                  >
                    <option value="" disabled>
                      + Add question...
                    </option>
                    {QUESTION_TYPES.map((qt) => (
                      <option key={qt.value} value={qt.value}>
                        + {qt.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="divide-y divide-hairline overflow-y-auto max-h-[620px]">
                {draftQuestions.map((q, idx) => {
                  const selected = idx === selectedIdx;
                  const hasLogic = Boolean(q.conditional_logic?.rules?.length);
                  const hasRules = (q.validation_rules?.length || 0) > 0;
                  return (
                    <div
                      key={`${q.question_key}-${idx}`}
                      onClick={() => setSelectedIdx(idx)}
                      className={`flex cursor-pointer items-start justify-between gap-2 px-3.5 py-2.5 transition-colors ${
                        selected ? 'bg-teal-tint/50 border-l-2 border-teal-accent' : 'hover:bg-canvas/70'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-[11px]">
                          <span className="font-mono font-semibold text-navy-500">Q{idx + 1}</span>
                          <span className="font-mono text-teal-accent">{q.question_key}</span>
                          <span className="rounded bg-recessed px-1.5 py-0.5 text-[10px] text-navy-600">
                            {q.question_type}
                          </span>
                          {q.is_required && <span className="text-crimson-err font-semibold">*</span>}
                        </div>
                        <div className="mt-1 truncate text-[12.5px] font-medium text-navy">{q.prompt}</div>
                        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-navy-500">
                          <span>{q.section_title}</span>
                          {hasLogic && (
                            <span className="inline-flex items-center gap-0.5 text-teal-accent font-medium">
                              <GitBranch className="h-3 w-3" /> Conditional
                            </span>
                          )}
                          {hasRules && (
                            <span className="inline-flex items-center gap-0.5 text-amber-warn font-medium">
                              <ShieldCheck className="h-3 w-3" /> {q.validation_rules.length} rule(s)
                            </span>
                          )}
                        </div>
                      </div>
                      {isEditable && (
                        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => moveQuestion(idx, -1)}
                            disabled={idx === 0}
                            className="rounded p-1 text-navy-400 hover:bg-recessed hover:text-navy disabled:opacity-30"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => moveQuestion(idx, 1)}
                            disabled={idx === draftQuestions.length - 1}
                            className="rounded p-1 text-navy-400 hover:bg-recessed hover:text-navy disabled:opacity-30"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => removeQuestion(idx)}
                            className="rounded p-1 text-navy-400 hover:bg-crimson-tint hover:text-crimson-err"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Inspector */}
            <div className="ops-surface p-4 lg:col-span-7">
              {!selectedQ ? (
                <div className="py-16 text-center text-[13px] text-navy-500">
                  Select a question from the outline or add a new question to configure properties.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between border-b border-hairline pb-2.5">
                    <div>
                      <div className="text-[13.5px] font-semibold text-navy">
                        Question {selectedIdx + 1} Properties
                      </div>
                      <div className="text-[11.5px] text-navy-500">
                        Schema key, branching rules, and automated pipeline validation constraints
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[12.5px] font-medium text-navy">
                      <input
                        type="checkbox"
                        disabled={!isEditable}
                        checked={selectedQ.is_required}
                        onChange={(e) => updateQuestion(selectedIdx, { is_required: e.target.checked })}
                        className="accent-teal-accent"
                      />
                      Required Field
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Question Key (snake_case)</label>
                      <input
                        disabled={!isEditable}
                        value={selectedQ.question_key}
                        onChange={(e) =>
                          updateQuestion(selectedIdx, {
                            question_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
                          })
                        }
                        className="ops-input font-mono"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Question Type</label>
                      <select
                        disabled={!isEditable}
                        value={selectedQ.question_type}
                        onChange={(e) => updateQuestion(selectedIdx, { question_type: e.target.value as QuestionType })}
                        className="ops-input"
                      >
                        {QUESTION_TYPES.map((qt) => (
                          <option key={qt.value} value={qt.value}>
                            {qt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Section</label>
                      <input
                        disabled={!isEditable}
                        value={selectedQ.section_title}
                        onChange={(e) => updateQuestion(selectedIdx, { section_title: e.target.value })}
                        className="ops-input"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Question Prompt</label>
                    <textarea
                      rows={2}
                      disabled={!isEditable}
                      value={selectedQ.prompt}
                      onChange={(e) => updateQuestion(selectedIdx, { prompt: e.target.value })}
                      className="ops-input"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Enumerator Help Text</label>
                      <input
                        disabled={!isEditable}
                        value={selectedQ.help_text}
                        onChange={(e) => updateQuestion(selectedIdx, { help_text: e.target.value })}
                        placeholder="Optional interviewer guidance"
                        className="ops-input"
                      />
                    </div>
                    {selectedQ.question_type === 'number' && (
                      <div>
                        <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Unit Label</label>
                        <input
                          disabled={!isEditable}
                          value={String(selectedQ.config?.unit || '')}
                          onChange={(e) =>
                            updateQuestion(selectedIdx, { config: { ...selectedQ.config, unit: e.target.value } })
                          }
                          placeholder="e.g. minutes, USD, trips/week"
                          className="ops-input"
                        />
                      </div>
                    )}
                  </div>

                  {/* Choice Options Editor */}
                  {(selectedQ.question_type === 'single_choice' || selectedQ.question_type === 'multi_choice') && (
                    <div className="rounded-sm border border-hairline bg-canvas/50 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-navy">Choice Options</span>
                        {isEditable && (
                          <button
                            type="button"
                            onClick={() =>
                              updateQuestion(selectedIdx, {
                                options: [
                                  ...(selectedQ.options || []),
                                  {
                                    value: `opt_${(selectedQ.options?.length || 0) + 1}`,
                                    label: `Option ${(selectedQ.options?.length || 0) + 1}`,
                                  },
                                ],
                              })
                            }
                            className="ops-btn-secondary px-2 py-0.5 text-[11px]"
                          >
                            <Plus className="h-3 w-3" /> Add Option
                          </button>
                        )}
                      </div>
                      <div className="space-y-1.5">
                        {(selectedQ.options || []).map((opt, oIdx) => (
                          <div key={oIdx} className="flex items-center gap-2">
                            <input
                              disabled={!isEditable}
                              value={opt.value}
                              onChange={(e) => {
                                const next = [...selectedQ.options];
                                next[oIdx] = { ...next[oIdx], value: e.target.value };
                                updateQuestion(selectedIdx, { options: next });
                              }}
                              placeholder="code"
                              className="ops-input w-40 font-mono text-[12px]"
                            />
                            <input
                              disabled={!isEditable}
                              value={opt.label}
                              onChange={(e) => {
                                const next = [...selectedQ.options];
                                next[oIdx] = { ...next[oIdx], label: e.target.value };
                                updateQuestion(selectedIdx, { options: next });
                              }}
                              placeholder="Display label"
                              className="ops-input flex-1 text-[12px]"
                            />
                            {isEditable && (
                              <button
                                type="button"
                                onClick={() =>
                                  updateQuestion(selectedIdx, {
                                    options: selectedQ.options.filter((_, j) => j !== oIdx),
                                  })
                                }
                                className="p-1 text-navy-400 hover:text-crimson-err"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Conditional Branching Logic Editor */}
                  <div className="rounded-sm border border-hairline bg-canvas/50 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <GitBranch className="h-3.5 w-3.5 text-teal-accent" />
                        <span className="text-[12px] font-semibold text-navy">Conditional Branching (Skip Logic)</span>
                      </div>
                      {isEditable && selectedIdx > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            const prior = draftQuestions[selectedIdx - 1];
                            const existing = selectedQ.conditional_logic || { operator: 'all' as const, rules: [] };
                            const nextRule: ConditionalRule = {
                              question_key: prior.question_key,
                              condition: 'equals',
                              value: prior.question_type === 'boolean' ? 'true' : prior.options?.[0]?.value || '',
                            };
                            updateQuestion(selectedIdx, {
                              conditional_logic: { ...existing, rules: [...existing.rules, nextRule] },
                            });
                          }}
                          className="ops-btn-secondary px-2 py-0.5 text-[11px]"
                        >
                          <Plus className="h-3 w-3" /> Add Condition
                        </button>
                      )}
                    </div>

                    {!selectedQ.conditional_logic?.rules?.length ? (
                      <p className="text-[11.5px] text-navy-500">
                        Always visible. Add a condition referencing an earlier question to control conditional display.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-[11.5px] text-navy-600">
                          <span>Display this question when</span>
                          <select
                            disabled={!isEditable}
                            value={selectedQ.conditional_logic.operator}
                            onChange={(e) =>
                              updateQuestion(selectedIdx, {
                                conditional_logic: {
                                  ...selectedQ.conditional_logic!,
                                  operator: e.target.value as 'all' | 'any',
                                },
                              })
                            }
                            className="ops-input w-24 py-0.5 text-[11.5px]"
                          >
                            <option value="all">ALL</option>
                            <option value="any">ANY</option>
                          </select>
                          <span>of the following match:</span>
                        </div>
                        {selectedQ.conditional_logic.rules.map((rule, rIdx) => (
                          <div key={rIdx} className="grid grid-cols-12 items-center gap-1.5">
                            <select
                              disabled={!isEditable}
                              value={rule.question_key}
                              onChange={(e) => {
                                const rules = [...selectedQ.conditional_logic!.rules];
                                rules[rIdx] = { ...rules[rIdx], question_key: e.target.value };
                                updateQuestion(selectedIdx, {
                                  conditional_logic: { ...selectedQ.conditional_logic!, rules },
                                });
                              }}
                              className="ops-input col-span-4 font-mono text-[11.5px]"
                            >
                              {draftQuestions.slice(0, selectedIdx).map((pq) => (
                                <option key={pq.question_key} value={pq.question_key}>
                                  {pq.question_key}
                                </option>
                              ))}
                            </select>
                            <select
                              disabled={!isEditable}
                              value={rule.condition}
                              onChange={(e) => {
                                const rules = [...selectedQ.conditional_logic!.rules];
                                rules[rIdx] = {
                                  ...rules[rIdx],
                                  condition: e.target.value as ConditionalRule['condition'],
                                };
                                updateQuestion(selectedIdx, {
                                  conditional_logic: { ...selectedQ.conditional_logic!, rules },
                                });
                              }}
                              className="ops-input col-span-3 text-[11.5px]"
                            >
                              <option value="equals">equals</option>
                              <option value="not_equals">not equals</option>
                              <option value="in">in list</option>
                              <option value="contains">contains</option>
                              <option value="greater_than">greater than</option>
                              <option value="less_than">less than</option>
                              <option value="is_answered">is answered</option>
                            </select>
                            <input
                              disabled={!isEditable}
                              value={Array.isArray(rule.value) ? rule.value.join(', ') : String(rule.value ?? '')}
                              onChange={(e) => {
                                const rules = [...selectedQ.conditional_logic!.rules];
                                const raw = e.target.value;
                                rules[rIdx] = {
                                  ...rules[rIdx],
                                  value: rule.condition === 'in' ? raw.split(',').map((s) => s.trim()) : raw,
                                };
                                updateQuestion(selectedIdx, {
                                  conditional_logic: { ...selectedQ.conditional_logic!, rules },
                                });
                              }}
                              placeholder="Expected value"
                              className="ops-input col-span-4 text-[11.5px]"
                            />
                            {isEditable && (
                              <button
                                type="button"
                                onClick={() => {
                                  const rules = selectedQ.conditional_logic!.rules.filter((_, j) => j !== rIdx);
                                  updateQuestion(selectedIdx, {
                                    conditional_logic: rules.length ? { ...selectedQ.conditional_logic!, rules } : null,
                                  });
                                }}
                                className="col-span-1 p-1 text-navy-400 hover:text-crimson-err"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Validation & Outlier Rules Editor */}
                  <div className="rounded-sm border border-hairline bg-canvas/50 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="h-3.5 w-3.5 text-amber-warn" />
                        <span className="text-[12px] font-semibold text-navy">Pipeline Validation & Outlier Rules</span>
                      </div>
                      {isEditable && (
                        <button
                          type="button"
                          onClick={() => {
                            const nextRule: ValidationRule = {
                              rule_type: selectedQ.question_type === 'number' ? 'outlier_bounds' : 'max_length',
                              rule_config: selectedQ.question_type === 'number' ? { min: 0, max: 100 } : { max: 250 },
                              severity: 'warning',
                              error_message: 'Value outside expected range',
                              is_active: true,
                            };
                            updateQuestion(selectedIdx, {
                              validation_rules: [...(selectedQ.validation_rules || []), nextRule],
                            });
                          }}
                          className="ops-btn-secondary px-2 py-0.5 text-[11px]"
                        >
                          <Plus className="h-3 w-3" /> Add Rule
                        </button>
                      )}
                    </div>

                    {(selectedQ.validation_rules || []).length === 0 ? (
                      <p className="text-[11.5px] text-navy-500">
                        No extra validation constraints beyond data type and required-field checks.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectedQ.validation_rules.map((vr, vIdx) => (
                          <div key={vIdx} className="rounded-sm border border-hairline bg-surface p-2.5 space-y-2">
                            <div className="grid grid-cols-12 items-center gap-2">
                              <select
                                disabled={!isEditable}
                                value={vr.rule_type}
                                onChange={(e) => {
                                  const next = [...selectedQ.validation_rules];
                                  next[vIdx] = { ...next[vIdx], rule_type: e.target.value as ValidationRule['rule_type'] };
                                  updateQuestion(selectedIdx, { validation_rules: next });
                                }}
                                className="ops-input col-span-4 text-[11.5px]"
                              >
                                <option value="outlier_bounds">Outlier Bounds (min/max)</option>
                                <option value="min_value">Min Numeric Value</option>
                                <option value="max_value">Max Numeric Value</option>
                                <option value="min_length">Min Text Length</option>
                                <option value="max_length">Max Text Length</option>
                                <option value="regex">Regex Pattern</option>
                              </select>
                              <select
                                disabled={!isEditable}
                                value={vr.severity}
                                onChange={(e) => {
                                  const next = [...selectedQ.validation_rules];
                                  next[vIdx] = { ...next[vIdx], severity: e.target.value as ValidationRule['severity'] };
                                  updateQuestion(selectedIdx, { validation_rules: next });
                                }}
                                className="ops-input col-span-3 text-[11.5px]"
                              >
                                <option value="warning">Warning (Flag)</option>
                                <option value="critical">Critical (Reject/High)</option>
                              </select>
                              <input
                                disabled={!isEditable}
                                value={JSON.stringify(vr.rule_config)}
                                onChange={(e) => {
                                  try {
                                    const parsed = JSON.parse(e.target.value);
                                    const next = [...selectedQ.validation_rules];
                                    next[vIdx] = { ...next[vIdx], rule_config: parsed };
                                    updateQuestion(selectedIdx, { validation_rules: next });
                                  } catch {
                                    // ignore until valid json
                                  }
                                }}
                                className="ops-input col-span-4 font-mono text-[11px]"
                                title='JSON config e.g. {"min": 1, "max": 60}'
                              />
                              {isEditable && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateQuestion(selectedIdx, {
                                      validation_rules: selectedQ.validation_rules.filter((_, j) => j !== vIdx),
                                    })
                                  }
                                  className="col-span-1 p-1 text-navy-400 hover:text-crimson-err"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                            <input
                              disabled={!isEditable}
                              value={vr.error_message}
                              onChange={(e) => {
                                const next = [...selectedQ.validation_rules];
                                next[vIdx] = { ...next[vIdx], error_message: e.target.value };
                                updateQuestion(selectedIdx, { validation_rules: next });
                              }}
                              placeholder="Diagnostic message surfaced in Data Quality Console"
                              className="ops-input text-[11.5px]"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: INTERACTIVE PREVIEW */}
      {activeTab === 'preview' && (
        <div className="space-y-3">
          <div className="ops-surface flex items-center justify-between px-4 py-2.5">
            <div className="text-[12.5px] text-navy-600">
              Live interactive preview of <strong>v{activeVersion?.version_number}</strong> — test conditional branching without writing to database.
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPreviewViewport('mobile')}
                className={previewViewport === 'mobile' ? 'ops-btn-primary px-2.5 py-1 text-[12px]' : 'ops-btn-secondary px-2.5 py-1 text-[12px]'}
              >
                <Smartphone className="h-3.5 w-3.5" /> Mobile (390px)
              </button>
              <button
                onClick={() => setPreviewViewport('desktop')}
                className={previewViewport === 'desktop' ? 'ops-btn-primary px-2.5 py-1 text-[12px]' : 'ops-btn-secondary px-2.5 py-1 text-[12px]'}
              >
                <Monitor className="h-3.5 w-3.5" /> Desktop
              </button>
              <button
                onClick={() => setPreviewAnswers({})}
                className="ops-btn-secondary px-2.5 py-1 text-[12px]"
              >
                Reset Answers
              </button>
            </div>
          </div>

          <div className="flex justify-center py-2">
            <div
              className={`w-full rounded border border-hairlineStrong bg-surface p-5 shadow-card ${
                previewViewport === 'mobile' ? 'max-w-[410px]' : 'max-w-3xl'
              }`}
            >
              <div className="mb-4 border-b border-hairline pb-3">
                <div className="font-mono text-[11px] text-teal-accent">{survey.code} · PREVIEW MODE</div>
                <h2 className="mt-0.5 text-[16px] font-semibold text-navy">{survey.title}</h2>
                {survey.instructions && (
                  <p className="mt-1.5 rounded-sm bg-canvas p-2.5 text-[12px] text-navy-600">{survey.instructions}</p>
                )}
              </div>
              <DynamicQuestionnaireForm
                questions={draftQuestions}
                answers={previewAnswers}
                onChange={(k, v) => setPreviewAnswers((prev) => ({ ...prev, [k]: v }))}
              />
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: ASSIGNMENTS */}
      {activeTab === 'assignments' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="ops-surface overflow-hidden lg:col-span-8">
            <div className="border-b border-hairline px-4 py-3">
              <h2 className="text-[13.5px] font-semibold text-navy">Assigned Field Enumerators</h2>
              <p className="text-[11.5px] text-navy-500">Agents receive active assignments directly in their mobile field application</p>
            </div>
            {survey.assignments.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12.5px] text-navy-500">
                No field agents assigned yet. {survey.status !== 'published' && 'Publish this survey first to create assignments.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <th className="ops-th">Field Agent</th>
                      <th className="ops-th">District / Zone</th>
                      <th className="ops-th text-right">Progress</th>
                      <th className="ops-th">Due Date</th>
                      <th className="ops-th">Status</th>
                      {hasRole('admin') && <th className="ops-th text-right">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {survey.assignments.map((a) => (
                      <tr key={a.id} className="hover:bg-canvas/50">
                        <td className="ops-td">
                          <div className="font-medium text-navy">{a.agent_name}</div>
                          <div className="text-[11px] text-navy-500">{a.agent_email}</div>
                        </td>
                        <td className="ops-td">{a.region}</td>
                        <td className="ops-td text-right tabular-nums">
                          <span className="font-semibold">{a.collected_count}</span> / {a.target_count}
                        </td>
                        <td className="ops-td text-[12px] text-navy-500 tabular-nums">
                          {a.due_date ? formatShortDate(a.due_date) : '—'}
                        </td>
                        <td className="ops-td">
                          <StatusBadge status={a.status} />
                        </td>
                        {hasRole('admin') && (
                          <td className="ops-td text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <select
                                value={a.status}
                                onChange={(e) =>
                                  updateAssignmentStatusMutation.mutate({
                                    assignmentId: a.id,
                                    status: e.target.value,
                                  })
                                }
                                className="ops-input w-24 py-0.5 text-[11px]"
                              >
                                <option value="active">Active</option>
                                <option value="paused">Paused</option>
                                <option value="completed">Completed</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteAsgn({ id: a.id, agent_name: a.agent_name })}
                                className="p-1 text-navy-400 hover:text-crimson-err"
                                aria-label={`Remove assignment for ${a.agent_name}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {hasRole('admin') && (
            <div className="ops-surface p-4 lg:col-span-4">
              <h3 className="text-[13.5px] font-semibold text-navy">Assign Field Agent</h3>
              <p className="mt-0.5 text-[11.5px] text-navy-500">
                Dispatch published version v{activeVersion?.version_number} to an enumerator.
              </p>

              {survey.status !== 'published' ? (
                <div className="mt-3 rounded-sm border border-amber-border/60 bg-amber-tint/40 p-3 text-[12px] text-amber-warn">
                  Publish this survey before assigning it to field agents.
                </div>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    createAssignmentMutation.mutate();
                  }}
                  className="mt-3.5 space-y-3"
                >
                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Field Agent</label>
                    <select
                      value={asgnForm.agent_id}
                      onChange={(e) => {
                        const ag = agentsQ.data?.find((u) => u.id === e.target.value);
                        setAsgnForm({ ...asgnForm, agent_id: e.target.value, region: ag?.region || asgnForm.region });
                      }}
                      className="ops-input"
                    >
                      {(agentsQ.data || []).map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          {ag.full_name} ({ag.region})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Assigned District / Zone</label>
                    <select
                      value={asgnForm.region}
                      onChange={(e) => setAsgnForm({ ...asgnForm, region: e.target.value })}
                      className="ops-input"
                    >
                      {DISTRICTS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Target Count</label>
                      <input
                        type="number"
                        min={1}
                        value={asgnForm.target_count}
                        onChange={(e) => setAsgnForm({ ...asgnForm, target_count: Number(e.target.value) })}
                        className="ops-input tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Due Date</label>
                      <input
                        type="date"
                        value={asgnForm.due_date}
                        onChange={(e) => setAsgnForm({ ...asgnForm, due_date: e.target.value })}
                        className="ops-input"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[11.5px] font-medium text-navy-600">Field Briefing Note</label>
                    <textarea
                      rows={2}
                      value={asgnForm.notes}
                      onChange={(e) => setAsgnForm({ ...asgnForm, notes: e.target.value })}
                      placeholder="Sampling corridor or ward priority..."
                      className="ops-input"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={createAssignmentMutation.isPending || !asgnForm.agent_id}
                    className="ops-btn-primary w-full"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {createAssignmentMutation.isPending ? 'Assigning...' : 'Dispatch Assignment'}
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: SETTINGS & METADATA */}
      {activeTab === 'settings' && (
        <div className="ops-surface max-w-3xl p-5">
          <h2 className="text-[14px] font-semibold text-navy">Survey Governance & Privacy Settings</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              updateMetaMutation.mutate();
            }}
            className="mt-4 space-y-3.5"
          >
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Title</label>
              <input
                disabled={!hasRole('admin')}
                value={metaForm.title}
                onChange={(e) => setMetaForm({ ...metaForm, title: e.target.value })}
                className="ops-input"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[12px] font-medium text-navy-700">Category</label>
                <input
                  disabled={!hasRole('admin')}
                  value={metaForm.category}
                  onChange={(e) => setMetaForm({ ...metaForm, category: e.target.value })}
                  className="ops-input"
                />
              </div>
              <div>
                <label className="mb-1 block text-[12px] font-medium text-navy-700">Target Responses</label>
                <input
                  type="number"
                  disabled={!hasRole('admin')}
                  value={metaForm.target_responses}
                  onChange={(e) => setMetaForm({ ...metaForm, target_responses: Number(e.target.value) })}
                  className="ops-input tabular-nums"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Description</label>
              <textarea
                rows={2}
                disabled={!hasRole('admin')}
                value={metaForm.description}
                onChange={(e) => setMetaForm({ ...metaForm, description: e.target.value })}
                className="ops-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Field Instructions</label>
              <textarea
                rows={3}
                disabled={!hasRole('admin')}
                value={metaForm.instructions}
                onChange={(e) => setMetaForm({ ...metaForm, instructions: e.target.value })}
                className="ops-input"
              />
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Respondent Consent Statement</label>
              <textarea
                rows={3}
                disabled={!hasRole('admin')}
                value={metaForm.consent_text}
                onChange={(e) => setMetaForm({ ...metaForm, consent_text: e.target.value })}
                className="ops-input"
              />
            </div>
            <div className="flex gap-6 pt-1">
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  disabled={!hasRole('admin')}
                  checked={metaForm.requires_consent}
                  onChange={(e) => setMetaForm({ ...metaForm, requires_consent: e.target.checked })}
                  className="accent-teal-accent"
                />
                Require respondent consent
              </label>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="checkbox"
                  disabled={!hasRole('admin')}
                  checked={metaForm.allow_location_capture}
                  onChange={(e) => setMetaForm({ ...metaForm, allow_location_capture: e.target.checked })}
                  className="accent-teal-accent"
                />
                Allow consented GPS location capture
              </label>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-3 text-[11.5px] text-navy-500">
              <span>Last updated {formatDateTime(survey.updated_at)}</span>
              {hasRole('admin') && (
                <button type="submit" disabled={updateMetaMutation.isPending} className="ops-btn-primary">
                  <Save className="h-3.5 w-3.5" /> Save Settings
                </button>
              )}
            </div>
          </form>
        </div>
      )}
      <ConfirmModal
        open={Boolean(confirmDeleteAsgn)}
        title="Remove Field Assignment?"
        message={`Remove ${confirmDeleteAsgn?.agent_name}'s assignment from ${survey.code}? Previously submitted responses remain safely stored.`}
        confirmLabel="Remove Assignment"
        isPending={deleteAssignmentMutation.isPending}
        onConfirm={() => confirmDeleteAsgn && deleteAssignmentMutation.mutate(confirmDeleteAsgn.id)}
        onCancel={() => setConfirmDeleteAsgn(null)}
      />
    </div>
  );
}
