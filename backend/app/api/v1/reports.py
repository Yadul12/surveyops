import csv
import io
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import Response as FastAPIResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.deps import get_current_user, require_roles
from app.db.session import get_db
from app.models.models import AuditEvent, Report, Survey, User
from app.schemas.schemas import ReportCreateRequest, ReportUpdateRequest
from app.services.analytics import (
    compute_geographic_distribution,
    compute_overview_kpis,
    compute_quality_breakdown,
    compute_question_distributions,
)
from app.services.report_pdf import render_insight_report_pdf

router = APIRouter(prefix="/reports", tags=["Insight Reports"])


def _serialize_report(r: Report, include_payload: bool = False) -> dict:
    out = {
        "id": str(r.id),
        "survey_id": str(r.survey_id),
        "survey_code": r.survey.code if r.survey else "",
        "survey_title": r.survey.title if r.survey else "",
        "survey_category": r.survey.category if r.survey else "",
        "survey_version_id": str(r.survey_version_id) if r.survey_version_id else None,
        "title": r.title,
        "report_type": r.report_type,
        "status": r.status,
        "filters_json": r.filters_json,
        "summary_stats": r.summary_stats,
        "analyst_notes": r.analyst_notes,
        "created_by_name": r.created_by.full_name if r.created_by else "",
        "created_at": r.created_at.isoformat(),
        "updated_at": r.updated_at.isoformat(),
    }
    if include_payload:
        out["question_insights"] = r.question_insights or []
        out["quality_summary"] = r.quality_summary or {}
        out["geo_summary"] = r.geo_summary or []
    return out


