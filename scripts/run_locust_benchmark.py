"""
Executes Locust headlessly against the live SurveyOps API and writes
the verified, empirical load test metrics to benchmarks/locust_measured.json.
"""
import argparse
import csv
import json
import os
import platform
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def run_locust_benchmark(host: str, users: int, spawn_rate: int, duration_sec: int, output_path: Path) -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        csv_prefix = Path(tmpdir) / "locust"
        cmd = [
            "locust",
            "-f",
            "/app/loadtests/locustfile.py",
            "--headless",
            "-u",
            str(users),
            "-r",
            str(spawn_rate),
            "-t",
            f"{duration_sec}s",
            "--host",
            host,
            "--csv",
            str(csv_prefix),
            "--only-summary",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        stats_csv = Path(f"{csv_prefix}_stats.csv")
        if not stats_csv.exists():
            print("Locust stdout:", proc.stdout)
            print("Locust stderr:", proc.stderr)
            raise RuntimeError(f"Locust failed to produce stats CSV (exit {proc.returncode})")

        endpoints = []
        agg = None
        with stats_csv.open("r", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                if row["Name"] == "Aggregated":
                    agg = row
                else:
                    endpoints.append({
                        "method": row["Type"],
                        "endpoint": row["Name"],
                        "requests": int(row["Request Count"]),
                        "failures": int(row["Failure Count"]),
                        "avg_ms": round(float(row["Average Response Time"]), 1),
                        "p50_ms": round(float(row["50%"]), 1),
                        "p95_ms": round(float(row["95%"]), 1),
                        "p99_ms": round(float(row["99%"]), 1),
                        "rps": round(float(row["Requests/s"]), 2),
                    })

        if not agg:
            raise RuntimeError("Aggregated stats row missing from Locust CSV")

        total_req = int(agg["Request Count"])
        total_fail = int(agg["Failure Count"])

        result = {
            "benchmark_type": "locust_load_test",
            "measured_at": datetime.now(timezone.utc).isoformat(),
            "environment": {
                "python_version": platform.python_version(),
                "platform": platform.platform(),
                "cpu_count": os.cpu_count(),
                "target_host": host,
            },
            "config": {
                "concurrent_users": users,
                "spawn_rate_per_sec": spawn_rate,
                "duration_seconds": duration_sec,
            },
            "locust_summary": {
                "concurrent_users": users,
                "duration_seconds": duration_sec,
                "requests": total_req,
                "failures": total_fail,
                "failure_rate_pct": round((total_fail / max(1, total_req)) * 100, 2),
                "requests_per_sec": round(float(agg["Requests/s"]), 2),
                "avg_ms": round(float(agg["Average Response Time"]), 1),
                "p50_ms": round(float(agg["50%"]), 1),
                "p95_ms": round(float(agg["95%"]), 1),
                "p99_ms": round(float(agg["99%"]), 1),
            },
            "endpoints": endpoints,
        }

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost:8000")
    parser.add_argument("--users", type=int, default=20)
    parser.add_argument("--spawn-rate", type=int, default=5)
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--output", default="/app/benchmarks/locust_measured.json")
    args = parser.parse_args()
    run_locust_benchmark(args.host, args.users, args.spawn_rate, args.duration, Path(args.output))
