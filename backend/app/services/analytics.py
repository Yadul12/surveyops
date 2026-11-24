import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import case, cast, func, select, Date
from sqlalchemy.orm import Session, selectinload

from app.models.models import (
    ProcessingJob,
    QualityIssue,
    Question,
    Response,
    ResponseAnswer,
    Survey,
    SurveyAssignment,
    SurveyVersion,
    User,
)


def _get_benchmark_survey_ids(db: Session) -> List[uuid.UUID]:
    return list(
        db.execute(select(Survey.id).where(Survey.code == "CIV-2026-SCALE")).scalars().all()
    )


def _apply_response_filters(
    stmt,
    survey_id: Optional[uuid.UUID] = None,
    survey_version_id: Optional[uuid.UUID] = None,
    district: Optional[str] = None,
    status_filter: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    exclude_survey_ids: Optional[List[uuid.UUID]] = None,
):
    if survey_id:
        stmt = stmt.where(Response.survey_id == survey_id)
    elif exclude_survey_ids:
        stmt = stmt.where(Response.survey_id.notin_(exclude_survey_ids))
    if survey_version_id:
        stmt = stmt.where(Response.survey_version_id == survey_version_id)
    if district and district != "all":
        stmt = stmt.where(Response.district == district)
    if status_filter and status_filter != "all":
        if status_filter == "valid":
            stmt = stmt.where(Response.processing_status.in_(["approved", "validated"]))
        else:
            stmt = stmt.where(Response.processing_status == status_filter)
    if date_from:
        stmt = stmt.where(Response.submitted_at >= date_from)
    if date_to:
        stmt = stmt.where(Response.submitted_at <= date_to)
    return stmt


def compute_overview_kpis(
    db: Session,
    survey_id: Optional[uuid.UUID] = None,
    survey_version_id: Optional[uuid.UUID] = None,
    district: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    exclude_benchmark: bool = False,
) -> Dict[str, Any]:
    excl_ids = _get_benchmark_survey_ids(db) if (exclude_benchmark and not survey_id) else []
    stmt = select(
        func.count(Response.id).label("total"),
        func.sum(case((Response.processing_status.in_(["approved", "validated"]), 1), else_=0)).label("valid"),
        func.sum(case((Response.processing_status == "approved", 1), else_=0)).label("approved"),
        func.sum(case((Response.processing_status == "flagged", 1), else_=0)).label("flagged"),
        func.sum(case((Response.processing_status == "rejected", 1), else_=0)).label("rejected"),
        func.sum(case((Response.processing_status.in_(["ingested", "processing"]), 1), else_=0)).label("backlog"),
        func.sum(case((Response.is_duplicate.is_(True), 1), else_=0)).label("duplicates"),
        func.avg(Response.quality_score).label("avg_quality_score"),
        func.avg(Response.duration_seconds).label("avg_duration_seconds"),
        func.sum(case((Response.location_consent_given.is_(True), 1), else_=0)).label("geo_consented"),
    )
    stmt = _apply_response_filters(stmt, survey_id, survey_version_id, district, None, date_from, date_to, excl_ids)
    row = db.execute(stmt).one()

    total = int(row.total or 0)
    valid = int(row.valid or 0)
    approved = int(row.approved or 0)
    flagged = int(row.flagged or 0)
    rejected = int(row.rejected or 0)
    backlog = int(row.backlog or 0)
    duplicates = int(row.duplicates or 0)
    geo_consented = int(row.geo_consented or 0)

    # Target completion rate from surveys or assignments
    target_stmt = select(func.coalesce(func.sum(Survey.target_responses), 0))
    if survey_id:
        target_stmt = target_stmt.where(Survey.id == survey_id)
    else:
        target_stmt = target_stmt.where(Survey.status == "published")
        if excl_ids:
            target_stmt = target_stmt.where(Survey.id.notin_(excl_ids))
    target_total = int(db.execute(target_stmt).scalar() or 0)

    # Open quality issues count
    issue_stmt = select(func.count(QualityIssue.id)).where(QualityIssue.status == "open")
    if survey_id:
        issue_stmt = issue_stmt.where(QualityIssue.survey_id == survey_id)
    elif excl_ids:
        issue_stmt = issue_stmt.where(QualityIssue.survey_id.notin_(excl_ids))
    open_issues = int(db.execute(issue_stmt).scalar() or 0)

    # Active agents & surveys
    active_agents = int(
        db.execute(
            select(func.count(func.distinct(SurveyAssignment.agent_id))).where(SurveyAssignment.status == "active")
        ).scalar()
        or 0
    )
    active_surveys_stmt = select(func.count(Survey.id)).where(Survey.status == "published")
    if excl_ids:
        active_surveys_stmt = active_surveys_stmt.where(Survey.id.notin_(excl_ids))
    active_surveys = int(db.execute(active_surveys_stmt).scalar() or 0)

    queued_jobs = int(
        db.execute(
            select(func.count(ProcessingJob.id)).where(ProcessingJob.status.in_(["queued", "running", "retrying"]))
        ).scalar()
        or 0
    )

    valid_rate = round((valid / total) * 100, 1) if total > 0 else 0.0
    completion_rate = round((total / target_total) * 100, 1) if target_total > 0 else 0.0

    return {
        "total_responses": total,
        "valid_responses": valid,
        "approved_responses": approved,
        "flagged_responses": flagged,
        "rejected_responses": rejected,
        "processing_backlog": backlog + queued_jobs,
        "duplicate_responses": duplicates,
        "open_quality_issues": open_issues,
        "target_responses": target_total,
        "completion_rate": min(completion_rate, 100.0) if target_total > 0 else 0.0,
        "raw_target_attainment_pct": completion_rate,
        "valid_rate": valid_rate,
        "avg_quality_score": round(float(row.avg_quality_score or 0.0), 1),
        "avg_duration_seconds": int(round(float(row.avg_duration_seconds or 0.0))),
        "geo_consented_pct": round((geo_consented / total) * 100, 1) if total > 0 else 0.0,
        "active_agents": active_agents,
        "active_surveys": active_surveys,
    }


