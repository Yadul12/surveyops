"""
Comprehensive End-to-End & Integration Test Suite for SurveyOps.

Covers:
1. Authentication & Role-Based Access Control (Admin, Analyst, Field Agent)
2. Full Enterprise Acceptance Workflow:
   Admin creates survey (multi-type, conditional branching, validation rules) ->
   Publishes v1 (verifies immutability) ->
   Assigns to Field Agent ->
   Field Agent collects clean, outlier, missing-conditional, duplicate, idempotent replay,
   and non-consented-location responses (both single & offline batch sync) ->
   9-stage Processing Pipeline scores & flags anomalies ->
   Analyst inspects Data Quality Console, applies tracked correction (verifying immutable raw),
   approves clean dataset ->
   Analytics Workspace SQL queries verify accurate stats ->
   Analyst generates Insight Report & exports verified CSV and PDF artifacts.
"""
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.db.session import SessionLocal
from app.db.seed import seed_database
from app.main import app


@pytest.fixture(scope="module")
def client():
    # Ensure database has baseline seed users/roles and run pipeline synchronously for deterministic assertions
    settings.PIPELINE_EAGER_MODE = True
    db = SessionLocal()
    try:
        seed_database(db)
    finally:
        db.close()

    with TestClient(app) as c:
        yield c


def _login(client: TestClient, email: str, password: str) -> dict:
    r = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, f"Login failed for {email}: {r.text}"
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def test_health_and_rbac_enforcement(client: TestClient):
    h = client.get("/api/v1/health")
    assert h.status_code == 200
    assert h.json()["database"] == "connected"

    # Invalid login rejected
    bad = client.post("/api/v1/auth/login", json={"email": "admin@surveyops.org", "password": "wrongpassword"})
    assert bad.status_code == 401

    admin_hdr = _login(client, "admin@surveyops.org", "AdminPass123!")
    analyst_hdr = _login(client, "analyst@surveyops.org", "AnalystPass123!")
    agent_hdr = _login(client, "agent@surveyops.org", "AgentPass123!")

    # Unauthenticated request denied
    assert client.get("/api/v1/surveys").status_code == 401

    # Field agent cannot create survey or view quality console
    assert client.post("/api/v1/surveys", headers=agent_hdr, json={"title": "Unauthorized Survey"}).status_code == 403
    assert client.get("/api/v1/quality/issues", headers=agent_hdr).status_code == 403

    # Analyst cannot create surveys, but CAN view quality console
    assert client.post("/api/v1/surveys", headers=analyst_hdr, json={"title": "Analyst Cannot Create"}).status_code == 403
    assert client.get("/api/v1/quality/issues", headers=analyst_hdr).status_code == 200

    # Admin can view users
    users_res = client.get("/api/v1/auth/users", headers=admin_hdr, params={"role": "field_agent"})
    assert users_res.status_code == 200
    assert len(users_res.json()) >= 1

    # Field agent global search never leaks quality issues
    agent_search = client.get("/api/v1/search", headers=agent_hdr, params={"q": "RULE"})
    assert agent_search.status_code == 200
    assert agent_search.json()["quality_issues"] == []

    # Field agent cannot read another agent's response (IDOR protection)
    all_resps = client.get("/api/v1/responses", headers=admin_hdr, params={"page": 1, "page_size": 20}).json()["items"]
    other_resp = next((r for r in all_resps if r["agent_name"] != "David Okafor"), None)
    if other_resp:
        idor = client.get(f"/api/v1/responses/{other_resp['id']}", headers=agent_hdr)
        assert idor.status_code == 403

    # Unauthenticated WebSocket connection is rejected with policy violation (1008)
    with pytest.raises(Exception):
        with client.websocket_connect("/api/v1/ws/live") as ws:
            ws.receive_text()