@router.get("")
def list_reports(
    survey_id: Optional[uuid.UUID] = Query(default=None),
    search: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    stmt = (
        select(Report)
        .options(selectinload(Report.survey), selectinload(Report.created_by))
        .order_by(Report.created_at.desc())
    )
    if survey_id:
        stmt = stmt.where(Report.survey_id == survey_id)
    if search:
        term = f"%{search.strip()}%"
        stmt = stmt.where((Report.title.ilike(term)) | (Report.analyst_notes.ilike(term)))

    rows = db.execute(stmt).scalars().all()
    return {"items": [_serialize_report(r, include_payload=False) for r in rows], "total": len(rows)}


@router.post("", status_code=status.HTTP_201_CREATED)
def create_report(
    payload: ReportCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    survey = db.get(Survey, payload.survey_id)
    if not survey:
        raise HTTPException(status_code=404, detail="Survey not found.")

    version_id = payload.survey_version_id or survey.active_version_id
    stats = compute_overview_kpis(
        db,
        survey_id=survey.id,
        survey_version_id=version_id,
        district=payload.district,
    )
    q_insights = compute_question_distributions(
        db,
        survey_id=survey.id,
        survey_version_id=version_id,
        status_filter=payload.status_filter,
        district=payload.district,
    )
    q_summary = compute_quality_breakdown(db, survey_id=survey.id)
    geo = compute_geographic_distribution(
        db,
        survey_id=survey.id,
        survey_version_id=version_id,
        status_filter=payload.status_filter,
    )

    rep = Report(
        survey_id=survey.id,
        survey_version_id=version_id,
        title=payload.title.strip(),
        report_type=payload.report_type,
        status="published",
        filters_json={"status": payload.status_filter, "district": payload.district or "all"},
        summary_stats=stats,
        question_insights=q_insights,
        quality_summary=q_summary,
        geo_summary=geo,
        analyst_notes=payload.analyst_notes.strip(),
        created_by_id=current_user.id,
    )
    db.add(rep)
    db.flush()

    db.add(
        AuditEvent(
            entity_type="report",
            entity_id=str(rep.id),
            action="report.generated",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Generated Insight Report '{rep.title}' for {survey.code} ({stats.get('valid_responses', 0)} valid responses).",
            after_state={"survey_code": survey.code, "valid_responses": stats.get("valid_responses", 0)},
            notify_level="info",
        )
    )
    db.commit()

    reloaded = db.execute(
        select(Report)
        .options(selectinload(Report.survey), selectinload(Report.created_by))
        .where(Report.id == rep.id)
    ).scalar_one()
    return _serialize_report(reloaded, include_payload=True)


@router.get("/{report_id}")
def get_report(
    report_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rep = db.execute(
        select(Report)
        .options(selectinload(Report.survey), selectinload(Report.created_by))
        .where(Report.id == report_id)
    ).scalar_one_or_none()
    if not rep:
        raise HTTPException(status_code=404, detail="Report not found.")
    return _serialize_report(rep, include_payload=True)


@router.patch("/{report_id}")
def update_report(
    report_id: uuid.UUID,
    payload: ReportUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    rep = db.execute(
        select(Report)
        .options(selectinload(Report.survey), selectinload(Report.created_by))
        .where(Report.id == report_id)
    ).scalar_one_or_none()
    if not rep:
        raise HTTPException(status_code=404, detail="Report not found.")

    for field, val in payload.model_dump(exclude_unset=True).items():
        setattr(rep, field, val)

    db.add(
        AuditEvent(
            entity_type="report",
            entity_id=str(rep.id),
            action="report.updated",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Updated analyst notes/metadata on report '{rep.title}'.",
        )
    )
    db.commit()
    db.refresh(rep)
    return _serialize_report(rep, include_payload=True)


@router.delete("/{report_id}")
def delete_report(
    report_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_roles("admin", "analyst")),
):
    rep = db.get(Report, report_id)
    if not rep:
        raise HTTPException(status_code=404, detail="Report not found.")
    title = rep.title
    db.delete(rep)
    db.add(
        AuditEvent(
            entity_type="report",
            entity_id=str(report_id),
            action="report.deleted",
            actor_id=current_user.id,
            actor_type="user",
            summary=f"Deleted report '{title}'.",
        )
    )
    db.commit()
    return {"deleted": True}


@router.get("/{report_id}/export/csv")
def export_report_csv(
    report_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rep = db.execute(
        select(Report).options(selectinload(Report.survey)).where(Report.id == report_id)
    ).scalar_one_or_none()
    if not rep:
        raise HTTPException(status_code=404, detail="Report not found.")

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Section", "Metric / Question", "Category / Option", "Count / Value", "Percentage / Rate"])

    for k, v in (rep.summary_stats or {}).items():
        writer.writerow(["Executive KPI", k, "", v, ""])

    for g in (rep.geo_summary or []):
        writer.writerow([
            "Geographic Distribution",
            g.get("district", ""),
            f"Valid: {g.get('valid', 0)} / Total: {g.get('total', 0)}",
            g.get("avg_quality_score", ""),
            f"{g.get('valid_rate', 0)}%",
        ])

    for qi in (rep.quality_summary or {}).get("by_type", []):
        writer.writerow([
            "Data Quality Audit",
            qi.get("issue_type", ""),
            f"Open: {qi.get('open', 0)} | Resolved: {qi.get('resolved', 0)}",
            qi.get("total", 0),
            "",
        ])

    for q in (rep.question_insights or []):
        for row in q.get("distribution", []):
            writer.writerow([
                "Question Distribution",
                f"{q.get('question_key')} - {q.get('prompt')}",
                row.get("label", ""),
                row.get("count", 0),
                f"{row.get('pct', 0)}%",
            ])

    buf.seek(0)
    code = rep.survey.code.lower() if rep.survey else "report"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="surveyops_{code}_insight_report.csv"'},
    )


@router.get("/{report_id}/export/pdf")
def export_report_pdf(
    report_id: uuid.UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    rep = db.execute(
        select(Report)
        .options(selectinload(Report.survey), selectinload(Report.created_by))
        .where(Report.id == report_id)
    ).scalar_one_or_none()
    if not rep:
        raise HTTPException(status_code=404, detail="Report not found.")

    pdf_bytes = render_insight_report_pdf(
        report_title=rep.title,
        survey_title=rep.survey.title if rep.survey else "",
        survey_code=rep.survey.code if rep.survey else "SURVEY",
        survey_category=rep.survey.category if rep.survey else "Civic Research",
        author_name=rep.created_by.full_name if rep.created_by else "SurveyOps Analyst",
        created_at=rep.created_at.isoformat(),
        summary_stats=rep.summary_stats or {},
        quality_summary=rep.quality_summary or {},
        geo_summary=rep.geo_summary or [],
        question_insights=rep.question_insights or [],
        analyst_notes=rep.analyst_notes or "",
    )
    code = rep.survey.code.lower() if rep.survey else "report"
    return FastAPIResponse(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="surveyops_{code}_insight_report.pdf"'},
    )
