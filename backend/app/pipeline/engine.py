import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.core.logging import get_logger
from app.db.base import utcnow
from app.models.models import (
    AuditEvent,
    ProcessingJob,
    QualityIssue,
    Question,
    Response,
    ResponseAnswer,
    SurveyVersion,
    ValidationRule,
)
from app.services.events import publish_live_event

logger = get_logger("surveyops.pipeline")


def evaluate_conditional_logic(logic: Optional[dict], answers: Dict[str, Any]) -> bool:
    """Return True if the question should be displayed/evaluated given current answers."""
    if not logic or not logic.get("rules"):
        return True

    operator = logic.get("operator", "all")
    results: List[bool] = []

    for rule in logic.get("rules", []):
        q_key = rule.get("question_key")
        condition = rule.get("condition", "equals")
        expected = rule.get("value")
        actual = answers.get(q_key)

        matched = False
        if condition == "equals":
            matched = str(actual).strip().lower() == str(expected).strip().lower() if actual is not None else False
        elif condition == "not_equals":
            matched = actual is not None and str(actual).strip().lower() != str(expected).strip().lower()
        elif condition == "contains":
            if isinstance(actual, list):
                matched = expected in actual or str(expected).lower() in [str(x).lower() for x in actual]
            elif actual is not None:
                matched = str(expected).lower() in str(actual).lower()
        elif condition == "in":
            if isinstance(expected, list):
                matched = str(actual).lower() in [str(x).lower() for x in expected] if actual is not None else False
        elif condition == "greater_than":
            try:
                matched = float(actual) > float(expected)
            except (TypeError, ValueError):
                matched = False
        elif condition == "less_than":
            try:
                matched = float(actual) < float(expected)
            except (TypeError, ValueError):
                matched = False
        elif condition == "is_answered":
            matched = actual is not None and actual != "" and actual != []

        results.append(matched)

    if not results:
        return True
    return all(results) if operator == "all" else any(results)


