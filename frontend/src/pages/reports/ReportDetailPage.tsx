import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, FileSpreadsheet, Save } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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
import { formatDateTime, formatDuration, formatNumber, humanizeKey } from '@/lib/format';
import type { InsightReport } from '@/types';

export function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);

  const reportQ = useQuery({
    queryKey: ['reports', id],
    queryFn: () => apiRequest<InsightReport>(`/reports/${id}`),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (reportQ.data) {
      setNotes(reportQ.data.analyst_notes || '');
      setDirty(false);
    }
  }, [reportQ.data]);

  const saveNotesMutation = useMutation({
    mutationFn: () => apiRequest(`/reports/${id}`, { method: 'PATCH', body: { analyst_notes: notes } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reports', id] });
      setDirty(false);
      pushToast({ tone: 'success', title: 'Analyst notes saved', detail: 'Updated commentary will appear in PDF exports.' });
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Save failed', detail: err.message }),
  });

  const exportFile = async (fmt: 'pdf' | 'csv') => {
    try {
      await apiDownloadFile(`/reports/${id}/export/${fmt}`, `surveyops_report.${fmt}`);
      pushToast({ tone: 'success', title: `Exported ${fmt.toUpperCase()} report` });
    } catch (err: unknown) {
      pushToast({ tone: 'error', title: 'Export failed', detail: err instanceof Error ? err.message : 'Error' });
    }
  };

  if (reportQ.isLoading) return <LoadingState message="Loading insight report..." />;
  if (reportQ.isError || !reportQ.data) {
    return <ErrorState message={(reportQ.error as Error)?.message || 'Not found'} onRetry={() => reportQ.refetch()} />;
  }

  const rep = reportQ.data;
  const stats = rep.summary_stats;

  return (
    <div className="space-y-5">
      <div className="text-[12px] text-navy-500">
        <Link to="/reports" className="inline-flex items-center gap-1 hover:text-navy">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Insight Reports
        </Link>
      </div>

      <PageHeader
        title={rep.title}
        subtitle={`${rep.survey_code} — ${rep.survey_title} · Prepared by ${rep.created_by_name} on ${formatDateTime(rep.created_at)}`}
        actions={
          <>
            <StatusBadge status="published" label={humanizeKey(rep.report_type)} />
            <button onClick={() => exportFile('csv')} className="ops-btn-secondary">
              <FileSpreadsheet className="h-3.5 w-3.5" /> Export CSV
            </button>
            <button onClick={() => exportFile('pdf')} className="ops-btn-primary">
              <Download className="h-3.5 w-3.5" /> Export PDF Report
            </button>
          </>
        }
      />

      {/* Executive KPI Summary */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiCell label="Total Collected" value={formatNumber(stats.total_responses)} />
        <KpiCell label="Valid & Approved" value={formatNumber(stats.valid_responses)} sublabel={`${stats.valid_rate}% rate`} tone="teal" />
        <KpiCell label="Flagged" value={formatNumber(stats.flagged_responses)} tone={stats.flagged_responses > 0 ? 'amber' : 'default'} />
        <KpiCell label="Rejected" value={formatNumber(stats.rejected_responses)} tone={stats.rejected_responses > 0 ? 'crimson' : 'default'} />
        <KpiCell label="Avg Quality Score" value={`${stats.avg_quality_score}/100`} />
        <KpiCell label="Avg Duration" value={formatDuration(stats.avg_duration_seconds)} sublabel={`${stats.completion_rate}% of target`} />
      </div>

      {/* Analyst Notes */}
      <div className="ops-surface p-4">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h2 className="text-[13.5px] font-semibold text-navy">Analyst Findings & Executive Commentary</h2>
            <p className="text-[11.5px] text-navy-500">Included verbatim in exported PDF briefing documents</p>
          </div>
          {hasRole('admin', 'analyst') && (
            <button
              onClick={() => saveNotesMutation.mutate()}
              disabled={!dirty || saveNotesMutation.isPending}
              className="ops-btn-secondary text-[12px]"
            >
              <Save className="h-3.5 w-3.5" /> {saveNotesMutation.isPending ? 'Saving...' : 'Save Notes'}
            </button>
          )}
        </div>
        <textarea
          rows={4}
          disabled={!hasRole('admin', 'analyst')}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setDirty(true);
          }}
          className="ops-input leading-relaxed"
        />
      </div>

      {/* Geographic & Quality Summary */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="ops-surface overflow-hidden">
          <div className="border-b border-hairline px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-navy">Geographic Distribution Snapshot</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">District</th>
                  <th className="ops-th text-right">Total</th>
                  <th className="ops-th text-right">Valid</th>
                  <th className="ops-th text-right">Valid %</th>
                  <th className="ops-th text-right">Avg Score</th>
                </tr>
              </thead>
              <tbody>
                {(rep.geo_summary || []).map((g) => (
                  <tr key={g.district}>
                    <td className="ops-td font-medium">{g.district}</td>
                    <td className="ops-td text-right tabular-nums">{g.total}</td>
                    <td className="ops-td text-right text-teal-accent tabular-nums">{g.valid}</td>
                    <td className="ops-td text-right tabular-nums">{g.valid_rate}%</td>
                    <td className="ops-td text-right font-mono tabular-nums">{g.avg_quality_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="ops-surface overflow-hidden">
          <div className="border-b border-hairline px-4 py-2.5">
            <h2 className="text-[13px] font-semibold text-navy">Data Quality Audit Summary</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">Issue Category</th>
                  <th className="ops-th text-right">Total</th>
                  <th className="ops-th text-right">Open</th>
                  <th className="ops-th text-right">Resolved</th>
                  <th className="ops-th text-right">Dismissed</th>
                </tr>
              </thead>
              <tbody>
                {(rep.quality_summary?.by_type || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="ops-td text-center text-navy-500">
                      Zero quality anomalies in report scope.
                    </td>
                  </tr>
                ) : (
                  (rep.quality_summary?.by_type || []).map((item) => (
                    <tr key={item.issue_type}>
                      <td className="ops-td font-medium">{humanizeKey(item.issue_type)}</td>
                      <td className="ops-td text-right tabular-nums">{item.total}</td>
                      <td className="ops-td text-right text-amber-warn tabular-nums">{item.open}</td>
                      <td className="ops-td text-right text-teal-accent tabular-nums">{item.resolved}</td>
                      <td className="ops-td text-right text-navy-500 tabular-nums">{item.dismissed}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Question-Level Charts & Findings */}
      <div className="space-y-3">
        <h2 className="text-[14.5px] font-semibold text-navy">Question-Level Insights</h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(rep.question_insights || []).map((q) => (
            <div key={q.question_id} className="ops-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-mono text-[11px] font-semibold text-teal-accent">{q.question_key}</span>
                  <h3 className="mt-0.5 text-[13px] font-semibold text-navy">{q.prompt}</h3>
                </div>
                <span className="font-mono text-[11px] text-navy-500 tabular-nums">n={q.answered_count}</span>
              </div>
              {q.numeric_stats && (
                <div className="mt-2 flex gap-4 font-mono text-[11.5px] text-navy-600 tabular-nums">
                  <span>Mean: <strong>{q.numeric_stats.mean}</strong></span>
                  <span>Min: <strong>{q.numeric_stats.min}</strong></span>
                  <span>Max: <strong>{q.numeric_stats.max}</strong></span>
                </div>
              )}
              {q.distribution.length > 0 && (
                <div className="mt-3 h-[170px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={q.distribution.slice(0, 6)}
                      layout="vertical"
                      margin={{ top: 2, right: 20, left: 10, bottom: 0 }}
                    >
                      <CartesianGrid stroke="#E2E4E9" strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 10.5, fill: '#64748B' }} />
                      <YAxis type="category" dataKey="label" width={135} tick={{ fontSize: 10.5, fill: '#0F1E36' }} />
                      <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #CFD4DC', borderRadius: 4, fontSize: 12 }} />
                      <Bar dataKey="count" name="Responses" fill="#0F766E" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
