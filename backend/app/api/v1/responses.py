import csv
import io
import time
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_roles
from app.core.config import settings
from app.core.logging import get_logger
from app.db.base import utcnow
from app.db.session import get_db
from app.models.models import (
    AuditEvent,
    ProcessingJob,
    Question,
    Respondent,
    Response,
    ResponseAnswer,
    Survey,
    SurveyAssignment,
    SurveyVersion,
    User,
)
from app.pipeline.engine import evaluate_conditional_logic, process_response_pipeline
from app.schemas.schemas import BatchResponseSubmitRequest, ResponseSubmitRequest
from app.services.events import publish_live_event

logger = get_logger("surveyops.api.responses")
router = APIRouter(prefix="/responses", tags=["Responses & Ingestion"])


def _ingest_single_record(
    db: Session,
    payload: ResponseSubmitRequest,
    actor: User,
) -> tuple[Response, bool]:
    """
    Idempotently ingest a raw response record.
    Returns (response, created_new). If client_submission_id already exists, returns existing record safely.
    """
    existing = db.execute(
        select(Response).where(Response.client_submission_id == payload.client_submission_id)
    ).scalar_one_or_none()
    if existing:
        return existing, False

    survey = db.get(Survey, payload.survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail=f"Survey {payload.survey_id} not found.")

    version_id = payload.survey_version_id or survey.active_version_id
    if not version_id:
        raise HTTPException(status_code=400, detail="Survey has no published active version.")

    # Create respondent if provided
    respondent_id = None
    if payload.respondent:
        resp_entity = Respondent(
            external_ref=payload.respondent.external_ref,
            district=payload.respondent.district or payload.district,
            ward=payload.respondent.ward,
            age_bracket=payload.respondent.age_bracket,
            household_size=payload.respondent.household_size,
            consent_given=payload.consent_given,
            consent_timestamp=payload.started_at or utcnow(),
            location_consent_given=payload.location_consent_given,
        )
        db.add(resp_entity)
        db.flush()
        respondent_id = resp_entity.id

    # Respect privacy rule: store coordinates only when location consent is given AND survey allows it
    lat = payload.latitude if (payload.location_consent_given and survey.allow_location_capture) else None
    lng = payload.longitude if (payload.location_consent_given and survey.allow_location_capture) else None
    acc = payload.location_accuracy_m if (lat is not None and lng is not None) else None

    submitted_ts = payload.submitted_at or utcnow()
    duration = payload.duration_seconds
    if duration is None and payload.started_at:
        delta = (submitted_ts - payload.started_at).total_seconds()
        duration = max(0, int(delta))

    raw_snapshot = {
        "answers": payload.answers,
        "client_submission_id": payload.client_submission_id,
        "district": payload.district,
        "consent_given": payload.consent_given,
        "location_consent_given": payload.location_consent_given,
        "captured_at": submitted_ts.isoformat(),
    }

    response_obj = Response(
        client_submission_id=payload.client_submission_id,
        survey_id=survey.id,
        survey_version_id=version_id,
        assignment_id=payload.assignment_id,
        agent_id=actor.id,
        respondent_id=respondent_id,
        raw_payload=raw_snapshot,
        processing_status="ingested",
        pipeline_stage="raw_ingestion",
        consent_given=payload.consent_given,
        location_consent_given=payload.location_consent_given,
        latitude=lat,
        longitude=lng,
        location_accuracy_m=acc,
        district=payload.district or actor.region or "Metro Central",
        started_at=payload.started_at,
        submitted_at=submitted_ts,
        synced_at=utcnow(),
        duration_seconds=duration,
        source_channel=payload.source_channel,
        device_info=payload.device_info or {},
    )
    db.add(response_obj)
    db.flush()

    if payload.assignment_id:
        asgn = db.get(SurveyAssignment, payload.assignment_id)
        if asgn:
            asgn.collected_count = (asgn.collected_count or 0) + 1

    db.add(
        AuditEvent(
            entity_type="response",
            entity_id=str(response_obj.id),
            action="response.ingested",
            actor_id=actor.id,
            actor_type="user",
            summary=f"Raw response ingested via {payload.source_channel} ({response_obj.district}).",
            after_state={
                "client_submission_id": payload.client_submission_id,
                "processing_status": "ingested",
                "source_channel": payload.source_channel,
            },
            metadata_json={"survey_id": str(survey.id)},
        )
    )
    return response_obj, True


