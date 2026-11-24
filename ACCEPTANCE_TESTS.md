# SurveyOps — Acceptance Test Plan & Verification Report

This document defines the end-to-end acceptance test matrix for **SurveyOps** and documents verification of every advertised platform workflow.

---

## 1. End-to-End Enterprise Acceptance Workflow (Section 9)

The flagship acceptance workflow verifies that all modules operate cohesively with real PostgreSQL persistence, Redis/Celery pipeline execution, source immutability, RBAC, and export generation:

| Step | Actor | Action | Expected & Verified System Behavior |
|---|---|---|---|
| **1. Survey Creation** | Administrator (`admin@surveyops.org`) | Creates a new civic survey (`E2E-2026-*`) with 5 questions (`single_choice`, `number`, `boolean`, conditional `single_choice`, `rating`), conditional skip logic (`defect_severity` shown only when `curb_ramp_damaged = true`), and validation rules (`min_value >= 0`, `outlier_bounds [5, 120]`). | Survey persists in `draft` state with v1 draft `SurveyVersion`, 5 `Question` rows, 2 `ValidationRule` rows, and `survey.created` `AuditEvent`. |
| **2. Publishing & Immutability** | Administrator | Publishes v1 (`POST /api/v1/surveys/{id}/publish`), then attempts to overwrite published v1 questions directly (`PUT .../questions`). | `survey.status` transitions to `published`, `active_version_id` locks v1, `schema_hash` recorded. Direct edit on published version returns `HTTP 400` enforcing schema immutability. |
| **3. Field Assignment** | Administrator | Dispatches published survey to Field Agent (`agent@surveyops.org`) for `North Metro` with target `25`. | `SurveyAssignment` created (`status='active'`). Field Agent fetches assignment with full embedded schema via `GET /api/v1/assignments/my-field-assignments` (ready for IndexedDB offline caching). |
| **4. Mobile Field Collection & Offline Sync** | Field Agent (`agent@surveyops.org`) | Submits 1 clean online response, 1 idempotent replay of the exact same `client_submission_id`, and a 4-item offline batch sync containing: (a) outlier (`260s`) + speeding (`9s`), (b) missing conditional required field, (c) duplicate fingerprint within 60m, and (d) GPS coordinates sent with `location_consent_given=false`. | Clean response scores `>= 88` and auto-approves. Replay returns `idempotent_replay=true` with zero duplicate rows. Non-consented GPS coordinates are stripped to `NULL` before persistence. |
| **5. 9-Stage Pipeline & Flagging** | Automated Pipeline (`engine.py` / Celery) | Runs all 9 stages (`raw_ingestion` → `schema_validation` → `required_field_validation` → `duplicate_detection` → `data_normalization` → `quality_scoring` → routing). | Duplicate rejected (`is_duplicate=true`, `RULE_DUPLICATE_FINGERPRINT`). Conditional missing required field flagged (`RULE_REQUIRED_MISSING`). Outlier + speeding record flagged (`RULE_OUTLIER_BOUNDS`, `RULE_SPEEDING_SUBMISSION`). |
| **6. Analyst Inspection, Correction & Approval** | Analyst (`analyst@surveyops.org`) | Inspects outlier record in Data Quality Console, applies tracked override (`260 -> 26` with mandatory justification), verifies raw immutability, and approves record. | `raw_payload` and `answer.raw_value` remain `260` (untouched). `corrected_value` and `effective_value` become `26`. `AuditEvent` records `analyst.corrected_answer` and `analyst.approve_response`. Status transitions to `approved`. |
| **7. Live SQL Analytics Verification** | Analyst | Queries `/api/v1/analytics/overview` and `/api/v1/analytics/questions/{survey_id}?status=approved`. | Overview confirms `total=5`, `approved=3`, `rejected>=1`. Question distribution mean reflects corrected value: `(42 + 28 + 26) / 3 = 32.0` (never distorted by raw outlier `260`). |
| **8. Insight Report & CSV/PDF Exports** | Analyst | Generates Insight Report (`POST /api/v1/reports`) with custom analyst notes, downloads Report CSV, Report PDF, and Clean Approved Dataset CSV. | Report persists SQL snapshot. Report CSV contains KPI and question distributions. Report PDF begins with `%PDF-` and renders valid multi-section document (>2 KB). Clean dataset CSV includes approved records and excludes rejected duplicates. |

---

## 2. Security & RBAC Verification Matrix