def compute_response_trends(
    db: Session,
    survey_id: Optional[uuid.UUID] = None,
    survey_version_id: Optional[uuid.UUID] = None,
    district: Optional[str] = None,
    days: int = 30,
    exclude_benchmark: bool = False,
) -> List[Dict[str, Any]]:
    excl_ids = _get_benchmark_survey_ids(db) if (exclude_benchmark and not survey_id) else []
    date_from = datetime.now(timezone.utc) - timedelta(days=days)
    day_col = cast(Response.submitted_at, Date).label("day")
    stmt = (
        select(
            day_col,
            func.count(Response.id).label("total"),
            func.sum(case((Response.processing_status.in_(["approved", "validated"]), 1), else_=0)).label("valid"),
            func.sum(case((Response.processing_status == "flagged", 1), else_=0)).label("flagged"),
            func.sum(case((Response.processing_status == "rejected", 1), else_=0)).label("rejected"),
            func.avg(Response.quality_score).label("avg_quality_score"),
        )
        .group_by(day_col)
        .order_by(day_col.asc())
    )
    stmt = _apply_response_filters(stmt, survey_id, survey_version_id, district, None, date_from, None, excl_ids)
    rows = db.execute(stmt).all()
    return [
        {
            "date": row.day.isoformat(),
            "total": int(row.total or 0),
            "valid": int(row.valid or 0),
            "flagged": int(row.flagged or 0),
            "rejected": int(row.rejected or 0),
            "avg_quality_score": round(float(row.avg_quality_score or 0.0), 1),
            "issue_rate": round(((int(row.flagged or 0) + int(row.rejected or 0)) / int(row.total)) * 100, 1)
            if int(row.total or 0) > 0
            else 0.0,
        }
        for row in rows
    ]


