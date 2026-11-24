import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Plus,
  Radio,
  ShieldAlert,
  Smartphone,
  Workflow,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useLiveEventsContext } from '@/hooks/useLiveEvents';
import {
  ErrorState,
  KpiCell,
  LoadingState,
  PageHeader,
  StatusBadge,
} from '@/components/ui/Primitives';
import { formatNumber, formatRelativeTime, humanizeKey } from '@/lib/format';
import type { OverviewKpis, QualityIssueItem, SurveyListItem, TrendPoint } from '@/types';

export function DashboardPage() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const { connected, events } = useLiveEventsContext();
  const [includeBenchmark, setIncludeBenchmark] = useState(false);

  const overviewQ = useQuery({
    queryKey: ['analytics', 'overview', 'dashboard', { includeBenchmark }],
    queryFn: () =>
      apiRequest<{ kpis: OverviewKpis; trends: TrendPoint[] }>('/analytics/overview', {
        params: { days: 21, exclude_benchmark: !includeBenchmark },
      }),
  });

  const surveysQ = useQuery({
    queryKey: ['surveys', 'dashboard'],
    queryFn: () =>
      apiRequest<{ items: SurveyListItem[]; total: number }>('/surveys', {
        params: { page: 1, page_size: 8, exclude_archived: true, sort_by: 'updated_at', sort_dir: 'desc' },
      }),
  });

  const issuesQ = useQuery({
    queryKey: ['quality', 'dashboard-open'],
    queryFn: () =>
      apiRequest<{ items: QualityIssueItem[]; total: number }>('/quality/issues', {
        params: { status: 'open', page: 1, page_size: 6 },
      }),
    enabled: hasRole('admin', 'analyst'),
  });

  if (overviewQ.isLoading || surveysQ.isLoading) {
    return <LoadingState message="Loading live operations command center..." />;
  }

  if (overviewQ.isError) {
    return (
      <ErrorState
        message={(overviewQ.error as Error).message}
        onRetry={() => overviewQ.refetch()}
      />
    );
  }

  const kpis = overviewQ.data!.kpis;
  const trends = overviewQ.data!.trends;
  const allSurveys = surveysQ.data?.items || [];
  const surveys = includeBenchmark
    ? allSurveys
    : allSurveys.filter((s) => s.code !== 'CIV-2026-SCALE');
  const openIssues = issuesQ.data?.items || [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operations Command Center"
        subtitle="Real-time field collection telemetry, ingestion pipeline throughput, and quality triage queues."
        actions={
          <>
            <div
              className="inline-flex rounded-sm border border-hairlineStrong bg-surface p-0.5 text-[11.5px]"
              role="group"
              aria-label="Dataset scope"
            >
              <button
                type="button"
                onClick={() => setIncludeBenchmark(false)}
                className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                  !includeBenchmark ? 'bg-navy text-white' : 'text-navy-600 hover:text-navy'
                }`}
              >
                Civic Operations
              </button>
              <button
                type="button"
                onClick={() => setIncludeBenchmark(true)}
                className={`rounded-sm px-2.5 py-1 font-medium transition-colors ${
                  includeBenchmark ? 'bg-navy text-white' : 'text-navy-600 hover:text-navy'
                }`}
              >
                Incl. 100k Benchmark
              </button>
            </div>
            <Link to="/field" className="ops-btn-secondary whitespace-nowrap">
              <Smartphone className="h-3.5 w-3.5" />
              Field Mobile App
            </Link>
            {hasRole('admin') && (
              <Link to="/surveys?create=1" className="ops-btn-primary whitespace-nowrap">
                <Plus className="h-3.5 w-3.5" />
                New Survey
              </Link>
            )}
          </>
        }
      />

      {/* KPI Strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCell
          label="Total Responses"
          value={formatNumber(kpis.total_responses)}
          sublabel={`${kpis.active_surveys} published surveys`}
        />
        <KpiCell
          label="Valid & Approved"
          value={formatNumber(kpis.valid_responses)}
          sublabel={`${kpis.valid_rate}% validation rate`}
          tone="teal"
        />
        <KpiCell
          label="Flagged Review"
          value={formatNumber(kpis.flagged_responses)}
          sublabel={`${formatNumber(kpis.open_quality_issues)} open issues`}
          tone={kpis.flagged_responses > 0 ? 'amber' : 'default'}
        />
        <KpiCell
          label="Rejected Records"
          value={formatNumber(kpis.rejected_responses)}
          sublabel={`${formatNumber(kpis.duplicate_responses)} duplicates caught`}
          tone={kpis.rejected_responses > 0 ? 'crimson' : 'default'}
        />
        <KpiCell
          label="Processing Backlog"
          value={formatNumber(kpis.processing_backlog)}
          sublabel={`Avg score ${kpis.avg_quality_score}/100`}
        />
        <KpiCell
          label="Target Attainment"
          value={`${kpis.completion_rate}%`}
          sublabel={`${kpis.active_agents} active field agents`}
        />
      </div>

      {/* Main Two-Column Operational Split */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Collection Trend Chart */}
        <div className="ops-surface p-4 xl:col-span-8">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 className="text-[13.5px] font-semibold text-navy">Response Ingestion & Approval Trend (21 Days)</h2>
              <p className="text-[11.5px] text-navy-500">
                Daily database totals ({includeBenchmark ? 'all datasets incl. 100k benchmark' : 'active civic field surveys'}) split by pipeline status
              </p>
            </div>
            <Link
              to="/analytics"
              className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-teal-accent hover:underline"
            >
              Full Analytics <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="h-[230px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trends} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="#E2E4E9" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#64748B' }}
                  tickFormatter={(v) => String(v).slice(5)}
                  axisLine={{ stroke: '#E2E4E9' }}
                  tickLine={false}
                />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    border: '1px solid #CFD4DC',
                    borderRadius: '4px',
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="valid"
                  name="Valid / Approved"
                  stackId="1"
                  stroke="#0F766E"
                  fill="#0F766E"
                  fillOpacity={0.14}
                  strokeWidth={1.75}
                />
                <Area
                  type="monotone"
                  dataKey="flagged"
                  name="Flagged"
                  stackId="1"
                  stroke="#B45309"
                  fill="#F59E0B"
                  fillOpacity={0.2}
                  strokeWidth={1.5}
                />
                <Area
                  type="monotone"
                  dataKey="rejected"
                  name="Rejected"
                  stackId="1"
                  stroke="#B91C1C"
                  fill="#FEE2E2"
                  fillOpacity={0.5}
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Live Ingestion Stream */}
        <div className="ops-surface flex flex-col xl:col-span-4">
          <div className="flex items-center justify-between border-b border-hairline px-4 py-2.5">
            <div className="flex items-center gap-2">
              <Radio className={`h-3.5 w-3.5 ${connected ? 'text-teal-accent' : 'text-amber-warn'}`} />
              <h2 className="text-[13px] font-semibold text-navy">Live Pipeline Feed</h2>
            </div>
            <Link to="/pipeline" className="text-[11.5px] font-medium text-teal-accent hover:underline">
              Jobs Queue
            </Link>
          </div>
          <div className="max-h-[250px] flex-1 divide-y divide-hairline overflow-y-auto">
            {events.length === 0 ? (
              <div className="px-4 py-10 text-center text-[12px] text-navy-500">
                Listening on SSE stream for real-time field submissions and pipeline stage transitions.
              </div>
            ) : (
              events.slice(0, 12).map((evt, idx) => (
                <div key={`${evt.timestamp}-${idx}`} className="px-3.5 py-2 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] font-medium text-navy">{evt.event_type}</span>
                    <span className="text-[10.5px] text-navy-400 tabular-nums whitespace-nowrap">
                      {formatRelativeTime(evt.timestamp)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-navy-500">
                    <span className="truncate">
                      {String(evt.payload.district || evt.payload.code || evt.payload.batch_job_id || 'Pipeline event')}
                    </span>
                    {Boolean(evt.payload.processing_status) && (
                      <StatusBadge status={String(evt.payload.processing_status)} />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Active Survey Portfolio Table */}
      <div className="ops-surface overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
          <div>
            <h2 className="text-[13.5px] font-semibold text-navy">Active Survey Collection Portfolio</h2>
            <p className="text-[11.5px] text-navy-500">Live progress, active enumerators, and pipeline quality benchmarks per instrument</p>
          </div>
          <Link to="/surveys" className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-teal-accent hover:underline">
            Manage all surveys <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="ops-th">Code</th>
                <th className="ops-th">Survey Title</th>
                <th className="ops-th">Status</th>
                <th className="ops-th">Ver.</th>
                <th className="ops-th text-right">Collected / Target</th>
                <th className="ops-th text-right">Valid Rate</th>
                <th className="ops-th text-right">Avg Quality</th>
                <th className="ops-th text-right">Agents</th>
                <th className="ops-th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {surveys.map((s) => {
                const pct = Math.min(100, Math.round((s.response_stats.total / Math.max(1, s.target_responses)) * 100));
                return (
                  <tr key={s.id} className="hover:bg-canvas/60">
                    <td className="ops-td font-mono text-[12px] text-teal-accent whitespace-nowrap">{s.code}</td>
                    <td className="ops-td min-w-[240px]">
                      <button
                        type="button"
                        onClick={() => navigate(`/surveys/${s.id}/builder`)}
                        className="text-left font-medium text-navy hover:text-teal-accent hover:underline"
                      >
                        {s.title}
                      </button>
                      <div className="text-[11px] text-navy-500">{s.category} · {s.question_count} questions</div>
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="ops-td font-mono text-[12px] tabular-nums whitespace-nowrap">v{s.active_version_number}</td>
                    <td className="ops-td text-right tabular-nums whitespace-nowrap">
                      <div className="font-medium">
                        {formatNumber(s.response_stats.total)} / {formatNumber(s.target_responses)}
                      </div>
                      <div className="mt-1 ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-recessed">
                        <div className="h-full bg-teal-accent" style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td className="ops-td text-right font-medium tabular-nums whitespace-nowrap">
                      {s.response_stats.total > 0 ? `${s.response_stats.valid_rate}%` : '—'}
                    </td>
                    <td className="ops-td text-right tabular-nums whitespace-nowrap">
                      {s.response_stats.total > 0 ? `${s.response_stats.avg_quality_score}` : '—'}
                    </td>
                    <td className="ops-td text-right tabular-nums whitespace-nowrap">{s.active_assignments}</td>
                    <td className="ops-td text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2.5 text-[12px]">
                        <Link to={`/surveys/${s.id}/builder`} className="font-medium text-navy-600 hover:text-teal-accent">
                          Builder
                        </Link>
                        <Link to={`/analytics?survey=${s.id}`} className="font-medium text-teal-accent hover:underline">
                          Analytics
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Quality Escalation Queue (Admins & Analysts) */}
      {hasRole('admin', 'analyst') && (
        <div className="ops-surface overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-hairline px-4 py-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-warn" />
              <div>
                <h2 className="text-[13.5px] font-semibold text-navy">Open Quality Triage Queue</h2>
                <p className="text-[11.5px] text-navy-500">Latest flagged anomalies requiring analyst verification or override</p>
              </div>
            </div>
            <Link to="/quality" className="inline-flex shrink-0 items-center gap-1 text-[12px] font-medium text-teal-accent hover:underline">
              Open Quality Console <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {openIssues.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-navy-500">
              Zero open data quality issues. All collected responses are clean.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className="ops-th">Severity</th>
                    <th className="ops-th">Issue Type</th>
                    <th className="ops-th">Survey / Submission</th>
                    <th className="ops-th">Diagnostic Finding</th>
                    <th className="ops-th text-right">Score</th>
                    <th className="ops-th text-right">Inspect</th>
                  </tr>
                </thead>
                <tbody>
                  {openIssues.map((qi) => (
                    <tr key={qi.id} className="hover:bg-canvas/60">
                      <td className="ops-td whitespace-nowrap">
                        <StatusBadge status={qi.severity} />
                      </td>
                      <td className="ops-td font-medium whitespace-nowrap">{humanizeKey(qi.issue_type)}</td>
                      <td className="ops-td whitespace-nowrap">
                        <div className="font-mono text-[11.5px] text-navy">{qi.client_submission_id}</div>
                        <div className="text-[11px] text-navy-500">{qi.survey_code} · {qi.district}</div>
                      </td>
                      <td className="ops-td max-w-md text-[12.5px] text-navy-700">{qi.message}</td>
                      <td className="ops-td text-right font-mono tabular-nums whitespace-nowrap">{qi.quality_score ?? '—'}</td>
                      <td className="ops-td text-right whitespace-nowrap">
                        <Link
                          to={`/responses/${qi.response_id}`}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                        >
                          <Workflow className="h-3 w-3" />
                          Review
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