def compute_fingerprint(survey_version_id: uuid.UUID, district: str, answers: Dict[str, Any]) -> str:
    canonical = {
        "v": str(survey_version_id),
        "d": (district or "").strip().lower(),
        "a": {k: answers[k] for k in sorted(answers.keys())},
    }
    blob = json.dumps(canonical, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def is_empty_value(val: Any) -> bool:
    if val is None:
        return True
    if isinstance(val, str) and val.strip() == "":
        return True
    if isinstance(val, list) and len(val) == 0:
        return True
    if isinstance(val, dict) and len(val) == 0:
        return True
    return False


def normalize_answer_value(q_type: str, raw_val: Any, options: List[dict]) -> Tuple[Any, Optional[float], Optional[str], Optional[str]]:
    """
    Returns (normalized_value, numeric_value, text_value, type_error_message).
    Never mutates raw_val.
    """
    if is_empty_value(raw_val):
        return None, None, None, None

    if q_type in ("short_text", "long_text"):
        text = " ".join(str(raw_val).strip().split())
        return text, None, text[:255], None

    if q_type == "number":
        try:
            if isinstance(raw_val, bool):
                return raw_val, None, str(raw_val), "Expected numeric value, received boolean"
            num = float(str(raw_val).strip().replace(",", ""))
            norm = int(num) if num.is_integer() else round(num, 4)
            return norm, num, str(norm), None
        except (ValueError, TypeError):
            return raw_val, None, str(raw_val)[:255], f"Value '{raw_val}' is not a valid number"

    if q_type == "rating":
        try:
            num = float(str(raw_val).strip())
            norm = int(round(num))
            return norm, float(norm), str(norm), None
        except (ValueError, TypeError):
            return raw_val, None, str(raw_val)[:255], f"Value '{raw_val}' is not a valid rating integer"

    if q_type == "boolean":
        if isinstance(raw_val, bool):
            return raw_val, (1.0 if raw_val else 0.0), ("true" if raw_val else "false"), None
        s = str(raw_val).strip().lower()
        if s in ("true", "yes", "1", "y"):
            return True, 1.0, "true", None
        if s in ("false", "no", "0", "n"):
            return False, 0.0, "false", None
        return raw_val, None, s[:255], f"Value '{raw_val}' is not a valid boolean"

    if q_type == "date":
        s = str(raw_val).strip()
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%m/%d/%Y"):
            try:
                parsed = datetime.strptime(s[:10], fmt).date().isoformat()
                return parsed, None, parsed, None
            except ValueError:
                continue
        return raw_val, None, s[:255], f"Value '{raw_val}' is not a recognized ISO date (YYYY-MM-DD)"

    if q_type == "single_choice":
        s = str(raw_val).strip()
        valid_values = {str(o.get("value", "")).lower(): str(o.get("value", "")) for o in (options or [])}
        valid_labels = {str(o.get("label", "")).lower(): str(o.get("value", "")) for o in (options or [])}
        if valid_values:
            if s.lower() in valid_values:
                canon = valid_values[s.lower()]
                return canon, None, canon[:255], None
            if s.lower() in valid_labels:
                canon = valid_labels[s.lower()]
                return canon, None, canon[:255], None
            return s, None, s[:255], f"Choice '{s}' is not in allowed options"
        return s, None, s[:255], None

    if q_type == "multi_choice":
        items = raw_val if isinstance(raw_val, list) else [x.strip() for x in str(raw_val).split(",") if x.strip()]
        valid_values = {str(o.get("value", "")).lower(): str(o.get("value", "")) for o in (options or [])}
        valid_labels = {str(o.get("label", "")).lower(): str(o.get("value", "")) for o in (options or [])}
        normalized_list: List[str] = []
        invalid_items: List[str] = []
        for item in items:
            s = str(item).strip()
            if not s:
                continue
            if valid_values:
                if s.lower() in valid_values:
                    normalized_list.append(valid_values[s.lower()])
                elif s.lower() in valid_labels:
                    normalized_list.append(valid_labels[s.lower()])
                else:
                    invalid_items.append(s)
                    normalized_list.append(s)
            else:
                normalized_list.append(s)
        # deduplicate preserving order
        deduped = list(dict.fromkeys(normalized_list))
        err = f"Invalid selections: {', '.join(invalid_items)}" if invalid_items else None
        return deduped, float(len(deduped)), ",".join(deduped)[:255], err

    if q_type == "location":
        if isinstance(raw_val, dict) and "lat" in raw_val and "lng" in raw_val:
            try:
                lat = round(float(raw_val["lat"]), 6)
                lng = round(float(raw_val["lng"]), 6)
                if not (-90 <= lat <= 90 and -180 <= lng <= 180):
                    return raw_val, None, f"{lat},{lng}", "Coordinates out of valid geographic bounds"
                norm = {"lat": lat, "lng": lng}
                if "accuracy" in raw_val:
                    norm["accuracy"] = raw_val["accuracy"]
                return norm, None, f"{lat},{lng}", None
            except (TypeError, ValueError):
                return raw_val, None, str(raw_val)[:255], "Invalid location coordinates"
        return raw_val, None, str(raw_val)[:255], "Location must contain lat and lng fields"

    return raw_val, None, str(raw_val)[:255], None


def evaluate_validation_rule(rule: ValidationRule, value: Any, num_val: Optional[float]) -> Optional[Tuple[str, str, str]]:
    """
    Returns (issue_type, rule_code, message) if violated, else None.
    """
    if not rule.is_active or is_empty_value(value):
        return None
    cfg = rule.rule_config or {}
    rtype = rule.rule_type

    if rtype == "min_value" and num_val is not None:
        min_v = cfg.get("min")
        if min_v is not None and num_val < float(min_v):
            return ("validation_failure", "RULE_MIN_VALUE", rule.error_message or f"Value {num_val} is below minimum {min_v}")

    elif rtype == "max_value" and num_val is not None:
        max_v = cfg.get("max")
        if max_v is not None and num_val > float(max_v):
            return ("validation_failure", "RULE_MAX_VALUE", rule.error_message or f"Value {num_val} exceeds maximum {max_v}")

    elif rtype == "outlier_bounds" and num_val is not None:
        low = cfg.get("min")
        high = cfg.get("max")
        if (low is not None and num_val < float(low)) or (high is not None and num_val > float(high)):
            return (
                "outlier",
                "RULE_OUTLIER_BOUNDS",
                rule.error_message or f"Numeric value {num_val} falls outside expected distribution [{low}, {high}]",
            )

    elif rtype == "min_length":
        min_l = cfg.get("min")
        if min_l is not None and len(str(value)) < int(min_l):
            return ("validation_failure", "RULE_MIN_LENGTH", rule.error_message or f"Text length {len(str(value))} below minimum {min_l}")

    elif rtype == "max_length":
        max_l = cfg.get("max")
        if max_l is not None and len(str(value)) > int(max_l):
            return ("validation_failure", "RULE_MAX_LENGTH", rule.error_message or f"Text length {len(str(value))} exceeds maximum {max_l}")

    elif rtype == "regex":
        pattern = cfg.get("pattern")
        if pattern and not re.match(pattern, str(value)):
            return ("validation_failure", "RULE_REGEX_MISMATCH", rule.error_message or f"Value '{value}' failed pattern validation")

    elif rtype == "allowed_values":
        allowed = cfg.get("values", [])
        if allowed and str(value) not in [str(a) for a in allowed]:
            return ("validation_failure", "RULE_ALLOWED_VALUES", rule.error_message or f"Value '{value}' not in permitted list")

    return None


def process_response_pipeline(
    db: Session,
    response_id: uuid.UUID,
    job_id: Optional[uuid.UUID] = None,
    emit_events: bool = True,
    preserve_corrections: bool = True,
) -> Response:
    """
    Execute the complete 9-stage response processing pipeline deterministically.
    Raw source payload (`response.raw_payload`) is strictly read-only.
    """
    t0 = time.perf_counter()
    stages_log: List[dict] = []

    response = db.execute(
        select(Response)
        .options(selectinload(Response.answers), selectinload(Response.quality_issues))
        .where(Response.id == response_id)
    ).scalar_one_or_none()

    if response is None:
        raise ValueError(f"Response {response_id} not found")

    job: Optional[ProcessingJob] = None
    if job_id:
        job = db.get(ProcessingJob, job_id)
    if job is None:
        job = ProcessingJob(
            response_id=response.id,
            job_type="single_response",
            status="running",
            current_stage="raw_ingestion",
            total_items=1,
            processed_items=0,
            attempt_count=1,
            started_at=utcnow(),
        )
        db.add(job)
        db.flush()
    else:
        job.status = "running"
        job.attempt_count = (job.attempt_count or 0) + 1
        job.started_at = utcnow()
        job.error_message = None

    response.processing_status = "processing"
    response.pipeline_stage = "raw_ingestion"

    # Load version, questions, and validation rules
    version = db.execute(
        select(SurveyVersion)
        .options(selectinload(SurveyVersion.questions).selectinload(Question.validation_rules))
        .where(SurveyVersion.id == response.survey_version_id)
    ).scalar_one_or_none()

    if version is None:
        raise ValueError(f"SurveyVersion {response.survey_version_id} not found")

    questions = sorted(version.questions, key=lambda q: q.order_index)
    question_map = {q.question_key: q for q in questions}

    # Existing analyst corrections (if reprocessing)
    existing_corrections: Dict[str, ResponseAnswer] = {}
    if preserve_corrections:
        for ans in response.answers:
            if ans.corrected_value is not None:
                existing_corrections[ans.question_key] = ans

    # Clear previously open automated quality issues before re-evaluating
    for existing_issue in list(response.quality_issues):
        if existing_issue.status == "open":
            db.delete(existing_issue)
    db.flush()

    raw_answers: Dict[str, Any] = {}
    if isinstance(response.raw_payload, dict):
        if "answers" in response.raw_payload and isinstance(response.raw_payload["answers"], dict):
            raw_answers = dict(response.raw_payload["answers"])
        else:
            raw_answers = dict(response.raw_payload)

    # Effective answers map incorporates any analyst corrections when re-scoring
    working_answers = dict(raw_answers)
    for qk, corr_ans in existing_corrections.items():
        working_answers[qk] = corr_ans.corrected_value

    new_issues: List[QualityIssue] = []

    def add_issue(
        issue_type: str,
        severity: str,
        rule_code: str,
        message: str,
        question: Optional[Question] = None,
        detected_value: Any = None,
        expected_constraint: Any = None,
    ) -> None:
        new_issues.append(
            QualityIssue(
                response_id=response.id,
                survey_id=response.survey_id,
                question_id=question.id if question else None,
                question_key=question.question_key if question else None,
                issue_type=issue_type,
                severity=severity,
                status="open",
                rule_code=rule_code,
                message=message,
                detected_value=detected_value,
                expected_constraint=expected_constraint,
            )
        )

    # ---------------- STAGE 1: raw_ingestion ----------------
    s_start = time.perf_counter()
    fp = compute_fingerprint(response.survey_version_id, response.district, raw_answers)
    response.fingerprint_hash = fp
    if not response.consent_given:
        add_issue(
            issue_type="validation_failure",
            severity="critical",
            rule_code="RULE_CONSENT_REQUIRED",
            message="Respondent consent was not recorded prior to submission.",
            detected_value=False,
            expected_constraint={"consent_given": True},
        )
    if not response.location_consent_given and (response.latitude is not None or response.longitude is not None):
        add_issue(
            issue_type="schema_error",
            severity="warning",
            rule_code="RULE_LOCATION_CONSENT_MISMATCH",
            message="GPS coordinates present without explicit location consent; coordinates stripped from normalized record.",
            detected_value={"lat": response.latitude, "lng": response.longitude},
            expected_constraint={"location_consent_given": True},
        )
    stages_log.append({"stage": "raw_ingestion", "status": "completed", "duration_ms": round((time.perf_counter() - s_start) * 1000, 2)})

    # ---------------- STAGE 2: schema_validation ----------------
    s_start = time.perf_counter()
    response.pipeline_stage = "schema_validation"
    unknown_keys = [k for k in raw_answers.keys() if k not in question_map]
    if unknown_keys:
        add_issue(
            issue_type="schema_error",
            severity="warning",
            rule_code="RULE_UNKNOWN_SCHEMA_KEYS",
            message=f"Payload contains unrecognized question keys: {', '.join(unknown_keys[:5])}",
            detected_value=unknown_keys,
            expected_constraint={"allowed_keys": list(question_map.keys())},
        )
    stages_log.append({"stage": "schema_validation", "status": "completed", "duration_ms": round((time.perf_counter() - s_start) * 1000, 2)})

    # ---------------- STAGE 3: required_field_validation ----------------
    s_start = time.perf_counter()
    response.pipeline_stage = "required_field_validation"
    visible_questions: List[Question] = []
    for q in questions:
        is_visible = evaluate_conditional_logic(q.conditional_logic, working_answers)
        if is_visible:
            visible_questions.append(q)
            val = working_answers.get(q.question_key)
            if q.is_required and is_empty_value(val):
                add_issue(
                    issue_type="missing_value",
                    severity="critical",
                    rule_code="RULE_REQUIRED_MISSING",
                    message=f"Required question '{q.question_key}' ({q.prompt[:60]}) is missing a response.",
                    question=q,
                    detected_value=val,
                    expected_constraint={"required": True},
                )
    stages_log.append({
        "stage": "required_field_validation",
        "status": "completed",
        "duration_ms": round((time.perf_counter() - s_start) * 1000, 2),
        "visible_questions": len(visible_questions),
    })

    # ---------------- STAGE 4: duplicate_detection ----------------
    s_start = time.perf_counter()
    response.pipeline_stage = "duplicate_detection"
    window_start = response.submitted_at - timedelta(minutes=settings.DUPLICATE_WINDOW_MINUTES)
    dup_candidate = db.execute(
        select(Response.id)
        .where(
            Response.survey_id == response.survey_id,
            Response.fingerprint_hash == fp,
            Response.id != response.id,
            Response.submitted_at >= window_start,
            Response.submitted_at <= response.submitted_at,
        )
        .order_by(Response.submitted_at.asc())
        .limit(1)
    ).scalar_one_or_none()

    if dup_candidate is not None:
        response.is_duplicate = True
        response.duplicate_of_id = dup_candidate
        add_issue(
            issue_type="duplicate",
            severity="critical",
            rule_code="RULE_DUPLICATE_FINGERPRINT",
            message=f"Exact answer fingerprint matches earlier response {str(dup_candidate)[:8]} within {settings.DUPLICATE_WINDOW_MINUTES}m window.",
            detected_value={"fingerprint_hash": fp[:16], "duplicate_of_id": str(dup_candidate)},
            expected_constraint={"unique_within_minutes": settings.DUPLICATE_WINDOW_MINUTES},
        )
    else:
        response.is_duplicate = False
        response.duplicate_of_id = None

    stages_log.append({
        "stage": "duplicate_detection",
        "status": "completed",
        "duration_ms": round((time.perf_counter() - s_start) * 1000, 2),
        "is_duplicate": response.is_duplicate,
    })

    # ---------------- STAGE 5: data_normalization ----------------
    s_start = time.perf_counter()
    response.pipeline_stage = "data_normalization"

    # Map existing answers for update vs insert
    existing_ans_by_key = {a.question_key: a for a in response.answers}
    normalized_payload: Dict[str, Any] = {}
    rating_values: List[float] = []
    answer_meta: Dict[str, Tuple[Question, Any, Optional[float], bool]] = {}

    for q in questions:
        raw_val = raw_answers.get(q.question_key)
        is_visible = q in visible_questions

        norm_val, num_val, text_val, type_err = normalize_answer_value(q.question_type, raw_val, q.options)

        # Check if analyst already corrected this answer
        corr_obj = existing_corrections.get(q.question_key)
        if corr_obj is not None:
            eff_norm, eff_num, eff_text, eff_err = normalize_answer_value(q.question_type, corr_obj.corrected_value, q.options)
            effective_val = eff_norm
            active_num = eff_num
            active_text = eff_text
            active_err = eff_err
        else:
            effective_val = norm_val
            active_num = num_val
            active_text = text_val
            active_err = type_err

        is_missing = is_empty_value(effective_val)
        is_valid = active_err is None and not (is_visible and q.is_required and is_missing)
        is_outlier = False

        if active_err and is_visible:
            add_issue(
                issue_type="schema_error",
                severity="critical",
                rule_code="RULE_TYPE_VALIDATION",
                message=f"Question '{q.question_key}': {active_err}",
                question=q,
                detected_value=raw_val,
                expected_constraint={"question_type": q.question_type},
            )

        # Evaluate question-specific validation rules on effective value
        if is_visible and not is_missing and active_err is None:
            for rule in q.validation_rules:
                violation = evaluate_validation_rule(rule, effective_val, active_num)
                if violation:
                    v_type, v_code, v_msg = violation
                    if v_type == "outlier":
                        is_outlier = True
                    else:
                        is_valid = False
                    add_issue(
                        issue_type=v_type,
                        severity=rule.severity,
                        rule_code=v_code,
                        message=v_msg,
                        question=q,
                        detected_value=effective_val,
                        expected_constraint=rule.rule_config,
                    )

        if q.question_type == "rating" and active_num is not None:
            rating_values.append(active_num)

        normalized_payload[q.question_key] = effective_val
        answer_meta[q.question_key] = (q, effective_val, active_num, is_outlier)

        if q.question_key in existing_ans_by_key:
            ans = existing_ans_by_key[q.question_key]
            # Never mutate ans.raw_value!
            ans.normalized_value = norm_val
            ans.effective_value = effective_val
            ans.numeric_value = active_num
            ans.text_value = active_text
            ans.is_valid = is_valid
            ans.is_missing = is_missing
            ans.is_outlier = is_outlier
        else:
            ans = ResponseAnswer(
                response_id=response.id,
                question_id=q.id,
                question_key=q.question_key,
                raw_value=raw_val,
                normalized_value=norm_val,
                corrected_value=None,
                effective_value=effective_val,
                numeric_value=active_num,
                text_value=active_text,
                is_valid=is_valid,
                is_missing=is_missing,
                is_outlier=is_outlier,
            )
            db.add(ans)

    response.normalized_payload = normalized_payload
    stages_log.append({"stage": "data_normalization", "status": "completed", "duration_ms": round((time.perf_counter() - s_start) * 1000, 2)})

    # ---------------- STAGE 6: quality_scoring ----------------
    s_start = time.perf_counter()
    response.pipeline_stage = "quality_scoring"

    # Suspicious completion duration checks
    min_expected_seconds = max(12, int(len(visible_questions) * settings.MIN_COMPLETION_SECONDS_PER_QUESTION))
    if response.duration_seconds is not None:
        if response.duration_seconds < min_expected_seconds:
            sev = "critical" if response.duration_seconds < max(8, min_expected_seconds * 0.45) else "warning"
            add_issue(
                issue_type="suspicious_duration",
                severity=sev,
                rule_code="RULE_SPEEDING_SUBMISSION",
                message=f"Completed in {response.duration_seconds}s across {len(visible_questions)} questions (minimum expected {min_expected_seconds}s).",
                detected_value={"duration_seconds": response.duration_seconds},
                expected_constraint={"min_seconds": min_expected_seconds},
            )
        elif response.duration_seconds > 3600:
            add_issue(
                issue_type="suspicious_duration",
                severity="warning",
                rule_code="RULE_ABNORMAL_IDLE_DURATION",
                message=f"Completion duration of {response.duration_seconds}s exceeds 60-minute operational window.",
                detected_value={"duration_seconds": response.duration_seconds},
                expected_constraint={"max_seconds": 3600},
            )

    # Straight-lining check across rating questions
    if len(rating_values) >= 3 and len(set(rating_values)) == 1:
        add_issue(
            issue_type="straight_lining",
            severity="warning",
            rule_code="RULE_STRAIGHT_LINING",
            message=f"Identical rating ({int(rating_values[0])}) submitted across all {len(rating_values)} scale questions.",
            detected_value=rating_values,
            expected_constraint={"min_variance": True},
        )

    # Compute deterministic score 0..100
    score = 100.0
    critical_count = 0
    warning_count = 0
    for issue in new_issues:
        if issue.severity == "critical":
            score -= 28.0
            critical_count += 1
        elif issue.severity == "warning":
            score -= 12.0
            warning_count += 1
        else:
            score -= 4.0

    # Minor completeness bonus/penalty for optional questions
    answered_visible = sum(1 for q in visible_questions if not is_empty_value(normalized_payload.get(q.question_key)))
    if visible_questions:
        completeness_ratio = answered_visible / len(visible_questions)
        if completeness_ratio < 0.85:
            score -= round((0.85 - completeness_ratio) * 20.0, 2)

    score = round(max(0.0, min(100.0, score)), 2)
    response.quality_score = score

    for issue in new_issues:
        db.add(issue)

    stages_log.append({
        "stage": "quality_scoring",
        "status": "completed",
        "duration_ms": round((time.perf_counter() - s_start) * 1000, 2),
        "quality_score": score,
        "issues_found": len(new_issues),
    })

    # ---------------- STAGE 7/8/9: routing & dataset materialization ----------------
    s_start = time.perf_counter()
    if response.is_duplicate or not response.consent_given or score < settings.QUALITY_REJECT_THRESHOLD or critical_count >= 2:
        response.processing_status = "rejected"
        response.pipeline_stage = "rejected_record_handling"
        notify_level = "critical" if critical_count >= 2 or response.is_duplicate else "warning"
        stage_name = "rejected_record_handling"
    elif len(new_issues) > 0 or score < settings.QUALITY_AUTO_APPROVE_THRESHOLD:
        response.processing_status = "flagged"
        response.pipeline_stage = "analyst_review"
        notify_level = "warning"
        stage_name = "analyst_review"
    else:
        response.processing_status = "approved"
        response.pipeline_stage = "approved_dataset_generation"
        notify_level = "none"
        stage_name = "approved_dataset_generation"

    stages_log.append({"stage": stage_name, "status": "completed", "duration_ms": round((time.perf_counter() - s_start) * 1000, 2)})

    total_ms = int(round((time.perf_counter() - t0) * 1000))
    job.status = "completed"
    job.current_stage = response.pipeline_stage
    job.stages_completed = stages_log
    job.processed_items = 1
    job.failed_items = 0
    job.completed_at = utcnow()
    job.duration_ms = total_ms

    # Record complete audit event
    db.add(
        AuditEvent(
            entity_type="response",
            entity_id=str(response.id),
            action=f"pipeline.{response.processing_status}",
            actor_type="pipeline",
            summary=f"Pipeline completed ({response.processing_status}, score={score}, issues={len(new_issues)}) in {total_ms}ms",
            after_state={
                "processing_status": response.processing_status,
                "pipeline_stage": response.pipeline_stage,
                "quality_score": score,
                "issue_count": len(new_issues),
                "is_duplicate": response.is_duplicate,
            },
            metadata_json={"job_id": str(job.id), "duration_ms": total_ms, "survey_id": str(response.survey_id)},
            notify_level=notify_level,
        )
    )

    db.commit()

    if emit_events:
        publish_live_event(
            "response.processed",
            {
                "response_id": str(response.id),
                "survey_id": str(response.survey_id),
                "district": response.district,
                "processing_status": response.processing_status,
                "pipeline_stage": response.pipeline_stage,
                "quality_score": score,
                "issue_count": len(new_issues),
                "duration_ms": total_ms,
            },
        )

    return response
