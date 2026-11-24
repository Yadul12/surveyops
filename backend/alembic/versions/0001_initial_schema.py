"""Initial SurveyOps relational schema with indexes.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-11-24 19:00:00
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. roles
    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(50), nullable=False, unique=True),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("permissions", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_roles_name", "roles", ["name"], unique=True)

    # 2. users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False, unique=True),
        sa.Column("full_name", sa.String(200), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("roles.id"), nullable=False),
        sa.Column("department", sa.String(120), nullable=False, server_default="Civic Research"),
        sa.Column("region", sa.String(120), nullable=False, server_default="Metro Central"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_role_id", "users", ["role_id"])

    # 3. surveys
    op.create_table(
        "surveys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False, unique=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("category", sa.String(100), nullable=False, server_default="Civic Services"),
        sa.Column("status", sa.String(30), nullable=False, server_default="draft"),
        sa.Column("active_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("target_responses", sa.Integer(), nullable=False, server_default="500"),
        sa.Column("requires_consent", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("allow_location_capture", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("instructions", sa.Text(), nullable=False, server_default=""),
        sa.Column("consent_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_surveys_code", "surveys", ["code"], unique=True)
    op.create_index("ix_surveys_category", "surveys", ["category"])
    op.create_index("ix_surveys_status", "surveys", ["status"])

    # 4. survey_versions
    op.create_table(
        "survey_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("survey_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(30), nullable=False, server_default="draft"),
        sa.Column("schema_hash", sa.String(64), nullable=True),
        sa.Column("change_notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("survey_id", "version_number", name="uq_survey_version_number"),
    )
    op.create_index("ix_survey_versions_survey_id", "survey_versions", ["survey_id"])
    op.create_index("ix_survey_versions_status", "survey_versions", ["status"])

    op.create_foreign_key(
        "fk_surveys_active_version_id",
        "surveys",
        "survey_versions",
        ["active_version_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 5. questions
    op.create_table(
        "questions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("survey_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("question_key", sa.String(80), nullable=False),
        sa.Column("section_title", sa.String(120), nullable=False, server_default="General"),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("help_text", sa.Text(), nullable=False, server_default=""),
        sa.Column("question_type", sa.String(40), nullable=False),
        sa.Column("order_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_required", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("options", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("conditional_logic", postgresql.JSONB(), nullable=True),
        sa.Column("config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("survey_version_id", "question_key", name="uq_version_question_key"),
    )
    op.create_index("ix_questions_survey_version_id", "questions", ["survey_version_id"])

    # 6. validation_rules
    op.create_table(
        "validation_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("question_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("questions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("rule_type", sa.String(50), nullable=False),
        sa.Column("rule_config", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("severity", sa.String(20), nullable=False, server_default="warning"),
        sa.Column("error_message", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_validation_rules_question_id", "validation_rules", ["question_id"])

    # 7. survey_assignments
    op.create_table(
        "survey_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("survey_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("survey_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("assigned_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("region", sa.String(120), nullable=False),
        sa.Column("target_count", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("collected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(30), nullable=False, server_default="active"),
        sa.Column("due_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_survey_assignments_survey_id", "survey_assignments", ["survey_id"])
    op.create_index("ix_survey_assignments_survey_version_id", "survey_assignments", ["survey_version_id"])
    op.create_index("ix_survey_assignments_agent_id", "survey_assignments", ["agent_id"])
    op.create_index("ix_survey_assignments_region", "survey_assignments", ["region"])
    op.create_index("ix_survey_assignments_status", "survey_assignments", ["status"])

    # 8. respondents
    op.create_table(
        "respondents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("external_ref", sa.String(100), nullable=False),
        sa.Column("district", sa.String(120), nullable=False, server_default="Metro Central"),
        sa.Column("ward", sa.String(80), nullable=False, server_default="Ward 1"),
        sa.Column("age_bracket", sa.String(40), nullable=True),
        sa.Column("household_size", sa.Integer(), nullable=True),
        sa.Column("consent_given", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("consent_timestamp", sa.DateTime(timezone=True), nullable=True),
        sa.Column("location_consent_given", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_respondents_external_ref", "respondents", ["external_ref"])
    op.create_index("ix_respondents_district", "respondents", ["district"])

    # 9. responses
    op.create_table(
        "responses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("client_submission_id", sa.String(120), nullable=False, unique=True),
        sa.Column("survey_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("survey_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("assignment_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("survey_assignments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("respondent_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("respondents.id", ondelete="SET NULL"), nullable=True),
        sa.Column("raw_payload", postgresql.JSONB(), nullable=False),
        sa.Column("normalized_payload", postgresql.JSONB(), nullable=True),
        sa.Column("processing_status", sa.String(30), nullable=False, server_default="ingested"),
        sa.Column("pipeline_stage", sa.String(50), nullable=False, server_default="raw_ingestion"),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("is_duplicate", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("duplicate_of_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("responses.id", ondelete="SET NULL"), nullable=True),
        sa.Column("fingerprint_hash", sa.String(64), nullable=True),
        sa.Column("consent_given", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("location_consent_given", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("latitude", sa.Float(), nullable=True),
        sa.Column("longitude", sa.Float(), nullable=True),
        sa.Column("location_accuracy_m", sa.Float(), nullable=True),
        sa.Column("district", sa.String(120), nullable=False, server_default="Metro Central"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("source_channel", sa.String(40), nullable=False, server_default="mobile_online"),
        sa.Column("device_info", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("reviewed_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_responses_client_submission_id", "responses", ["client_submission_id"], unique=True)
    op.create_index("ix_responses_survey_id", "responses", ["survey_id"])
    op.create_index("ix_responses_survey_version_id", "responses", ["survey_version_id"])
    op.create_index("ix_responses_assignment_id", "responses", ["assignment_id"])
    op.create_index("ix_responses_agent_id", "responses", ["agent_id"])
    op.create_index("ix_responses_respondent_id", "responses", ["respondent_id"])
    op.create_index("ix_responses_processing_status", "responses", ["processing_status"])
    op.create_index("ix_responses_pipeline_stage", "responses", ["pipeline_stage"])
    op.create_index("ix_responses_quality_score", "responses", ["quality_score"])
    op.create_index("ix_responses_is_duplicate", "responses", ["is_duplicate"])
    op.create_index("ix_responses_fingerprint_hash", "responses", ["fingerprint_hash"])
    op.create_index("ix_responses_district", "responses", ["district"])
    op.create_index("ix_responses_submitted_at", "responses", ["submitted_at"])
    op.create_index("ix_responses_survey_status_submitted", "responses", ["survey_id", "processing_status", "submitted_at"])
    op.create_index("ix_responses_survey_district_status", "responses", ["survey_id", "district", "processing_status"])
    op.create_index("ix_responses_fingerprint_survey", "responses", ["survey_id", "fingerprint_hash", "submitted_at"])
    op.create_index("ix_responses_agent_submitted", "responses", ["agent_id", "submitted_at"])

    # 10. response_answers
    op.create_table(
        "response_answers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("response_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("responses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("question_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("questions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("question_key", sa.String(80), nullable=False),
        sa.Column("raw_value", postgresql.JSONB(), nullable=True),
        sa.Column("normalized_value", postgresql.JSONB(), nullable=True),
        sa.Column("corrected_value", postgresql.JSONB(), nullable=True),
        sa.Column("effective_value", postgresql.JSONB(), nullable=True),
        sa.Column("numeric_value", sa.Float(), nullable=True),
        sa.Column("text_value", sa.String(255), nullable=True),
        sa.Column("is_valid", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("is_missing", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_outlier", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("corrected_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("corrected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("correction_reason", sa.Text(), nullable=True),
    )
    op.create_index("ix_response_answers_response_id", "response_answers", ["response_id"])
    op.create_index("ix_response_answers_question_id", "response_answers", ["question_id"])
    op.create_index("ix_response_answers_question_text", "response_answers", ["question_id", "text_value"])
    op.create_index("ix_response_answers_question_num", "response_answers", ["question_id", "numeric_value"])
    op.create_index("ix_response_answers_resp_key", "response_answers", ["response_id", "question_key"])

    # 11. processing_jobs
    op.create_table(
        "processing_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", sa.String(100), nullable=True),
        sa.Column("response_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("responses.id", ondelete="SET NULL"), nullable=True),
        sa.Column("job_type", sa.String(40), nullable=False, server_default="single_response"),
        sa.Column("status", sa.String(30), nullable=False, server_default="queued"),
        sa.Column("current_stage", sa.String(50), nullable=False, server_default="raw_ingestion"),
        sa.Column("stages_completed", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("total_items", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("processed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("celery_task_id", sa.String(120), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_processing_jobs_batch_id", "processing_jobs", ["batch_id"])
    op.create_index("ix_processing_jobs_response_id", "processing_jobs", ["response_id"])
    op.create_index("ix_processing_jobs_job_type", "processing_jobs", ["job_type"])
    op.create_index("ix_processing_jobs_status", "processing_jobs", ["status"])
    op.create_index("ix_processing_jobs_celery_task_id", "processing_jobs", ["celery_task_id"])
    op.create_index("ix_processing_jobs_status_created", "processing_jobs", ["status", "created_at"])

    # 12. quality_issues
    op.create_table(
        "quality_issues",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("response_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("responses.id", ondelete="CASCADE"), nullable=False),
        sa.Column("survey_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("question_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("questions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("question_key", sa.String(80), nullable=True),
        sa.Column("issue_type", sa.String(40), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False, server_default="warning"),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("rule_code", sa.String(60), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("detected_value", postgresql.JSONB(), nullable=True),
        sa.Column("expected_constraint", postgresql.JSONB(), nullable=True),
        sa.Column("resolved_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolution_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_quality_issues_response_id", "quality_issues", ["response_id"])
    op.create_index("ix_quality_issues_survey_id", "quality_issues", ["survey_id"])
    op.create_index("ix_quality_issues_issue_type", "quality_issues", ["issue_type"])
    op.create_index("ix_quality_issues_severity", "quality_issues", ["severity"])
    op.create_index("ix_quality_issues_status", "quality_issues", ["status"])
    op.create_index("ix_quality_issues_created_at", "quality_issues", ["created_at"])
    op.create_index("ix_quality_issues_status_type_sev", "quality_issues", ["status", "issue_type", "severity"])
    op.create_index("ix_quality_issues_survey_status", "quality_issues", ["survey_id", "status"])

    # 13. audit_events
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("entity_type", sa.String(50), nullable=False),
        sa.Column("entity_id", sa.String(120), nullable=False),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("actor_type", sa.String(20), nullable=False, server_default="user"),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("before_state", postgresql.JSONB(), nullable=True),
        sa.Column("after_state", postgresql.JSONB(), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("notify_level", sa.String(20), nullable=False, server_default="none"),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_audit_events_action", "audit_events", ["action"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_entity", "audit_events", ["entity_type", "entity_id", "created_at"])
    op.create_index("ix_audit_events_notify", "audit_events", ["notify_level", "is_read", "created_at"])

    # 14. reports
    op.create_table(
        "reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("survey_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False),
        sa.Column("survey_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("survey_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("title", sa.String(255), nullable=False),
        sa.Column("report_type", sa.String(40), nullable=False, server_default="full_insight"),
        sa.Column("status", sa.String(30), nullable=False, server_default="published"),
        sa.Column("filters_json", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("summary_stats", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("question_insights", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("quality_summary", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("geo_summary", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("analyst_notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_reports_survey_id", "reports", ["survey_id"])


def downgrade() -> None:
    op.drop_table("reports")
    op.drop_table("audit_events")
    op.drop_table("quality_issues")
    op.drop_table("processing_jobs")
    op.drop_table("response_answers")
    op.drop_table("responses")
    op.drop_table("respondents")
    op.drop_table("survey_assignments")
    op.drop_table("validation_rules")
    op.drop_table("questions")
    op.drop_constraint("fk_surveys_active_version_id", "surveys", type_="foreignkey")
    op.drop_table("survey_versions")
    op.drop_table("surveys")
    op.drop_table("users")
    op.drop_table("roles")
