import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, Search } from 'lucide-react';
import { apiDownloadFile, apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PaginationBar,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatDuration, humanizeKey } from '@/lib/format';
import type { ResponseListItem, SurveyListItem } from '@/types';

const DISTRICTS = ['Metro Central', 'North Metro', 'East River', 'South Harbor', 'West Highlands'];

export function ResponsesListPage() {
  const { hasRole } = useAuth();
  const { pushToast } = useToast();

  const [surveyId, setSurveyId] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [district, setDistrict] = useState('all');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('submitted_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const surveysQ = useQuery({
    queryKey: ['surveys', 'dropdown'],
    queryFn: () => apiRequest<{ items: SurveyListItem[] }>('/surveys', { params: { page_size: 50 } }),
  });

  const responsesQ = useQuery({
    queryKey: ['responses', { surveyId, statusFilter, district, search, sortBy, sortDir, page }],
    queryFn: () =>
      apiRequest<{ items: ResponseListItem[]; total: number; page: number; page_size: number }>('/responses', {
        params: {
          survey_id: surveyId || undefined,
          processing_status: statusFilter,
          district,
          search: search.trim() || undefined,
          sort_by: sortBy,
          sort_dir: sortDir,
          page,
          page_size: 25,
        },
      }),
  });

  const handleExportCsv = async () => {
    const targetSurvey = surveyId || surveysQ.data?.items?.[0]?.id;
    if (!targetSurvey) return;
    try {
      await apiDownloadFile('/responses/export/csv', 'surveyops_clean_dataset.csv', {
        survey_id: targetSurvey,
        status_filter: statusFilter === 'all' ? 'approved' : statusFilter,
        district: district !== 'all' ? district : undefined,
      });
      pushToast({ tone: 'success', title: 'CSV exported', detail: 'Downloaded normalized/approved dataset.' });
    } catch (err: unknown) {
      pushToast({ tone: 'error', title: 'Export failed', detail: err instanceof Error ? err.message : 'Error' });
    }
  };

  const toggleSort = (col: string) => {
    if (sortBy === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Response Registry"
        subtitle="Inspect every collected field submission, pipeline stage, quality score, and immutable audit history."
        actions={
          hasRole('admin', 'analyst') && (
            <button onClick={handleExportCsv} className="ops-btn-secondary">
              <Download className="h-3.5 w-3.5" />
              Export Clean CSV
            </button>
          )
        }
      />

      {/* Filter Bar */}
      <div className="ops-surface flex flex-wrap items-center gap-2.5 p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-navy-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search submission ID or district..."
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
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="ops-input w-36"
        >
          <option value="all">All Statuses</option>
          <option value="approved">Approved</option>
          <option value="flagged">Flagged</option>
          <option value="rejected">Rejected</option>
          <option value="ingested">Ingested</option>
          <option value="processing">Processing</option>
        </select>
        <select
          value={district}
          onChange={(e) => {
            setDistrict(e.target.value);
            setPage(1);
          }}
          className="ops-input w-40"
        >
          <option value="all">All Districts</option>
          {DISTRICTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {responsesQ.isLoading ? (
        <LoadingState message="Querying responses..." />
      ) : responsesQ.isError ? (
        <ErrorState message={(responsesQ.error as Error).message} onRetry={() => responsesQ.refetch()} />
      ) : responsesQ.data!.items.length === 0 ? (
        <EmptyState
          title="No responses found"
          description="No collected responses match the active filter criteria."
        />
      ) : (
        <div className="ops-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">Submission ID</th>
                  <th className="ops-th">Survey</th>
                  <th onClick={() => toggleSort('district')} className="ops-th cursor-pointer hover:text-navy">
                    District {sortBy === 'district' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th className="ops-th">Enumerator / Channel</th>
                  <th onClick={() => toggleSort('processing_status')} className="ops-th cursor-pointer hover:text-navy">
                    Status
                  </th>
                  <th onClick={() => toggleSort('quality_score')} className="ops-th cursor-pointer text-right hover:text-navy">
                    Score {sortBy === 'quality_score' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th onClick={() => toggleSort('duration_seconds')} className="ops-th cursor-pointer text-right hover:text-navy">
                    Duration
                  </th>
                  <th onClick={() => toggleSort('submitted_at')} className="ops-th cursor-pointer hover:text-navy">
                    Submitted {sortBy === 'submitted_at' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </th>
                  <th className="ops-th text-right">Inspect</th>
                </tr>
              </thead>
              <tbody>
                {responsesQ.data!.items.map((r) => (
                  <tr key={r.id} className="hover:bg-canvas/60">
                    <td className="ops-td whitespace-nowrap">
                      <Link
                        to={`/responses/${r.id}`}
                        className="font-mono text-[12px] font-medium text-teal-accent hover:underline"
                      >
                        {r.client_submission_id}
                      </Link>
                      {r.is_duplicate && <span className="ml-1.5 text-[10.5px] font-semibold text-crimson-err">DUP</span>}
                    </td>
                    <td className="ops-td">
                      <div className="font-mono text-[11px] text-navy-500 whitespace-nowrap">{r.survey_code}</div>
                      <div className="max-w-[210px] truncate text-[12px] font-medium text-navy">{r.survey_title}</div>
                    </td>
                    <td className="ops-td text-[12.5px] whitespace-nowrap">{r.district}</td>
                    <td className="ops-td whitespace-nowrap">
                      <div className="text-[12.5px] text-navy">{r.agent_name}</div>
                      <div className="text-[11px] text-navy-500">{humanizeKey(r.source_channel)}</div>
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <StatusBadge status={r.processing_status} />
                      {r.open_issue_count > 0 && (
                        <div className="mt-0.5 text-[10.5px] text-amber-warn">{r.open_issue_count} open issue(s)</div>
                      )}
                    </td>
                    <td className="ops-td text-right font-mono font-semibold tabular-nums whitespace-nowrap">
                      {r.quality_score !== null ? r.quality_score.toFixed(1) : '—'}
                    </td>
                    <td className="ops-td text-right font-mono text-[12px] text-navy-600 tabular-nums whitespace-nowrap">
                      {formatDuration(r.duration_seconds)}
                    </td>
                    <td className="ops-td text-[12px] text-navy-500 tabular-nums whitespace-nowrap">
                      {formatDateTime(r.submitted_at)}
                    </td>
                    <td className="ops-td text-right whitespace-nowrap">
                      <Link to={`/responses/${r.id}`} className="ops-btn-secondary px-2 py-1 text-[11.5px]">
                        <Eye className="h-3 w-3" /> Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationBar page={page} pageSize={25} total={responsesQ.data!.total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