def _dispatch_single_pipeline(db: Session, response: Response, force_sync: bool = False) -> ProcessingJob:
    job = ProcessingJob(
        response_id=response.id,
        job_type="single_response",
        status="queued",
        current_stage="raw_ingestion",
        total_items=1,
        processed_items=0,
    )
    db.add(job)
    db.commit()

    if force_sync or settings.effective_pipeline_eager_mode:
        process_response_pipeline(db, response.id, job_id=job.id, emit_events=True)
        db.refresh(job)
        db.refresh(response)
    else:
        try:
            from app.workers.tasks import process_response_task

            task = process_response_task.delay(str(response.id), str(job.id))
            job.celery_task_id = task.id
            db.commit()
        except Exception as exc:
            logger.warning("Celery broker unavailable (%s); falling back to synchronous pipeline execution.", exc)
            process_response_pipeline(db, response.id, job_id=job.id, emit_events=True)
            db.refresh(job)
            db.refresh(response)
    return job


@router.post("", status_code=status.HTTP_201_CREATED)
def submit_response(
    payload: ResponseSubmitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    response_obj, created = _ingest_single_record(db, payload, current_user)
    if not created:
        return {
            "id": str(response_obj.id),
            "client_submission_id": response_obj.client_submission_id,
            "idempotent_replay": True,
            "processing_status": response_obj.processing_status,
            "pipeline_stage": response_obj.pipeline_stage,
            "quality_score": response_obj.quality_score,
        }

    job = _dispatch_single_pipeline(db, response_obj, force_sync=payload.process_sync)
    publish_live_event(
        "response.ingested",
        {
            "response_id": str(response_obj.id),
            "survey_id": str(response_obj.survey_id),
            "district": response_obj.district,
            "source_channel": response_obj.source_channel,
        },
    )
    return {
        "id": str(response_obj.id),
        "client_submission_id": response_obj.client_submission_id,
        "idempotent_replay": False,
        "job_id": str(job.id),
        "processing_status": response_obj.processing_status,
        "pipeline_stage": response_obj.pipeline_stage,
        "quality_score": response_obj.quality_score,
    }


@router.post("/batch", status_code=status.HTTP_202_ACCEPTED)
def submit_batch_responses(
    payload: BatchResponseSubmitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    batch_id = payload.batch_id or f"batch-{uuid.uuid4().hex[:10]}"
    ingested_ids: List[str] = []
    replayed_ids: List[str] = []
    results: List[dict] = []

    for item in payload.items:
        resp_obj, created = _ingest_single_record(db, item, current_user)
        if created:
            ingested_ids.append(str(resp_obj.id))
            results.append({
                "client_submission_id": item.client_submission_id,
                "response_id": str(resp_obj.id),
                "status": "ingested",
            })
        else:
            replayed_ids.append(str(resp_obj.id))
            results.append({
                "client_submission_id": item.client_submission_id,
                "response_id": str(resp_obj.id),
                "status": "idempotent_replay",
                "processing_status": resp_obj.processing_status,
            })

    job = ProcessingJob(
        batch_id=batch_id,
        job_type="batch_ingest",
        status="queued" if ingested_ids else "completed",
        current_stage="raw_ingestion" if ingested_ids else "approved_dataset_generation",
        total_items=len(ingested_ids),
        processed_items=0,
    )
    db.add(job)
    db.commit()

    if ingested_ids:
        if payload.process_sync or settings.effective_pipeline_eager_mode:
            t_batch = time.perf_counter()
            job.status = "running"
            job.attempt_count = 1
            job.started_at = utcnow()
            processed = 0
            for rid in ingested_ids:
                process_response_pipeline(db, uuid.UUID(rid), emit_events=False)
                processed += 1
            job.processed_items = processed
            job.status = "completed"
            job.current_stage = "approved_dataset_generation"
            job.completed_at = utcnow()
            job.duration_ms = max(1, int(round((time.perf_counter() - t_batch) * 1000)))
            db.commit()
        else:
            try:
                from app.workers.tasks import process_batch_task

                task = process_batch_task.delay(ingested_ids, str(job.id))
                job.celery_task_id = task.id
                db.commit()
            except Exception as exc:
                logger.warning("Celery unavailable for batch %s (%s); processing synchronously.", batch_id, exc)
                t_batch = time.perf_counter()
                job.status = "running"
                job.attempt_count = 1
                job.started_at = utcnow()
                processed = 0
                for rid in ingested_ids:
                    process_response_pipeline(db, uuid.UUID(rid), emit_events=False)
                    processed += 1
                job.processed_items = processed
                job.status = "completed"
                job.current_stage = "approved_dataset_generation"
                job.completed_at = utcnow()
                job.duration_ms = max(1, int(round((time.perf_counter() - t_batch) * 1000)))
                db.commit()

    return {
        "batch_id": batch_id,
        "job_id": str(job.id),
        "ingested_count": len(ingested_ids),
        "replayed_count": len(replayed_ids),
        "items": results,
    }


@router.get("")
def list_responses(
    survey_id: Optional[uuid.UUID] = Query(default=None),
    processing_status: Optional[str] = Query(default=None),
    district: Optional[str] = Query(default=None),
    agent_id: Optional[uuid.UUID] = Query(default=None),
    search: Optional[str] = Query(default=None),
    sort_by: str = Query(default="submitted_at"),
    sort_dir: str = Query(default="desc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = select(Response).options(
        selectinload(Response.survey),
        selectinload(Response.agent),
        selectinload(Response.quality_issues),
    )

    if current_user.role.name == "field_agent":
        stmt = stmt.where(Response.agent_id == current_user.id)
    elif agent_id:
        stmt = stmt.where(Response.agent_id == agent_id)

    if survey_id:
        stmt = stmt.where(Response.survey_id == survey_id)
    if processing_status and processing_status != "all":
        stmt = stmt.where(Response.processing_status == processing_status)
    if district and district != "all":
        stmt = stmt.where(Response.district == district)
    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            (Response.client_submission_id.ilike(term))
            | (Response.district.ilike(term))
            | (Response.pipeline_stage.ilike(term))
        )

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar() or 0)

    sort_col = {
        "submitted_at": Response.submitted_at,
        "quality_score": Response.quality_score,
        "processing_status": Response.processing_status,
        "duration_seconds": Response.duration_seconds,
        "district": Response.district,
    }.get(sort_by, Response.submitted_at)
    stmt = stmt.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    rows = db.execute(stmt).scalars().all()
    items = []
    for r in rows:
        open_issues = sum(1 for qi in (r.quality_issues or []) if qi.status == "open")
        items.append(
            {
                "id": str(r.id),
                "client_submission_id": r.client_submission_id,
                "survey_id": str(r.survey_id),
                "survey_code": r.survey.code if r.survey else "",
                "survey_title": r.survey.title if r.survey else "",
                "agent_name": r.agent.full_name if r.agent else "Batch / API",
                "district": r.district,
                "processing_status": r.processing_status,
                "pipeline_stage": r.pipeline_stage,
                "quality_score": r.quality_score,
                "is_duplicate": r.is_duplicate,
                "open_issue_count": open_issues,
                "total_issue_count": len(r.quality_issues or []),
                "duration_seconds": r.duration_seconds,
                "source_channel": r.source_channel,
                "location_consent_given": r.location_consent_given,
                "submitted_at": r.submitted_at.isoformat(),
                "synced_at": r.synced_at.isoformat() if r.synced_at else None,
            }
        )

    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/export/csv")
def export_clean_dataset_csv(
    survey_id: uuid.UUID = Query(...),
    status_filter: str = Query(default="approved"),
    district: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(require_roles("admin", "analyst")),
):
    survey = db.get(Survey, survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")

    version_id = survey.active_version_id
    version = db.execute(
        select(SurveyVersion)
        .options(selectinload(SurveyVersion.questions))
        .where(SurveyVersion.id == version_id)
    ).scalar_one_or_none()
    q_keys = [q.question_key for q in sorted(version.questions, key=lambda x: x.order_index)] if version else []

    stmt = (
        select(Response)
        .options(selectinload(Response.answers), selectinload(Response.agent))
        .where(Response.survey_id == survey_id)
        .order_by(Response.submitted_at.desc())
        .limit(10000)
    )
    if status_filter == "valid":
        stmt = stmt.where(Response.processing_status.in_(["approved", "validated"]))
    elif status_filter != "all":
        stmt = stmt.where(Response.processing_status == status_filter)
    if district and district != "all":
        stmt = stmt.where(Response.district == district)

    responses = db.execute(stmt).scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    header = [
        "response_id",
        "client_submission_id",
        "survey_code",
        "processing_status",
        "quality_score",
        "district",
        "agent",
        "duration_seconds",
        "source_channel",
        "consent_given",
        "location_consent_given",
        "latitude",
        "longitude",
        "submitted_at",
        *q_keys,
    ]
    writer.writerow(header)

    for r in responses:
        ans_map = {a.question_key: a.effective_value for a in (r.answers or [])}
        row = [
            str(r.id),
            r.client_submission_id,
            survey.code,
            r.processing_status,
            r.quality_score,
            r.district,
            r.agent.full_name if r.agent else "",
            r.duration_seconds,
            r.source_channel,
            r.consent_given,
            r.location_consent_given,
            r.latitude if r.location_consent_given else "",
            r.longitude if r.location_consent_given else "",
            r.submitted_at.isoformat(),
        ]
        for k in q_keys:
            val = ans_map.get(k)
            row.append("; ".join(map(str, val)) if isinstance(val, list) else ("" if val is None else val))
        writer.writerow(row)

    buf.seek(0)
    filename = f"surveyops_{survey.code.lower()}_{status_filter}_dataset.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{response_id}")
def get_response_detail(
    response_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    resp = db.execute(
        select(Response)
        .options(
            selectinload(Response.survey),
            selectinload(Response.survey_version).selectinload(SurveyVersion.questions),
            selectinload(Response.agent),
            selectinload(Response.reviewed_by),
            selectinload(Response.respondent),
            selectinload(Response.answers).selectinload(ResponseAnswer.question),
            selectinload(Response.quality_issues),
        )
        .where(Response.id == response_id)
    ).scalar_one_or_none()
    if not resp:
        raise HTTPException(status_code=404, detail="Response not found.")

    if current_user.role.name == "field_agent" and resp.agent_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Field agents may only inspect responses they submitted.",
        )

    effective_answers_map = {a.question_key: a.effective_value for a in (resp.answers or [])}

    audit_rows = db.execute(
        select(AuditEvent)
        .options(selectinload(AuditEvent.actor))
        .where(AuditEvent.entity_type == "response", AuditEvent.entity_id == str(resp.id))
        .order_by(AuditEvent.created_at.desc())
        .limit(50)
    ).scalars().all()

    jobs = db.execute(
        select(ProcessingJob)
        .where(ProcessingJob.response_id == resp.id)
        .order_by(ProcessingJob.created_at.desc())
        .limit(10)
    ).scalars().all()

    ordered_answers = sorted(
        resp.answers or [],
        key=lambda a: a.question.order_index if a.question else 999,
    )

    return {
        "id": str(resp.id),
        "client_submission_id": resp.client_submission_id,
        "survey_id": str(resp.survey_id),
        "survey_code": resp.survey.code if resp.survey else "",
        "survey_title": resp.survey.title if resp.survey else "",
        "survey_version_id": str(resp.survey_version_id),
        "version_number": resp.survey_version.version_number if resp.survey_version else 1,
        "agent_name": resp.agent.full_name if resp.agent else "Batch / API",
        "agent_email": resp.agent.email if resp.agent else "",
        "district": resp.district,
        "processing_status": resp.processing_status,
        "pipeline_stage": resp.pipeline_stage,
        "quality_score": resp.quality_score,
        "is_duplicate": resp.is_duplicate,
        "duplicate_of_id": str(resp.duplicate_of_id) if resp.duplicate_of_id else None,
        "fingerprint_hash": resp.fingerprint_hash,
        "consent_given": resp.consent_given,
        "location_consent_given": resp.location_consent_given,
        "latitude": resp.latitude,
        "longitude": resp.longitude,
        "location_accuracy_m": resp.location_accuracy_m,
        "duration_seconds": resp.duration_seconds,
        "source_channel": resp.source_channel,
        "device_info": resp.device_info,
        "started_at": resp.started_at.isoformat() if resp.started_at else None,
        "submitted_at": resp.submitted_at.isoformat(),
        "synced_at": resp.synced_at.isoformat() if resp.synced_at else None,
        "reviewed_by_name": resp.reviewed_by.full_name if resp.reviewed_by else None,
        "reviewed_at": resp.reviewed_at.isoformat() if resp.reviewed_at else None,
        "review_notes": resp.review_notes,
        "respondent": {
            "external_ref": resp.respondent.external_ref,
            "ward": resp.respondent.ward,
            "age_bracket": resp.respondent.age_bracket,
            "household_size": resp.respondent.household_size,
        }
        if resp.respondent
        else None,
        "raw_payload": resp.raw_payload,
        "normalized_payload": resp.normalized_payload,
        "answers": [
            {
                "id": str(a.id),
                "question_id": str(a.question_id),
                "question_key": a.question_key,
                "prompt": a.question.prompt if a.question else a.question_key,
                "question_type": a.question.question_type if a.question else "short_text",
                "options": a.question.options if a.question else [],
                "raw_value": a.raw_value,
                "normalized_value": a.normalized_value,
                "corrected_value": a.corrected_value,
                "effective_value": a.effective_value,
                "is_valid": a.is_valid,
                "is_missing": a.is_missing,
                "is_skipped": (
                    not evaluate_conditional_logic(a.question.conditional_logic, effective_answers_map)
                    if a.question and a.question.conditional_logic
                    else False
                ),
                "is_outlier": a.is_outlier,
                "corrected_at": a.corrected_at.isoformat() if a.corrected_at else None,
                "correction_reason": a.correction_reason,
            }
            for a in ordered_answers
        ],
        "quality_issues": [
            {
                "id": str(qi.id),
                "question_key": qi.question_key,
                "issue_type": qi.issue_type,
                "severity": qi.severity,
                "status": qi.status,
                "rule_code": qi.rule_code,
                "message": qi.message,
                "detected_value": qi.detected_value,
                "expected_constraint": qi.expected_constraint,
                "resolution_note": qi.resolution_note,
                "resolved_at": qi.resolved_at.isoformat() if qi.resolved_at else None,
                "created_at": qi.created_at.isoformat(),
            }
            for qi in (resp.quality_issues or [])
        ],
        "processing_jobs": [
            {
                "id": str(j.id),
                "job_type": j.job_type,
                "status": j.status,
                "current_stage": j.current_stage,
                "stages_completed": j.stages_completed,
                "attempt_count": j.attempt_count,
                "duration_ms": j.duration_ms,
                "error_message": j.error_message,
                "created_at": j.created_at.isoformat(),
            }
            for j in jobs
        ],
        "audit_history": [
            {
                "id": str(ae.id),
                "action": ae.action,
                "actor_type": ae.actor_type,
                "actor_name": ae.actor.full_name if ae.actor else ae.actor_type.title(),
                "summary": ae.summary,
                "before_state": ae.before_state,
                "after_state": ae.after_state,
                "created_at": ae.created_at.isoformat(),
            }
            for ae in audit_rows
        ],
    }
