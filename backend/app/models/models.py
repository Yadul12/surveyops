import uuid
from datetime import datetime
from typing import Any, List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, utcnow


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    permissions: Mapped[List[str]] = mapped_column(JSONB, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    users: Mapped[List["User"]] = relationship("User", back_populates="role")


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("roles.id"), nullable=False, index=True)
    department: Mapped[str] = mapped_column(String(120), default="Civic Research", nullable=False)
    region: Mapped[str] = mapped_column(String(120), default="Metro Central", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    role: Mapped["Role"] = relationship("Role", back_populates="users")


class Survey(Base, TimestampMixin):
    __tablename__ = "surveys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(40), unique=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    category: Mapped[str] = mapped_column(String(100), default="Civic Services", nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(30), default="draft", nullable=False, index=True)
    active_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("survey_versions.id", use_alter=True, name="fk_surveys_active_version_id"),
        nullable=True,
    )
    target_responses: Mapped[int] = mapped_column(Integer, default=500, nullable=False)
    requires_consent: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    allow_location_capture: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    instructions: Mapped[str] = mapped_column(Text, default="", nullable=False)
    consent_text: Mapped[str] = mapped_column(
        Text,
        default="Participation is voluntary. Responses are anonymized and used exclusively for public-service planning and civic research.",
        nullable=False,
    )
    created_by_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    created_by: Mapped["User"] = relationship("User", foreign_keys=[created_by_id])
    versions: Mapped[List["SurveyVersion"]] = relationship(
        "SurveyVersion",
        back_populates="survey",
        foreign_keys="SurveyVersion.survey_id",
        order_by="SurveyVersion.version_number.desc()",
        cascade="all, delete-orphan",
    )
    active_version: Mapped[Optional["SurveyVersion"]] = relationship(
        "SurveyVersion",
        foreign_keys=[active_version_id],
        post_update=True,
    )
    assignments: Mapped[List["SurveyAssignment"]] = relationship(
        "SurveyAssignment", back_populates="survey", cascade="all, delete-orphan"
    )


class SurveyVersion(Base):
    __tablename__ = "survey_versions"
    __table_args__ = (
        UniqueConstraint("survey_id", "version_number", name="uq_survey_version_number"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="draft", nullable=False, index=True)
    schema_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    change_notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    survey: Mapped["Survey"] = relationship("Survey", back_populates="versions", foreign_keys=[survey_id])
    questions: Mapped[List["Question"]] = relationship(
        "Question",
        back_populates="survey_version",
        order_by="Question.order_index.asc()",
        cascade="all, delete-orphan",
    )


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("survey_version_id", "question_key", name="uq_version_question_key"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_key: Mapped[str] = mapped_column(String(80), nullable=False)
    section_title: Mapped[str] = mapped_column(String(120), default="General", nullable=False)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    help_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    question_type: Mapped[str] = mapped_column(String(40), nullable=False)
    order_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_required: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    options: Mapped[List[dict]] = mapped_column(JSONB, default=list, nullable=False)
    conditional_logic: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    config: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    survey_version: Mapped["SurveyVersion"] = relationship("SurveyVersion", back_populates="questions")
    validation_rules: Mapped[List["ValidationRule"]] = relationship(
        "ValidationRule", back_populates="question", cascade="all, delete-orphan"
    )


class ValidationRule(Base):
    __tablename__ = "validation_rules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    question_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rule_type: Mapped[str] = mapped_column(String(50), nullable=False)
    rule_config: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    severity: Mapped[str] = mapped_column(String(20), default="warning", nullable=False)
    error_message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    question: Mapped["Question"] = relationship("Question", back_populates="validation_rules")


class SurveyAssignment(Base, TimestampMixin):
    __tablename__ = "survey_assignments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True
    )
    survey_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True
    )
    assigned_by_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    region: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    target_count: Mapped[int] = mapped_column(Integer, default=50, nullable=False)
    collected_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="active", nullable=False, index=True)
    due_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)

    survey: Mapped["Survey"] = relationship("Survey", back_populates="assignments")
    survey_version: Mapped["SurveyVersion"] = relationship("SurveyVersion")
    agent: Mapped["User"] = relationship("User", foreign_keys=[agent_id])
    assigned_by: Mapped["User"] = relationship("User", foreign_keys=[assigned_by_id])


