# SurveyOps — Product Requirements Document (PRD)

**Product Name:** SurveyOps — Field Survey Intelligence Platform  
**Version:** 1.0.0  
**Target Domain:** Civic Research, Municipal Operations, and Public-Service Field Data Collection  
**Status:** Production Release Candidate

---

## 1. Executive Summary & Product Objective

Public-service agencies, civic research institutes, and municipal operations teams rely on field enumeration to measure transit reliability, water continuity, community digital access, and neighbourhood equity. Legacy workflows—disconnected paper forms, fragile spreadsheets, ad-hoc CSV cleanups, and opaque BI dashboards—suffer from four systemic failures:

1. **Schema Drift & Versioning Loss:** Editing a live questionnaire corrupts historical response analysis.
2. **Offline Field Data Loss:** Enumerators working in basements, transit tunnels, or low-coverage wards lose interviews or create silent duplicate submissions upon reconnect.
3. **Silent Raw-Data Corruption:** Analysts fixing obvious typos directly inside spreadsheets destroy provenance and break auditability.
4. **Delayed Operational Visibility:** Collection supervisors discover speeding enumerators, missing skip-branch values, or geographic gaps weeks after fieldwork ends.

**SurveyOps** solves these challenges as an end-to-end enterprise field survey and data intelligence platform enabling organizations to:
1. Design, validate, version, and publish structured civic surveys.
2. Assign published survey versions to field enumerators with district targets and deadlines.
3. Collect responses on mobile devices with explicit respondent consent, optional consented GPS capture, local draft persistence, and IndexedDB-backed offline synchronisation.
4. Process every submission through a real 9-stage deterministic data pipeline with background worker execution, idempotent ingestion, deduplication, normalization, and quality scoring.
5. Triage anomalies in a dedicated Data Quality Console with strict raw-payload immutability and tracked analyst overrides.
6. Monitor collection in real time, analyze clean SQL-backed distributions, and publish exportable CSV & PDF Insight Reports.

---

## 2. User Personas & Role-Based Access Control (RBAC)

| Role | Typical Persona | Core Responsibilities & Permissions |
|---|---|---|
| **Administrator (`admin`)** | Director of Civic Data Operations | Full governance: author/edit draft surveys, configure conditional branching and validation rules, publish immutable versions, create new draft revisions, manage field assignments, review quality queues, view analytics & benchmarks, generate reports, manage user accounts. |
| **Analyst (`analyst`)** | Data Quality & Quantitative Research Analyst | Inspect pipeline jobs, triage Data Quality Console queues (outliers, duplicates, missing values, suspicious durations, schema errors), apply audited field overrides without modifying raw payloads, approve/reject records into clean analytical datasets, explore live SQL analytics, author & export Insight Reports (CSV/PDF). |
| **Field Agent (`field_agent`)** | Field Enumerator | Operate the mobile-first Field Agent Application: view active assigned surveys & instructions, record informed respondent consent and optional location consent, complete dynamic questionnaires, save drafts locally, queue offline responses in IndexedDB, monitor synchronisation states (`Saved Locally`, `Syncing`, `Synchronised`, `Failed`), and retry syncs. |

---

## 3. Functional Scope & Module Requirements

### 3.1 Survey Management & Builder
- **Question Types:** `short_text`, `long_text`, `number`, `single_choice`, `multi_choice`, `rating`, `date`, `boolean`, `location`.
- **Conditional Branching (Skip Logic):** Multi-rule `ALL`/`ANY` conditions (`equals`, `not_equals`, `in`, `contains`, `greater_than`, `less_than`, `is_answered`) evaluated identically across Builder Preview, Field Agent App, and Backend Pipeline.
- **Validation Rules:** Per-question rules (`min_value`, `max_value`, `min_length`, `max_length`, `regex`, `outlier_bounds`, `allowed_values`) with configurable severity (`critical`, `warning`, `info`) and diagnostic message.
- **Immutable Versioning:** Publishing locks a `SurveyVersion` (with SHA-256 `schema_hash`); future edits require spawning draft `vN+1` while preserving historical responses linked to their original `survey_version_id`.
- **Interactive Preview:** Desktop and mobile (390px) live preview executing real conditional logic without persisting records.
- **Assignment Dispatch:** Assign published versions to field agents by district/zone, target count, due date, and briefing notes.