def test_full_end_to_end_enterprise_acceptance_workflow(client: TestClient):
    admin_hdr = _login(client, "admin@surveyops.org", "AdminPass123!")
    analyst_hdr = _login(client, "analyst@surveyops.org", "AnalystPass123!")
    agent_hdr = _login(client, "agent@surveyops.org", "AgentPass123!")

    # Resolve field agent user ID
    me_agent = client.get("/api/v1/auth/me", headers=agent_hdr).json()
    agent_id = me_agent["id"]

    # 1. ADMIN CREATES SURVEY WITH BRANCHING & VALIDATION RULES
    unique_suffix = uuid.uuid4().hex[:5].upper()
    survey_code = f"E2E-2026-{unique_suffix}"
    create_res = client.post(
        "/api/v1/surveys",
        headers=admin_hdr,
        json={
            "code": survey_code,
            "title": f"Municipal Sidewalk Accessibility Audit ({unique_suffix})",
            "description": "End-to-end acceptance workflow verification survey.",
            "category": "Public Transit",
            "target_responses": 50,
            "requires_consent": True,
            "allow_location_capture": True,
            "instructions": "Verify consent before recording sidewalk audit.",
            "consent_text": "Voluntary civic accessibility audit.",
            "questions": [
                {
                    "question_key": "corridor_type",
                    "section_title": "Location",
                    "prompt": "Type of pedestrian corridor inspected?",
                    "question_type": "single_choice",
                    "order_index": 0,
                    "is_required": True,
                    "options": [
                        {"value": "school_zone", "label": "School Zone"},
                        {"value": "transit_hub", "label": "Transit Hub"},
                        {"value": "residential", "label": "Residential Street"},
                    ],
                },
                {
                    "question_key": "crossing_wait_sec",
                    "section_title": "Timing",
                    "prompt": "Pedestrian signal wait time (seconds)?",
                    "question_type": "number",
                    "order_index": 1,
                    "is_required": True,
                    "config": {"unit": "seconds"},
                    "validation_rules": [
                        {
                            "rule_type": "min_value",
                            "rule_config": {"min": 0},
                            "severity": "critical",
                            "error_message": "Wait seconds cannot be negative.",
                            "is_active": True,
                        },
                        {
                            "rule_type": "outlier_bounds",
                            "rule_config": {"min": 5, "max": 120},
                            "severity": "warning",
                            "error_message": "Signal wait exceeds 120 seconds; verify timing.",
                            "is_active": True,
                        },
                    ],
                },
                {
                    "question_key": "curb_ramp_damaged",
                    "section_title": "Defects",
                    "prompt": "Is the curb ramp damaged or obstructed?",
                    "question_type": "boolean",
                    "order_index": 2,
                    "is_required": True,
                },
                {
                    "question_key": "defect_severity",
                    "section_title": "Defects",
                    "prompt": "Select curb ramp defect severity.",
                    "question_type": "single_choice",
                    "order_index": 3,
                    "is_required": True,
                    "options": [
                        {"value": "minor", "label": "Minor Surface Crack"},
                        {"value": "moderate", "label": "Uneven Lip (>2cm)"},
                        {"value": "severe", "label": "Impassable / Blocked"},
                    ],
                    "conditional_logic": {
                        "operator": "all",
                        "rules": [
                            {"question_key": "curb_ramp_damaged", "condition": "equals", "value": "true"}
                        ],
                    },
                },
                {
                    "question_key": "lighting_rating",
                    "section_title": "Quality",
                    "prompt": "Rate evening street lighting quality (1-5).",
                    "question_type": "rating",
                    "order_index": 4,
                    "is_required": True,
                    "config": {"min": 1, "max": 5},
                },
            ],
        },
    )
    assert create_res.status_code == 201, create_res.text
    survey = create_res.json()
    survey_id = survey["id"]
    v1_id = survey["versions"][0]["id"]
    assert survey["status"] == "draft"
    assert len(survey["versions"][0]["questions"]) == 5

    # 2. ADMIN PUBLISHES SURVEY v1
    pub_res = client.post(f"/api/v1/surveys/{survey_id}/publish", headers=admin_hdr, json={"version_id": v1_id})
    assert pub_res.status_code == 200, pub_res.text
    assert pub_res.json()["status"] == "published"
    assert pub_res.json()["active_version_id"] == v1_id

    # Verify published version is immutable
    immut_res = client.put(
        f"/api/v1/surveys/{survey_id}/versions/{v1_id}/questions",
        headers=admin_hdr,
        json={"questions": []},
    )
    assert immut_res.status_code == 400

    # 3. ADMIN ASSIGNS SURVEY TO FIELD AGENT
    asgn_res = client.post(
        "/api/v1/assignments",
        headers=admin_hdr,
        json={
            "survey_id": survey_id,
            "agent_id": agent_id,
            "region": "North Metro",
            "target_count": 25,
            "notes": "Inspect school zones and bus transfer intersections.",
        },
    )
    assert asgn_res.status_code == 201, asgn_res.text
    assignment_id = asgn_res.json()["id"]

    # Verify agent sees assignment with full offline-ready schema
    my_asgns = client.get("/api/v1/assignments/my-field-assignments", headers=agent_hdr)
    assert my_asgns.status_code == 200
    found_asgn = next((a for a in my_asgns.json()["items"] if a["id"] == assignment_id), None)
    assert found_asgn is not None
    assert len(found_asgn["survey_schema"]["questions"]) == 5

    # 4. FIELD AGENT COLLECTS RESPONSES (CLEAN, IDEMPOTENT REPLAY, OUTLIER+SPEEDING, CONDITIONAL MISSING, DUPLICATE, PRIVACY)
    clean_cid = f"e2e-clean-{unique_suffix}"
    clean_answers = {
        "corridor_type": "school_zone",
        "crossing_wait_sec": 42,
        "curb_ramp_damaged": False,
        "lighting_rating": 4,
    }
    r_clean = client.post(
        "/api/v1/responses",
        headers=agent_hdr,
        json={
            "client_submission_id": clean_cid,
            "survey_id": survey_id,
            "survey_version_id": v1_id,
            "assignment_id": assignment_id,
            "answers": clean_answers,
            "consent_given": True,
            "location_consent_given": True,
            "latitude": 40.8245,
            "longitude": -73.9412,
            "location_accuracy_m": 12.0,
            "district": "North Metro",
            "submitted_at": datetime.now(timezone.utc).isoformat(),
            "duration_seconds": 145,
            "source_channel": "mobile_online",
            "process_sync": True,
        },
    )
    assert r_clean.status_code == 201, r_clean.text
    assert r_clean.json()["processing_status"] == "approved"
    assert r_clean.json()["quality_score"] >= 88.0

    # Idempotent replay check
    r_replay = client.post(
        "/api/v1/responses",
        headers=agent_hdr,
        json={
            "client_submission_id": clean_cid,
            "survey_id": survey_id,
            "answers": clean_answers,
            "consent_given": True,
            "district": "North Metro",
            "duration_seconds": 145,
            "process_sync": True,
        },
    )
    assert r_replay.status_code == 201
    assert r_replay.json()["idempotent_replay"] is True
    assert r_replay.json()["id"] == r_clean.json()["id"]

    # Offline batch sync with:
    # (a) outlier + speeding (wait_sec=260, duration=9s -> flagged)
    # (b) conditional required missing (curb_ramp_damaged=True without defect_severity -> flagged/rejected)
    # (c) duplicate fingerprint of clean_answers with new submission ID -> rejected
    # (d) privacy test: GPS sent with location_consent_given=False -> stripped to null
    outlier_cid = f"e2e-outlier-{unique_suffix}"
    missing_cond_cid = f"e2e-condmiss-{unique_suffix}"
    dup_cid = f"e2e-dup-{unique_suffix}"
    privacy_cid = f"e2e-priv-{unique_suffix}"

    batch_res = client.post(
        "/api/v1/responses/batch",
        headers=agent_hdr,
        json={
            "batch_id": f"e2e-batch-{unique_suffix}",
            "process_sync": True,
            "items": [
                {
                    "client_submission_id": outlier_cid,
                    "survey_id": survey_id,
                    "survey_version_id": v1_id,
                    "assignment_id": assignment_id,
                    "answers": {
                        "corridor_type": "transit_hub",
                        "crossing_wait_sec": 260,  # outlier > 120s
                        "curb_ramp_damaged": True,
                        "defect_severity": "moderate",
                        "lighting_rating": 3,
                    },
                    "consent_given": True,
                    "location_consent_given": False,
                    "district": "North Metro",
                    "duration_seconds": 9,  # speeding
                    "source_channel": "mobile_offline",
                },
                {
                    "client_submission_id": missing_cond_cid,
                    "survey_id": survey_id,
                    "survey_version_id": v1_id,
                    "answers": {
                        "corridor_type": "residential",
                        "crossing_wait_sec": 35,
                        "curb_ramp_damaged": True,
                        # defect_severity missing despite curb_ramp_damaged=True!
                        "lighting_rating": 4,
                    },
                    "consent_given": True,
                    "district": "East River",
                    "duration_seconds": 130,
                    "source_channel": "mobile_offline",
                },
                {
                    "client_submission_id": dup_cid,
                    "survey_id": survey_id,
                    "survey_version_id": v1_id,
                    "answers": clean_answers,  # exact fingerprint duplicate within 60m!
                    "consent_given": True,
                    "district": "North Metro",
                    "duration_seconds": 145,
                    "source_channel": "mobile_offline",
                },
                {
                    "client_submission_id": privacy_cid,
                    "survey_id": survey_id,
                    "survey_version_id": v1_id,
                    "answers": {
                        "corridor_type": "residential",
                        "crossing_wait_sec": 28,
                        "curb_ramp_damaged": False,
                        "lighting_rating": 5,
                    },
                    "consent_given": True,
                    "location_consent_given": False,
                    "latitude": 40.75,
                    "longitude": -73.98,
                    "district": "South Harbor",
                    "duration_seconds": 160,
                    "source_channel": "mobile_offline",
                },
            ],
        },
    )
    assert batch_res.status_code == 202, batch_res.text
    assert batch_res.json()["ingested_count"] == 4
    id_by_cid = {it["client_submission_id"]: it["response_id"] for it in batch_res.json()["items"]}

    # Verify privacy guarantee: coordinates were NOT persisted when location_consent_given=False
    priv_detail = client.get(f"/api/v1/responses/{id_by_cid[privacy_cid]}", headers=analyst_hdr).json()
    assert priv_detail["latitude"] is None
    assert priv_detail["longitude"] is None
    assert priv_detail["processing_status"] == "approved"

    # Verify conditional skipped answer is marked is_skipped=True (not falsely treated as missing error)
    assert any(a["question_key"] == "defect_severity" and a["is_skipped"] is True for a in priv_detail["answers"])

    # Verify duplicate detection
    dup_detail = client.get(f"/api/v1/responses/{id_by_cid[dup_cid]}", headers=analyst_hdr).json()
    assert dup_detail["is_duplicate"] is True
    assert dup_detail["processing_status"] == "rejected"
    assert any(qi["issue_type"] == "duplicate" for qi in dup_detail["quality_issues"])

    # Verify conditional required field detection
    cond_detail = client.get(f"/api/v1/responses/{id_by_cid[missing_cond_cid]}", headers=analyst_hdr).json()
    assert cond_detail["processing_status"] in ("flagged", "rejected")
    assert any(qi["issue_type"] == "missing_value" and qi["question_key"] == "defect_severity" for qi in cond_detail["quality_issues"])

    # 5. ANALYST INSPECTS QUALITY CONSOLE, CORRECTS OUTLIER (IMMUTABLE RAW PRESERVED), & APPROVES
    outlier_id = id_by_cid[outlier_cid]
    outlier_detail = client.get(f"/api/v1/responses/{outlier_id}", headers=analyst_hdr).json()
    assert outlier_detail["processing_status"] in ("flagged", "rejected")
    issue_types = {qi["issue_type"] for qi in outlier_detail["quality_issues"]}
    assert "outlier" in issue_types
    assert "suspicious_duration" in issue_types

    # Apply tracked correction on crossing_wait_sec: 260 -> 26
    corr_res = client.patch(
        f"/api/v1/quality/responses/{outlier_id}/answers/crossing_wait_sec",
        headers=analyst_hdr,
        json={
            "corrected_value": 26,
            "correction_reason": "Verified trailing zero typo with enumerator shift sheet.",
            "reprocess": True,
        },
    )
    assert corr_res.status_code == 200, corr_res.text
    assert corr_res.json()["raw_value"] == 260  # IMMUTABLE RAW PRESERVED!
    assert corr_res.json()["corrected_value"] == 26
    assert corr_res.json()["effective_value"] == 26

    # Approve corrected record
    approve_res = client.post(
        f"/api/v1/quality/responses/{outlier_id}/decision",
        headers=analyst_hdr,
        json={"decision": "approve", "review_notes": "Timing verified; approved for clean dataset.", "resolve_open_issues": True},
    )
    assert approve_res.status_code == 200
    assert approve_res.json()["processing_status"] == "approved"

    # Re-fetch full record and verify raw_payload is STILL untouched & audit trail recorded
    post_detail = client.get(f"/api/v1/responses/{outlier_id}", headers=analyst_hdr).json()
    assert post_detail["raw_payload"]["answers"]["crossing_wait_sec"] == 260
    assert post_detail["normalized_payload"]["crossing_wait_sec"] == 26
    audit_actions = [a["action"] for a in post_detail["audit_history"]]
    assert "analyst.corrected_answer" in audit_actions
    assert "analyst.approve_response" in audit_actions

    # 6. ANALYTICS WORKSPACE SQL VERIFICATION
    ov = client.get("/api/v1/analytics/overview", headers=analyst_hdr, params={"survey_id": survey_id}).json()
    assert ov["kpis"]["total_responses"] == 5
    assert ov["kpis"]["approved_responses"] == 3  # clean + privacy + analyst-approved outlier
    assert ov["kpis"]["rejected_responses"] >= 1  # duplicate

    q_dist = client.get(f"/api/v1/analytics/questions/{survey_id}", headers=analyst_hdr, params={"status": "approved"}).json()
    wait_q = next(q for q in q_dist["questions"] if q["question_key"] == "crossing_wait_sec")
    # Mean of approved wait times: (42 + 28 + 26) / 3 = 32.0 (uses corrected 26, NOT raw 260!)
    assert wait_q["numeric_stats"]["mean"] == 32.0

    # 7. INSIGHT REPORT GENERATION + CSV & PDF EXPORT VERIFICATION
    rep_res = client.post(
        "/api/v1/reports",
        headers=analyst_hdr,
        json={
            "survey_id": survey_id,
            "title": f"Acceptance Test Sidewalk Audit Report ({unique_suffix})",
            "report_type": "full_insight",
            "status_filter": "approved",
            "analyst_notes": "Verified 3 clean/corrected records across North Metro and South Harbor. Duplicate and missing-branch records excluded.",
        },
    )
    assert rep_res.status_code == 201, rep_res.text
    report_id = rep_res.json()["id"]
    assert rep_res.json()["summary_stats"]["approved_responses"] == 3

    # CSV export
    csv_res = client.get(f"/api/v1/reports/{report_id}/export/csv", headers=analyst_hdr)
    assert csv_res.status_code == 200
    assert "text/csv" in csv_res.headers["content-type"]
    assert "Executive KPI" in csv_res.text
    assert "crossing_wait_sec" in csv_res.text

    # PDF export
    pdf_res = client.get(f"/api/v1/reports/{report_id}/export/pdf", headers=analyst_hdr)
    assert pdf_res.status_code == 200
    assert "application/pdf" in pdf_res.headers["content-type"]
    assert pdf_res.content[:5] == b"%PDF-"
    assert len(pdf_res.content) > 2000

    # Clean dataset CSV export
    ds_csv = client.get(
        "/api/v1/responses/export/csv",
        headers=analyst_hdr,
        params={"survey_id": survey_id, "status_filter": "approved"},
    )
    assert ds_csv.status_code == 200
    assert clean_cid in ds_csv.text
    assert dup_cid not in ds_csv.text  # rejected duplicate excluded from clean approved CSV!

    # Verify archive behavior preserves records, then hard-clean synthetic E2E rows from DB
    del_res = client.delete(f"/api/v1/surveys/{survey_id}", headers=admin_hdr)
    assert del_res.status_code == 200
    assert del_res.json()["action"] == "survey.archived"

    # Hard cleanup so automated tests never leave archived E2E artifacts in live workspace
    from sqlalchemy import text
    db = SessionLocal()
    try:
        db.execute(text("DELETE FROM audit_events WHERE entity_id = :sid OR metadata_json->>'survey_id' = :sid"), {"sid": survey_id})
        db.execute(text("DELETE FROM processing_jobs WHERE batch_id = :bid"), {"bid": f"e2e-batch-{unique_suffix}"})
        db.execute(text("DELETE FROM surveys WHERE id = :sid"), {"sid": survey_id})
        db.commit()
    finally:
        db.close()
