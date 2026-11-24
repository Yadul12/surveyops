import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download, FileText } from 'lucide-react';
import { apiDownloadFile, apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  ErrorState,
  KpiCell,
  LoadingState,
  PageHeader,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDuration, formatNumber, humanizeKey } from '@/lib/format';
import type {
  GeoDistrictStat,
  OverviewKpis,
  QuestionDistribution,
  SurveyListItem,
  TrendPoint,
} from '@/types';

const DISTRICTS = ['Metro Central', 'North Metro', 'East River', 'South Harbor', 'West Highlands'];

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { hasRole } = useAuth();
  const { pushToast } = useToast();

  const [surveyId, setSurveyId] = useState(searchParams.get('survey') || '');
  const [district, setDistrict] = useState('all');
  const [days, setDays] = useState(30);
  const [statusScope, setStatusScope] = useState('valid');

  const surveysQ = useQuery({
    queryKey: ['surveys', 'analytics-picker'],
    queryFn: () => apiRequest<{ items: SurveyListItem[] }>('/surveys', { params: { page_size: 50 } }),
  });

  useEffect(() => {
    if (!surveyId && surveysQ.data?.items?.length) {
      const civic = surveysQ.data.items.find((s) => s.status === 'published' && s.code !== 'CIV-2026-SCALE');
      const fallback = surveysQ.data.items.find((s) => s.status === 'published') || surveysQ.data.items[0];
      if (civic || fallback) setSurveyId((civic || fallback).id);
    }
  }, [surveysQ.data, surveyId]);

  const overviewQ = useQuery({
    queryKey: ['analytics', 'overview', { surveyId, district, days }],
    queryFn: () =>
      apiRequest<{
        kpis: OverviewKpis;
        trends: TrendPoint[];
        geographic: GeoDistrictStat[];
        quality_breakdown: {
          by_type: Array<{ issue_type: string; total: number; open: number; resolved: number; dismissed: number }>;
          by_severity: Record<string, number>;
        };
      }>('/analytics/overview', {
        params: {
          survey_id: surveyId || undefined,
          district: district !== 'all' ? district : undefined,
          days,
        },
      }),
  });

  const questionsQ = useQuery({
    queryKey: ['analytics', 'questions', { surveyId, statusScope, district }],
    queryFn: () =>
      apiRequest<{ questions: QuestionDistribution[] }>(`/analytics/questions/${surveyId}`, {
        params: {
          status: statusScope,
          district: district !== 'all' ? district : undefined,
        },
      }),
    enabled: Boolean(surveyId),
  });

  const handleExportCsv = async () => {
    if (!surveyId) return;
    try {
      await apiDownloadFile('/responses/export/csv', 'surveyops_dataset.csv', {
        survey_id: surveyId,
        status_filter: statusScope,
        district: district !== 'all' ? district : undefined,
      });
      pushToast({ tone: 'success', title: 'Dataset CSV downloaded' });
    } catch (err: unknown) {
      pushToast({ tone: 'error', title: 'Export failed', detail: err instanceof Error ? err.message : 'Error' });
    }
  };

  if (overviewQ.isLoading) return <LoadingState message="Executing SQL analytical aggregations..." />;
  if (overviewQ.isError) return <ErrorState message={(overviewQ.error as Error).message} onRetry={() => overviewQ.refetch()} />;

  const { kpis, trends, geographic, quality_breakdown } = overviewQ.data!;
  const questionStats = questionsQ.data?.questions || [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics Workspace"
        subtitle="Live PostgreSQL analytical queries covering collection volume, quality trends, geographic distribution, and question-level breakdowns."
        actions={
          <>
            {hasRole('admin', 'analyst') && surveyId && (
              <>
                <button onClick={handleExportCsv} className="ops-btn-secondary">
                  <Download className="h-3.5 w-3.5" /> Export Dataset CSV
                </button>
                <Link to={`/reports?create=1&survey=${surveyId}`} className="ops-btn-primary">
                  <FileText className="h-3.5 w-3.5" /> Generate Insight Report
                </Link>
              </>
            )}
          </>
        }
      />

      {/* Filter Bar */}
      <div className="ops-surface flex flex-wrap items-center gap-2.5 p-3">
        <select
          value={surveyId}
          onChange={(e) => {
            setSurveyId(e.target.value);
            if (e.target.value) setSearchParams({ survey: e.target.value }, { replace: true });
            else setSearchParams({}, { replace: true });
          }}
          className="ops-input min-w-[260px] flex-1"
        >
          <option value="">All Published Surveys (Aggregate)</option>
          {(surveysQ.data?.items || []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.code} — {s.title}
            </option>
          ))}
        </select>
        <select value={district} onChange={(e) => setDistrict(e.target.value)} className="ops-input w-44">
          <option value="all">All Districts</option>
          {DISTRICTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ops-input w-36">
          <option value={14}>Last 14 Days</option>
          <option value={30}>Last 30 Days</option>
          <option value={90}>Last 90 Days</option>
        </select>
        <select value={statusScope} onChange={(e) => setStatusScope(e.target.value)} className="ops-input w-44">
          <option value="valid">Valid & Approved Only</option>
          <option value="approved">Approved Only</option>
          <option value="all">All Collected Records</option>
        </select>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiCell label="Total Responses" value={formatNumber(kpis.total_responses)} sublabel={`Target ${formatNumber(kpis.target_responses)}`} />
        <KpiCell label="Valid Responses" value={formatNumber(kpis.valid_responses)} sublabel={`${kpis.valid_rate}% clean rate`} tone="teal" />
        <KpiCell label="Rejected" value={formatNumber(kpis.rejected_responses)} sublabel={`${formatNumber(kpis.flagged_responses)} flagged pending`} tone={kpis.rejected_responses > 0 ? 'crimson' : 'default'} />
        <KpiCell label="Processing Backlog" value={formatNumber(kpis.processing_backlog)} sublabel={`${formatNumber(kpis.open_quality_issues)} open issues`} />
        <KpiCell label="Completion Rate" value={`${kpis.completion_rate}%`} sublabel={`Avg duration ${formatDuration(kpis.avg_duration_seconds)}`} />
        <KpiCell label="Avg Quality Score" value={`${kpis.avg_quality_score}`} sublabel={`${kpis.geo_consented_pct}% GPS consented`} tone="teal" />
      </div>

      {/* Trends Row */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* Daily Response Volume */}
        <div className="ops-surface p-4">
          <h2 className="text-[13.5px] font-semibold text-navy">Response Collection Trends</h2>
          <p className="mb-3 text-[11.5px] text-navy-500">Daily ingested volume segmented by pipeline classification</p>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trends} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="#E2E4E9" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748B' }} tickFormatter={(v) => String(v).slice(5)} />
                <YAxis tick={{ fontSize: 11, fill: '#64748B' }} />
                <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #CFD4DC', borderRadius: 4, fontSize: 12 }} />
                <Bar dataKey="valid" name="Valid / Approved" stackId="a" fill="#0F766E" />
                <Bar dataKey="flagged" name="Flagged" stackId="a" fill="#D97706" />
                <Bar dataKey="rejected" name="Rejected" stackId="a" fill="#B91C1C" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Data Quality Score & Issue Rate Trend */}
        <div className="ops-surface p-4">
          <h2 className="text-[13.5px] font-semibold text-navy">Data Quality Trends</h2>
          <p className="mb-3 text-[11.5px] text-navy-500">Daily average quality score (0–100) vs anomaly issue rate (%)</p>
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trends} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid stroke="#E2E4E9" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#64748B' }} tickFormatter={(v) => String(v).slice(5)} />
                <YAxis yAxisId="left" domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748B' }} />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} tick={{ fontSize: 11, fill: '#64748B' }} unit="%" />
                <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #CFD4DC', borderRadius: 4, fontSize: 12 }} />
                <Bar yAxisId="right" dataKey="issue_rate" name="Issue Rate %" fill="#FEF3C7" stroke="#D97706" />
                <Line yAxisId="left" type="monotone" dataKey="avg_quality_score" name="Avg Quality Score" stroke="#0F1E36" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Geographic Distribution & Quality Issue Breakdown */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <div className="ops-surface overflow-hidden xl:col-span-7">
          <div className="border-b border-hairline px-4 py-3">
            <h2 className="text-[13.5px] font-semibold text-navy">Geographic Response Distribution</h2>
            <p className="text-[11.5px] text-navy-500">District-level coverage, validation rate, quality score, and consented GPS capture</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">District / Zone</th>
                  <th className="ops-th text-right">Total</th>
                  <th className="ops-th text-right">Valid</th>
                  <th className="ops-th text-right">Flagged / Rej.</th>
                  <th className="ops-th text-right">Valid Rate</th>
                  <th className="ops-th text-right">Avg Score</th>
                  <th className="ops-th text-right">GPS Consent</th>
                </tr>
              </thead>
              <tbody>
                {geographic.map((g) => (
                  <tr key={g.district} className="hover:bg-canvas/60">
                    <td className="ops-td font-medium text-navy">{g.district}</td>
                    <td className="ops-td text-right font-semibold tabular-nums">{formatNumber(g.total)}</td>
                    <td className="ops-td text-right text-teal-accent font-medium tabular-nums">{formatNumber(g.valid)}</td>
                    <td className="ops-td text-right text-navy-600 tabular-nums">
                      {g.flagged} / {g.rejected}
                    </td>
                    <td className="ops-td text-right tabular-nums">{g.valid_rate}%</td>
                    <td className="ops-td text-right font-mono tabular-nums">{g.avg_quality_score}</td>
                    <td className="ops-td text-right tabular-nums">{g.gps_coverage_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="ops-surface p-4 xl:col-span-5">
          <h2 className="text-[13.5px] font-semibold text-navy">Quality Issues by Anomaly Category</h2>
          <p className="mb-3 text-[11.5px] text-navy-500">Cumulative pipeline-detected anomalies across selected scope</p>
          {quality_breakdown.by_type.length === 0 ? (
            <div className="py-12 text-center text-[12.5px] text-navy-500">No quality anomalies recorded.</div>
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={quality_breakdown.by_type.map((x) => ({ ...x, label: humanizeKey(x.issue_type) }))}
                  layout="vertical"
                  margin={{ top: 4, right: 16, left: 20, bottom: 0 }}
                >
                  <CartesianGrid stroke="#E2E4E9" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#64748B' }} />
                  <YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 11, fill: '#0F1E36' }} />
                  <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #CFD4DC', borderRadius: 4, fontSize: 12 }} />
                  <Bar dataKey="open" name="Open" stackId="q" fill="#D97706" />
                  <Bar dataKey="resolved" name="Resolved" stackId="q" fill="#0F766E" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Question-Wise Distributions */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14.5px] font-semibold text-navy">Question-Wise Response Distributions</h2>
            <p className="text-[12px] text-navy-500">
              {surveyId
                ? `Computed directly from SQL response_answers (${statusScope} scope)`
                : 'Select a specific survey above to inspect question-level distributions.'}
            </p>
          </div>
        </div>

        {surveyId && questionsQ.isLoading && (
          <LoadingState message="Computing question-level SQL distributions..." />
        )}

        {surveyId && !questionsQ.isLoading && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {questionStats.map((q) => (
              <div key={q.question_id} className="ops-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-mono font-semibold text-teal-accent">{q.question_key}</span>
                      <StatusBadge status="draft" label={humanizeKey(q.question_type)} />
                      <span className="text-navy-500">{q.section_title}</span>
                    </div>
                    <h3 className="mt-1 text-[13px] font-semibold text-navy leading-snug">{q.prompt}</h3>
                  </div>
                  <div className="shrink-0 text-right font-mono text-[11px] text-navy-500 tabular-nums">
                    <div>n={q.answered_count}</div>
                    <div>{q.response_rate}% ans</div>
                  </div>
                </div>

                {q.numeric_stats && (
                  <div className="mt-2.5 flex gap-4 rounded-sm bg-canvas px-3 py-1.5 font-mono text-[11.5px] text-navy-700 tabular-nums">
                    <span>Mean: <strong>{q.numeric_stats.mean}</strong></span>
                    <span>Min: <strong>{q.numeric_stats.min}</strong></span>
                    <span>Max: <strong>{q.numeric_stats.max}</strong></span>
                    {q.outlier_count > 0 && <span className="text-amber-warn">Outliers: {q.outlier_count}</span>}
                  </div>
                )}

                <div className="mt-3 space-y-1.5">
                  {q.distribution.length === 0 ? (
                    <div className="py-4 text-center text-[12px] text-navy-400">No responses recorded for this question yet.</div>
                  ) : (
                    q.distribution.slice(0, 7).map((row) => (
                      <div key={row.key} className="text-[12px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-navy-700">{row.label}</span>
                          <span className="shrink-0 font-mono text-[11.5px] text-navy tabular-nums">
                            {row.count} <span className="text-navy-500">({row.pct}%)</span>
                          </span>
                        </div>
                        <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-recessed">
                          <div className="h-full bg-teal-accent" style={{ width: `${Math.min(100, row.pct)}%` }} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