def compute_geographic_distribution(
    db: Session,
    survey_id: Optional[uuid.UUID] = None,
    survey_version_id: Optional[uuid.UUID] = None,
    status_filter: Optional[str] = None,
    exclude_benchmark: bool = False,
) -> List[Dict[str, Any]]:
    excl_ids = _get_benchmark_survey_ids(db) if (exclude_benchmark and not survey_id) else []
    stmt = (
        select(
            Response.district,
            func.count(Response.id).label("total"),
            func.sum(case((Response.processing_status.in_(["approved", "validated"]), 1), else_=0)).label("valid"),
            func.sum(case((Response.processing_status == "flagged", 1), else_=0)).label("flagged"),
            func.sum(case((Response.processing_status == "rejected", 1), else_=0)).label("rejected"),
            func.avg(Response.quality_score).label("avg_quality_score"),
            func.sum(case((Response.location_consent_given.is_(True), 1), else_=0)).label("gps_consented"),
            func.avg(Response.latitude).label("avg_lat"),
            func.avg(Response.longitude).label("avg_lng"),
        )
        .group_by(Response.district)
        .order_by(func.count(Response.id).desc())
    )
    stmt = _apply_response_filters(stmt, survey_id, survey_version_id, None, status_filter, None, None, excl_ids)
    rows = db.execute(stmt).all()
    out = []
    for row in rows:
        total = int(row.total or 0)
        valid = int(row.valid or 0)
        gps = int(row.gps_consented or 0)
        out.append(
            {
                "district": row.district,
                "total": total,
                "valid": valid,
                "flagged": int(row.flagged or 0),
                "rejected": int(row.rejected or 0),
                "valid_rate": round((valid / total) * 100, 1) if total > 0 else 0.0,
                "avg_quality_score": round(float(row.avg_quality_score or 0.0), 1),
                "gps_coverage_pct": round((gps / total) * 100, 1) if total > 0 else 0.0,
                "centroid": {
                    "lat": round(float(row.avg_lat), 4) if row.avg_lat is not None else None,
                    "lng": round(float(row.avg_lng), 4) if row.avg_lng is not None else None,
                },
            }
        )
    return out


def compute_quality_breakdown(
    db: Session,
    survey_id: Optional[uuid.UUID] = None,
    exclude_benchmark: bool = False,
) -> Dict[str, Any]:
    excl_ids = _get_benchmark_survey_ids(db) if (exclude_benchmark and not survey_id) else []
    by_type_stmt = (
        select(
            QualityIssue.issue_type,
            func.count(QualityIssue.id).label("total"),
            func.sum(case((QualityIssue.status == "open", 1), else_=0)).label("open_count"),
            func.sum(case((QualityIssue.status == "resolved", 1), else_=0)).label("resolved_count"),
            func.sum(case((QualityIssue.status == "dismissed", 1), else_=0)).label("dismissed_count"),
        )
        .group_by(QualityIssue.issue_type)
        .order_by(func.count(QualityIssue.id).desc())
    )
    if survey_id:
        by_type_stmt = by_type_stmt.where(QualityIssue.survey_id == survey_id)
    elif excl_ids:
        by_type_stmt = by_type_stmt.where(QualityIssue.survey_id.notin_(excl_ids))

    by_type_rows = db.execute(by_type_stmt).all()

    by_sev_stmt = (
        select(QualityIssue.severity, func.count(QualityIssue.id).label("total"))
        .group_by(QualityIssue.severity)
    )
    if survey_id:
        by_sev_stmt = by_sev_stmt.where(QualityIssue.survey_id == survey_id)
    elif excl_ids:
        by_sev_stmt = by_sev_stmt.where(QualityIssue.survey_id.notin_(excl_ids))
    by_sev_rows = db.execute(by_sev_stmt).all()

    return {
        "by_type": [
            {
                "issue_type": r.issue_type,
                "total": int(r.total or 0),
                "open": int(r.open_count or 0),
                "resolved": int(r.resolved_count or 0),
                "dismissed": int(r.dismissed_count or 0),
            }
            for r in by_type_rows
        ],
        "by_severity": {r.severity: int(r.total or 0) for r in by_sev_rows},
    }


