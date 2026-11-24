import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  BarChart3,
  Edit3,
  Plus,
  Search,
  Send,
  Users,
} from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  PaginationBar,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatNumber, formatShortDate } from '@/lib/format';
import type { SurveyListItem } from '@/types';

const CATEGORIES = [
  'Public Transit',
  'Water & Sanitation',
  'Digital Literacy',
  'Parks & Civic Spaces',
  'Public Health',
  'Civic Services',
];

export function SurveysListPage() {
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortBy, setSortBy] = useState('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState<SurveyListItem | null>(null);
  const [newSurvey, setNewSurvey] = useState({
    code: '',
    title: '',
    description: '',
    category: 'Civic Services',
    target_responses: 250,
    requires_consent: true,
    allow_location_capture: true,
    instructions: 'Verify respondent consent before starting enumeration. Capture coordinates only when explicitly consented.',
    consent_text: 'Participation is voluntary and confidential. Responses are anonymized for municipal planning and public-service research.',
  });

  useEffect(() => {
    if (searchParams.get('create') === '1' && hasRole('admin')) {
      setCreateOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, hasRole, setSearchParams]);

  const surveysQ = useQuery({
    queryKey: ['surveys', { search, statusFilter, categoryFilter, sortBy, sortDir, page }],
    queryFn: () =>
      apiRequest<{ items: SurveyListItem[]; total: number; page: number; page_size: number }>('/surveys', {
        params: {
          search: search.trim() || undefined,
          status: statusFilter,
          category: categoryFilter,
          sort_by: sortBy,
          sort_dir: sortDir,
          page,
          page_size: 15,
        },
      }),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ id: string; code: string }>('/surveys', {
        method: 'POST',
        body: {
          ...newSurvey,
          code: newSurvey.code.trim() || undefined,
          questions: [
            {
              question_key: 'q1_service_satisfaction',
              section_title: 'Core Assessment',
              prompt: 'Overall, how satisfied are you with this municipal service (1 = Very Poor, 5 = Excellent)?',
              help_text: 'Read scale anchors aloud to respondent.',
              question_type: 'rating',
              order_index: 0,
              is_required: true,
              options: [],
              conditional_logic: null,
              config: { min: 1, max: 5 },
              validation_rules: [
                { rule_type: 'min_value', rule_config: { min: 1 }, severity: 'critical', error_message: 'Must be 1-5', is_active: true },
                { rule_type: 'max_value', rule_config: { max: 5 }, severity: 'critical', error_message: 'Must be 1-5', is_active: true },
              ],
            },
          ],
        },
      }),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      setCreateOpen(false);
      pushToast({ tone: 'success', title: 'Survey draft created', detail: `${created.code} ready in Survey Builder.` });
      navigate(`/surveys/${created.id}/builder`);
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Creation failed', detail: err.message }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => apiRequest<{ message: string }>(`/surveys/${id}`, { method: 'DELETE' }),
    onSuccess: (res) => {
      setConfirmArchive(null);
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      pushToast({ tone: 'info', title: 'Survey updated', detail: res.message });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Action failed', detail: err.message }),
  });

  const publishMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/surveys/${id}/publish`, { method: 'POST', body: {} }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      pushToast({ tone: 'success', title: 'Survey published', detail: 'Active version is now live for agent assignment.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Publish failed', detail: err.message }),
  });

  const toggleSort = (col: string) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Survey Management"
        subtitle="Author versioned civic questionnaires, configure conditional branching and validation rules, publish, and assign to field agents."
        actions={
          hasRole('admin') && (
            <button onClick={() => setCreateOpen(true)} className="ops-btn-primary">
              <Plus className="h-3.5 w-3.5" />
              Create Survey
            </button>
          )
        }
      />

      {/* Filter Bar */}
      <div className="ops-surface flex flex-wrap items-center gap-2.5 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-navy-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by survey code, title, or description..."
            className="ops-input pl-8"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="ops-input w-36"
        >
          <option value="all">All Statuses</option>
          <option value="published">Published</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className="ops-input w-48"
        >
          <option value="all">All Categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {surveysQ.isLoading ? (
        <LoadingState message="Loading surveys..." />
      ) : surveysQ.isError ? (
        <ErrorState message={(surveysQ.error as Error).message} onRetry={() => surveysQ.refetch()} />
      ) : (surveysQ.data?.items || []).length === 0 ? (
        <EmptyState
          title="No surveys match your filters"
          description="Adjust your search criteria or create a new survey instrument to begin field collection."
          action={
            hasRole('admin') && (
              <button onClick={() => setCreateOpen(true)} className="ops-btn-primary">
                <Plus className="h-3.5 w-3.5" /> Create Survey
              </button>
            )
          }
        />
      ) : (
        <div className="ops-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th onClick={() => toggleSort('code')} className="ops-th cursor-pointer hover:text-navy">
                    Code {sortBy === 'code' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th onClick={() => toggleSort('title')} className="ops-th cursor-pointer hover:text-navy">
                    Survey Instrument {sortBy === 'title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th onClick={() => toggleSort('status')} className="ops-th cursor-pointer hover:text-navy">
                    Status
                  </th>
                  <th className="ops-th">Ver.</th>
                  <th className="ops-th text-right">Responses</th>
                  <th className="ops-th text-right">Valid %</th>
                  <th className="ops-th text-right">Agents</th>
                  <th onClick={() => toggleSort('updated_at')} className="ops-th cursor-pointer hover:text-navy">
                    Updated
                  </th>
                  <th className="ops-th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {surveysQ.data!.items.map((s) => (
                  <tr key={s.id} className="hover:bg-canvas/60">
                    <td className="ops-td font-mono text-[12px] font-medium text-teal-accent whitespace-nowrap">{s.code}</td>
                    <td className="ops-td max-w-[260px]">
                      <Link
                        to={`/surveys/${s.id}/builder`}
                        className="block truncate font-semibold text-navy hover:text-teal-accent hover:underline"
                      >
                        {s.title}
                      </Link>
                      <div className="mt-0.5 truncate text-[11.5px] text-navy-500">
                        {s.category} · {s.question_count} Qs · Target {formatNumber(s.target_responses)}
                      </div>
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="ops-td font-mono text-[12px] tabular-nums whitespace-nowrap">
                      v{s.active_version_number}
                      {s.latest_version_number > s.active_version_number && (
                        <span className="ml-1 text-[10.5px] text-amber-warn">(v{s.latest_version_number} draft)</span>
                      )}
                    </td>
                    <td className="ops-td text-right font-medium tabular-nums whitespace-nowrap">
                      {formatNumber(s.response_stats.total)}
                    </td>
                    <td className="ops-td text-right tabular-nums whitespace-nowrap">
                      {s.response_stats.total > 0 ? `${s.response_stats.valid_rate}%` : '—'}
                    </td>
                    <td className="ops-td text-right tabular-nums whitespace-nowrap">{s.active_assignments}</td>
                    <td className="ops-td text-[12px] text-navy-500 tabular-nums whitespace-nowrap">
                      {formatShortDate(s.updated_at)}
                    </td>
                    <td className="ops-td text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <Link
                          to={`/surveys/${s.id}/builder`}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Open Survey Builder"
                        >
                          <Edit3 className="h-3 w-3" />
                          Builder
                        </Link>
                        <Link
                          to={`/surveys/${s.id}/builder?tab=assignments`}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Manage Agent Assignments"
                          aria-label="Manage agent assignments"
                        >
                          <Users className="h-3 w-3" />
                        </Link>
                        <Link
                          to={`/analytics?survey=${s.id}`}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="View Survey Analytics"
                          aria-label="View survey analytics"
                        >
                          <BarChart3 className="h-3 w-3" />
                        </Link>
                        {hasRole('admin') && s.status === 'draft' && (
                          <button
                            type="button"
                            disabled={publishMutation.isPending}
                            onClick={() => publishMutation.mutate(s.id)}
                            className="ops-btn-primary px-2 py-1 text-[11.5px]"
                            title="Publish Draft"
                            aria-label="Publish draft survey"
                          >
                            <Send className="h-3 w-3" />
                          </button>
                        )}
                        {hasRole('admin') && s.status !== 'archived' && (
                          <button
                            type="button"
                            onClick={() => setConfirmArchive(s)}
                            className="ops-btn-secondary px-2 py-1 text-[11.5px] text-navy-500 hover:text-crimson-err"
                            title={s.response_stats.total > 0 ? 'Archive Survey' : 'Delete Draft Survey'}
                            aria-label="Archive or delete survey"
                          >
                            <Archive className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar
            page={page}
            pageSize={15}
            total={surveysQ.data!.total}
            onPageChange={setPage}
          />
        </div>
      )}

      {/* Create Survey Modal */}
      <Modal
        open={createOpen}
        title="Create New Civic Research Survey"
        subtitle="Creates a v1 draft instrument with configurable consent, privacy, and questionnaire structure."
        onClose={() => setCreateOpen(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
          className="space-y-3.5"
        >
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Survey Code</label>
              <input
                value={newSurvey.code}
                onChange={(e) => setNewSurvey({ ...newSurvey, code: e.target.value })}
                placeholder="Auto (e.g. CIV-2026-04)"
                className="ops-input font-mono uppercase"
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Survey Title *</label>
              <input
                required
                minLength={3}
                value={newSurvey.title}
                onChange={(e) => setNewSurvey({ ...newSurvey, title: e.target.value })}
                placeholder="e.g. Municipal Street Lighting Safety Audit"
                className="ops-input"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Category</label>
              <select
                value={newSurvey.category}
                onChange={(e) => setNewSurvey({ ...newSurvey, category: e.target.value })}
                className="ops-input"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Target Sample Size</label>
              <input
                type="number"
                min={1}
                value={newSurvey.target_responses}
                onChange={(e) => setNewSurvey({ ...newSurvey, target_responses: Number(e.target.value) })}
                className="ops-input tabular-nums"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Description</label>
            <textarea
              rows={2}
              value={newSurvey.description}
              onChange={(e) => setNewSurvey({ ...newSurvey, description: e.target.value })}
              placeholder="Research scope, geographic coverage, and civic planning objective."
              className="ops-input"
            />
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Field Agent Briefing Instructions</label>
            <textarea
              rows={2}
              value={newSurvey.instructions}
              onChange={(e) => setNewSurvey({ ...newSurvey, instructions: e.target.value })}
              className="ops-input"
            />
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Respondent Consent Statement</label>
            <textarea
              rows={2}
              value={newSurvey.consent_text}
              onChange={(e) => setNewSurvey({ ...newSurvey, consent_text: e.target.value })}
              className="ops-input"
            />
          </div>

          <div className="flex items-center gap-6 pt-1">
            <label className="flex items-center gap-2 text-[12.5px] text-navy">
              <input
                type="checkbox"
                checked={newSurvey.requires_consent}
                onChange={(e) => setNewSurvey({ ...newSurvey, requires_consent: e.target.checked })}
                className="accent-teal-accent"
              />
              Require respondent consent
            </label>
            <label className="flex items-center gap-2 text-[12.5px] text-navy">
              <input
                type="checkbox"
                checked={newSurvey.allow_location_capture}
                onChange={(e) => setNewSurvey({ ...newSurvey, allow_location_capture: e.target.checked })}
                className="accent-teal-accent"
              />
              Allow consented GPS capture
            </label>
          </div>

          <div className="flex justify-end gap-2 border-t border-hairline pt-3">
            <button type="button" onClick={() => setCreateOpen(false)} className="ops-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={createMutation.isPending} className="ops-btn-primary">
              {createMutation.isPending ? 'Creating...' : 'Create & Open Builder'}
            </button>
          </div>
        </form>
      </Modal>
      {/* Archive / Delete Confirmation */}
      <ConfirmModal
        open={Boolean(confirmArchive)}
        title={
          (confirmArchive?.response_stats.total || 0) > 0
            ? `Archive Survey ${confirmArchive?.code}?`
            : `Delete Draft Survey ${confirmArchive?.code}?`
        }
        message={
          (confirmArchive?.response_stats.total || 0) > 0
            ? `This survey has ${formatNumber(confirmArchive?.response_stats.total)} collected responses. Archiving stops new fieldwork while preserving all collected data and reports intact.`
            : 'This draft has zero responses and will be permanently deleted.'
        }
        confirmLabel={(confirmArchive?.response_stats.total || 0) > 0 ? 'Archive Survey' : 'Delete Draft'}
        isPending={archiveMutation.isPending}
        onConfirm={() => confirmArchive && archiveMutation.mutate(confirmArchive.id)}
        onCancel={() => setConfirmArchive(null)}
      />
    </div>
  );
}
