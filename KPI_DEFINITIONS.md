# SurveyOps — KPI & Operational Metric Definitions

All KPIs in SurveyOps are computed directly from live PostgreSQL queries (`backend/app/services/analytics.py`)—never hardcoded or approximated on the client.

---

## 1. Core Collection & Pipeline KPIs

| Metric | API Field | SQL / Mathematical Definition | Operational Interpretation |
|---|---|---|---|
| **Total Responses** | `total_responses` | `COUNT(responses.id)` within active filters (survey, version, district, date range). | Total raw submissions received across all channels (`mobile_online`, `mobile_offline`, `batch_api`). |
| **Valid Responses** | `valid_responses` | `COUNT(responses.id) WHERE processing_status IN ('approved', 'validated')` | Records passing automated pipeline rules or explicitly approved by an analyst after review/correction. |
| **Approved Responses** | `approved_responses` | `COUNT(responses.id) WHERE processing_status = 'approved'` | Records materialized into the clean analytical dataset used for official reporting and clean CSV exports. |
| **Flagged Responses** | `flagged_responses` | `COUNT(responses.id) WHERE processing_status = 'flagged'` | Records awaiting analyst inspection in the Data Quality Console due to warnings, outliers, or borderline quality scores. |
| **Rejected Responses** | `rejected_responses` | `COUNT(responses.id) WHERE processing_status = 'rejected'` | Quarantined records (duplicates, missing consent, severe schema/missing-required violations, or quality score `< 45.0`). Excluded from approved datasets. |
| **Processing Backlog** | `processing_backlog` | `COUNT(responses WHERE status IN ('ingested','processing')) + COUNT(processing_jobs WHERE status IN ('queued','running','retrying'))` | Real-time queue depth awaiting completion by Celery background workers. Sustained growth signals worker scaling need. |
| **Duplicate Responses** | `duplicate_responses` | `COUNT(responses.id) WHERE is_duplicate = true` | Submissions matching an identical `(survey_id, fingerprint_hash)` within the configured sliding window (`60 min`). |
| **Open Quality Issues** | `open_quality_issues` | `COUNT(quality_issues.id) WHERE status = 'open'` | Unresolved field-level or record-level anomalies requiring analyst triage. |

---

## 2. Efficiency, Quality & Coverage Rates

| Metric | API Field | Formula |
|---|---|---|
| **Validation Rate (%)** | `valid_rate` | $\frac{\text{valid\_responses}}{\text{total\_responses}} \times 100$ |
| **Target Completion Rate (%)** | `completion_rate` | $\min\!\left(100,\; \frac{\text{total\_responses}}{\sum \text{surveys.target\_responses}} \times 100\right)$ |
| **Average Quality Score** | `avg_quality_score` | `AVG(responses.quality_score)` on a `0–100` scale |
| **Average Interview Duration** | `avg_duration_seconds` | `AVG(responses.duration_seconds)` in seconds |
| **Consented GPS Coverage (%)** | `geo_consented_pct` | $\frac{\text{COUNT(location\_consent\_given = true)}}{\text{total\_responses}} \times 100$ |
| **Daily Anomaly Issue Rate (%)** | `issue_rate` (trends) | $\frac{\text{flagged\_day} + \text{rejected\_day}}{\text{total\_day}} \times 100$ |

---

## 3. Question-Level Analytical Metrics

Computed per question in `compute_question_distributions()` over `response_answers` joined to `responses`:
- **Answered Count (`answered_count`)**: `COUNT(*) WHERE is_missing = false`
- **Response Rate (`response_rate`)**: `(answered_count / total_records) * 100` (naturally reflects conditional skip-branch denominators)
- **Outlier Count (`outlier_count`)**: `COUNT(*) WHERE is_outlier = true`
- **Categorical Distribution (`single_choice`, `boolean`, `rating`, `multi_choice`)**: Exact SQL `GROUP BY text_value` (or array frequency aggregation) producing `{key, label, count, pct}` where `pct = (count / answered_count) * 100`.
- **Numeric Statistics (`number`, `rating`)**: Exact SQL `AVG(numeric_value)`, `MIN(numeric_value)`, `MAX(numeric_value)`, plus 6-bin equal-width histogram distribution.
- **Override Consistency:** All analytics query `effective_value` / `numeric_value` / `text_value`, which immediately reflect analyst-approved corrections while preserving immutable `raw_value` for provenance audits.

---

## 4. Field Assignment & Offline Sync Metrics

- **Assignment Attainment (%)**: `(collected_count / target_count) * 100` per field enumerator and district.
- **Local Sync Queue States (IndexedDB)**:
  - `Saved Locally` (`local_saved`): Persisted safely in IndexedDB on device; not yet transmitted.
  - `Syncing` (`syncing`): In-flight HTTP POST with idempotent `client_submission_id`.
  - `Synchronised` (`synced`): Confirmed HTTP 201 ingestion with server `response_id` and pipeline status.
  - `Sync Failed` (`failed`): Transmission failed; retains payload and error message for retry without data loss.