class Respondent(Base):
    __tablename__ = "respondents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    external_ref: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    district: Mapped[str] = mapped_column(String(120), default="Metro Central", nullable=False, index=True)
    ward: Mapped[str] = mapped_column(String(80), default="Ward 1", nullable=False)
    age_bracket: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    household_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    consent_given: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    consent_timestamp: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    location_consent_given: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Response(Base, TimestampMixin):
    __tablename__ = "responses"
    __table_args__ = (
        Index("ix_responses_survey_status_submitted", "survey_id", "processing_status", "submitted_at"),
        Index("ix_responses_survey_district_status", "survey_id", "district", "processing_status"),
        Index("ix_responses_fingerprint_survey", "survey_id", "fingerprint_hash", "submitted_at"),
        Index("ix_responses_agent_submitted", "agent_id", "submitted_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_submission_id: Mapped[str] = mapped_column(String(120), unique=True, nullable=False, index=True)
    survey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True
    )
    survey_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("survey_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    assignment_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("survey_assignments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    respondent_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("respondents.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Immutable raw payload as submitted from mobile/API; never overwritten by pipeline or analysts
    raw_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    normalized_payload: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

    processing_status: Mapped[str] = mapped_column(String(30), default="ingested", nullable=False, index=True)
    pipeline_stage: Mapped[str] = mapped_column(String(50), default="raw_ingestion", nullable=False, index=True)
    quality_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True, index=True)
    is_duplicate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    duplicate_of_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responses.id", ondelete="SET NULL"), nullable=True
    )
    fingerprint_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)

    consent_given: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    location_consent_given: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    latitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    longitude: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    location_accuracy_m: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    district: Mapped[str] = mapped_column(String(120), default="Metro Central", nullable=False, index=True)

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    synced_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    source_channel: Mapped[str] = mapped_column(String(40), default="mobile_online", nullable=False)
    device_info: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    reviewed_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    review_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    survey: Mapped["Survey"] = relationship("Survey")
    survey_version: Mapped["SurveyVersion"] = relationship("SurveyVersion")
    agent: Mapped[Optional["User"]] = relationship("User", foreign_keys=[agent_id])
    reviewed_by: Mapped[Optional["User"]] = relationship("User", foreign_keys=[reviewed_by_id])
    respondent: Mapped[Optional["Respondent"]] = relationship("Respondent")
    answers: Mapped[List["ResponseAnswer"]] = relationship(
        "ResponseAnswer", back_populates="response", cascade="all, delete-orphan"
    )
    quality_issues: Mapped[List["QualityIssue"]] = relationship(
        "QualityIssue", back_populates="response", cascade="all, delete-orphan"
    )


class ResponseAnswer(Base):
    __tablename__ = "response_answers"
    __table_args__ = (
        Index("ix_response_answers_question_text", "question_id", "text_value"),
        Index("ix_response_answers_question_num", "question_id", "numeric_value"),
        Index("ix_response_answers_resp_key", "response_id", "question_key"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    response_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_key: Mapped[str] = mapped_column(String(80), nullable=False)
    raw_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    normalized_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    corrected_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    effective_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    numeric_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    text_value: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    is_valid: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_missing: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_outlier: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    corrected_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    corrected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    correction_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    response: Mapped["Response"] = relationship("Response", back_populates="answers")
    question: Mapped["Question"] = relationship("Question")


class ProcessingJob(Base, TimestampMixin):
    __tablename__ = "processing_jobs"
    __table_args__ = (
        Index("ix_processing_jobs_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, index=True)
    response_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responses.id", ondelete="SET NULL"), nullable=True, index=True
    )
    job_type: Mapped[str] = mapped_column(String(40), default="single_response", nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(30), default="queued", nullable=False, index=True)
    current_stage: Mapped[str] = mapped_column(String(50), default="raw_ingestion", nullable=False)
    stages_completed: Mapped[List[dict]] = mapped_column(JSONB, default=list, nullable=False)
    total_items: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    processed_items: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_items: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    celery_task_id: Mapped[Optional[str]] = mapped_column(String(120), nullable=True, index=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)


class QualityIssue(Base):
    __tablename__ = "quality_issues"
    __table_args__ = (
        Index("ix_quality_issues_status_type_sev", "status", "issue_type", "severity"),
        Index("ix_quality_issues_survey_status", "survey_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    response_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("responses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    survey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("questions.id", ondelete="SET NULL"), nullable=True
    )
    question_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    issue_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    severity: Mapped[str] = mapped_column(String(20), default="warning", nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), default="open", nullable=False, index=True)
    rule_code: Mapped[str] = mapped_column(String(60), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    detected_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    expected_constraint: Mapped[Any] = mapped_column(JSONB, nullable=True)
    resolved_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    resolution_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    response: Mapped["Response"] = relationship("Response", back_populates="quality_issues")


class AuditEvent(Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_entity", "entity_type", "entity_id", "created_at"),
        Index("ix_audit_events_notify", "notify_level", "is_read", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(120), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    actor_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    actor_type: Mapped[str] = mapped_column(String(20), default="user", nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    before_state: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    metadata_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    notify_level: Mapped[str] = mapped_column(String(20), default="none", nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)

    actor: Mapped[Optional["User"]] = relationship("User")


class Report(Base, TimestampMixin):
    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True
    )
    survey_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("survey_versions.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    report_type: Mapped[str] = mapped_column(String(40), default="full_insight", nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="published", nullable=False)
    filters_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    summary_stats: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    question_insights: Mapped[List[dict]] = mapped_column(JSONB, default=list, nullable=False)
    quality_summary: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    geo_summary: Mapped[List[dict]] = mapped_column(JSONB, default=list, nullable=False)
    analyst_notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    survey: Mapped["Survey"] = relationship("Survey")
    created_by: Mapped["User"] = relationship("User")
