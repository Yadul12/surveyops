import json
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.config import settings
from app.db.session import get_db
from app.models.models import User
from app.services.analytics import (
    compute_geographic_distribution,
    compute_overview_kpis,
    compute_quality_breakdown,
    compute_question_distributions,
    compute_response_trends,
)

router = APIRouter(prefix="/analytics", tags=["Analytics Workspace"])


@router.get("/overview")
def get_analytics_overview(
    survey_id: Optional[uuid.UUID] = Query(default=None),
    survey_version_id: Optional[uuid.UUID] = Query(default=None),
    district: Optional[str] = Query(default=None),
    days: int = Query(default=30, ge=7, le=365),
    exclude_benchmark: bool = Query(default=False),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    kpis = compute_overview_kpis(
        db,
        survey_id=survey_id,
        survey_version_id=survey_version_id,
        district=district,
        exclude_benchmark=exclude_benchmark,
    )
    trends = compute_response_trends(
        db,
        survey_id=survey_id,
        survey_version_id=survey_version_id,
        district=district,
        days=days,
        exclude_benchmark=exclude_benchmark,
    )
    geo = compute_geographic_distribution(
        db,
        survey_id=survey_id,
        survey_version_id=survey_version_id,
        exclude_benchmark=exclude_benchmark,
    )
    quality = compute_quality_breakdown(db, survey_id=survey_id, exclude_benchmark=exclude_benchmark)

    return {
        "kpis": kpis,
        "trends": trends,
        "geographic": geo,
        "quality_breakdown": quality,
    }


@router.get("/questions/{survey_id}")
def get_question_analytics(
    survey_id: uuid.UUID,
    survey_version_id: Optional[uuid.UUID] = Query(default=None),
    status_filter: str = Query(default="valid", alias="status"),
    district: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    distributions = compute_question_distributions(
        db,
        survey_id=survey_id,
        survey_version_id=survey_version_id,
        status_filter=status_filter,
        district=district,
    )
    return {"survey_id": str(survey_id), "status_filter": status_filter, "questions": distributions}


@router.get("/benchmarks")
def get_measured_benchmarks(
    _: User = Depends(get_current_user),
):
    """
    Returns ONLY actual measured benchmark runs stored in the benchmarks/ directory.
    Never returns fabricated or hardcoded throughput claims.
    """
    candidates = [
        Path(settings.BENCHMARKS_DIR),
        Path("/app/benchmarks"),
        Path(__file__).resolve().parents[3] / "benchmarks",
        Path(__file__).resolve().parents[4] / "benchmarks",
    ]
    bench_dir = next((p for p in candidates if p.exists() and p.is_dir()), None)
    runs = []
    if bench_dir:
        for f in sorted(bench_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                data["_filename"] = f.name
                runs.append(data)
            except Exception:
                continue
    return {"measured_runs": runs, "count": len(runs)}
