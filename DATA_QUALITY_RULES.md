# SurveyOps — Data Quality Rules & Processing Pipeline Specification

Implemented in `backend/app/pipeline/engine.py` and executed asynchronously by Celery workers (`backend/app/workers/tasks.py`).

---

## 1. Source Data Immutability Contract

SurveyOps enforces a strict **zero silent mutation** guarantee:
- `responses.raw_payload` and `response_answers.raw_value` are **write-once** at ingestion time.
- Automated normalization writes exclusively to `normalized_payload` and `response_answers.normalized_value`.
- Analyst overrides write exclusively to `response_answers.corrected_value` with a mandatory `correction_reason`, actor ID, timestamp, and immutable `AuditEvent` capturing both `before_state` and `after_state`.
- Analytical queries evaluate `effective_value = COALESCE(corrected_value, normalized_value)` so reports reflect verified data while raw evidence remains permanently auditable.

---

## 2. Deterministic 9-Stage Processing Pipeline

| Stage | Name | Operation & Output |
|---|---|---|
| **01** | `raw_ingestion` | Verifies write-once `raw_payload`, computes canonical SHA-256 `fingerprint_hash` over `(survey_version_id, district, sorted_answers)`, validates informed consent (`RULE_CONSENT_REQUIRED`) and location-consent consistency (`RULE_LOCATION_CONSENT_MISMATCH`). |
| **02** | `schema_validation` | Loads immutable `SurveyVersion` schema; flags unrecognized keys (`RULE_UNKNOWN_SCHEMA_KEYS`) and prepares type validation against declared `question_type`. |
| **03** | `required_field_validation` | Evaluates each question's `conditional_logic` against effective answers. Only **visible** questions with `is_required=true` and empty value raise `RULE_REQUIRED_MISSING` (`critical`). Conditionally skipped questions are never falsely penalized. |
| **04** | `duplicate_detection` | Queries `ix_responses_fingerprint_survey` for matching `fingerprint_hash` on the same `survey_id` within `DUPLICATE_WINDOW_MINUTES` (default 60 min). Matches set `is_duplicate=true`, link `duplicate_of_id`, and emit `RULE_DUPLICATE_FINGERPRINT` (`critical`). |
| **05** | `data_normalization` | Standardizes text (whitespace collapse), numeric strings (comma strip, float/int parsing), booleans (`yes/no/1/0`), ISO dates (`YYYY-MM-DD`), choice labels → canonical option codes, deduplicated multi-choice lists, and validated geographic bounds (`[-90,90]`, `[-180,180]`). Upserts `response_answers` preserving `raw_value` untouched and populating indexed `numeric_value`/`text_value`. |
| **06** | `quality_scoring` | Executes all active `ValidationRule` checks (`min_value`, `max_value`, `outlier_bounds`, `min_length`, `max_length`, `regex`, `allowed_values`), completion duration checks (`RULE_SPEEDING_SUBMISSION`, `RULE_ABNORMAL_IDLE_DURATION`), straight-lining check (`RULE_STRAIGHT_LINING`), and computes weighted 0–100 quality score. |
| **07** | `rejected_record_handling` | Quarantines records where `is_duplicate=true`, `consent_given=false`, `quality_score < 45.0`, or `critical_issues >= 2` to `processing_status='rejected'`. |
| **08** | `analyst_review` | Routes non-rejected records with any open `QualityIssue` or `quality_score < 88.0` to `processing_status='flagged'` in the Data Quality Console. |
| **09** | `approved_dataset_generation` | Promotes clean records (`quality_score >= 88.0`, 0 open issues, consented, non-duplicate) to `processing_status='approved'` for immediate inclusion in clean analytics and exports. |

---

## 3. Automated Rule Catalogue

| Rule Code | Issue Type | Default Severity | Trigger Condition |
|---|---|---|---|
| `RULE_CONSENT_REQUIRED` | `validation_failure` | `critical` | `consent_given` is `false`. |
| `RULE_LOCATION_CONSENT_MISMATCH` | `schema_error` | `warning` | GPS coordinates transmitted without `location_consent_given=true` (stripped at ingestion). |
| `RULE_UNKNOWN_SCHEMA_KEYS` | `schema_error` | `warning` | Payload contains keys not present in the target `SurveyVersion`. |
| `RULE_TYPE_VALIDATION` | `schema_error` | `critical` | Answer cannot be parsed as declared `question_type` or invalid choice option. |
| `RULE_REQUIRED_MISSING` | `missing_value` | `critical` | Visible required question has `null`, `""`, or `[]`. |
| `RULE_DUPLICATE_FINGERPRINT` | `duplicate` | `critical` | Identical answer fingerprint submitted on the same survey within 60 minutes. |
| `RULE_MIN_VALUE` / `RULE_MAX_VALUE` | `validation_failure` | Configurable | Numeric answer violates hard lower/upper bound. |
| `RULE_OUTLIER_BOUNDS` | `outlier` | `warning` | Numeric answer falls outside expected statistical/domain bounds (e.g. wait time > 60 min). |
| `RULE_MIN_LENGTH` / `RULE_MAX_LENGTH` | `validation_failure` | `warning` | Text length outside configured character limits. |
| `RULE_REGEX_MISMATCH` | `validation_failure` | Configurable | String fails configured regular expression. |
| `RULE_SPEEDING_SUBMISSION` | `suspicious_duration` | `warning` / `critical` | `duration_seconds < max(12, visible_questions * 3s)` (`critical` if `< 45%` of threshold). |
| `RULE_ABNORMAL_IDLE_DURATION` | `suspicious_duration` | `warning` | `duration_seconds > 3600s` (60 minutes). |
| `RULE_STRAIGHT_LINING` | `straight_lining` | `warning` | Identical rating submitted across `>= 3` rating-scale questions. |

---

## 4. Quality Scoring Formula

Each response begins at `100.0` points:

$$\text{QualityScore} = \text{clamp}_{[0, 100]}\!\left(100 - 28\,N_{\text{critical}} - 12\,N_{\text{warning}} - 4\,N_{\text{info}} - P_{\text{completeness}}\right)$$

where:
- $N_{\text{critical}}, N_{\text{warning}}, N_{\text{info}}$ are counts of open quality issues detected on the record.
- $P_{\text{completeness}} = \max(0, (0.85 - R_{\text{answered}}) \times 20)$ applies a mild penalty when fewer than 85% of visible questions (including optional questions) are answered.

**Decision Thresholds** (configurable via `.env`):
- `QUALITY_AUTO_APPROVE_THRESHOLD = 88.0` (with 0 open issues) → `approved`
- `QUALITY_REJECT_THRESHOLD = 45.0` (or duplicate / missing consent / $\ge 2$ critical issues) → `rejected`
- Intermediate or warning-flagged records → `flagged` (`analyst_review`)

---

## 5. Analyst Correction & Reprocessing Protocol

When an analyst inspects a flagged record in the Data Quality Console:
1. Submitting `PATCH /api/v1/quality/responses/{id}/answers/{question_key}` validates the corrected value against the question type, stores `corrected_value`, `effective_value`, `corrected_by_id`, `corrected_at`, and `correction_reason`, and marks matching field issues `resolved`.
2. When `reprocess=true` (default), the pipeline re-runs with `preserve_corrections=True`, keeping `raw_payload` and `raw_value` completely untouched while re-evaluating validation rules and quality score against effective values.
3. Explicitly approving or rejecting (`POST /api/v1/quality/responses/{id}/decision`) records `reviewed_by_id`, `reviewed_at`, `review_notes`, updates `processing_status`, writes an `AuditEvent`, and broadcasts a live SSE update.
