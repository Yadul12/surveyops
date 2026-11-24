import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, require_roles
from app.core.config import settings
from app.db.session import get_db
from app.models.models import AuditEvent, ProcessingJob, Response, User
from app.pipeline.engine import process_response_pipeline

router = APIRouter(prefix="/pipeline", tags=["Response Processing Pipeline"])


@router.get("/summary")
def get_pipeline_summary(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stage_rows = db.execute(
        select(Response.pipeline_stage, func.count(Response.id)).group_by(Response.pipeline_stage)
    ).all()
    status_rows = db.execute(
        select(Response.processing_status, func.count(Response.id)).group_by(Response.processing_status)
    ).all()
    job_rows = db.execute(
        select(
            ProcessingJob.status,
            func.count(ProcessingJob.id),
            func.avg(ProcessingJob.duration_ms),
        ).group_by(ProcessingJob.status)
    ).all()

    return {
        "by_stage": {stage: int(cnt) for stage, cnt in stage_rows},
        "by_response_status": {st: int(cnt) for st, cnt in status_rows},
        "jobs_by_status": {
            st: {"count": int(cnt), "avg_duration_ms": round(float(avg_ms or 0), 1)}
            for st, cnt, avg_ms in job_rows
        },
        "stages_ordered": [
            "raw_ingestion",
            "schema_validation",
            "required_field_validation",
            "duplicate_detection",
            "data_normalization",
            "quality_scoring",
            "rejected_record_handling",
            "analyst_review",
            "approved_dataset_generation",
        ],
    }


@router.get("/jobs")
def list_processing_jobs(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    job_type: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(ProcessingJob).order_by(ProcessingJob.created_at.desc())
    if status_filter and status_filter != "all":
        stmt = stmt.where(ProcessingJob.status == status_filter)
    if job_type and job_type != "all":
        stmt = stmt.where(ProcessingJob.job_type == job_type)

    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).scalars().all()

    return {
        "items": [
            {
                "id": str(j.id),
                "batch_id": j.batch_id,
                "response_id": str(j.response_id) if j.response_id else None,
                "job_type": j.job_type,
                "status": j.status,
                "current_stage": j.current_stage,
                "stages_completed": j.stages_completed,
                "total_items": j.total_items,
                "processed_items": j.processed_items,
                "failed_items": j.failed_items,
                "attempt_count": j.attempt_count,
                "max_attempts": j.max_attempts,
                "celery_task_id": j.celery_task_id,
                "error_message": j.error_message,
                "duration_ms": j.duration_ms,
                "started_at": j.started_at.isoformat() if j.started_at else None,
                "completed_at": j.completed_at.isoformat() if j.completed_at else None,
                "created_at": j.created_at.isoformat(),
            }
            for j in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/jobs/{job_id}/retry")
def retry_processing_job(
    job_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    job = db.get(ProcessingJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Processing job not found.")
    if not job.response_id:
        raise HTTPException(status_code=400, detail="Only response-scoped jobs can be individually retried.")

    job.status = "queued"
    job.error_message = None
    db.add(
        AuditEvent(
            entity_type="processing_job",
            entity_id=str(job.id),
            action="pipeline.manual_retry",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Manual pipeline retry triggered for response {str(job.response_id)[:8]}.",
        )
    )
    db.commit()

    if settings.effective_pipeline_eager_mode:
        resp = process_response_pipeline(db, job.response_id, job_id=job.id, emit_events=True)
        return {"job_id": str(job.id), "status": job.status, "response_status": resp.processing_status}

    try:
        from app.workers.tasks import process_response_task

        task = process_response_task.delay(str(job.response_id), str(job.id))
        job.celery_task_id = task.id
        db.commit()
    except Exception:
        process_response_pipeline(db, job.response_id, job_id=job.id, emit_events=True)
    return {"job_id": str(job.id), "status": job.status}


@router.post("/responses/{response_id}/reprocess")
def reprocess_response(
    response_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    resp = db.get(Response, response_id)
    if not resp:
        raise HTTPException(status_code=404, detail="Response not found.")

    updated = process_response_pipeline(db, response_id, emit_events=True, preserve_corrections=True)
    return {
        "response_id": str(updated.id),
        "processing_status": updated.processing_status,
        "pipeline_stage": updated.pipeline_stage,
        "quality_score": updated.quality_score,
    }
