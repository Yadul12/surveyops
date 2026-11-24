# SurveyOps — Field Survey Intelligence Platform

**SurveyOps** is an enterprise field survey, offline mobile data collection, automated quality validation, real-time monitoring, and analytical reporting platform designed for civic research and public-service operations.

Built with a real **FastAPI + PostgreSQL 16 + SQLAlchemy 2.0 + Alembic + Redis 7 + Celery 5.4 + SSE/WebSockets** backend and a **React 18 + TypeScript + Vite + Tailwind CSS + TanStack Query + React Hook Form + Zod + Recharts + IndexedDB** frontend.

---

## Key Capabilities

1. **Survey Management & Versioned Builder (`/surveys`, `/surveys/:id/builder`)**
   - 9 question types (`short_text`, `long_text`, `number`, `single_choice`, `multi_choice`, `rating`, `date`, `boolean`, `location`).
   - Required/optional toggles, sections, drag/reorder controls, **conditional branching (skip logic)**, and **per-question validation & outlier rules**.
   - Immutable version publishing (`v1` → `v2` draft cloning) preserving schema fidelity for historical responses.
   - Interactive Desktop & Mobile (`390px`) preview mode and Field Agent assignment dispatch.
2. **Mobile-First Field Agent Application (`/field`)**
   - Offline-ready mobile interface powered by **IndexedDB** (`surveyops_field_v1`: `cached_assignments`, `drafts`, `submission_queue`).
   - Survey briefing instructions, explicit **Respondent Informed Consent**, and optional **Consented Location Capture** (GPS coordinates are strictly stripped server-side if location consent is not granted).
   - Save-and-resume drafts, simulated offline toggle + real `navigator.onLine` detection, idempotent `client_submission_id` synchronisation queue displaying explicit **`Saved Locally`**, **`Syncing...`**, **`Synchronised`**, and **`Sync Failed`** states with retry controls.
3. **9-Stage Response Processing Pipeline (`/pipeline`, `/responses`)**
   - Asynchronous Celery workers executing: `raw_ingestion` → `schema_validation` → `required_field_validation` → `duplicate_detection` → `data_normalization` → `quality_scoring` → `rejected_record_handling` / `analyst_review` / `approved_dataset_generation`.
   - Real-time Server-Sent Events (`/api/v1/events/stream`) and WebSocket (`/api/v1/ws/live`) telemetry backed by Redis pub/sub.
4. **Data Quality Console (`/quality`, `/responses/:id`)**
   - Dedicated operational triage queue for outliers, duplicates, missing required values, suspicious completion times, validation failures, schema errors, and straight-lining.
   - **Strict Source Immutability:** Raw payloads (`raw_payload`, `raw_value`) are write-once and never silently modified. Analyst overrides store separate `corrected_value` + mandatory `correction_reason` + `AuditEvent` lineage and trigger pipeline re-scoring.
5. **Analytics Workspace & Insight Reports (`/analytics`, `/reports`)**
   - 100% live PostgreSQL SQL aggregations: KPI strips, response & quality trends, geographic district distributions, and question-level breakdowns.
   - Reproducible Insight Report snapshots with editable analyst commentary and downloadable **CSV** and server-rendered **PDF** exports (`fpdf2`).
6. **Verified 100,000-Response Scalability & Load Benchmarks (`/scalability`)**
   - Reproducible 100,000-response synthetic ingestion generator (`scripts/generate_synthetic_data.py`), composite PostgreSQL indexes, idempotent `ON CONFLICT` batch writes, and headless Locust load testing (`loadtests/locustfile.py`).

---

## Quick Start (Docker Compose)

```bash
# 1. Copy environment template (optional: defaults work out of the box)
cp .env.example .env

# 2. Build and launch PostgreSQL 16, Redis 7, FastAPI, Celery Worker, and Nginx Frontend
docker compose up -d --build
```

On startup, the backend automatically executes `alembic upgrade head` and seeds reproducible synthetic civic-research data (`app.db.seed`).

### Service Endpoints (Default `.env` Ports)

| Service | URL |
|---|---|
| **Web Application (Operations Console & `/field` Mobile App)** | `http://localhost:3070` |
| **FastAPI REST API & Swagger Docs** | `http://localhost:8070/api/docs` |
| **Health Check** | `http://localhost:8070/api/v1/health` |
| **PostgreSQL 16** | `localhost:5472` (`surveyops` / `surveyops_secure_pass`) |
| **Redis 7** | `localhost:6382` |

### Seeded Role Accounts

