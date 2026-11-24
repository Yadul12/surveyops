import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, Search, ShieldCheck, XCircle } from 'lucide-react';
import { apiRequest } from '@/api/client';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PaginationBar,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatNumber, humanizeKey } from '@/lib/format';
import type { QualityIssueItem, SurveyListItem } from '@/types';

function formatDetectedValue(val: unknown): string {
  if (val === null || val === undefined) return 'Empty';
  if (Array.isArray(val)) return val.join(', ');
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if ('duplicate_of_id' in obj) {
      return `Matches record ${String(obj.duplicate_of_id).slice(0, 8)} (fp ${String(obj.fingerprint_hash || '').slice(0, 8)})`;
    }
    if ('duration_seconds' in obj) {
      return `Duration: ${obj.duration_seconds}s`;
    }
    return Object.entries(obj)
      .map(([k, v]) => `${humanizeKey(k)}: ${String(v)}`)
      .join(' · ');
  }
  return String(val);
}

const ISSUE_TABS = [
  { id: 'all', label: 'All Issues' },
  { id: 'outlier', label: 'Outliers' },
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'missing_value', label: 'Missing Values' },
  { id: 'suspicious_duration', label: 'Suspicious Time' },
  { id: 'validation_failure', label: 'Validation Failures' },
  { id: 'schema_error', label: 'Schema Errors' },
  { id: 'straight_lining', label: 'Straight-Lining' },
];

