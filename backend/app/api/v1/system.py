import asyncio
import json
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, selectinload

from app.api.deps import _resolve_user_from_token, get_current_user
from app.core.config import settings
from app.db.session import SessionLocal, get_db
from app.models.models import AuditEvent, QualityIssue, Report, Response, Survey, User
from app.services.events import EVENT_CHANNEL, get_recent_events, get_redis_client

router = APIRouter(tags=["System, Search & Live Updates"])


@router.get("/health")
def health_check(db: Session = Depends(get_db)):
    db_ok = False
    redis_ok = False
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        db_ok = False

    redis_configured = bool(settings.effective_redis_url)
    if redis_configured:
        try:
            r = get_redis_client()
            if r and r.ping():
                redis_ok = True
        except Exception:
            redis_ok = False

    return {
        "status": "healthy" if db_ok else "degraded",
        "service": settings.APP_NAME,
        "database": "connected" if db_ok else "error",
        "redis": "connected" if redis_ok else ("unavailable" if redis_configured else "eager_mode"),
        "pipeline_mode": "eager" if settings.effective_pipeline_eager_mode else "celery_worker",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/search")
def global_search(
    q: str = Query(min_length=1, max_length=120),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    term = f"%{q.strip()}%"
    is_agent = current_user.role.name == "field_agent"

    surveys = db.execute(
        select(Survey)
        .where((Survey.title.ilike(term)) | (Survey.code.ilike(term)) | (Survey.category.ilike(term)))
        .limit(6)
    ).scalars().all()

    resp_stmt = (
        select(Response)
        .options(selectinload(Response.survey))
        .where((Response.client_submission_id.ilike(term)) | (Response.district.ilike(term)))
        .order_by(Response.submitted_at.desc())
        .limit(6)
    )
    if is_agent:
        resp_stmt = resp_stmt.where(Response.agent_id == current_user.id)
    responses = db.execute(resp_stmt).scalars().all()

    issues = (
        []
        if is_agent
        else db.execute(
            select(QualityIssue)
            .where(
                (QualityIssue.message.ilike(term))
                | (QualityIssue.rule_code.ilike(term))
                | (QualityIssue.issue_type.ilike(term))
            )
            .order_by(QualityIssue.created_at.desc())
            .limit(6)
        )
        .scalars()
        .all()
    )

    reports = db.execute(
        select(Report)
        .where((Report.title.ilike(term)) | (Report.analyst_notes.ilike(term)))
        .order_by(Report.created_at.desc())
        .limit(6)
    ).scalars().all()

    return {
        "query": q,
        "surveys": [{"id": str(s.id), "code": s.code, "title": s.title, "status": s.status} for s in surveys],
        "responses": [
            {
                "id": str(r.id),
                "client_submission_id": r.client_submission_id,
                "survey_code": r.survey.code if r.survey else "",
                "district": r.district,
                "status": r.processing_status,
            }
            for r in responses
        ],
        "quality_issues": [
            {
                "id": str(i.id),
                "response_id": str(i.response_id),
                "issue_type": i.issue_type,
                "severity": i.severity,
                "message": i.message[:110],
            }
            for i in issues
        ],
        "reports": [{"id": str(r.id), "title": r.title, "report_type": r.report_type} for r in reports],
    }


@router.get("/notifications")
def list_notifications(
    limit: int = Query(default=25, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rows = db.execute(
        select(AuditEvent)
        .options(selectinload(AuditEvent.actor))
        .where(AuditEvent.notify_level.in_(["info", "warning", "critical"]))
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
    ).scalars().all()

    unread_count = int(
        db.execute(
            select(func.count(AuditEvent.id)).where(
                AuditEvent.notify_level.in_(["info", "warning", "critical"]),
                AuditEvent.is_read.is_(False),
            )
        ).scalar()
        or 0
    )

    return {
        "unread_count": unread_count,
        "items": [
            {
                "id": str(e.id),
                "entity_type": e.entity_type,
                "entity_id": e.entity_id,
                "action": e.action,
                "level": e.notify_level,
                "summary": e.summary,
                "actor_name": e.actor.full_name if e.actor else e.actor_type.title(),
                "is_read": e.is_read,
                "created_at": e.created_at.isoformat(),
            }
            for e in rows
        ],
    }


@router.post("/notifications/read-all")
def mark_all_notifications_read(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    unread = db.execute(
        select(AuditEvent).where(
            AuditEvent.notify_level.in_(["info", "warning", "critical"]),
            AuditEvent.is_read.is_(False),
        )
    ).scalars().all()
    for e in unread:
        e.is_read = True
    db.commit()
    return {"marked_read": len(unread)}


@router.get("/audit")
def list_audit_events(
    entity_type: Optional[str] = Query(default=None),
    entity_id: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=30, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(AuditEvent).options(selectinload(AuditEvent.actor)).order_by(AuditEvent.created_at.desc())
    if entity_type and entity_type != "all":
        stmt = stmt.where(AuditEvent.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditEvent.entity_id == entity_id)

    total = int(db.execute(select(func.count()).select_from(stmt.subquery())).scalar() or 0)
    rows = db.execute(stmt.offset((page - 1) * page_size).limit(page_size)).scalars().all()
    return {
        "items": [
            {
                "id": str(e.id),
                "entity_type": e.entity_type,
                "entity_id": e.entity_id,
                "action": e.action,
                "actor_type": e.actor_type,
                "actor_name": e.actor.full_name if e.actor else e.actor_type.title(),
                "summary": e.summary,
                "before_state": e.before_state,
                "after_state": e.after_state,
                "created_at": e.created_at.isoformat(),
            }
            for e in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def _recent_audit_events_fallback(limit: int = 12) -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.execute(
            select(AuditEvent).order_by(AuditEvent.created_at.desc()).limit(limit)
        ).scalars().all()
        return [
            {
                "event_type": e.action,
                "timestamp": e.created_at.isoformat(),
                "payload": {
                    "entity_type": e.entity_type,
                    "entity_id": e.entity_id,
                    "summary": e.summary,
                    **(e.after_state or {}),
                },
            }
            for e in rows
        ]
    except Exception:
        return []
    finally:
        db.close()


@router.get("/events/stream")
async def sse_event_stream(
    _: User = Depends(get_current_user),
):
    """Server-Sent Events endpoint streaming real-time ingestion, pipeline, and quality events."""

    async def event_generator():
        recent = get_recent_events(12)
        if not recent:
            recent = _recent_audit_events_fallback(12)

        # Send immediate connection & recent events burst
        yield "retry: 8000\n"
        yield f"event: connected\ndata: {json.dumps({'status': 'live', 'recent': recent})}\n\n"

        client = get_redis_client()
        pubsub = None
        if client is not None:
            try:
                pubsub = client.pubsub(ignore_subscribe_messages=True)
                pubsub.subscribe(EVENT_CHANNEL)
            except Exception:
                pubsub = None

        heartbeat_ticks = 0
        elapsed_seconds = 0
        max_stream_seconds = 20 if settings.is_vercel else 0
        try:
            while True:
                if pubsub is not None:
                    msg = pubsub.get_message(timeout=0.1)
                    if msg and msg.get("type") == "message":
                        data = msg.get("data")
                        yield f"event: update\ndata: {data}\n\n"
                        heartbeat_ticks = 0
                        continue

                await asyncio.sleep(1.0)
                elapsed_seconds += 1
                heartbeat_ticks += 1
                if heartbeat_ticks >= 15:
                    yield f"event: heartbeat\ndata: {json.dumps({'ts': datetime.now(timezone.utc).isoformat()})}\n\n"
                    heartbeat_ticks = 0
                if max_stream_seconds and elapsed_seconds >= max_stream_seconds:
                    yield f"event: reconnect\ndata: {json.dumps({'reason': 'serverless_cycle'})}\n\n"
                    break
        finally:
            if pubsub is not None:
                try:
                    pubsub.close()
                except Exception:
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.websocket("/ws/live")
async def websocket_live(websocket: WebSocket, token: Optional[str] = Query(default=None)):
    # Enforce JWT authentication prior to accepting WebSocket stream
    if not token:
        await websocket.close(code=1008, reason="Authentication token required")
        return
    db = SessionLocal()
    try:
        _resolve_user_from_token(token, db)
    except Exception:
        await websocket.close(code=1008, reason="Invalid or expired token")
        return
    finally:
        db.close()

    await websocket.accept()
    await websocket.send_json({"event_type": "connected", "recent": get_recent_events(10)})
    client = get_redis_client()
    pubsub = None
    if client is not None:
        try:
            pubsub = client.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe(EVENT_CHANNEL)
        except Exception:
            pubsub = None
    try:
        while True:
            if pubsub is not None:
                msg = pubsub.get_message(timeout=0.1)
                if msg and msg.get("type") == "message":
                    await websocket.send_text(str(msg.get("data")))
                    continue
            await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass
    finally:
        if pubsub is not None:
            try:
                pubsub.close()
            except Exception:
                pass
