import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import require_roles
from app.db.base import utcnow
from app.db.session import get_db
from app.models.models import (
    AuditEvent,
    QualityIssue,
    Response,
    ResponseAnswer,
    Survey,
    User,
)
from app.pipeline.engine import normalize_answer_value, process_response_pipeline
from app.schemas.schemas import AnswerCorrectionRequest, BulkApproveRequest, IssueActionRequest, ResponseDecisionRequest
from app.services.events import publish_live_event

router = APIRouter(prefix="/quality", tags=["Data Quality Console"])


@router.get("/issues")
def list_quality_issues(
    survey_id: Optional[uuid.UUID] = Query(default=None),
    issue_type: Optional[str] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default="open", alias="status"),
    search: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin", "analyst")),
):
    stmt = (
        select(QualityIssue)
        .options(selectinload(QualityIssue.response).selectinload(Response.survey))
        .order_by(QualityIssue.created_at.desc())
    )
    if survey_id:
        stmt = stmt.where(QualityIssue.survey_id == survey_id)
    if issue_type and issue_type != "all":
        stmt = stmt.where(QualityIssue.issue_type == issue_type)
    if severity and severity != "all":
        stmt = stmt.where(QualityIssue.severity == severity)
    if status_filter and status_filter != "all":
        stmt = stmt.where(QualityIssue.status == status_filter)
    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            (QualityIssue.message.ilike(term))
            | (QualityIssue.rule_code.ilike(term))
            | (QualityIssue.question_key.ilike(term))
        )

    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).scalars().all()

    # Summary counts for filter tabs
    tab_rows = db.execute(
        select(QualityIssue.issue_type, func.count(QualityIssue.id))
        .where(QualityIssue.status == "open")
        .group_by(QualityIssue.issue_type)
    ).all()
    open_by_type = {t: int(c) for t, c in tab_rows}

    items = []
    for qi in rows:
        resp = qi.response
        items.append(
            {
                "id": str(qi.id),
                "response_id": str(qi.response_id),
                "client_submission_id": resp.client_submission_id if resp else "",
                "survey_id": str(qi.survey_id),
                "survey_code": resp.survey.code if resp and resp.survey else "",
                "survey_title": resp.survey.title if resp and resp.survey else "",
                "district": resp.district if resp else "",
                "response_status": resp.processing_status if resp else "",
                "quality_score": resp.quality_score if resp else None,
                "question_key": qi.question_key,
                "issue_type": qi.issue_type,
                "severity": qi.severity,
                "status": qi.status,
                "rule_code": qi.rule_code,
                "message": qi.message,
                "detected_value": qi.detected_value,
                "expected_constraint": qi.expected_constraint,
                "resolution_note": qi.resolution_note,
                "created_at": qi.created_at.isoformat(),
            }
        )

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "open_by_type": open_by_type,
    }


