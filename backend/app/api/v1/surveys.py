import hashlib
import json
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_roles
from app.db.base import utcnow
from app.db.session import get_db
from app.models.models import (
    AuditEvent,
    Question,
    Response,
    Survey,
    SurveyAssignment,
    SurveyVersion,
    User,
    ValidationRule,
)
from app.schemas.schemas import (
    PublishSurveyRequest,
    QuestionIn,
    SurveyCreateRequest,
    SurveyUpdateRequest,
    SurveyVersionSaveQuestionsRequest,
)
from app.services.events import publish_live_event

router = APIRouter(prefix="/surveys", tags=["Survey Management"])


def _compute_schema_hash(questions: List[QuestionIn]) -> str:
    serialized = [q.model_dump(mode="json") for q in questions]
    return hashlib.sha256(json.dumps(serialized, sort_keys=True).encode("utf-8")).hexdigest()


def _serialize_question(q: Question) -> Dict[str, Any]:
    return {
        "id": str(q.id),
        "survey_version_id": str(q.survey_version_id),
        "question_key": q.question_key,
        "section_title": q.section_title,
        "prompt": q.prompt,
        "help_text": q.help_text,
        "question_type": q.question_type,
        "order_index": q.order_index,
        "is_required": q.is_required,
        "options": q.options or [],
        "conditional_logic": q.conditional_logic,
        "config": q.config or {},
        "validation_rules": [
            {
                "id": str(r.id),
                "question_id": str(r.question_id),
                "rule_type": r.rule_type,
                "rule_config": r.rule_config or {},
                "severity": r.severity,
                "error_message": r.error_message,
                "is_active": r.is_active,
            }
            for r in (q.validation_rules or [])
        ],
    }


def _serialize_version(v: SurveyVersion, include_questions: bool = True) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "id": str(v.id),
        "survey_id": str(v.survey_id),
        "version_number": v.version_number,
        "status": v.status,
        "schema_hash": v.schema_hash,
        "change_notes": v.change_notes,
        "published_at": v.published_at.isoformat() if v.published_at else None,
        "created_at": v.created_at.isoformat(),
        "question_count": len(v.questions) if v.questions is not None else 0,
    }
    if include_questions:
        ordered = sorted(v.questions or [], key=lambda q: q.order_index)
        out["questions"] = [_serialize_question(q) for q in ordered]
    return out


def _replace_version_questions(db: Session, version: SurveyVersion, questions_in: List[QuestionIn]) -> None:
    # Delete existing questions on draft version
    existing = db.execute(select(Question).where(Question.survey_version_id == version.id)).scalars().all()
    for eq in existing:
        db.delete(eq)
    db.flush()

    seen_keys = set()
    for idx, qin in enumerate(questions_in):
        key = qin.question_key.strip()
        if key in seen_keys:
            raise HTTPException(status_code=400, detail=f"Duplicate question_key '{key}' in survey version.")
        seen_keys.add(key)

        q = Question(
            survey_version_id=version.id,
            question_key=key,
            section_title=qin.section_title.strip() or "General",
            prompt=qin.prompt.strip(),
            help_text=qin.help_text.strip(),
            question_type=qin.question_type,
            order_index=idx,
            is_required=qin.is_required,
            options=qin.options or [],
            conditional_logic=qin.conditional_logic,
            config=qin.config or {},
        )
        db.add(q)
        db.flush()

        for rin in qin.validation_rules:
            db.add(
                ValidationRule(
                    question_id=q.id,
                    rule_type=rin.rule_type,
                    rule_config=rin.rule_config or {},
                    severity=rin.severity,
                    error_message=rin.error_message,
                    is_active=rin.is_active,
                )
            )

    version.schema_hash = _compute_schema_hash(questions_in)


