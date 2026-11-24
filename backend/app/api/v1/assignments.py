import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_roles
from app.api.v1.surveys import _serialize_question
from app.db.session import get_db
from app.models.models import (
    AuditEvent,
    Question,
    Survey,
    SurveyAssignment,
    SurveyVersion,
    User,
)
from app.schemas.schemas import AssignmentCreateRequest, AssignmentUpdateRequest

router = APIRouter(prefix="/assignments", tags=["Survey Assignments"])


def _serialize_assignment(a: SurveyAssignment, include_schema: bool = False) -> dict:
    data = {
        "id": str(a.id),
        "survey_id": str(a.survey_id),
        "survey_code": a.survey.code if a.survey else "",
        "survey_title": a.survey.title if a.survey else "",
        "survey_category": a.survey.category if a.survey else "",
        "survey_version_id": str(a.survey_version_id),
        "version_number": a.survey_version.version_number if a.survey_version else 1,
        "agent_id": str(a.agent_id),
        "agent_name": a.agent.full_name if a.agent else "",
        "agent_email": a.agent.email if a.agent else "",
        "region": a.region,
        "target_count": a.target_count,
        "collected_count": a.collected_count,
        "completion_pct": round((a.collected_count / a.target_count) * 100, 1) if a.target_count > 0 else 0.0,
        "status": a.status,
        "due_date": a.due_date.isoformat() if a.due_date else None,
        "notes": a.notes,
        "created_at": a.created_at.isoformat(),
    }
    if include_schema and a.survey and a.survey_version:
        ordered = sorted(a.survey_version.questions or [], key=lambda q: q.order_index)
        data["survey_schema"] = {
            "id": str(a.survey.id),
            "code": a.survey.code,
            "title": a.survey.title,
            "description": a.survey.description,
            "instructions": a.survey.instructions,
            "consent_text": a.survey.consent_text,
            "requires_consent": a.survey.requires_consent,
            "allow_location_capture": a.survey.allow_location_capture,
            "version_id": str(a.survey_version.id),
            "version_number": a.survey_version.version_number,
            "questions": [_serialize_question(q) for q in ordered],
        }
    return data


@router.get("")
def list_assignments(
    survey_id: Optional[uuid.UUID] = Query(default=None),
    agent_id: Optional[uuid.UUID] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    stmt = (
        select(SurveyAssignment)
        .options(
            selectinload(SurveyAssignment.survey),
            selectinload(SurveyAssignment.survey_version),
            selectinload(SurveyAssignment.agent),
        )
        .order_by(SurveyAssignment.created_at.desc())
    )
    if current_user.role.name == "field_agent":
        stmt = stmt.where(SurveyAssignment.agent_id == current_user.id)
    else:
        if agent_id:
            stmt = stmt.where(SurveyAssignment.agent_id == agent_id)
    if survey_id:
        stmt = stmt.where(SurveyAssignment.survey_id == survey_id)
    if status_filter and status_filter != "all":
        stmt = stmt.where(SurveyAssignment.status == status_filter)

    rows = db.execute(stmt).scalars().all()
    return {"items": [_serialize_assignment(a) for a in rows], "total": len(rows)}


@router.get("/my-field-assignments")
def get_my_field_assignments(
    agent_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Returns full assignment + embedded questionnaire schema for offline IndexedDB caching.
    Admins/analysts may also pass agent_id or view all active assignments to preview/test field mode.
    """
    stmt = (
        select(SurveyAssignment)
        .options(
            selectinload(SurveyAssignment.survey),
            selectinload(SurveyAssignment.survey_version)
            .selectinload(SurveyVersion.questions)
            .selectinload(Question.validation_rules),
            selectinload(SurveyAssignment.agent),
        )
        .where(SurveyAssignment.status == "active")
        .order_by(SurveyAssignment.due_date.asc().nulls_last())
    )

    if current_user.role.name == "field_agent":
        stmt = stmt.where(SurveyAssignment.agent_id == current_user.id)
    elif agent_id:
        stmt = stmt.where(SurveyAssignment.agent_id == agent_id)

    rows = db.execute(stmt).scalars().all()
    return {"items": [_serialize_assignment(a, include_schema=True) for a in rows]}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_assignment(
    payload: AssignmentCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    survey = db.get(Survey, payload.survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")
    if survey.status != "published" or not survey.active_version_id:
        raise HTTPException(
            status_code=400,
            detail="Only published surveys with an active version can be assigned to field agents.",
        )

    agent = db.execute(
        select(User).options(selectinload(User.role)).where(User.id == payload.agent_id)
    ).scalar_one_or_none()
    if not agent:
        raise HTTPException(status_code=404, detail="Field agent user not found.")

    assignment = SurveyAssignment(
        survey_id=survey.id,
        survey_version_id=survey.active_version_id,
        agent_id=agent.id,
        assigned_by_id=current_user.id,
        region=payload.region.strip(),
        target_count=payload.target_count,
        due_date=payload.due_date,
        notes=payload.notes.strip(),
        status="active",
    )
    db.add(assignment)
    db.flush()

    db.add(
        AuditEvent(
            entity_type="assignment",
            entity_id=str(assignment.id),
            action="assignment.created",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Assigned {survey.code} to {agent.full_name} ({payload.region}, target {payload.target_count}).",
            after_state={"survey_code": survey.code, "agent_email": agent.email, "region": payload.region},
            notify_level="info",
        )
    )
    db.commit()

    reloaded = db.execute(
        select(SurveyAssignment)
        .options(
            selectinload(SurveyAssignment.survey),
            selectinload(SurveyAssignment.survey_version),
            selectinload(SurveyAssignment.agent),
        )
        .where(SurveyAssignment.id == assignment.id)
    ).scalar_one()
    return _serialize_assignment(reloaded)


@router.patch("/{assignment_id}")
def update_assignment(
    assignment_id: uuid.UUID,
    payload: AssignmentUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    asgn = db.get(SurveyAssignment, assignment_id)
    if not asgn:
        raise HTTPException(status_code=404, detail="Assignment not found.")

    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(asgn, field, val)

    db.add(
        AuditEvent(
            entity_type="assignment",
            entity_id=str(asgn.id),
            action="assignment.updated",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Updated assignment status={asgn.status}, target={asgn.target_count}.",
        )
    )
    db.commit()

    reloaded = db.execute(
        select(SurveyAssignment)
        .options(
            selectinload(SurveyAssignment.survey),
            selectinload(SurveyAssignment.survey_version),
            selectinload(SurveyAssignment.agent),
        )
        .where(SurveyAssignment.id == assignment_id)
    ).scalar_one()
    return _serialize_assignment(reloaded)


@router.delete("/{assignment_id}")
def delete_assignment(
    assignment_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    asgn = db.get(SurveyAssignment, assignment_id)
    if not asgn:
        raise HTTPException(status_code=404, detail="Assignment not found.")
    db.delete(asgn)
    db.add(
        AuditEvent(
            entity_type="assignment",
            entity_id=str(assignment_id),
            action="assignment.deleted",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Removed survey assignment {str(assignment_id)[:8]}.",
        )
    )
    db.commit()
    return {"deleted": True}