| Role | Email | Password | Scope |
|---|---|---|---|
| **Administrator** | `admin@surveyops.org` | `AdminPass123!` | Full survey authoring, publishing, assignments, quality, analytics, reports |
| **Analyst** | `analyst@surveyops.org` | `AnalystPass123!` | Data Quality Console, tracked overrides, approvals, analytics, CSV/PDF reports |
| **Field Agent** | `agent@surveyops.org` | `AgentPass123!` | Mobile Field App (`/field`), offline IndexedDB drafts & sync queue |

---

## Local Development (Without Containerizing Frontend/Backend)

```bash
# Start backing services only
docker compose up -d postgres redis

# Backend (using venv + pip)
cd backend
python -m venv .venv
.venv/Scripts/activate   # or: source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
python -m app.db.seed
uvicorn app.main:app --reload --port 8070

# Celery worker (separate terminal)
celery -A app.workers.celery_app.celery_app worker --loglevel=info

# Frontend (separate terminal)
cd frontend
npm install
npm run dev   # http://localhost:5174
```

---

## Automated Tests & Reproducible Benchmarks

```bash
# Frontend TypeScript check & production build
cd frontend && npm run build

# Backend unit & full E2E acceptance test suite
docker exec surveyops-backend pytest -v /app/tests

# Reproducible 100,000-response synthetic ingestion & SQL query benchmark
docker exec surveyops-backend python /app/scripts/generate_synthetic_data.py \
  --count 100000 --batch-size 2000 --seed 20261124

# Headless Locust API load test against 100k+ row database
docker exec surveyops-backend python /app/scripts/run_locust_benchmark.py \
  --host http://localhost:8000 --users 25 --spawn-rate 5 --duration 25
```

---

## Measured Empirical Benchmark Summary

*(Populated directly from `benchmarks/scale_100k_measured.json` and `benchmarks/locust_measured.json` — see `/scalability` in the app for live artifact inspection.)*

### 100,000-Response Synthetic Scale Benchmark
- **Dataset Generated:** 100,000 responses + 300,000 normalized `response_answers` + 8,872 `quality_issues` (total DB rows: 100,428 responses)
- **Batch Size / Seed:** `2,000` rows per commit, RNG seed `20261124`
- **Measured Batch Ingestion Throughput:** **560.6 responses/sec** (`1,681.7 answer rows/sec`, total `178.396s` with 18 active PostgreSQL B-tree indexes)
- **Idempotent Replay Verification:** `500` replayed `client_submission_id` keys processed in **271.97 ms** with **0 duplicate inserts**
- **Measured PostgreSQL Indexed Query Latencies (on 100,428 rows):**
  - Overview KPIs aggregation: **38.42 ms**
  - 30-day daily trends `GROUP BY`: **38.21 ms**
  - Geographic district breakdown: **26.06 ms**
  - Deep pagination (`OFFSET 50000 LIMIT 25`): **107.88 ms**
  - Question distributions over 300,000 answers: **721.9 ms**

### Locust Concurrent API Load Test (Measured Against 100,428-Row Database)
- **Configuration:** `25` concurrent users (`FieldAgentUser` weight 3 + `AnalystOperationsUser` weight 2), spawn rate `5/s`, duration `25s`
- **Measured Totals:** **648 requests**, **0 failures (`0.0%`)**, **26.98 req/s** sustained (including **689** new field submissions processed asynchronously via Redis/Celery)
- **Measured End-to-End Latencies:** `avg 56.1 ms` | `p50 42.0 ms` | `p95 140.0 ms` | `p99 190.0 ms`
  - `GET /api/v1/analytics/overview` (100k+ rows): `p50 29.0 ms`, `p95 96.0 ms`
  - `GET /api/v1/responses` (paginated over 100k+ rows): `p50 26.0 ms`, `p95 67.0 ms`
  - `POST /api/v1/responses` (single field ingest + Celery dispatch): `p50 42.0 ms`, `p95 130.0 ms`
  - `POST /api/v1/responses/batch` (5-item offline sync batch): `p50 55.0 ms`, `p95 150.0 ms`

---

## Product & Engineering Documentation

- [PRD.md](./PRD.md) — Product Requirements, Personas & RBAC
- [USER_JOURNEYS.md](./USER_JOURNEYS.md) — End-to-End Operational User Journeys
- [ARCHITECTURE.md](./ARCHITECTURE.md) — System Architecture, Offline Sync & Infrastructure
- [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) — 14-Table Relational Model, ERD & Indexing Strategy
- [DATA_QUALITY_RULES.md](./DATA_QUALITY_RULES.md) — 9-Stage Pipeline, Validation Rules & Scoring Formula
- [KPI_DEFINITIONS.md](./KPI_DEFINITIONS.md) — Formal SQL KPI & Metric Specifications
- [ACCEPTANCE_TESTS.md](./ACCEPTANCE_TESTS.md) — End-to-End Verification Matrix & Execution Results