export function QualityConsolePage() {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [issueType, setIssueType] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [statusFilter, setStatusFilter] = useState('open');
  const [surveyId, setSurveyId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selectedResponseIds, setSelectedResponseIds] = useState<string[]>([]);

  const surveysQ = useQuery({
    queryKey: ['surveys', 'dropdown'],
    queryFn: () => apiRequest<{ items: SurveyListItem[] }>('/surveys', { params: { page_size: 50 } }),
  });

  const issuesQ = useQuery({
    queryKey: ['quality', 'issues', { issueType, severity, statusFilter, surveyId, search, page }],
    queryFn: () =>
      apiRequest<{
        items: QualityIssueItem[];
        total: number;
        page: number;
        page_size: number;
        open_by_type: Record<string, number>;
      }>('/quality/issues', {
        params: {
          issue_type: issueType,
          severity,
          status: statusFilter,
          survey_id: surveyId || undefined,
          search: search.trim() || undefined,
          page,
          page_size: 20,
        },
      }),
  });

  const quickDecisionMutation = useMutation({
    mutationFn: ({ responseId, decision }: { responseId: string; decision: 'approve' | 'reject' }) =>
      apiRequest(`/quality/responses/${responseId}/decision`, {
        method: 'POST',
        body: {
          decision,
          review_notes: `Quick ${decision} from Data Quality Console`,
          resolve_open_issues: true,
        },
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['responses'] });
      pushToast({ tone: 'success', title: `Response ${vars.decision}d` });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Action failed', detail: err.message }),
  });

  const bulkApproveMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ approved_count: number }>('/quality/responses/bulk-approve', {
        method: 'POST',
        body: {
          response_ids: selectedResponseIds,
          review_notes: 'Bulk approved by analyst after triage inspection.',
        },
      }),
    onSuccess: (res) => {
      setSelectedResponseIds([]);
      queryClient.invalidateQueries({ queryKey: ['quality'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      pushToast({ tone: 'success', title: `Approved ${res.approved_count} responses` });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Bulk approve failed', detail: err.message }),
  });

  const toggleSelect = (respId: string) => {
    setSelectedResponseIds((prev) =>
      prev.includes(respId) ? prev.filter((x) => x !== respId) : [...prev, respId]
    );
  };

  const openByType = issuesQ.data?.open_by_type || {};
  const totalOpenAll = Object.values(openByType).reduce((acc, v) => acc + v, 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Data Quality Console"
        subtitle="Inspect invalid records, duplicates, outliers, missing required values, and suspicious completion times. Raw source records remain strictly immutable."
        actions={
          selectedResponseIds.length > 0 && (
            <button
              onClick={() => bulkApproveMutation.mutate()}
              disabled={bulkApproveMutation.isPending}
              className="ops-btn-primary"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Approve Selected ({selectedResponseIds.length})
            </button>
          )
        }
      />

      {/* Issue Category Queue Tabs */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ISSUE_TABS.map((t) => {
          const cnt = t.id === 'all' ? totalOpenAll : openByType[t.id] || 0;
          const active = issueType === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                setIssueType(t.id);
                setPage(1);
              }}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                active
                  ? 'border-teal-accent bg-teal-tint text-teal-accent'
                  : 'border-hairline bg-surface text-navy-600 hover:bg-canvas'
              }`}
            >
              <span>{t.label}</span>
              <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[10.5px] text-navy-600 tabular-nums">
                {formatNumber(cnt)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="ops-surface flex flex-wrap items-center gap-2.5 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-navy-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by rule code, field key, or message..."
            className="ops-input pl-8"
          />
        </div>
        <select
          value={surveyId}
          onChange={(e) => {
            setSurveyId(e.target.value);
            setPage(1);
          }}
          className="ops-input w-56"
        >
          <option value="">All Surveys</option>
          {(surveysQ.data?.items || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} — {s.title}
            </option>
          ))}
        </select>
        <select
          value={severity}
          onChange={(e) => {
            setSeverity(e.target.value);
            setPage(1);
          }}
          className="ops-input w-36"
        >
          <option value="all">All Severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="ops-input w-36"
        >
          <option value="open">Open Queue</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
          <option value="all">All Statuses</option>
        </select>
      </div>

      {/* Queue Table */}
      {issuesQ.isLoading ? (
        <LoadingState message="Loading data quality triage queue..." />
      ) : issuesQ.isError ? (
        <ErrorState message={(issuesQ.error as Error).message} onRetry={() => issuesQ.refetch()} />
      ) : issuesQ.data!.items.length === 0 ? (
        <EmptyState
          title="No quality issues in this queue"
          description="All records matching the selected filters passed automated quality rules or have already been resolved."
        />
      ) : (
        <div className="ops-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all issues on page"
                      checked={
                        issuesQ.data!.items.length > 0 &&
                        issuesQ.data!.items.every((i) => selectedResponseIds.includes(i.response_id))
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedResponseIds(
                            Array.from(new Set(issuesQ.data!.items.map((i) => i.response_id)))
                          );
                        } else {
                          setSelectedResponseIds([]);
                        }
                      }}
                      className="accent-teal-accent"
                    />
                  </th>
                  <th className="ops-th">Severity / Status</th>
                  <th className="ops-th">Category & Rule</th>
                  <th className="ops-th">Submission / District</th>
                  <th className="ops-th">Diagnostic Finding</th>
                  <th className="ops-th text-right">Score</th>
                  <th className="ops-th">Flagged At</th>
                  <th className="ops-th text-right">Analyst Actions</th>
                </tr>
              </thead>
              <tbody>
                {issuesQ.data!.items.map((qi) => (
                  <tr key={qi.id} className="hover:bg-canvas/60">
                    <td className="ops-td">
                      <input
                        type="checkbox"
                        aria-label={`Select submission ${qi.client_submission_id}`}
                        checked={selectedResponseIds.includes(qi.response_id)}
                        onChange={() => toggleSelect(qi.response_id)}
                        className="accent-teal-accent"
                      />
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={qi.severity} />
                        <StatusBadge status={qi.status} />
                      </div>
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <div className="font-semibold text-navy">{humanizeKey(qi.issue_type)}</div>
                      <div className="font-mono text-[11px] text-navy-500">{qi.rule_code}</div>
                      {qi.question_key && (
                        <div className="font-mono text-[10.5px] text-teal-accent">{qi.question_key}</div>
                      )}
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <Link
                        to={`/responses/${qi.response_id}`}
                        className="font-mono text-[12px] font-medium text-teal-accent hover:underline"
                      >
                        {qi.client_submission_id}
                      </Link>
                      <div className="text-[11px] text-navy-500">
                        {qi.survey_code} · {qi.district}
                      </div>
                    </td>
                    <td className="ops-td max-w-md">
                      <div className="text-[12.5px] text-navy-700 leading-snug">{qi.message}</div>
                      {qi.detected_value !== null && qi.detected_value !== undefined && (
                        <div className="mt-0.5 font-mono text-[11px] text-navy-500">
                          Detected: {formatDetectedValue(qi.detected_value)}
                        </div>
                      )}
                    </td>
                    <td className="ops-td text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                      {qi.quality_score !== null && qi.quality_score !== undefined ? qi.quality_score.toFixed(1) : '—'}
                    </td>
                    <td className="ops-td text-[11.5px] text-navy-500 tabular-nums whitespace-nowrap">
                      {formatDateTime(qi.created_at)}
                    </td>
                    <td className="ops-td text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <Link
                          to={`/responses/${qi.response_id}`}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Inspect raw payload & apply tracked correction"
                        >
                          <Eye className="h-3 w-3" /> Inspect
                        </Link>
                        {qi.status === 'open' && (
                          <>
                            <button
                              type="button"
                              disabled={quickDecisionMutation.isPending}
                              onClick={() =>
                                quickDecisionMutation.mutate({ responseId: qi.response_id, decision: 'approve' })
                              }
                              className="ops-btn-secondary px-1.5 py-1 text-teal-accent hover:bg-teal-tint"
                              title="Approve record"
                              aria-label="Approve record"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={quickDecisionMutation.isPending}
                              onClick={() =>
                                quickDecisionMutation.mutate({ responseId: qi.response_id, decision: 'reject' })
                              }
                              className="ops-btn-secondary px-1.5 py-1 text-crimson-err hover:bg-crimson-tint"
                              title="Reject record"
                              aria-label="Reject record"
                            >
                              <XCircle className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar page={page} pageSize={20} total={issuesQ.data!.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
