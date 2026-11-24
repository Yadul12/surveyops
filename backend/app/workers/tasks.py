import time
import uuid
from typing import List, Optional

from app.core.logging import get_logger
from app.db.base import utcnow
from app.db.session import SessionLocal
from app.models.models import ProcessingJob, Response
from app.pipeline.engine import process_response_pipeline
from app.services.events import publish_live_event
from app.workers.celery_app import celery_app

logger = get_logger("surveyops.workers")


@celery_app.task(bind=True, max_retries=3, default_retry_delay=5, name="surveyops.process_response")
def process_response_task(self, response_id: str, job_id: Optional[str] = None) -> dict:
    db = SessionLocal()
    try:
        resp_uuid = uuid.UUID(response_id)
        job_uuid = uuid.UUID(job_id) if job_id else None
        if job_uuid:
            job = db.get(ProcessingJob, job_uuid)
            if job:
                job.celery_task_id = self.request.id
                db.commit()
        response = process_response_pipeline(db, resp_uuid, job_id=job_uuid, emit_events=True)
        return {
            "response_id": str(response.id),
            "processing_status": response.processing_status,
            "quality_score": response.quality_score,
        }
    except Exception as exc:
        db.rollback()
        if job_id:
            try:
                job = db.get(ProcessingJob, uuid.UUID(job_id))
                if job:
                    job.attempt_count = (job.attempt_count or 0) + 1
                    job.error_message = str(exc)
                    job.status = "retrying" if self.request.retries < self.max_retries else "failed"
                    db.commit()
            except Exception:
                db.rollback()
        logger.error("Failed processing response %s: %s", response_id, exc)
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=2 ** self.request.retries)
        raise
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=3, default_retry_delay=10, name="surveyops.process_batch")
def process_batch_task(self, response_ids: List[str], batch_job_id: str) -> dict:
    db = SessionLocal()
    t0 = time.perf_counter()
    processed = 0
    failed = 0
    job = db.get(ProcessingJob, uuid.UUID(batch_job_id))
    try:
        if job:
            job.status = "running"
            job.celery_task_id = self.request.id
            job.attempt_count = (job.attempt_count or 0) + 1
            job.started_at = utcnow()
            db.commit()

        for rid in response_ids:
            try:
                process_response_pipeline(db, uuid.UUID(rid), emit_events=False)
                processed += 1
            except Exception as item_exc:
                db.rollback()
                failed += 1
                logger.warning("Batch item %s failed: %s", rid, item_exc)

            if job and (processed + failed) % 50 == 0:
                job.processed_items = processed
                job.failed_items = failed
                db.commit()

        duration_ms = int(round((time.perf_counter() - t0) * 1000))
        if job:
            job.processed_items = processed
            job.failed_items = failed
            job.status = "completed" if failed == 0 else ("completed" if processed > 0 else "failed")
            job.current_stage = "approved_dataset_generation"
            job.completed_at = utcnow()
            job.duration_ms = duration_ms
            db.commit()

        publish_live_event(
            "batch.processed",
            {
                "batch_job_id": batch_job_id,
                "total": len(response_ids),
                "processed": processed,
                "failed": failed,
                "duration_ms": duration_ms,
            },
        )
        return {"batch_job_id": batch_job_id, "processed": processed, "failed": failed, "duration_ms": duration_ms}
    except Exception as exc:
        db.rollback()
        if job:
            job.status = "retrying" if self.request.retries < self.max_retries else "failed"
            job.error_message = str(exc)
            db.commit()
        if self.request.retries < self.max_retries:
            raise self.retry(exc=exc, countdown=2 ** self.request.retries)
        raise
    finally:
        db.close()