| Test Case | Endpoint | Actor | Expected HTTP |
|---|---|---|---|
| Unauthenticated API access | `GET /api/v1/surveys` | None | `401 Unauthorized` |
| Invalid password login | `POST /api/v1/auth/login` | Bad credentials | `401 Unauthorized` |
| Field Agent attempting survey creation | `POST /api/v1/surveys` | `field_agent` | `403 Forbidden` |
| Field Agent accessing Data Quality Console | `GET /api/v1/quality/issues` | `field_agent` | `403 Forbidden` |
| Analyst attempting survey creation | `POST /api/v1/surveys` | `analyst` | `403 Forbidden` |
| Analyst accessing Data Quality Console | `GET /api/v1/quality/issues` | `analyst` | `200 OK` |
| Admin listing field agents | `GET /api/v1/auth/users?role=field_agent` | `admin` | `200 OK` |
| Field Agent reading another agent's response (IDOR) | `GET /api/v1/responses/{other_id}` | `field_agent` | `403 Forbidden` |
| Field Agent global search scoping | `GET /api/v1/search?q=RULE` | `field_agent` | `200 OK` (`quality_issues=[]`) |
| Unauthenticated WebSocket live feed | `WS /api/v1/ws/live` | None | Closed (`1008 Policy Violation`) |

---

## 3. Unit & Pipeline Logic Coverage (`backend/tests/test_pipeline_unit.py`)

- **Conditional Branching Evaluator:** Verifies all 7 operators (`equals`, `not_equals`, `in`, `contains`, `greater_than`, `less_than`, `is_answered`) under `ALL` and `ANY` combinators.
- **Multi-Type Normalization:** Verifies text whitespace collapse, comma-separated numeric parsing, invalid number rejection, boolean string coercion (`YES`/`no`), ISO date parsing, canonical choice label-to-code mapping, invalid choice rejection, multi-choice deduplication, and geographic latitude/longitude bounds.
- **Validation Rules & Fingerprinting:** Verifies `outlier_bounds`, `regex`, and order-insensitive SHA-256 duplicate fingerprint determinism.

---

## 4. Mobile Offline Storage & Sync Verification (`/field`)

- Active assignments and complete question schemas cache automatically into IndexedDB (`surveyops_field_v1.cached_assignments`).
- Saving an incomplete interview persists into `surveyops_field_v1.drafts` and restores cleanly on resume.
- Toggling **Offline Mode** queues submitted responses into `surveyops_field_v1.submission_queue` displaying **`Saved Locally`**.
- Re-enabling connectivity and clicking **Sync Pending** transmits queued records idempotently, transitioning badges to **`Synchronised`** with live server `processing_status` (or **`Sync Failed`** with diagnostic error and Retry button on failure).

---

## 5. Execution Commands

```bash
# 1. Frontend typecheck & production build
cd frontend && npm run build

# 2. Backend unit + full E2E acceptance test suite
docker exec surveyops-backend pytest -v /app/tests

# 3. 100,000-response synthetic scale benchmark
docker exec surveyops-backend python /app/scripts/generate_synthetic_data.py --count 100000 --batch-size 2000 --seed 20261124

# 4. Headless Locust API load test
docker exec surveyops-backend python /app/scripts/run_locust_benchmark.py --host http://localhost:8000 --users 25 --spawn-rate 5 --duration 25
```

---

## 6. Verified Execution Results (2026-11-24)

| Verification Suite | Command | Result | Details |
|---|---|---|---|
| **Frontend Typecheck & Production Build** | `npm run build` (`tsc --noEmit && vite build`) | **PASS** | 0 TypeScript errors, 2,076 modules bundled in `5.43s` |
| **Backend Unit & Full E2E Acceptance Suite** | `pytest -v /app/tests` | **PASS (5/5)** | All 5 unit, RBAC, and full Section 9 E2E workflow tests passed in `3.55s` |
| **100,000-Response Synthetic Scale Benchmark** | `generate_synthetic_data.py --count 100000 --batch-size 2000` | **PASS** | `100,000` responses + `300,000` answers + `8,872` issues in `178.396s` (`560.6 resp/s`); 500-key idempotency replay = `0` duplicates; KPI SQL `38.42 ms` |
| **Locust API Load Test (against 100k+ row DB)** | `run_locust_benchmark.py -u 25 -r 5 -t 25s` | **PASS** | `648` requests, `0` failures (`0.0%`), `26.98 req/s`, `p50 42 ms`, `p95 140 ms`, `p99 190 ms` |
| **Docker Compose 5-Service Stack & Nginx Proxy** | `docker compose ps` + live HTTP checks | **PASS** | All 5 containers healthy; security headers (`nosniff`, `DENY`, `Referrer-Policy`) + SPA routes + Celery worker verified |
| **Playwright Chrome Visual & Interactive Audit** | `verify-after.js` across `1440x900`, `768x1024`, `390x844` | **PASS (21/21)** | `0` console errors, `0` failed requests, `0` horizontal overflows across desktop/tablet/mobile, live IndexedDB offline queue → online sync verified |
