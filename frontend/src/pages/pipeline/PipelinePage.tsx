import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PaginationBar,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatNumber, humanizeKey } from '@/lib/format';
import type { ProcessingJobItem } from '@/types';

export function PipelinePage() {
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState('all');
  const [jobType, setJobType] = useState('all');
  const [page, setPage] = useState(1);

  const summaryQ = useQuery({
    queryKey: ['pipeline', 'summary'],
    queryFn: () =>
      apiRequest<{
        by_stage: Record<string, number>;
        by_response_status: Record<string, number>;
        jobs_by_status: Record<string, { count: number; avg_duration_ms: number }>;
        stages_ordered: string[];
      }>('/pipeline/summary'),
    refetchInterval: 15000,
  });

  const jobsQ = useQuery({
    queryKey: ['pipeline', 'jobs', { statusFilter, jobType, page }],
    queryFn: () =>
      apiRequest<{ items: ProcessingJobItem[]; total: number; page: number; page_size: number }>('/pipeline/jobs', {
        params: { status: statusFilter, job_type: jobType, page, page_size: 20 },
      }),
    refetchInterval: 15000,
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => apiRequest(`/pipeline/jobs/${jobId}/retry`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline'] });
      pushToast({ tone: 'success', title: 'Job requeued', detail: 'Dispatched back to Celery processing workers.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Retry failed', detail: err.message }),
  });

  if (summaryQ.isLoading || jobsQ.isLoading) return <LoadingState message="Loading pipeline telemetry..." />;
  if (summaryQ.isError) return <ErrorState message={(summaryQ.error as Error).message} onRetry={() => summaryQ.refetch()} />;

  const summary = summaryQ.data!;
  const jobs = jobsQ.data!;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Response Processing Pipeline"
        subtitle="9-stage deterministic ingestion, schema validation, deduplication, normalization, quality scoring, and dataset approval monitor."
        actions={
          <button
            onClick={() => {
              summaryQ.refetch();
              jobsQ.refetch();
            }}
            className="ops-btn-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh Telemetry
          </button>
        }
      />

      {/* 9-Stage Pipeline Architecture Strip */}
      <div className="ops-surface p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-navy">Pipeline Stage Distribution (Live DB State)</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(summary.by_response_status).map(([st, cnt]) => (
              <span key={st} className="inline-flex items-center gap-1.5 text-[11.5px] text-navy-600 tabular-nums">
                <StatusBadge status={st} /> <strong>{formatNumber(cnt)}</strong>
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-9">
          {summary.stages_ordered.map((stage, idx) => {
            const count = summary.by_stage[stage] || 0;
            const highlight =
              stage === 'approved_dataset_generation'
                ? 'border-teal-border bg-teal-tint/30'
                : stage === 'analyst_review'
                ? 'border-amber-border/60 bg-amber-tint/30'
                : stage === 'rejected_record_handling'
                ? 'border-crimson-border/60 bg-crimson-tint/20'
                : 'border-hairline bg-canvas/60';
            return (
              <div key={stage} className={`rounded-sm border p-2.5 ${highlight}`}>
                <div className="font-mono text-[10px] font-semibold text-navy-400">STAGE 0{idx + 1}</div>
                <div className="mt-1 text-[11.5px] font-semibold leading-tight text-navy">
                  {humanizeKey(stage)}
                </div>
                <div className="mt-2 font-mono text-[16px] font-semibold text-navy tabular-nums">
                  {formatNumber(count)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Job Queue Table */}
      <div className="ops-surface overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-navy">Background Processing Jobs (Celery / Redis)</h2>
            <p className="text-[11.5px] text-navy-500">Execution timings, retry tracking, and stage diagnostics</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="ops-input w-36 py-1 text-[12px]"
            >
              <option value="all">All Statuses</option>
              <option value="completed">Completed</option>
              <option value="running">Running</option>
              <option value="queued">Queued</option>
              <option value="retrying">Retrying</option>
              <option value="failed">Failed</option>
            </select>
            <select
              value={jobType}
              onChange={(e) => {
                setJobType(e.target.value);
                setPage(1);
              }}
              className="ops-input w-40 py-1 text-[12px]"
            >
              <option value="all">All Job Types</option>
              <option value="single_response">Single Response</option>
              <option value="batch_ingest">Batch Ingest</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="ops-th">Job ID / Batch</th>
                <th className="ops-th">Type</th>
                <th className="ops-th">Status</th>
                <th className="ops-th">Terminal Stage</th>
                <th className="ops-th text-right">Items</th>
                <th className="ops-th text-right">Attempts</th>
                <th className="ops-th text-right">Duration</th>
                <th className="ops-th">Created</th>
                <th className="ops-th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.items.map((j) => (
                <tr key={j.id} className="hover:bg-canvas/50">
                  <td className="ops-td whitespace-nowrap">
                    <div className="font-mono text-[11.5px] font-medium text-navy">{j.id.slice(0, 12)}</div>
                    {j.batch_id && <div className="font-mono text-[10.5px] text-teal-accent">{j.batch_id}</div>}
                    {j.error_message && (
                      <div className="mt-0.5 max-w-xs truncate text-[11px] text-crimson-err">{j.error_message}</div>
                    )}
                  </td>
                  <td className="ops-td text-[12px] whitespace-nowrap">{humanizeKey(j.job_type)}</td>
                  <td className="ops-td whitespace-nowrap">
                    <StatusBadge status={j.status} />
                  </td>
                  <td className="ops-td font-mono text-[11.5px] text-navy-600 whitespace-nowrap">{j.current_stage}</td>
                  <td className="ops-td text-right tabular-nums whitespace-nowrap">
                    {formatNumber(j.processed_items)}/{formatNumber(j.total_items)}
                    {j.failed_items > 0 && <span className="ml-1 text-crimson-err">({j.failed_items} err)</span>}
                  </td>
                  <td className="ops-td text-right font-mono tabular-nums whitespace-nowrap">
                    {j.attempt_count}/{j.max_attempts}
                  </td>
                  <td className="ops-td text-right font-mono text-[12px] tabular-nums whitespace-nowrap">
                    {j.duration_ms !== null ? `${formatNumber(j.duration_ms)}ms` : '—'}
                  </td>
                  <td className="ops-td text-[12px] text-navy-500 tabular-nums whitespace-nowrap">
                    {formatDateTime(j.created_at)}
                  </td>
                  <td className="ops-td text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-1.5">
                      {j.response_id && (
                        <Link to={`/responses/${j.response_id}`} className="ops-btn-secondary px-2 py-1 text-[11.5px]">
                          Record
                        </Link>
                      )}
                      {hasRole('admin', 'analyst') && j.response_id && (
                        <button
                          onClick={() => retryMutation.mutate(j.id)}
                          disabled={retryMutation.isPending}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Re-run response pipeline"
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <PaginationBar page={page} pageSize={20} total={jobs.total} onPageChange={setPage} />
      </div>
    </div>
  );
}
