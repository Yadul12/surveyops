import hashlib
import json
import random
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.logging import get_logger, setup_logging
from app.core.security import hash_password
from app.db.session import SessionLocal
from app.models.models import (
    AuditEvent,
    QualityIssue,
    Question,
    Report,
    Respondent,
    Response,
    ResponseAnswer,
    Role,
    Survey,
    SurveyAssignment,
    SurveyVersion,
    User,
    ValidationRule,
)
from app.pipeline.engine import process_response_pipeline
from app.services.analytics import (
    compute_geographic_distribution,
    compute_overview_kpis,
    compute_quality_breakdown,
    compute_question_distributions,
)

logger = get_logger("surveyops.seed")

DISTRICTS = {
    "Metro Central": (40.7580, -73.9855),
    "North Metro": (40.8240, -73.9420),
    "East River": (40.7410, -73.9280),
    "South Harbor": (40.6820, -73.9910),
    "West Highlands": (40.7790, -74.0210),
}


def _schema_hash(questions_spec: list[dict]) -> str:
    return hashlib.sha256(json.dumps(questions_spec, sort_keys=True).encode("utf-8")).hexdigest()


def seed_database(db: Session) -> None:
    # Idempotency check
    existing_roles = db.execute(select(func.count(Role.id))).scalar() or 0
    if existing_roles > 0:
        logger.info("Database already seeded (%s roles found); skipping.", existing_roles)
        return

    rng = random.Random(20261124)
    now = datetime.now(timezone.utc)

    # 1. Roles
    role_admin = Role(
        name="admin",
        description="System administrator with full survey authoring, publishing, assignment, quality, and reporting permissions.",
        permissions=[
            "surveys:read", "surveys:write", "surveys:publish", "assignments:manage",
            "responses:read", "responses:submit", "pipeline:manage",
            "quality:review", "analytics:read", "reports:write", "users:manage",
        ],
    )
    role_analyst = Role(
        name="analyst",
        description="Data quality and research analyst with review, correction, approval, analytics, and report permissions.",
        permissions=[
            "surveys:read", "responses:read", "pipeline:read",
            "quality:review", "analytics:read", "reports:write",
        ],
    )
    role_agent = Role(
        name="field_agent",
        description="Field enumerator operating the mobile offline-first collection application.",
        permissions=["surveys:read", "assignments:read", "responses:submit"],
    )
    db.add_all([role_admin, role_analyst, role_agent])
    db.flush()

    # 2. Users
    admin_user = User(
        email="admin@surveyops.org",
        full_name="Dr. Clara Chen",
        hashed_password=hash_password("AdminPass123!"),
        role_id=role_admin.id,
        department="Office of Civic Data Operations",
        region="Metro Central",
    )
    analyst_1 = User(
        email="analyst@surveyops.org",
        full_name="Marcus Vance",
        hashed_password=hash_password("AnalystPass123!"),
        role_id=role_analyst.id,
        department="Data Quality & Standards",
        region="Metro Central",
    )
    analyst_2 = User(
        email="priya.nair@surveyops.org",
        full_name="Priya Nair",
        hashed_password=hash_password("AnalystPass123!"),
        role_id=role_analyst.id,
        department="Urban Analytics Unit",
        region="East River",
    )
    agent_specs = [
        ("agent@surveyops.org", "David Okafor", "North Metro"),
        ("elena.morales@surveyops.org", "Elena Morales", "East River"),
        ("samuel.boateng@surveyops.org", "Samuel Boateng", "South Harbor"),
        ("hannah.kowalski@surveyops.org", "Hannah Kowalski", "West Highlands"),
        ("kenji.takahashi@surveyops.org", "Kenji Takahashi", "Metro Central"),
    ]
    agents = []
    for email, name, region in agent_specs:
        agents.append(
            User(
                email=email,
                full_name=name,
                hashed_password=hash_password("AgentPass123!"),
                role_id=role_agent.id,
                department="Field Enumeration Corps",
                region=region,
            )
        )
    db.add_all([admin_user, analyst_1, analyst_2, *agents])
    db.flush()

    # Helper to create survey + version + questions + validation rules
    def create_survey_with_questions(
        code: str,
        title: str,
        description: str,
        category: str,
        status: str,
        target_responses: int,
        instructions: str,
        questions_spec: list[dict],
        version_number: int = 1,
        include_retired_v1: bool = False,
    ) -> tuple[Survey, SurveyVersion]:
        survey = Survey(
            code=code,
            title=title,
            description=description,
            category=category,
            status=status,
            target_responses=target_responses,
            requires_consent=True,
            allow_location_capture=True,
            instructions=instructions,
            consent_text=(
                "Your participation is voluntary and confidential. Answers are anonymized and used strictly "
                "for municipal service planning and public-interest research. You may decline location capture "
                "or withdraw at any time."
            ),
            created_by_id=admin_user.id,
        )
        db.add(survey)
        db.flush()

        if include_retired_v1:
            v1 = SurveyVersion(
                survey_id=survey.id,
                version_number=1,
                status="retired",
                schema_hash=_schema_hash(questions_spec[:5]),
                change_notes="Initial pilot release prior to accessibility follow-up branching.",
                published_at=now - timedelta(days=45),
                published_by_id=admin_user.id,
            )
            db.add(v1)
            db.flush()

        ver = SurveyVersion(
            survey_id=survey.id,
            version_number=version_number,
            status="published" if status == "published" else "draft",
            schema_hash=_schema_hash(questions_spec),
            change_notes="Production field release with automated validation and conditional branching.",
            published_at=(now - timedelta(days=30)) if status == "published" else None,
            published_by_id=admin_user.id if status == "published" else None,
        )
        db.add(ver)
        db.flush()

        if status == "published":
            survey.active_version_id = ver.id

        for idx, qspec in enumerate(questions_spec):
            q = Question(
                survey_version_id=ver.id,
                question_key=qspec["key"],
                section_title=qspec.get("section", "General"),
                prompt=qspec["prompt"],
                help_text=qspec.get("help_text", ""),
                question_type=qspec["type"],
                order_index=idx,
                is_required=qspec.get("required", True),
                options=qspec.get("options", []),
                conditional_logic=qspec.get("conditional_logic"),
                config=qspec.get("config", {}),
            )
            db.add(q)
            db.flush()

            for rspec in qspec.get("rules", []):
                db.add(
                    ValidationRule(
                        question_id=q.id,
                        rule_type=rspec["rule_type"],
                        rule_config=rspec["rule_config"],
                        severity=rspec.get("severity", "warning"),
                        error_message=rspec.get("error_message", ""),
                        is_active=True,
                    )
                )

        db.add(
            AuditEvent(
                entity_type="survey",
                entity_id=str(survey.id),
                action="survey.published" if status == "published" else "survey.created",
                actor_id=admin_user.id,
                actor_type="user",
                summary=f"Survey {code} ({title}) initialized in {status} state (v{version_number}).",
                after_state={"status": status, "version": version_number, "questions": len(questions_spec)},
                notify_level="info",
                is_read=True,
                created_at=now - timedelta(days=29),
            )
        )
        return survey, ver

    # Survey 1: Municipal Public Transit Accessibility Assessment (v2 published + v1 retired)
    transit_questions = [
        {
            "key": "primary_mode",
            "section": "Commute Profile",
            "prompt": "What is your primary mode of local transportation during the workweek?",
            "type": "single_choice",
            "required": True,
            "options": [
                {"value": "municipal_bus", "label": "Municipal Bus"},
                {"value": "light_rail", "label": "Metro / Light Rail"},
                {"value": "paratransit", "label": "Paratransit / Accessible Shuttle"},
                {"value": "bicycle_walk", "label": "Walking or Cycling"},
                {"value": "private_vehicle", "label": "Private Vehicle"},
            ],
        },
        {
            "key": "weekly_transit_trips",
            "section": "Commute Profile",
            "prompt": "Approximately how many one-way public transit trips do you take per week?",
            "help_text": "Enter 0 if you do not currently use municipal transit.",
            "type": "number",
            "required": True,
            "config": {"unit": "trips/week", "placeholder": "e.g. 10"},
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 0}, "severity": "critical", "error_message": "Weekly trips cannot be negative."},
                {"rule_type": "outlier_bounds", "rule_config": {"min": 0, "max": 42}, "severity": "warning", "error_message": "Weekly transit trip count exceeds realistic ceiling (42/week)."},
            ],
        },
        {
            "key": "avg_wait_minutes",
            "section": "Service Reliability",
            "prompt": "What is your typical wait time (in minutes) during peak weekday hours?",
            "type": "number",
            "required": True,
            "config": {"unit": "minutes", "placeholder": "e.g. 12"},
            "conditional_logic": {
                "operator": "any",
                "rules": [
                    {"question_key": "primary_mode", "condition": "in", "value": ["municipal_bus", "light_rail", "paratransit"]},
                ],
            },
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 0}, "severity": "critical", "error_message": "Wait time must be non-negative."},
                {"rule_type": "outlier_bounds", "rule_config": {"min": 1, "max": 60}, "severity": "warning", "error_message": "Reported wait time exceeds 60 minutes; verify against dispatch logs."},
            ],
        },
        {
            "key": "step_free_access_needed",
            "section": "Accessibility",
            "prompt": "Does anyone in your household require step-free boarding, elevators, or audio/visual stop alerts?",
            "type": "boolean",
            "required": True,
        },
        {
            "key": "accessibility_barriers",
            "section": "Accessibility",
            "prompt": "Which accessibility barriers have you encountered in the last 30 days?",
            "type": "multi_choice",
            "required": True,
            "conditional_logic": {
                "operator": "all",
                "rules": [{"question_key": "step_free_access_needed", "condition": "equals", "value": "true"}],
            },
            "options": [
                {"value": "broken_elevator", "label": "Out-of-service elevator or lift"},
                {"value": "uneven_curb", "label": "Uneven curb / missing ramp at bus stop"},
                {"value": "signage_clarity", "label": "Unclear route signage or audio announcements"},
                {"value": "vehicle_crowding", "label": "Priority seating / wheelchair bay unavailable"},
                {"value": "none", "label": "No barriers encountered"},
            ],
        },
        {
            "key": "reliability_rating",
            "section": "Satisfaction Ratings",
            "prompt": "Rate overall schedule reliability and on-time arrival (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 1}, "severity": "critical", "error_message": "Rating must be between 1 and 5."},
                {"rule_type": "max_value", "rule_config": {"max": 5}, "severity": "critical", "error_message": "Rating must be between 1 and 5."},
            ],
        },
        {
            "key": "safety_rating",
            "section": "Satisfaction Ratings",
            "prompt": "Rate perceived personal safety at transit stops and stations (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 1}, "severity": "critical", "error_message": "Rating must be 1–5."},
                {"rule_type": "max_value", "rule_config": {"max": 5}, "severity": "critical", "error_message": "Rating must be 1–5."},
            ],
        },
        {
            "key": "affordability_rating",
            "section": "Satisfaction Ratings",
            "prompt": "Rate fare affordability for your household budget (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 1}, "severity": "critical", "error_message": "Rating must be 1–5."},
                {"rule_type": "max_value", "rule_config": {"max": 5}, "severity": "critical", "error_message": "Rating must be 1–5."},
            ],
        },
        {
            "key": "last_incident_date",
            "section": "Field Notes",
            "prompt": "If you experienced a major service disruption recently, when did it occur?",
            "type": "date",
            "required": False,
        },
        {
            "key": "improvement_priority",
            "section": "Field Notes",
            "prompt": "What single transit improvement would most benefit your neighbourhood?",
            "type": "short_text",
            "required": False,
            "config": {"placeholder": "Brief civic recommendation"},
            "rules": [
                {"rule_type": "max_length", "rule_config": {"max": 240}, "severity": "warning", "error_message": "Summary exceeds 240 characters."},
            ],
        },
    ]

    survey_transit, ver_transit = create_survey_with_questions(
        code="CIV-2026-TRN",
        title="Municipal Public Transit Accessibility Assessment",
        description="Metro-wide civic field audit measuring weekday transit wait times, ADA/step-free boarding reliability, and commuter service equity across five districts.",
        category="Public Transit",
        status="published",
        target_responses=300,
        instructions="Interview adult residents near transit hubs, community centres, and residential corridors. Verify respondent consent before starting. Capture GPS only when respondent explicitly opts in.",
        questions_spec=transit_questions,
        version_number=2,
        include_retired_v1=True,
    )

    # Survey 2: Municipal Water Quality & Sanitation Household Audit
    water_questions = [
        {
            "key": "water_source",
            "section": "Supply Infrastructure",
            "prompt": "What is your household's primary source of drinking water?",
            "type": "single_choice",
            "required": True,
            "options": [
                {"value": "municipal_piped", "label": "Municipal Piped Supply"},
                {"value": "filtered_municipal", "label": "Municipal Piped + Home Filter"},
                {"value": "community_standpipe", "label": "Community Standpipe / Kiosk"},
                {"value": "bottled_delivered", "label": "Bottled / Tanker Delivery"},
            ],
        },
        {
            "key": "monthly_water_bill_usd",
            "section": "Affordability",
            "prompt": "What is your approximate monthly household water and sewer bill (USD)?",
            "type": "number",
            "required": True,
            "config": {"unit": "USD/month"},
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 0}, "severity": "critical", "error_message": "Monthly utility bill cannot be negative."},
                {"rule_type": "outlier_bounds", "rule_config": {"min": 10, "max": 350}, "severity": "warning", "error_message": "Household bill outside expected $10–$350 residential band."},
            ],
        },
        {
            "key": "experienced_outage",
            "section": "Service Continuity",
            "prompt": "Has your household experienced an unplanned water supply interruption in the last 90 days?",
            "type": "boolean",
            "required": True,
        },
        {
            "key": "outage_hours_longest",
            "section": "Service Continuity",
            "prompt": "How many hours did the longest unplanned interruption last?",
            "type": "number",
            "required": True,
            "config": {"unit": "hours"},
            "conditional_logic": {
                "operator": "all",
                "rules": [{"question_key": "experienced_outage", "condition": "equals", "value": "true"}],
            },
            "rules": [
                {"rule_type": "min_value", "rule_config": {"min": 1}, "severity": "warning", "error_message": "Outage duration should be at least 1 hour."},
                {"rule_type": "outlier_bounds", "rule_config": {"min": 1, "max": 72}, "severity": "warning", "error_message": "Outage over 72 hours requires utility incident cross-check."},
            ],
        },
        {
            "key": "water_clarity_rating",
            "section": "Quality Perception",
            "prompt": "Rate tap water clarity, taste, and odor (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "waste_collection_rating",
            "section": "Quality Perception",
            "prompt": "Rate curbside waste and recycling collection reliability (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "stormwater_drainage_rating",
            "section": "Quality Perception",
            "prompt": "Rate street stormwater drainage during heavy rain (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "sanitation_concerns",
            "section": "Field Observations",
            "prompt": "Select any recurring neighbourhood sanitation concerns observed in the last 6 months.",
            "type": "multi_choice",
            "required": False,
            "options": [
                {"value": "low_pressure", "label": "Low water pressure during peak hours"},
                {"value": "street_flooding", "label": "Localized street flooding"},
                {"value": "missed_pickup", "label": "Missed recycling or waste pickup"},
                {"value": "odor_sewer", "label": "Storm drain odor or blockage"},
                {"value": "none", "label": "No recurring issues"},
            ],
        },
    ]

    survey_water, ver_water = create_survey_with_questions(
        code="CIV-2026-WTR",
        title="Municipal Water Quality & Sanitation Household Audit",
        description="Door-to-door residential assessment of drinking water reliability, utility affordability, supply interruptions, and neighbourhood stormwater readiness.",
        category="Water & Sanitation",
        status="published",
        target_responses=250,
        instructions="Conduct household interviews across assigned wards using systematic interval sampling (every 4th residence). Record anonymized household reference code only.",
        questions_spec=water_questions,
        version_number=1,
    )

    # Survey 3: Public Library & Community Digital Literacy Study
    library_questions = [
        {
            "key": "branch_visit_freq",
            "section": "Utilization",
            "prompt": "How frequently have members of your household visited a public library branch in the past 6 months?",
            "type": "single_choice",
            "required": True,
            "options": [
                {"value": "weekly", "label": "Weekly or more"},
                {"value": "monthly", "label": "1–3 times per month"},
                {"value": "quarterly", "label": "Once every few months"},
                {"value": "never", "label": "Have not visited"},
            ],
        },
        {
            "key": "home_broadband",
            "section": "Digital Access",
            "prompt": "Does your household have reliable high-speed home broadband internet (excluding mobile-only plans)?",
            "type": "boolean",
            "required": True,
        },
        {
            "key": "digital_services_used",
            "section": "Digital Access",
            "prompt": "Which library digital resources or public programs would be most useful to your household?",
            "type": "multi_choice",
            "required": True,
            "options": [
                {"value": "wifi_hotspots", "label": "Loanable Wi-Fi Hotspots"},
                {"value": "job_skills", "label": "Job Application & Resume Workshops"},
                {"value": "senior_tech", "label": "Older Adult Tech Support"},
                {"value": "youth_coding", "label": "After-School STEM & Homework Lab"},
                {"value": "ebooks_media", "label": "Digital Books & Research Databases"},
            ],
        },
        {
            "key": "monthly_internet_cost_usd",
            "section": "Digital Access",
            "prompt": "Approximate monthly household spend on home internet service (USD).",
            "type": "number",
            "required": False,
            "config": {"unit": "USD/month"},
            "conditional_logic": {
                "operator": "all",
                "rules": [{"question_key": "home_broadband", "condition": "equals", "value": "true"}],
            },
            "rules": [
                {"rule_type": "outlier_bounds", "rule_config": {"min": 15, "max": 220}, "severity": "warning", "error_message": "Broadband cost outside typical $15–$220 municipal benchmark."},
            ],
        },
        {
            "key": "hours_convenience_rating",
            "section": "Branch Evaluation",
            "prompt": "Rate convenience of current library opening hours (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "staff_helpfulness_rating",
            "section": "Branch Evaluation",
            "prompt": "Rate helpfulness of library staff and digital navigators (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "facility_access_rating",
            "section": "Branch Evaluation",
            "prompt": "Rate workspace, seating, and computer station availability (1 = Very Poor, 5 = Excellent).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "open_feedback",
            "section": "Community Suggestions",
            "prompt": "Additional suggestions for library collections, evening hours, or digital training.",
            "type": "long_text",
            "required": False,
        },
    ]

    survey_library, ver_library = create_survey_with_questions(
        code="CIV-2026-LIB",
        title="Public Library & Community Digital Literacy Study",
        description="Public-service equity study evaluating branch usage, home broadband affordability, and demand for community digital navigator programs.",
        category="Digital Literacy",
        status="published",
        target_responses=200,
        instructions="Interview residents at neighbourhood centres, transit plazas, and residential blocks—not exclusively inside library buildings—to avoid selection bias.",
        questions_spec=library_questions,
        version_number=1,
    )

    # Survey 4: Draft survey ready for editing/publishing
    parks_questions = [
        {
            "key": "park_walk_minutes",
            "section": "Access",
            "prompt": "How many minutes does it take to walk to the nearest public park or green space?",
            "type": "number",
            "required": True,
            "config": {"unit": "minutes"},
            "rules": [
                {"rule_type": "outlier_bounds", "rule_config": {"min": 1, "max": 60}, "severity": "warning", "error_message": "Walking distance over 60 minutes flagged for review."},
            ],
        },
        {
            "key": "park_maintenance_rating",
            "section": "Quality",
            "prompt": "Rate overall cleanliness, lighting, and playground maintenance (1–5).",
            "type": "rating",
            "required": True,
            "config": {"min": 1, "max": 5},
        },
        {
            "key": "priority_amenities",
            "section": "Investment Priorities",
            "prompt": "Which park amenities should receive municipal capital funding next fiscal year?",
            "type": "multi_choice",
            "required": True,
            "options": [
                {"value": "shade_trees", "label": "Shade Trees & Cooling Canopies"},
                {"value": "accessible_paths", "label": "Paved Accessible Walking Paths"},
                {"value": "youth_play", "label": "Inclusive Playground Equipment"},
                {"value": "lighting_safety", "label": "Evening Pathway Lighting"},
                {"value": "restrooms", "label": "Public Restrooms & Water Fountains"},
            ],
        },
    ]
    create_survey_with_questions(
        code="CIV-2026-PRK",
        title="Neighbourhood Parks & Civic Green-Space Equity Survey",
        description="Upcoming spring field survey measuring walking access to green space, shade canopy equity, and capital amenity priorities.",
        category="Parks & Civic Spaces",
        status="draft",
        target_responses=300,
        instructions="Draft instrument awaiting final review by Parks & Recreation planning liaison before publication.",
        questions_spec=parks_questions,
        version_number=1,
    )

    # 3. Survey Assignments
    assignments_map: dict[tuple[uuid.UUID, str], SurveyAssignment] = {}
    published_pairs = [
        (survey_transit, ver_transit, 60),
        (survey_water, ver_water, 50),
        (survey_library, ver_library, 40),
    ]
    for survey_obj, ver_obj, target_per_agent in published_pairs:
        for ag in agents:
            asgn = SurveyAssignment(
                survey_id=survey_obj.id,
                survey_version_id=ver_obj.id,
                agent_id=ag.id,
                assigned_by_id=admin_user.id,
                region=ag.region,
                target_count=target_per_agent,
                collected_count=0,
                status="active",
                due_date=now + timedelta(days=18),
                notes=f"Cover residential blocks and public hubs across {ag.region}. Ensure explicit consent capture.",
            )
            db.add(asgn)
            db.flush()
            assignments_map[(survey_obj.id, ag.region)] = asgn

    # 4. Seed 420 Realistic Civic Responses & Process Through the Real 9-Stage Pipeline
    transit_modes = ["municipal_bus", "light_rail", "paratransit", "bicycle_walk", "private_vehicle"]
    transit_mode_weights = [0.38, 0.29, 0.08, 0.13, 0.12]
    transit_notes = [
        "More frequent evening buses along corridor 14",
        "Real-time arrival displays at transfer stations",
        "Faster elevator repair turnaround times",
        "Better winter shelter coverage at outer stops",
        "Expanded off-peak senior and student fare discounts",
        "Clearer transfer signage between rail and bus bays",
    ]
    water_sources = ["municipal_piped", "filtered_municipal", "community_standpipe", "bottled_delivered"]
    water_weights = [0.54, 0.34, 0.05, 0.07]
    lib_freqs = ["weekly", "monthly", "quarterly", "never"]
    lib_weights = [0.22, 0.34, 0.26, 0.18]
    age_brackets = ["18-29", "30-44", "45-59", "60-74", "75+"]

    def make_transit_payload(anomaly: str | None) -> tuple[dict, int]:
        mode = rng.choices(transit_modes, weights=transit_mode_weights)[0]
        trips = rng.randint(4, 18) if mode in ("municipal_bus", "light_rail", "paratransit") else rng.randint(0, 4)
        wait = rng.randint(4, 24) if mode in ("municipal_bus", "light_rail", "paratransit") else None
        needs_access = rng.random() < 0.24
        barriers = rng.sample(["broken_elevator", "uneven_curb", "signage_clarity", "vehicle_crowding", "none"], k=rng.randint(1, 2)) if needs_access else []
        r1, r2, r3 = rng.randint(2, 5), rng.randint(2, 5), rng.randint(2, 5)
        if r1 == r2 == r3:
            r3 = 4 if r3 != 4 else 3
        duration = rng.randint(135, 390)

        answers: dict = {
            "primary_mode": mode,
            "weekly_transit_trips": trips,
            "step_free_access_needed": needs_access,
            "reliability_rating": r1,
            "safety_rating": r2,
            "affordability_rating": r3,
            "improvement_priority": rng.choice(transit_notes),
        }
        if wait is not None:
            answers["avg_wait_minutes"] = wait
        if needs_access:
            answers["accessibility_barriers"] = barriers
        if rng.random() < 0.35:
            answers["last_incident_date"] = (now - timedelta(days=rng.randint(1, 25))).date().isoformat()

        if anomaly == "outlier_wait":
            answers["primary_mode"] = "municipal_bus"
            answers["avg_wait_minutes"] = rng.choice([95, 135, 180])
        elif anomaly == "outlier_trips":
            answers["weekly_transit_trips"] = rng.choice([75, 110])
        elif anomaly == "speeding":
            duration = rng.randint(7, 14)
        elif anomaly == "missing_required":
            answers["primary_mode"] = "municipal_bus"
            answers.pop("avg_wait_minutes", None)
        elif anomaly == "straight_line":
            answers["reliability_rating"] = 3
            answers["safety_rating"] = 3
            answers["affordability_rating"] = 3
        elif anomaly == "invalid_type":
            answers["weekly_transit_trips"] = "twenty-five"

        return answers, duration

    def make_water_payload(anomaly: str | None) -> tuple[dict, int]:
        source = rng.choices(water_sources, weights=water_weights)[0]
        bill = rng.randint(38, 145)
        outage = rng.random() < 0.28
        r1, r2, r3 = rng.randint(2, 5), rng.randint(2, 5), rng.randint(2, 5)
        if r1 == r2 == r3:
            r2 = 5 if r2 != 5 else 4
        duration = rng.randint(120, 320)
        answers: dict = {
            "water_source": source,
            "monthly_water_bill_usd": bill,
            "experienced_outage": outage,
            "water_clarity_rating": r1,
            "waste_collection_rating": r2,
            "stormwater_drainage_rating": r3,
            "sanitation_concerns": rng.sample(["low_pressure", "street_flooding", "missed_pickup", "odor_sewer", "none"], k=rng.randint(1, 2)),
        }
        if outage:
            answers["outage_hours_longest"] = rng.randint(2, 18)

        if anomaly == "outlier_bill":
            answers["monthly_water_bill_usd"] = rng.choice([620, 940])
        elif anomaly == "speeding":
            duration = rng.randint(6, 12)
        elif anomaly == "missing_required":
            answers["experienced_outage"] = True
            answers.pop("outage_hours_longest", None)
        elif anomaly == "straight_line":
            answers["water_clarity_rating"] = 4
            answers["waste_collection_rating"] = 4
            answers["stormwater_drainage_rating"] = 4

        return answers, duration

    def make_library_payload(anomaly: str | None) -> tuple[dict, int]:
        freq = rng.choices(lib_freqs, weights=lib_weights)[0]
        broadband = rng.random() < 0.78
        r1, r2, r3 = rng.randint(3, 5), rng.randint(3, 5), rng.randint(2, 5)
        if r1 == r2 == r3:
            r3 = 3 if r3 != 3 else 4
        duration = rng.randint(110, 290)
        answers: dict = {
            "branch_visit_freq": freq,
            "home_broadband": broadband,
            "digital_services_used": rng.sample(["wifi_hotspots", "job_skills", "senior_tech", "youth_coding", "ebooks_media"], k=rng.randint(1, 3)),
            "hours_convenience_rating": r1,
            "staff_helpfulness_rating": r2,
            "facility_access_rating": r3,
            "open_feedback": rng.choice([
                "Extended Sunday afternoon hours would help working families.",
                "More quiet study pods and laptop lending stations.",
                "Expand evening ESL and digital navigation sessions.",
                "",
            ]),
        }
        if broadband:
            answers["monthly_internet_cost_usd"] = rng.randint(45, 115)

        if anomaly == "outlier_cost":
            answers["home_broadband"] = True
            answers["monthly_internet_cost_usd"] = rng.choice([380, 450])
        elif anomaly == "speeding":
            duration = rng.randint(5, 11)
        elif anomaly == "missing_required":
            answers.pop("branch_visit_freq", None)

        return answers, duration

    survey_configs = [
        (survey_transit, ver_transit, 185, make_transit_payload, ["outlier_wait", "outlier_trips", "speeding", "missing_required", "straight_line", "invalid_type"]),
        (survey_water, ver_water, 130, make_water_payload, ["outlier_bill", "speeding", "missing_required", "straight_line"]),
        (survey_library, ver_library, 105, make_library_payload, ["outlier_cost", "speeding", "missing_required"]),
    ]

    seeded_responses: list[Response] = []
    duplicate_anchors: list[tuple[Survey, SurveyVersion, SurveyAssignment, dict, datetime, str]] = []

    for survey_obj, ver_obj, count, payload_fn, anomalies in survey_configs:
        for i in range(count):
            ag = agents[i % len(agents)]
            district = ag.region
            asgn = assignments_map[(survey_obj.id, district)]

            # Spread timestamps over last 27 days (more recent density)
            days_ago = int(rng.triangular(0, 27, 4))
            sub_ts = now - timedelta(days=days_ago, hours=rng.randint(0, 22), minutes=rng.randint(0, 59))

            # ~16% injected quality anomalies, ~84% clean
            anomaly = rng.choice(anomalies) if rng.random() < 0.16 else None
            answers, duration = payload_fn(anomaly)

            loc_consent = rng.random() < 0.74
            base_lat, base_lng = DISTRICTS[district]
            lat = round(base_lat + rng.uniform(-0.025, 0.025), 6) if loc_consent else None
            lng = round(base_lng + rng.uniform(-0.025, 0.025), 6) if loc_consent else None

            resp_entity = Respondent(
                external_ref=f"HH-{district[:3].upper()}-{1000 + i}",
                district=district,
                ward=f"Ward {rng.randint(1, 8)}",
                age_bracket=rng.choice(age_brackets),
                household_size=rng.randint(1, 6),
                consent_given=True,
                consent_timestamp=sub_ts - timedelta(seconds=duration),
                location_consent_given=loc_consent,
            )
            db.add(resp_entity)
            db.flush()

            source_channel = rng.choices(["mobile_offline", "mobile_online"], weights=[0.42, 0.58])[0]
            response_obj = Response(
                client_submission_id=f"seed-{survey_obj.code.lower()}-{i:04d}",
                survey_id=survey_obj.id,
                survey_version_id=ver_obj.id,
                assignment_id=asgn.id,
                agent_id=ag.id,
                respondent_id=resp_entity.id,
                raw_payload={"answers": answers, "schema_version": ver_obj.version_number},
                processing_status="ingested",
                pipeline_stage="raw_ingestion",
                consent_given=True,
                location_consent_given=loc_consent,
                latitude=lat,
                longitude=lng,
                location_accuracy_m=round(rng.uniform(5.0, 28.0), 1) if loc_consent else None,
                district=district,
                started_at=sub_ts - timedelta(seconds=duration),
                submitted_at=sub_ts,
                synced_at=sub_ts + timedelta(minutes=rng.randint(0, 45) if source_channel == "mobile_offline" else 0),
                duration_seconds=duration,
                source_channel=source_channel,
                device_info={"platform": "SurveyOps Mobile PWA", "offline_queued": source_channel == "mobile_offline"},
            )
            db.add(response_obj)
            asgn.collected_count += 1
            db.flush()

            processed = process_response_pipeline(db, response_obj.id, emit_events=False)
            seeded_responses.append(processed)

            if anomaly is None and len(duplicate_anchors) < 8 and i % 40 == 5:
                duplicate_anchors.append((survey_obj, ver_obj, asgn, answers, sub_ts, district))

    # Inject 8 genuine near-window duplicates so duplicate_detection rule is showcased in Data Quality Console
    for idx, (survey_obj, ver_obj, asgn, answers, orig_ts, district) in enumerate(duplicate_anchors):
        dup_ts = orig_ts + timedelta(minutes=rng.randint(4, 22))
        dup_resp = Response(
            client_submission_id=f"seed-dup-{idx:03d}",
            survey_id=survey_obj.id,
            survey_version_id=ver_obj.id,
            assignment_id=asgn.id,
            agent_id=asgn.agent_id,
            raw_payload={"answers": answers, "schema_version": ver_obj.version_number},
            processing_status="ingested",
            pipeline_stage="raw_ingestion",
            consent_given=True,
            location_consent_given=False,
            district=district,
            started_at=dup_ts - timedelta(seconds=150),
            submitted_at=dup_ts,
            synced_at=dup_ts,
            duration_seconds=150,
            source_channel="mobile_offline",
            device_info={"platform": "SurveyOps Mobile PWA", "offline_queued": True},
        )
        db.add(dup_resp)
        db.flush()
        process_response_pipeline(db, dup_resp.id, emit_events=False)

    # Demonstrate real analyst correction & approval on 6 flagged outlier records (immutable raw preserved!)
    flagged_outliers = db.execute(
        select(Response)
        .join(QualityIssue, QualityIssue.response_id == Response.id)
        .where(Response.processing_status == "flagged", QualityIssue.issue_type == "outlier")
        .limit(6)
    ).scalars().all()

    for resp in flagged_outliers:
        for ans in resp.answers:
            if ans.is_outlier and ans.numeric_value is not None:
                before_val = ans.effective_value
                # Verified conservative correction (e.g. typo 135 min -> 13.5 or 18 min verified with field note)
                corrected_val = 18 if ans.question_key == "avg_wait_minutes" else (24 if ans.question_key == "weekly_transit_trips" else 95)
                ans.corrected_value = corrected_val
                ans.effective_value = corrected_val
                ans.numeric_value = float(corrected_val)
                ans.text_value = str(corrected_val)
                ans.is_outlier = False
                ans.is_valid = True
                ans.corrected_by_id = analyst_1.id
                ans.corrected_at = now - timedelta(hours=rng.randint(2, 48))
                ans.correction_reason = "Verified decimal entry typo with enumerator field log; raw payload preserved intact."

                for issue in resp.quality_issues:
                    if issue.question_key == ans.question_key and issue.status == "open":
                        issue.status = "resolved"
                        issue.resolved_by_id = analyst_1.id
                        issue.resolved_at = ans.corrected_at
                        issue.resolution_note = ans.correction_reason

                resp.processing_status = "approved"
                resp.pipeline_stage = "approved_dataset_generation"
                resp.quality_score = 94.0
                resp.reviewed_by_id = analyst_1.id
                resp.reviewed_at = ans.corrected_at
                resp.review_notes = "Outlier verified and corrected; approved for clean analytical dataset."

                db.add(
                    AuditEvent(
                        entity_type="response",
                        entity_id=str(resp.id),
                        action="analyst.corrected_and_approved",
                        actor_id=analyst_1.id,
                        actor_type="user",
                        summary=f"Corrected '{ans.question_key}' from {before_val} to {corrected_val} (raw immutable) and approved record.",
                        before_state={"question_key": ans.question_key, "effective_value": before_val},
                        after_state={"question_key": ans.question_key, "corrected_value": corrected_val, "processing_status": "approved"},
                        notify_level="info",
                        is_read=False,
                    )
                )
    db.commit()

    # 5. Seed 2 Pre-Generated Insight Reports with Live Computed SQL Stats
    for survey_obj, ver_obj, title, notes in [
        (
            survey_transit,
            ver_transit,
            "Q4 Municipal Transit Accessibility & Wait-Time Reliability Briefing",
            (
                "Field enumeration across all five metropolitan districts indicates consistent weekday demand for municipal bus "
                "and light rail corridors. Peak wait times average under 16 minutes in Metro Central and East River, while outer "
                "stops in North Metro and West Highlands exhibit elevated wait variability. Approximately 24% of surveyed households "
                "report requiring step-free boarding or audio-visual alerts; out-of-service station elevators and uneven bus-stop curbs "
                "represent the highest-frequency accessibility barriers. Data quality controls flagged and quarantined duplicate "
                "offline retries and numeric wait-time typos without modifying immutable raw submissions."
            ),
        ),
        (
            survey_water,
            ver_water,
            "Residential Water Continuity & Utility Affordability Audit Summary",
            (
                "Over 85% of surveyed households rely on municipal piped supply (with or without point-of-use filtration). "
                "Unplanned supply interruptions over the past 90 days were concentrated in aging mainlines in South Harbor and "
                "North Metro. Analyst validation removed six speeding interviews and normalized billing outliers prior to approval."
            ),
        ),
    ]:
        stats = compute_overview_kpis(db, survey_id=survey_obj.id)
        q_insights = compute_question_distributions(db, survey_id=survey_obj.id, survey_version_id=ver_obj.id, status_filter="valid")
        q_summary = compute_quality_breakdown(db, survey_id=survey_obj.id)
        geo = compute_geographic_distribution(db, survey_id=survey_obj.id, status_filter="valid")

        rep = Report(
            survey_id=survey_obj.id,
            survey_version_id=ver_obj.id,
            title=title,
            report_type="full_insight",
            status="published",
            filters_json={"status": "valid", "district": "all"},
            summary_stats=stats,
            question_insights=q_insights,
            quality_summary=q_summary,
            geo_summary=geo,
            analyst_notes=notes,
            created_by_id=analyst_1.id,
        )
        db.add(rep)
        db.flush()
        db.add(
            AuditEvent(
                entity_type="report",
                entity_id=str(rep.id),
                action="report.generated",
                actor_id=analyst_1.id,
                actor_type="user",
                summary=f"Published Insight Report: {title}",
                after_state={"survey_code": survey_obj.code, "valid_responses": stats.get("valid_responses", 0)},
                notify_level="info",
                is_read=False,
            )
        )

    db.commit()
    logger.info("SurveyOps database seeded successfully (%s primary responses + duplicates + 2 reports).", len(seeded_responses))


if __name__ == "__main__":
    setup_logging()
    db = SessionLocal()
    try:
        seed_database(db)
    finally:
        db.close()