def compute_question_distributions(
    db: Session,
    survey_id: uuid.UUID,
    survey_version_id: Optional[uuid.UUID] = None,
    status_filter: str = "valid",
    district: Optional[str] = None,
) -> List[Dict[str, Any]]:
    survey = db.get(Survey, survey_id)
    if not survey:
        return []

    target_version_id = survey_version_id or survey.active_version_id
    if not target_version_id:
        latest = db.execute(
            select(SurveyVersion)
            .where(SurveyVersion.survey_id == survey_id)
            .order_by(SurveyVersion.version_number.desc())
            .limit(1)
        ).scalar_one_or_none()
        if not latest:
            return []
        target_version_id = latest.id

    version = db.execute(
        select(SurveyVersion)
        .options(selectinload(SurveyVersion.questions))
        .where(SurveyVersion.id == target_version_id)
    ).scalar_one_or_none()
    if not version:
        return []

    questions = sorted(version.questions, key=lambda q: q.order_index)
    results: List[Dict[str, Any]] = []

    for q in questions:
        base_join = (
            select(ResponseAnswer)
            .join(Response, ResponseAnswer.response_id == Response.id)
            .where(ResponseAnswer.question_id == q.id)
        )
        base_join = _apply_response_filters(base_join, survey_id, target_version_id, district, status_filter, None, None)

        summary_stmt = (
            select(
                func.count(ResponseAnswer.id).label("total_records"),
                func.sum(case((ResponseAnswer.is_missing.is_(False), 1), else_=0)).label("answered"),
                func.sum(case((ResponseAnswer.is_missing.is_(True), 1), else_=0)).label("missing"),
                func.sum(case((ResponseAnswer.is_outlier.is_(True), 1), else_=0)).label("outliers"),
                func.avg(ResponseAnswer.numeric_value).label("mean_val"),
                func.min(ResponseAnswer.numeric_value).label("min_val"),
                func.max(ResponseAnswer.numeric_value).label("max_val"),
            )
            .select_from(ResponseAnswer)
            .join(Response, ResponseAnswer.response_id == Response.id)
            .where(ResponseAnswer.question_id == q.id)
        )
        summary_stmt = _apply_response_filters(summary_stmt, survey_id, target_version_id, district, status_filter, None, None)
        srow = db.execute(summary_stmt).one()

        answered = int(srow.answered or 0)
        total_records = int(srow.total_records or 0)
        option_label_map = {str(o.get("value")): str(o.get("label")) for o in (q.options or [])}

        distribution: List[Dict[str, Any]] = []

        if q.question_type in ("single_choice", "boolean", "rating"):
            dist_stmt = (
                select(ResponseAnswer.text_value, func.count(ResponseAnswer.id).label("cnt"))
                .select_from(ResponseAnswer)
                .join(Response, ResponseAnswer.response_id == Response.id)
                .where(ResponseAnswer.question_id == q.id, ResponseAnswer.is_missing.is_(False))
                .group_by(ResponseAnswer.text_value)
                .order_by(func.count(ResponseAnswer.id).desc())
            )
            dist_stmt = _apply_response_filters(dist_stmt, survey_id, target_version_id, district, status_filter, None, None)
            for val, cnt in db.execute(dist_stmt).all():
                key = str(val)
                label = option_label_map.get(key, key)
                if q.question_type == "boolean":
                    label = "Yes" if key == "true" else "No"
                distribution.append(
                    {
                        "key": key,
                        "label": label,
                        "count": int(cnt),
                        "pct": round((int(cnt) / answered) * 100, 1) if answered > 0 else 0.0,
                    }
                )
            if q.question_type == "rating":
                distribution.sort(key=lambda x: x["key"])

        elif q.question_type == "multi_choice":
            # Aggregate multi_choice selections from effective_value arrays
            arr_stmt = (
                select(ResponseAnswer.effective_value)
                .select_from(ResponseAnswer)
                .join(Response, ResponseAnswer.response_id == Response.id)
                .where(ResponseAnswer.question_id == q.id, ResponseAnswer.is_missing.is_(False))
            )
            arr_stmt = _apply_response_filters(arr_stmt, survey_id, target_version_id, district, status_filter, None, None)
            counts: Dict[str, int] = {}
            for (eff,) in db.execute(arr_stmt).all():
                if isinstance(eff, list):
                    for item in eff:
                        k = str(item)
                        counts[k] = counts.get(k, 0) + 1
            for k, cnt in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
                distribution.append(
                    {
                        "key": k,
                        "label": option_label_map.get(k, k),
                        "count": cnt,
                        "pct": round((cnt / answered) * 100, 1) if answered > 0 else 0.0,
                    }
                )

        elif q.question_type == "number":
            # Build clean 6-bucket histogram from SQL numeric values
            num_stmt = (
                select(ResponseAnswer.numeric_value)
                .select_from(ResponseAnswer)
                .join(Response, ResponseAnswer.response_id == Response.id)
                .where(
                    ResponseAnswer.question_id == q.id,
                    ResponseAnswer.is_missing.is_(False),
                    ResponseAnswer.numeric_value.is_not(None),
                )
            )
            num_stmt = _apply_response_filters(num_stmt, survey_id, target_version_id, district, status_filter, None, None)
            nums = [float(r[0]) for r in db.execute(num_stmt).all()]
            if nums:
                low, high = min(nums), max(nums)
                if low == high:
                    distribution.append({"key": str(low), "label": str(low), "count": len(nums), "pct": 100.0})
                else:
                    bins = 6
                    step = (high - low) / bins
                    for i in range(bins):
                        b_start = low + i * step
                        b_end = low + (i + 1) * step
                        cnt = sum(1 for v in nums if (b_start <= v < b_end) or (i == bins - 1 and v == b_end))
                        label = f"{round(b_start, 1)}–{round(b_end, 1)}"
                        distribution.append(
                            {
                                "key": label,
                                "label": label,
                                "count": cnt,
                                "pct": round((cnt / len(nums)) * 100, 1),
                            }
                        )

        elif q.question_type in ("short_text", "long_text", "date"):
            top_stmt = (
                select(ResponseAnswer.text_value, func.count(ResponseAnswer.id).label("cnt"))
                .select_from(ResponseAnswer)
                .join(Response, ResponseAnswer.response_id == Response.id)
                .where(ResponseAnswer.question_id == q.id, ResponseAnswer.is_missing.is_(False))
                .group_by(ResponseAnswer.text_value)
                .order_by(func.count(ResponseAnswer.id).desc())
                .limit(8)
            )
            top_stmt = _apply_response_filters(top_stmt, survey_id, target_version_id, district, status_filter, None, None)
            for val, cnt in db.execute(top_stmt).all():
                label = str(val or "")
                distribution.append(
                    {
                        "key": label,
                        "label": label[:48] + ("…" if len(label) > 48 else ""),
                        "count": int(cnt),
                        "pct": round((int(cnt) / answered) * 100, 1) if answered > 0 else 0.0,
                    }
                )

        numeric_stats = None
        if q.question_type in ("number", "rating") and srow.mean_val is not None:
            numeric_stats = {
                "mean": round(float(srow.mean_val), 2),
                "min": round(float(srow.min_val), 2) if srow.min_val is not None else None,
                "max": round(float(srow.max_val), 2) if srow.max_val is not None else None,
            }

        results.append(
            {
                "question_id": str(q.id),
                "question_key": q.question_key,
                "section_title": q.section_title,
                "prompt": q.prompt,
                "question_type": q.question_type,
                "is_required": q.is_required,
                "answered_count": answered,
                "missing_count": int(srow.missing or 0),
                "outlier_count": int(srow.outliers or 0),
                "response_rate": round((answered / total_records) * 100, 1) if total_records > 0 else 0.0,
                "numeric_stats": numeric_stats,
                "distribution": distribution,
            }
        )

    return results
