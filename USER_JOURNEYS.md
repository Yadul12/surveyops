# SurveyOps — End-to-End User Journeys

This document details the primary operational journeys across SurveyOps' three core personas: **Administrator**, **Field Enumerator**, and **Data Quality Analyst**.

---

## Journey 1: Administrator Designs, Publishes, and Dispatches a Civic Survey

**Persona:** Dr. Clara Chen (`admin@surveyops.org`) — Director of Civic Data Operations  
**Goal:** Launch a standardized municipal survey with conditional follow-up questions and automated outlier bounds, then dispatch it to regional field agents.

1. **Create Survey Draft:** From `Operations Overview` or `Surveys & Builder`, clicks **Create Survey**, enters code (`CIV-2026-TRN`), title, category, target sample size, field briefing instructions, and respondent consent text.
2. **Author Multi-Type Questionnaire:** Inside `/surveys/:id/builder`, adds questions across `single_choice`, `multi_choice`, `number`, `rating`, `boolean`, `date`, and `short_text`, grouping them into logical sections and ordering them cleanly.
3. **Configure Conditional Branching:** On `accessibility_barriers`, attaches a branching rule: *Display when `step_free_access_needed` equals `true`*.
4. **Configure Pipeline Validation Rules:** On `avg_wait_minutes`, adds `min_value >= 0` (`critical`) and `outlier_bounds [1, 60]` (`warning`) so extreme timings automatically flag for analyst review.
5. **Interactive Preview:** Switches to **Interactive Preview** (`Mobile 390px` viewport), tests toggling `step_free_access_needed` to verify conditional fields appear/disappear dynamically without creating database records.
6. **Publish Immutable Version:** Clicks **Publish v1**. Backend locks `v1`, records SHA-256 `schema_hash`, sets `survey.status = 'published'`, emits an `AuditEvent`, and broadcasts a live SSE update.
7. **Assign to Field Agents:** Opens the **Field Assignments** tab, selects field enumerators by district (`North Metro`, `East River`, etc.), sets individual target quotas and due dates, and dispatches assignments.

---

## Journey 2: Field Enumerator Collects Interviews Offline & Synchronises Queue

**Persona:** David Okafor (`agent@surveyops.org`) — Field Enumerator, North Metro  
**Goal:** Complete household/commuter interviews in a low-connectivity transit corridor without losing progress or violating respondent privacy.

1. **Open Mobile Field App:** Signs in and lands directly on `/field`. Active assignments load from `/api/v1/assignments/my-field-assignments` and immediately cache full schemas into local **IndexedDB** (`cached_assignments`).
2. **Enter Offline Zone:** Connectivity drops (or enumerator toggles **Offline Mode**). Banner clearly indicates offline storage is active.
3. **Briefing & Explicit Consent:** Opens `CIV-2026-TRN`, reads survey instructions aloud, enters anonymized household reference (`HH-NOR-4102`), confirms mandatory **Respondent Informed Consent**.
4. **Optional Location Consent:** Only if the respondent opts in, checks **Location Consent** and captures GPS coordinates; otherwise leaves unchecked so zero coordinates are collected.
5. **Complete Dynamic Questionnaire:** Answers questions; conditional follow-ups activate dynamically based on prior responses. Mid-interview, clicks **Save Draft** to store progress in IndexedDB (`drafts`), then resumes seamlessly.
6. **Offline Submission:** Taps **Save to Offline Queue**. The app persists the submission to IndexedDB (`submission_queue`) with a unique idempotent `client_submission_id` and displays badge **`Saved Locally`**.
7. **Reconnect & Synchronise:** Upon returning online, opens the **Sync Queue** tab, reviews pending counts (`Saved Locally`, `Synchronised`, `Failed`), and taps **Sync Pending**. Each item transitions `Saved Locally` → `Syncing...` → `Synchronised` with server pipeline status displayed. Any failed item displays its error message and a one-click **Retry** button without duplicating already-synced submissions.

---

## Journey 3: Automated Processing Pipeline & Real-Time Operations Monitoring

**System Actors:** FastAPI Ingestion API + Redis Broker + Celery Workers + SSE Live Stream  
**Goal:** Validate, deduplicate, normalize, and score incoming field responses asynchronously while providing live visibility to operations leads.

1. **Idempotent Ingestion:** `POST /api/v1/responses` (or `/responses/batch`) validates unique `client_submission_id`, writes immutable `raw_payload`, logs `response.ingested` audit event, creates a `ProcessingJob`, and enqueues Celery task `surveyops.process_response`.
2. **9-Stage Pipeline Execution:** Celery worker executes stages 1–9 (`raw_ingestion` → `schema_validation` → `required_field_validation` → `duplicate_detection` → `data_normalization` → `quality_scoring` → routing to `rejected_record_handling`, `analyst_review`, or `approved_dataset_generation`).
3. **Live Broadcast:** Worker publishes completion payload to Redis channel `surveyops:live_events`; FastAPI SSE stream updates `Operations Command Center` KPIs, Live Pipeline Feed, and Notification Centre in real time.

---

## Journey 4: Data Quality Analyst Audits Flagged Records & Approves Clean Dataset

**Persona:** Marcus Vance (`analyst@surveyops.org`) — Lead Data Quality Analyst  
**Goal:** Resolve flagged outliers, quarantine duplicates, correct verified data-entry typos with complete auditability, and approve the clean dataset.

1. **Triage Queue:** Opens `/quality` (Data Quality Console), filters by issue category tabs (`Outliers`, `Duplicates`, `Missing Values`, `Suspicious Time`, `Validation Failures`), severity, and survey.
2. **Inspect Record:** Clicks **Inspect** on a flagged submission (`avg_wait_minutes = 135`, flagged by `RULE_OUTLIER_BOUNDS`).
3. **Verify Source Immutability:** Reviews side-by-side table comparing **Raw Source (Immutable)** vs **Normalized Value** vs **Effective Value**, plus the read-only Raw JSON payload and enumerator timing metadata.
4. **Apply Tracked Correction:** Clicks **Correct** on `avg_wait_minutes`, enters verified value `18` with mandatory audit justification (*"Verified decimal entry typo with enumerator field log"*). Backend writes `corrected_value = 18` while leaving `raw_value = 135` and `raw_payload` 100% unchanged, logs `analyst.corrected_answer`, and re-scores the record.
5. **Approve or Reject:** Clicks **Approve Dataset** on the corrected record (or **Reject Record** on confirmed duplicates/speeders). Audit History timeline records every automated stage and human decision.

---

## Journey 5: Analyst Explores Live Analytics & Publishes PDF/CSV Insight Reports

**Persona:** Marcus Vance / Priya Nair (`analyst@surveyops.org`)  
**Goal:** Analyze verified civic findings across districts and export executive-ready CSV and PDF reports.

1. **Explore Analytics Workspace:** Navigates to `/analytics`, filters by survey (`CIV-2026-TRN`), district, timeframe, and dataset scope (`Valid & Approved Only`). Reviews live SQL charts: Collection Trends, Data Quality Score vs Issue Rate, Geographic Distribution table, and Question-Wise Distributions.
2. **Generate Insight Report:** Clicks **Generate Insight Report**, configures title, report type (`Full Insight`), scope (`Valid & Approved`), and drafts executive analyst commentary. Backend computes and persists an immutable statistical snapshot.
3. **Refine & Export:** Reviews charts and summary tables inside `/reports/:id`, updates analyst commentary if needed, downloads the **CSV Summary**, **Clean Approved Dataset CSV**, and server-rendered **PDF Report** for municipal stakeholders.