@router.patch("/responses/{response_id}/answers/{question_key}")
def correct_response_answer(
    response_id: uuid.UUID,
    question_key: str,
    payload: AnswerCorrectionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    """
    Explicitly apply an analyst correction to a normalized answer.
    IMMUTABILITY GUARANTEE: raw_payload and raw_value are NEVER modified.
    """
    resp = db.execute(
        select(Response)
        .options(selectinload(Response.answers).selectinload(ResponseAnswer.question))
        .where(Response.id == response_id)
    ).scalar_one_or_none()
    if not resp:
        raise HTTPException(status_code=404, detail="Response not found.")

    ans = next((a for a in resp.answers if a.question_key == question_key), None)
    if not ans:
        raise HTTPException(status_code=404, detail=f"Answer for question '{question_key}' not found on response.")

    q = ans.question
    norm_val, num_val, text_val, type_err = normalize_answer_value(
        q.question_type if q else "short_text",
        payload.corrected_value,
        q.options if q else [],
    )
    if type_err:
        raise HTTPException(status_code=422, detail=f"Invalid correction value: {type_err}")

    before_effective = ans.effective_value

    # NEVER modify ans.raw_value or resp.raw_payload
    ans.corrected_value = norm_val
    ans.effective_value = norm_val
    ans.numeric_value = num_val
    ans.text_value = text_val
    ans.is_valid = True
    ans.is_missing = False
    ans.is_outlier = False
    ans.corrected_by_id = current_user.id
    ans.corrected_at = utcnow()
    ans.correction_reason = payload.correction_reason.strip()

    # Update normalized_payload effective mirror without touching raw_payload
    norm_copy = dict(resp.normalized_payload or {})
    norm_copy[question_key] = norm_val
    resp.normalized_payload = norm_copy

    # Resolve open issues on this question
    open_q_issues = db.execute(
        select(QualityIssue).where(
            QualityIssue.response_id == response_id,
            QualityIssue.question_key == question_key,
            QualityIssue.status == "open",
        )
    ).scalars().all()
    for qi in open_q_issues:
        qi.status = "resolved"
        qi.resolved_by_id = current_user.id
        qi.resolved_at = utcnow()
        qi.resolution_note = f"Analyst corrected value: {payload.correction_reason.strip()}"

    db.add(
        AuditEvent(
            entity_type="response",
            entity_id=str(resp.id),
            action="analyst.corrected_answer",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Corrected '{question_key}' from {before_effective!r} to {norm_val!r} (raw immutable). Reason: {payload.correction_reason}",
            before_state={"question_key": question_key, "effective_value": before_effective, "raw_value": ans.raw_value},
            after_state={"question_key": question_key, "corrected_value": norm_val, "raw_value_unchanged": ans.raw_value},
            notify_level="info",
        )
    )
    db.commit()

    if payload.reprocess:
        process_response_pipeline(db, response_id, emit_events=True, preserve_corrections=True)
        db.refresh(resp)

    return {
        "response_id": str(resp.id),
        "question_key": question_key,
        "raw_value": ans.raw_value,
        "corrected_value": ans.corrected_value,
        "effective_value": ans.effective_value,
        "processing_status": resp.processing_status,
        "quality_score": resp.quality_score,
    }


@router.post("/responses/{response_id}/decision")
def decide_response_review(
    response_id: uuid.UUID,
    payload: ResponseDecisionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    resp = db.execute(
        select(Response).options(selectinload(Response.quality_issues)).where(Response.id == response_id)
    ).scalar_one_or_none()
    if not resp:
        raise HTTPException(status_code=404, detail="Response not found.")

    before_status = resp.processing_status
    if payload.decision == "approve":
        resp.processing_status = "approved"
        resp.pipeline_stage = "approved_dataset_generation"
        if payload.resolve_open_issues:
            for qi in resp.quality_issues:
                if qi.status == "open":
                    qi.status = "resolved"
                    qi.resolved_by_id = current_user.id
                    qi.resolved_at = utcnow()
                    qi.resolution_note = payload.review_notes or "Approved by analyst during quality review."
    elif payload.decision == "reject":
        resp.processing_status = "rejected"
        resp.pipeline_stage = "rejected_record_handling"
        if payload.resolve_open_issues:
            for qi in resp.quality_issues:
                if qi.status == "open":
                    qi.status = "resolved"
                    qi.resolved_by_id = current_user.id
                    qi.resolved_at = utcnow()
                    qi.resolution_note = payload.review_notes or "Record rejected by analyst."
    else:
        resp.processing_status = "flagged"
        resp.pipeline_stage = "analyst_review"

    resp.reviewed_by_id = current_user.id
    resp.reviewed_at = utcnow()
    resp.review_notes = payload.review_notes.strip() or f"Marked {payload.decision} by {current_user.full_name}."

    db.add(
        AuditEvent(
            entity_type="response",
            entity_id=str(resp.id),
            action=f"analyst.{payload.decision}_response",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Analyst {payload.decision}d response {resp.client_submission_id} ({before_status} -> {resp.processing_status}).",
            before_state={"processing_status": before_status},
            after_state={"processing_status": resp.processing_status, "review_notes": resp.review_notes},
            notify_level="info",
        )
    )
    db.commit()

    publish_live_event(
        f"quality.{payload.decision}",
        {
            "response_id": str(resp.id),
            "survey_id": str(resp.survey_id),
            "processing_status": resp.processing_status,
            "analyst": current_user.full_name,
        },
    )
    return {
        "response_id": str(resp.id),
        "processing_status": resp.processing_status,
        "pipeline_stage": resp.pipeline_stage,
        "reviewed_at": resp.reviewed_at.isoformat(),
    }


@router.patch("/issues/{issue_id}")
def update_quality_issue_status(
    issue_id: uuid.UUID,
    payload: IssueActionRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    qi = db.get(QualityIssue, issue_id)
    if not qi:
        raise HTTPException(status_code=404, detail="Quality issue not found.")

    qi.status = payload.status
    qi.resolution_note = payload.resolution_note.strip()
    if payload.status in ("resolved", "dismissed"):
        qi.resolved_by_id = current_user.id
        qi.resolved_at = utcnow()
    else:
        qi.resolved_by_id = None
        qi.resolved_at = None

    db.add(
        AuditEvent(
            entity_type="response",
            entity_id=str(qi.response_id),
            action=f"quality_issue.{payload.status}",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Marked issue {qi.rule_code} as {payload.status}. {qi.resolution_note}",
        )
    )
    db.commit()
    return {"id": str(qi.id), "status": qi.status, "resolution_note": qi.resolution_note}


@router.post("/responses/bulk-approve")
def bulk_approve_responses(
    payload: BulkApproveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    responses = db.execute(
        select(Response).options(selectinload(Response.quality_issues)).where(Response.id.in_(payload.response_ids))
    ).scalars().all()

    approved_count = 0
    for resp in responses:
        resp.processing_status = "approved"
        resp.pipeline_stage = "approved_dataset_generation"
        resp.reviewed_by_id = current_user.id
        resp.reviewed_at = utcnow()
        resp.review_notes = payload.review_notes
        for qi in resp.quality_issues:
            if qi.status == "open":
                qi.status = "resolved"
                qi.resolved_by_id = current_user.id
                qi.resolved_at = utcnow()
                qi.resolution_note = payload.review_notes
        approved_count += 1

    db.add(
        AuditEvent(
            entity_type="quality_issue",
            entity_id="bulk",
            action="analyst.bulk_approve",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Bulk approved {approved_count} responses into clean analytical dataset.",
            notify_level="info",
        )
    )
    db.commit()
    return {"approved_count": approved_count}