### 3.2 Field Agent Mobile-First Application
- **Dedicated Mobile Shell:** Independent route (`/field`) with responsive mobile layout, bottom tab navigation (`Assigned`, `Drafts`, `Sync Queue`), real `navigator.onLine` detection, and an explicit offline test toggle.
- **Offline Schema Caching:** Active survey assignments and full question schemas persist in IndexedDB (`cached_assignments`) so field collection works with zero connectivity.
- **Privacy-First Consent Capture:** Mandatory informed consent checkpoint before opening the questionnaire; separate opt-in consent gate for GPS coordinates (backend strips coordinates whenever `location_consent_given=false` or `allow_location_capture=false`).
- **Local Drafts & Sync Queue:** Incomplete interviews save to IndexedDB (`drafts`); submitted interviews write first to IndexedDB (`submission_queue`) with a unique `client_submission_id` UUID for idempotent delivery and display unmistakable status badges (`Saved Locally`, `Syncing`, `Synchronised`, `Sync Failed` with error text & Retry).

### 3.3 Response Processing Pipeline (9 Stages)
Every submitted response transitions deterministically through:
1. `raw_ingestion` — Persist write-once `raw_payload` JSONB and compute SHA-256 `fingerprint_hash`.
2. `schema_validation` — Verify schema version, recognized keys, and data types.
3. `required_field_validation` — Evaluate conditional branching first; flag missing required visible fields only.
4. `duplicate_detection` — Identify matching answer fingerprints within configurable time window (`DUPLICATE_WINDOW_MINUTES`).
5. `data_normalization` — Normalize strings, numbers, dates, booleans, and choices into `ResponseAnswer` without altering `raw_payload` or `raw_value`.
6. `quality_scoring` — Apply question `ValidationRule` checks, speeding/idle completion duration bounds, straight-lining detection, and compute 0–100 score.
7. `rejected_record_handling` — Auto-reject duplicates, non-consented records, or scores below rejection threshold (`45.0`).
8. `analyst_review` — Route flagged records (`< 88.0` or open warnings) into the Data Quality Console.
9. `approved_dataset_generation` — Mark clean/verified records as `approved` for Analytics and Insight Reports.

### 3.4 Data Quality Console
- Operational queue filterable by anomaly type (`outlier`, `duplicate`, `missing_value`, `suspicious_duration`, `validation_failure`, `schema_error`, `straight_lining`), severity, resolution status, survey, and keyword search.
- Detailed Record Inspector displaying side-by-side **Immutable Raw Value**, **Normalized Value**, and **Analyst-Corrected Effective Value**.
- Tracked inline override requires mandatory audit justification, logs `AuditEvent` with before/after states, triggers pipeline re-scoring, and **never modifies raw source data**.
- Single and bulk record approval/rejection workflows.

### 3.5 Analytics Workspace & Insight Reports
- 100% SQL-backed queries using composite PostgreSQL indexes: KPIs, daily collection & quality trends, geographic district distributions, issue breakdowns, and per-question response distributions (categorical counts/percentages, numeric histograms + mean/min/max).
- Snapshot-based Insight Reports persisting summary stats, quality audit tables, geographic tables, question insights, and editable analyst commentary.
- Real downloadable exports: Clean Approved Dataset CSV, Report Summary CSV, and formatted multi-section PDF briefing reports generated server-side via `fpdf2`.

---

## 4. Non-Functional Requirements & Design Principles

- **Enterprise Visual Restraint:** Warm light-grey workspace (`#F6F6F4`), crisp white surfaces (`#FFFFFF`), deep navy typography (`#0F1E36`), restrained teal accent (`#0F766E`), muted amber warnings (`#B45309`), crimson reserved strictly for critical errors (`#B91C1C`), 1px hairline borders, tabular numerals, zero decorative gradients or glassmorphism.
- **Real-Time Telemetry:** Redis pub/sub backed Server-Sent Events (`/api/v1/events/stream`) and WebSockets (`/api/v1/ws/live`) pushing ingestion, pipeline, and quality decisions immediately to connected operators.
- **Idempotency & Fault Tolerance:** Unique `client_submission_id` constraints prevent duplicate writes during mobile retries; Celery workers handle retries with exponential backoff.
- **Empirical Scalability Reporting:** Platform displays only empirically measured benchmark figures recorded against the running PostgreSQL + Redis + FastAPI stack—never fabricated claims.