@router.get("")
def list_surveys(
    search: Optional[str] = Query(default=None),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    exclude_archived: bool = Query(default=False),
    category: Optional[str] = Query(default=None),
    sort_by: str = Query(default="updated_at"),
    sort_dir: str = Query(default="desc"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = select(Survey).options(
        selectinload(Survey.versions).selectinload(SurveyVersion.questions),
        selectinload(Survey.created_by),
    )

    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where((Survey.title.ilike(term)) | (Survey.code.ilike(term)) | (Survey.description.ilike(term)))
    if status_filter and status_filter != "all":
        stmt = stmt.where(Survey.status == status_filter)
    elif exclude_archived:
        stmt = stmt.where(Survey.status != "archived")
    if category and category != "all":
        stmt = stmt.where(Survey.category == category)

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar() or 0)

    sort_col = {
        "title": Survey.title,
        "code": Survey.code,
        "status": Survey.status,
        "created_at": Survey.created_at,
        "updated_at": Survey.updated_at,
    }.get(sort_by, Survey.updated_at)
    stmt = stmt.order_by(sort_col.asc() if sort_dir == "asc" else sort_col.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    surveys = db.execute(stmt).scalars().all()
    survey_ids = [s.id for s in surveys]

    # Batch aggregate stats per survey
    resp_stats: Dict[uuid.UUID, Any] = {}
    if survey_ids:
        agg_rows = db.execute(
            select(
                Response.survey_id,
                func.count(Response.id).label("total"),
                func.sum(case((Response.processing_status.in_(["approved", "validated"]), 1), else_=0)).label("valid"),
                func.sum(case((Response.processing_status == "flagged", 1), else_=0)).label("flagged"),
                func.sum(case((Response.processing_status == "rejected", 1), else_=0)).label("rejected"),
                func.avg(Response.quality_score).label("avg_score"),
            )
            .where(Response.survey_id.in_(survey_ids))
            .group_by(Response.survey_id)
        ).all()
        for r in agg_rows:
            resp_stats[r.survey_id] = r

    assign_counts: Dict[uuid.UUID, int] = {}
    if survey_ids:
        asgn_rows = db.execute(
            select(SurveyAssignment.survey_id, func.count(SurveyAssignment.id))
            .where(SurveyAssignment.survey_id.in_(survey_ids), SurveyAssignment.status == "active")
            .group_by(SurveyAssignment.survey_id)
        ).all()
        for sid, cnt in asgn_rows:
            assign_counts[sid] = int(cnt)

    items = []
    for s in surveys:
        st = resp_stats.get(s.id)
        total_r = int(st.total) if st else 0
        valid_r = int(st.valid) if st else 0
        latest_ver = max(s.versions, key=lambda v: v.version_number) if s.versions else None
        active_ver = next((v for v in s.versions if v.id == s.active_version_id), latest_ver)

        items.append(
            {
                "id": str(s.id),
                "code": s.code,
                "title": s.title,
                "description": s.description,
                "category": s.category,
                "status": s.status,
                "active_version_id": str(s.active_version_id) if s.active_version_id else None,
                "active_version_number": active_ver.version_number if active_ver else 1,
                "latest_version_number": latest_ver.version_number if latest_ver else 1,
                "question_count": len(active_ver.questions) if active_ver else 0,
                "target_responses": s.target_responses,
                "requires_consent": s.requires_consent,
                "allow_location_capture": s.allow_location_capture,
                "active_assignments": assign_counts.get(s.id, 0),
                "response_stats": {
                    "total": total_r,
                    "valid": valid_r,
                    "flagged": int(st.flagged) if st else 0,
                    "rejected": int(st.rejected) if st else 0,
                    "valid_rate": round((valid_r / total_r) * 100, 1) if total_r > 0 else 0.0,
                    "avg_quality_score": round(float(st.avg_score or 0.0), 1) if st else 0.0,
                },
                "created_by_name": s.created_by.full_name if s.created_by else "",
                "created_at": s.created_at.isoformat(),
                "updated_at": s.updated_at.isoformat(),
            }
        )

    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_survey(
    payload: SurveyCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    code = (payload.code or f"CIV-2026-{uuid.uuid4().hex[:4].upper()}").strip().upper()
    existing = db.execute(select(Survey).where(Survey.code == code)).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail=f"Survey code '{code}' already exists.")

    survey = Survey(
        code=code,
        title=payload.title.strip(),
        description=payload.description.strip(),
        category=payload.category.strip() or "Civic Services",
        status="draft",
        target_responses=payload.target_responses,
        requires_consent=payload.requires_consent,
        allow_location_capture=payload.allow_location_capture,
        instructions=payload.instructions.strip(),
        consent_text=payload.consent_text.strip(),
        created_by_id=current_user.id,
    )
    db.add(survey)
    db.flush()

    v1 = SurveyVersion(
        survey_id=survey.id,
        version_number=1,
        status="draft",
        change_notes="Initial draft version",
    )
    db.add(v1)
    db.flush()

    if payload.questions:
        _replace_version_questions(db, v1, payload.questions)

    db.add(
        AuditEvent(
            entity_type="survey",
            entity_id=str(survey.id),
            action="survey.created",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Created survey {survey.code} — {survey.title}",
            after_state={"code": survey.code, "status": "draft", "questions": len(payload.questions)},
            notify_level="info",
        )
    )
    db.commit()
    return get_survey_detail(survey.id, db=db, _=current_user)


@router.get("/{survey_id}")
def get_survey_detail(
    survey_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    survey = db.execute(
        select(Survey)
        .options(
            selectinload(Survey.versions)
            .selectinload(SurveyVersion.questions)
            .selectinload(Question.validation_rules),
            selectinload(Survey.created_by),
            selectinload(Survey.assignments).selectinload(SurveyAssignment.agent),
        )
        .where(Survey.id == survey_id)
    ).scalar_one_or_none()

    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")

    versions_sorted = sorted(survey.versions, key=lambda v: v.version_number, reverse=True)
    return {
        "id": str(survey.id),
        "code": survey.code,
        "title": survey.title,
        "description": survey.description,
        "category": survey.category,
        "status": survey.status,
        "active_version_id": str(survey.active_version_id) if survey.active_version_id else None,
        "target_responses": survey.target_responses,
        "requires_consent": survey.requires_consent,
        "allow_location_capture": survey.allow_location_capture,
        "instructions": survey.instructions,
        "consent_text": survey.consent_text,
        "created_by_name": survey.created_by.full_name if survey.created_by else "",
        "created_at": survey.created_at.isoformat(),
        "updated_at": survey.updated_at.isoformat(),
        "versions": [_serialize_version(v, include_questions=True) for v in versions_sorted],
        "assignments": [
            {
                "id": str(a.id),
                "agent_id": str(a.agent_id),
                "agent_name": a.agent.full_name if a.agent else "",
                "agent_email": a.agent.email if a.agent else "",
                "region": a.region,
                "target_count": a.target_count,
                "collected_count": a.collected_count,
                "status": a.status,
                "due_date": a.due_date.isoformat() if a.due_date else None,
                "notes": a.notes,
            }
            for a in survey.assignments
        ],
    }


@router.patch("/{survey_id}")
def update_survey(
    survey_id: uuid.UUID,
    payload: SurveyUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    survey = db.get(Survey, survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")

    before = {"title": survey.title, "status": survey.status, "target_responses": survey.target_responses}
    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(survey, field, val)

    db.add(
        AuditEvent(
            entity_type="survey",
            entity_id=str(survey.id),
            action="survey.updated",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Updated survey metadata for {survey.code}.",
            before_state=before,
            after_state={"title": survey.title, "status": survey.status, "target_responses": survey.target_responses},
        )
    )
    db.commit()
    return get_survey_detail(survey_id, db=db, _=current_user)


@router.put("/{survey_id}/versions/{version_id}/questions")
def save_version_questions(
    survey_id: uuid.UUID,
    version_id: uuid.UUID,
    payload: SurveyVersionSaveQuestionsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    version = db.execute(
        select(SurveyVersion).where(SurveyVersion.id == version_id, SurveyVersion.survey_id == survey_id)
    ).scalar_one_or_none()
    if not version:
        raise HTTPException(status_code=404, detail="Survey version not found.")
    if version.status != "draft":
        raise HTTPException(
            status_code=400,
            detail="Published or retired survey versions are immutable. Create a new draft version to modify questions.",
        )

    _replace_version_questions(db, version, payload.questions)
    if payload.change_notes:
        version.change_notes = payload.change_notes

    db.add(
        AuditEvent(
            entity_type="survey_version",
            entity_id=str(version.id),
            action="survey_version.questions_saved",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Saved {len(payload.questions)} questions on v{version.version_number} draft.",
            after_state={"question_count": len(payload.questions), "schema_hash": version.schema_hash},
        )
    )
    db.commit()
    return get_survey_detail(survey_id, db=db, _=current_user)


@router.post("/{survey_id}/versions", status_code=status.HTTP_201_CREATED)
def create_new_draft_version(
    survey_id: uuid.UUID,
    change_notes: str = Query(default="Cloned draft from latest version"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    survey = db.execute(
        select(Survey)
        .options(
            selectinload(Survey.versions)
            .selectinload(SurveyVersion.questions)
            .selectinload(Question.validation_rules)
        )
        .where(Survey.id == survey_id)
    ).scalar_one_or_none()
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")
    if survey.status == "archived":
        raise HTTPException(status_code=400, detail="Archived surveys cannot spawn new draft versions.")

    existing_draft = next((v for v in survey.versions if v.status == "draft"), None)
    if existing_draft:
        raise HTTPException(
            status_code=409,
            detail=f"Draft version v{existing_draft.version_number} already exists. Edit or publish it first.",
        )

    latest = max(survey.versions, key=lambda v: v.version_number) if survey.versions else None
    next_num = (latest.version_number + 1) if latest else 1

    new_ver = SurveyVersion(
        survey_id=survey.id,
        version_number=next_num,
        status="draft",
        change_notes=change_notes,
        schema_hash=latest.schema_hash if latest else None,
    )
    db.add(new_ver)
    db.flush()

    if latest:
        for q in sorted(latest.questions, key=lambda x: x.order_index):
            q_copy = Question(
                survey_version_id=new_ver.id,
                question_key=q.question_key,
                section_title=q.section_title,
                prompt=q.prompt,
                help_text=q.help_text,
                question_type=q.question_type,
                order_index=q.order_index,
                is_required=q.is_required,
                options=q.options,
                conditional_logic=q.conditional_logic,
                config=q.config,
            )
            db.add(q_copy)
            db.flush()
            for r in q.validation_rules:
                db.add(
                    ValidationRule(
                        question_id=q_copy.id,
                        rule_type=r.rule_type,
                        rule_config=r.rule_config,
                        severity=r.severity,
                        error_message=r.error_message,
                        is_active=r.is_active,
                    )
                )

    db.add(
        AuditEvent(
            entity_type="survey_version",
            entity_id=str(new_ver.id),
            action="survey_version.created",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Created new draft v{next_num} for survey {survey.code}.",
        )
    )
    db.commit()
    return get_survey_detail(survey_id, db=db, _=current_user)


@router.post("/{survey_id}/publish")
def publish_survey(
    survey_id: uuid.UUID,
    payload: PublishSurveyRequest = PublishSurveyRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    survey = db.execute(
        select(Survey)
        .options(selectinload(Survey.versions).selectinload(SurveyVersion.questions))
        .where(Survey.id == survey_id)
    ).scalar_one_or_none()
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")
    if survey.status == "archived":
        raise HTTPException(status_code=400, detail="Archived surveys cannot be published.")

    if payload.version_id:
        target = next((v for v in survey.versions if v.id == payload.version_id), None)
    else:
        target = next((v for v in sorted(survey.versions, key=lambda x: x.version_number, reverse=True) if v.status == "draft"), None)

    if not target:
        raise HTTPException(status_code=400, detail="No draft version available to publish.")
    if not target.questions:
        raise HTTPException(status_code=400, detail="Cannot publish a survey version with zero questions.")

    # Retire previously published version
    for v in survey.versions:
        if v.id != target.id and v.status == "published":
            v.status = "retired"

    target.status = "published"
    target.published_at = utcnow()
    target.published_by_id = current_user.id
    if payload.change_notes:
        target.change_notes = payload.change_notes

    survey.status = "published"
    survey.active_version_id = target.id

    # Update active assignments to point to newly published version
    active_assignments = db.execute(
        select(SurveyAssignment).where(SurveyAssignment.survey_id == survey.id, SurveyAssignment.status == "active")
    ).scalars().all()
    for a in active_assignments:
        a.survey_version_id = target.id

    db.add(
        AuditEvent(
            entity_type="survey",
            entity_id=str(survey.id),
            action="survey.published",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Published {survey.code} v{target.version_number} ({len(target.questions)} questions).",
            after_state={"version_number": target.version_number, "status": "published"},
            notify_level="info",
        )
    )
    db.commit()

    publish_live_event(
        "survey.published",
        {"survey_id": str(survey.id), "code": survey.code, "title": survey.title, "version": target.version_number},
    )
    return get_survey_detail(survey_id, db=db, _=current_user)


@router.delete("/{survey_id}", status_code=status.HTTP_200_OK)
def archive_or_delete_survey(
    survey_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin")),
):
    survey = db.get(Survey, survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")

    resp_count = int(
        db.execute(select(func.count(Response.id)).where(Response.survey_id == survey_id)).scalar() or 0
    )
    if resp_count > 0:
        survey.status = "archived"
        action = "survey.archived"
        msg = f"Survey {survey.code} archived (preserved {resp_count} collected responses)."
    else:
        db.delete(survey)
        action = "survey.deleted"
        msg = f"Draft survey {survey.code} permanently deleted."

    db.add(
        AuditEvent(
            entity_type="survey",
            entity_id=str(survey_id),
            action=action,
            actor_id=current_user.id,
            actor_type="user",
            summary=msg,
            notify_level="info",
        )
    )
    db.commit()
    return {"message": msg, "action": action}
