import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, FileText, Plus, Trash2 } from 'lucide-react';
import { apiDownloadFile, apiRequest } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import {
  ConfirmModal,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  StatusBadge,
  useToast,
} from '@/components/ui/Primitives';
import { formatDateTime, formatNumber, humanizeKey } from '@/lib/format';
import type { InsightReport, SurveyListItem } from '@/types';

const DISTRICTS = ['Metro Central', 'North Metro', 'East River', 'South Harbor', 'West Highlands'];

export function ReportsPage() {
  const { hasRole } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDeleteReport, setConfirmDeleteReport] = useState<InsightReport | null>(null);
  const [form, setForm] = useState({
    survey_id: '',
    title: '',
    report_type: 'full_insight',
    district: '',
    status_filter: 'valid',
    analyst_notes: '',
  });

  const surveysQ = useQuery({
    queryKey: ['surveys', 'reports-picker'],
    queryFn: () => apiRequest<{ items: SurveyListItem[] }>('/surveys', { params: { page_size: 50 } }),
  });

  const reportsQ = useQuery({
    queryKey: ['reports'],
    queryFn: () => apiRequest<{ items: InsightReport[]; total: number }>('/reports'),
  });

  useEffect(() => {
    if (surveysQ.data?.items?.length && !form.survey_id) {
      const fromUrl = searchParams.get('survey');
      const found = fromUrl
        ? surveysQ.data.items.find((s) => s.id === fromUrl)
        : surveysQ.data.items.find((s) => s.status === 'published') || surveysQ.data.items[0];
      if (found) {
        setForm((prev) => ({
          ...prev,
          survey_id: found.id,
          title: `${found.title} — Analytical Insight Report`,
        }));
      }
    }
    if (searchParams.get('create') === '1' && hasRole('admin', 'analyst')) {
      setCreateOpen(true);
      setSearchParams({}, { replace: true });
    }
  }, [surveysQ.data, form.survey_id, searchParams, hasRole, setSearchParams]);

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<InsightReport>('/reports', {
        method: 'POST',
        body: {
          ...form,
          district: form.district || null,
        },
      }),
    onSuccess: (rep) => {
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      setCreateOpen(false);
      pushToast({ tone: 'success', title: 'Insight report generated', detail: 'Snapshot computed from verified dataset.' });
      navigate(`/reports/${rep.id}`);
    },
    onError: (err: Error) => pushToast({ tone: 'error', title: 'Report generation failed', detail: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest(`/reports/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDeleteReport(null);
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      pushToast({ tone: 'info', title: 'Report deleted' });
    },
  });

  const downloadExport = async (reportId: string, format: 'pdf' | 'csv') => {
    try {
      await apiDownloadFile(`/reports/${reportId}/export/${format}`, `surveyops_report.${format}`);
      pushToast({ tone: 'success', title: `${format.toUpperCase()} downloaded` });
    } catch (err: unknown) {
      pushToast({ tone: 'error', title: 'Download failed', detail: err instanceof Error ? err.message : 'Error' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Insight Reports"
        subtitle="Generate reproducible analytical briefings from verified survey datasets with analyst commentary and CSV/PDF export."
        actions={
          hasRole('admin', 'analyst') && (
            <button onClick={() => setCreateOpen(true)} className="ops-btn-primary">
              <Plus className="h-3.5 w-3.5" /> New Insight Report
            </button>
          )
        }
      />

      {reportsQ.isLoading ? (
        <LoadingState message="Loading insight reports..." />
      ) : reportsQ.isError ? (
        <ErrorState message={(reportsQ.error as Error).message} onRetry={() => reportsQ.refetch()} />
      ) : reportsQ.data!.items.length === 0 ? (
        <EmptyState
          title="No insight reports generated yet"
          description="Create a report to snapshot verified response statistics, question insights, data quality metrics, and analyst commentary."
        />
      ) : (
        <div className="ops-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="ops-th">Report Title</th>
                  <th className="ops-th">Survey</th>
                  <th className="ops-th">Type</th>
                  <th className="ops-th text-right">Valid / Total</th>
                  <th className="ops-th text-right">Score</th>
                  <th className="ops-th">Author</th>
                  <th className="ops-th">Generated</th>
                  <th className="ops-th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {reportsQ.data!.items.map((rep) => (
                  <tr key={rep.id} className="hover:bg-canvas/60">
                    <td className="ops-td max-w-[240px]">
                      <Link
                        to={`/reports/${rep.id}`}
                        className="block truncate font-semibold text-navy hover:text-teal-accent hover:underline"
                        title={rep.title}
                      >
                        {rep.title}
                      </Link>
                      {rep.analyst_notes && (
                        <div className="mt-0.5 truncate text-[11.5px] text-navy-500">{rep.analyst_notes}</div>
                      )}
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <div className="font-mono text-[11.5px] text-teal-accent">{rep.survey_code}</div>
                      <div className="text-[11px] text-navy-500">{rep.survey_category}</div>
                    </td>
                    <td className="ops-td whitespace-nowrap">
                      <StatusBadge status="active" label={humanizeKey(rep.report_type)} />
                    </td>
                    <td className="ops-td text-right font-mono tabular-nums whitespace-nowrap">
                      <strong>{formatNumber(rep.summary_stats?.valid_responses)}</strong> /{' '}
                      {formatNumber(rep.summary_stats?.total_responses)}
                    </td>
                    <td className="ops-td text-right font-mono tabular-nums whitespace-nowrap">
                      {rep.summary_stats?.avg_quality_score ?? '—'}
                    </td>
                    <td className="ops-td text-[12px] text-navy-700 whitespace-nowrap">{rep.created_by_name}</td>
                    <td className="ops-td text-[12px] text-navy-500 tabular-nums whitespace-nowrap">
                      {formatDateTime(rep.created_at)}
                    </td>
                    <td className="ops-td text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <Link to={`/reports/${rep.id}`} className="ops-btn-secondary px-2 py-1 text-[11.5px]">
                          <FileText className="h-3 w-3" /> Open
                        </Link>
                        <button
                          type="button"
                          onClick={() => downloadExport(rep.id, 'pdf')}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Download PDF Report"
                        >
                          <Download className="h-3 w-3" /> PDF
                        </button>
                        <button
                          type="button"
                          onClick={() => downloadExport(rep.id, 'csv')}
                          className="ops-btn-secondary px-2 py-1 text-[11.5px]"
                          title="Download CSV Summary"
                        >
                          <FileSpreadsheet className="h-3 w-3" /> CSV
                        </button>
                        {hasRole('admin', 'analyst') && (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteReport(rep)}
                            className="p-1 text-navy-400 hover:text-crimson-err"
                            aria-label={`Delete report ${rep.title}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={createOpen}
        title="Generate Insight Report"
        subtitle="Computes a live statistical snapshot directly from the database and persists an exportable report."
        onClose={() => setCreateOpen(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
          className="space-y-3.5"
        >
          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Target Survey *</label>
            <select
              required
              value={form.survey_id}
              onChange={(e) => {
                const s = surveysQ.data?.items.find((x) => x.id === e.target.value);
                setForm({
                  ...form,
                  survey_id: e.target.value,
                  title: s ? `${s.title} — Analytical Insight Report` : form.title,
                });
              }}
              className="ops-input"
            >
              {(surveysQ.data?.items || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Report Title *</label>
            <input
              required
              minLength={3}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="ops-input"
            />
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Report Type</label>
              <select
                value={form.report_type}
                onChange={(e) => setForm({ ...form, report_type: e.target.value })}
                className="ops-input"
              >
                <option value="full_insight">Full Insight</option>
                <option value="executive_summary">Executive Summary</option>
                <option value="data_quality_audit">Data Quality Audit</option>
                <option value="field_operations">Field Operations</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">Dataset Scope</label>
              <select
                value={form.status_filter}
                onChange={(e) => setForm({ ...form, status_filter: e.target.value })}
                className="ops-input"
              >
                <option value="valid">Valid & Approved</option>
                <option value="approved">Approved Only</option>
                <option value="all">All Records</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[12px] font-medium text-navy-700">District Filter</label>
              <select
                value={form.district}
                onChange={(e) => setForm({ ...form, district: e.target.value })}
                className="ops-input"
              >
                <option value="">All Districts</option>
                {DISTRICTS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[12px] font-medium text-navy-700">Analyst Commentary & Key Findings</label>
            <textarea
              rows={4}
              value={form.analyst_notes}
              onChange={(e) => setForm({ ...form, analyst_notes: e.target.value })}
              placeholder="Summarize key civic findings, data quality caveats, and policy recommendations..."
              className="ops-input"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-hairline pt-3">
            <button type="button" onClick={() => setCreateOpen(false)} className="ops-btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={createMutation.isPending} className="ops-btn-primary">
              {createMutation.isPending ? 'Computing Snapshot...' : 'Generate Report'}
            </button>
          </div>
        </form>
      </Modal>
      <ConfirmModal
        open={Boolean(confirmDeleteReport)}
        title="Delete Insight Report?"
        message={`Permanently delete "${confirmDeleteReport?.title}"? Underlying survey responses are not affected.`}
        confirmLabel="Delete Report"
        isPending={deleteMutation.isPending}
        onConfirm={() => confirmDeleteReport && deleteMutation.mutate(confirmDeleteReport.id)}
        onCancel={() => setConfirmDeleteReport(null)}
      />
    </div>
  );
}
