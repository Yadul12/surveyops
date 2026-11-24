import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Database, Gauge, RefreshCw, Terminal } from 'lucide-react';
import { apiRequest } from '@/api/client';
import {
  EmptyState,
  ErrorState,
  KpiCell,
  LoadingState,
  PageHeader,
  StatusBadge,
} from '@/components/ui/Primitives';
import { formatDateTime, formatNumber } from '@/lib/format';

interface MeasuredBenchmarkRun {
  _filename: string;
  benchmark_type: string;
  measured_at: string;
  environment?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  sql_query_latencies_ms?: Record<string, number>;
  locust_summary?: {
    requests: number;
    failures: number;
    failure_rate_pct: number;
    requests_per_sec: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    duration_seconds: number;
    concurrent_users: number;
  };
  endpoints?: Array<{
    method: string;
    endpoint: string;
    requests: number;
    failures: number;
    avg_ms: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    rps: number;
  }>;
}

export function ScalabilityPage() {
  const benchQ = useQuery({
    queryKey: ['analytics', 'benchmarks'],
    queryFn: () => apiRequest<{ measured_runs: MeasuredBenchmarkRun[]; count: number }>('/analytics/benchmarks'),
  });

  if (benchQ.isLoading) return <LoadingState message="Reading measured benchmark artifacts..." />;
  if (benchQ.isError) return <ErrorState message={(benchQ.error as Error).message} onRetry={() => benchQ.refetch()} />;

  const runs = benchQ.data?.measured_runs || [];
  const scaleRun = runs.find((r) => r.benchmark_type === 'synthetic_100k_scale_benchmark');
  const locustRun = runs.find((r) => r.benchmark_type === 'locust_load_test');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Scalability & Measured Benchmarks"
        subtitle="Empirical benchmark measurements recorded directly against PostgreSQL 16, Redis 7, FastAPI, and Celery — zero extrapolated or unmeasured claims."
        actions={
          <button onClick={() => benchQ.refetch()} className="ops-btn-secondary">
            <RefreshCw className="h-3.5 w-3.5" /> Reload Artifacts
          </button>
        }
      />

      {runs.length === 0 ? (
        <EmptyState
          title="No measured benchmark runs found yet"
          description="Run scripts/generate_synthetic_data.py and loadtests/locustfile.py to generate verified JSON benchmark reports in benchmarks/."
        />
      ) : (
        <>
          {/* 100,000-Response Synthetic Scale Benchmark */}
          {scaleRun && scaleRun.metrics && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-teal-accent" />
                  <h2 className="text-[14.5px] font-semibold text-navy">
                    100,000-Response Batch Ingestion & Indexed Query Benchmark
                  </h2>
                </div>
                <StatusBadge status="completed" label={`Measured ${formatDateTime(scaleRun.measured_at)}`} />
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <KpiCell
                  label="Responses Ingested"
                  value={formatNumber(Number(scaleRun.metrics.total_responses_generated || 0))}
                  sublabel={`Batch size ${formatNumber(Number(scaleRun.config?.batch_size || 0))}`}
                  tone="teal"
                />
                <KpiCell
                  label="Batch Ingest Rate"
                  value={`${formatNumber(Math.round(Number(scaleRun.metrics.ingestion_rows_per_sec || 0)))}/s`}
                  sublabel={`Total ${scaleRun.metrics.ingestion_elapsed_sec}s`}
                />
                <KpiCell
                  label="Answers Materialized"
                  value={formatNumber(Number(scaleRun.metrics.total_answers_materialized || 0))}
                  sublabel="Indexed response_answers rows"
                />
                <KpiCell
                  label="Idempotent Replay Check"
                  value={`${scaleRun.metrics.idempotent_replay_duplicates_inserted === 0 ? 'PASS (0 dup)' : 'FAIL'}`}
                  sublabel={`${scaleRun.metrics.idempotent_replay_tested} replayed keys`}
                  tone="teal"
                />
                <KpiCell
                  label="Flagged / Rejected"
                  value={formatNumber(Number(scaleRun.metrics.quality_issues_created || 0))}
                  sublabel="Automated anomaly flags"
                />
              </div>

              {/* Measured SQL Query Latencies at 100k+ Rows */}
              {scaleRun.sql_query_latencies_ms && (
                <div className="ops-surface overflow-hidden">
                  <div className="border-b border-hairline px-4 py-2.5">
                    <h3 className="text-[13px] font-semibold text-navy">
                      Measured PostgreSQL Query Latencies on 100,000+ Rows (Indexed)
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <th className="ops-th">Query Workload</th>
                          <th className="ops-th text-right">Measured Latency (ms)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(scaleRun.sql_query_latencies_ms).map(([k, ms]) => (
                          <tr key={k}>
                            <td className="ops-td font-mono text-[12px] text-navy">{k}</td>
                            <td className="ops-td text-right font-mono font-semibold text-teal-accent tabular-nums">
                              {ms} ms
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Locust HTTP Load Test Results */}
          {locustRun && locustRun.locust_summary && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Gauge className="h-4 w-4 text-teal-accent" />
                  <h2 className="text-[14.5px] font-semibold text-navy">
                    Locust API Load Test Results (Measured)
                  </h2>
                </div>
                <StatusBadge status="completed" label={`Measured ${formatDateTime(locustRun.measured_at)}`} />
              </div>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                <KpiCell
                  label="Concurrent Users"
                  value={locustRun.locust_summary.concurrent_users}
                  sublabel={`${locustRun.locust_summary.duration_seconds}s run`}
                />
                <KpiCell
                  label="Total Requests"
                  value={formatNumber(locustRun.locust_summary.requests)}
                  sublabel={`${locustRun.locust_summary.failures} failures`}
                />
                <KpiCell
                  label="Measured Throughput"
                  value={`${locustRun.locust_summary.requests_per_sec} req/s`}
                  tone="teal"
                />
                <KpiCell label="p50 Latency" value={`${locustRun.locust_summary.p50_ms} ms`} />
                <KpiCell label="p95 Latency" value={`${locustRun.locust_summary.p95_ms} ms`} />
                <KpiCell
                  label="p99 Latency"
                  value={`${locustRun.locust_summary.p99_ms} ms`}
                  sublabel={`Error rate ${locustRun.locust_summary.failure_rate_pct}%`}
                />
              </div>

              {locustRun.endpoints && locustRun.endpoints.length > 0 && (
                <div className="ops-surface overflow-hidden">
                  <div className="border-b border-hairline px-4 py-2.5">
                    <h3 className="text-[13px] font-semibold text-navy">Measured Per-Endpoint Latency Breakdown</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr>
                          <th className="ops-th">Method</th>
                          <th className="ops-th">Endpoint</th>
                          <th className="ops-th text-right">Requests</th>
                          <th className="ops-th text-right">Failures</th>
                          <th className="ops-th text-right">p50</th>
                          <th className="ops-th text-right">p95</th>
                          <th className="ops-th text-right">p99</th>
                          <th className="ops-th text-right">Req/s</th>
                        </tr>
                      </thead>
                      <tbody>
                        {locustRun.endpoints.map((ep, idx) => (
                          <tr key={idx}>
                            <td className="ops-td font-mono text-[11.5px] font-semibold text-teal-accent">{ep.method}</td>
                            <td className="ops-td font-mono text-[12px] text-navy">{ep.endpoint}</td>
                            <td className="ops-td text-right tabular-nums">{formatNumber(ep.requests)}</td>
                            <td className="ops-td text-right tabular-nums">{ep.failures}</td>
                            <td className="ops-td text-right font-mono tabular-nums">{ep.p50_ms}ms</td>
                            <td className="ops-td text-right font-mono tabular-nums">{ep.p95_ms}ms</td>
                            <td className="ops-td text-right font-mono tabular-nums">{ep.p99_ms}ms</td>
                            <td className="ops-td text-right font-mono font-semibold tabular-nums">{ep.rps}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Environment & Reproducibility */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="ops-surface p-4">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-navy">
                <Cpu className="h-4 w-4 text-navy-500" /> Test Configuration & Environment
              </div>
              <pre className="overflow-auto rounded-sm bg-canvas p-3 font-mono text-[11.5px] text-navy-700">
                {JSON.stringify(
                  {
                    scale_config: scaleRun?.config,
                    environment: scaleRun?.environment || locustRun?.environment,
                  },
                  null,
                  2
                )}
              </pre>
            </div>
            <div className="ops-surface p-4">
              <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-navy">
                <Terminal className="h-4 w-4 text-navy-500" /> Reproducible Benchmark Commands
              </div>
              <pre className="overflow-auto rounded-sm bg-navy p-3 font-mono text-[11.5px] text-slate-100 leading-relaxed">
{`# 1. Reproducible 100,000-response synthetic ingestion & SQL benchmark
docker exec surveyops-backend python /app/scripts/generate_synthetic_data.py \\
  --count 100000 --batch-size 2000 --seed 20261124

# 2. Headless Locust load test against live FastAPI stack
docker exec surveyops-backend locust -f /app/loadtests/locustfile.py \\
  --headless -u 25 -r 5 -t 30s --host http://localhost:8000`}
              </pre>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
