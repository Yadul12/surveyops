import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, EmailStr, Field


# ---------------- AUTH ----------------
class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: str
    permissions: List[str] = Field(default_factory=list)
    department: str
    region: str
    is_active: bool
    last_login_at: Optional[datetime] = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserSummary


class UserCreateRequest(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=200)
    password: str = Field(min_length=8, max_length=128)
    role_name: str = Field(pattern="^(admin|analyst|field_agent)$")
    department: str = "Civic Research"
    region: str = "Metro Central"


# ---------------- SURVEYS ----------------
class ValidationRuleIn(BaseModel):
    rule_type: str = Field(pattern="^(min_value|max_value|min_length|max_length|regex|outlier_bounds|allowed_values)$")
    rule_config: Dict[str, Any] = Field(default_factory=dict)
    severity: str = Field(default="warning", pattern="^(critical|warning|info)$")
    error_message: str = ""
    is_active: bool = True


class ValidationRuleOut(ValidationRuleIn):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    question_id: uuid.UUID


class QuestionIn(BaseModel):
    question_key: str = Field(min_length=1, max_length=80)
    section_title: str = "General"
    prompt: str = Field(min_length=1)
    help_text: str = ""
    question_type: str = Field(
        pattern="^(short_text|long_text|number|single_choice|multi_choice|rating|date|boolean|location)$"
    )
    order_index: int = 0
    is_required: bool = True
    options: List[Dict[str, Any]] = Field(default_factory=list)
    conditional_logic: Optional[Dict[str, Any]] = None
    config: Dict[str, Any] = Field(default_factory=dict)
    validation_rules: List[ValidationRuleIn] = Field(default_factory=list)


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    survey_version_id: uuid.UUID
    question_key: str
    section_title: str
    prompt: str
    help_text: str
    question_type: str
    order_index: int
    is_required: bool
    options: List[Dict[str, Any]]
    conditional_logic: Optional[Dict[str, Any]]
    config: Dict[str, Any]
    validation_rules: List[ValidationRuleOut] = Field(default_factory=list)


class SurveyVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    survey_id: uuid.UUID
    version_number: int
    status: str
    schema_hash: Optional[str]
    change_notes: str
    published_at: Optional[datetime]
    created_at: datetime
    questions: List[QuestionOut] = Field(default_factory=list)


class SurveyCreateRequest(BaseModel):
    code: Optional[str] = None
    title: str = Field(min_length=3, max_length=255)
    description: str = ""
    category: str = "Civic Services"
    target_responses: int = Field(default=250, ge=1, le=500000)
    requires_consent: bool = True
    allow_location_capture: bool = True
    instructions: str = ""
    consent_text: str = (
        "Participation is voluntary and confidential. Answers are anonymized and used strictly for civic research."
    )
    questions: List[QuestionIn] = Field(default_factory=list)


class SurveyUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=3, max_length=255)
    description: Optional[str] = None
    category: Optional[str] = None
    target_responses: Optional[int] = Field(default=None, ge=1, le=500000)
    requires_consent: Optional[bool] = None
    allow_location_capture: Optional[bool] = None
    instructions: Optional[str] = None
    consent_text: Optional[str] = None
    status: Optional[str] = Field(default=None, pattern="^(draft|published|archived)$")


class SurveyVersionSaveQuestionsRequest(BaseModel):
    change_notes: str = ""
    questions: List[QuestionIn]


class PublishSurveyRequest(BaseModel):
    version_id: Optional[uuid.UUID] = None
    change_notes: Optional[str] = None


# ---------------- ASSIGNMENTS ----------------
class AssignmentCreateRequest(BaseModel):
    survey_id: uuid.UUID
    agent_id: uuid.UUID
    region: str = Field(min_length=2, max_length=120)
    target_count: int = Field(default=50, ge=1, le=50000)
    due_date: Optional[datetime] = None
    notes: str = ""


class AssignmentUpdateRequest(BaseModel):
    region: Optional[str] = None
    target_count: Optional[int] = Field(default=None, ge=1, le=50000)
    status: Optional[str] = Field(default=None, pattern="^(active|paused|completed)$")
    due_date: Optional[datetime] = None
    notes: Optional[str] = None


# ---------------- RESPONSES ----------------
class RespondentIn(BaseModel):
    external_ref: str = Field(default="ANON", max_length=100)
    district: str = "Metro Central"
    ward: str = "Ward 1"
    age_bracket: Optional[str] = None
    household_size: Optional[int] = None


class ResponseSubmitRequest(BaseModel):
    client_submission_id: str = Field(min_length=4, max_length=120)
    survey_id: uuid.UUID
    survey_version_id: Optional[uuid.UUID] = None
    assignment_id: Optional[uuid.UUID] = None
    answers: Dict[str, Any] = Field(default_factory=dict)
    consent_given: bool = True
    location_consent_given: bool = False
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_accuracy_m: Optional[float] = None
    district: str = "Metro Central"
    started_at: Optional[datetime] = None
    submitted_at: Optional[datetime] = None
    duration_seconds: Optional[int] = Field(default=None, ge=0, le=86400)
    source_channel: str = "mobile_online"
    device_info: Dict[str, Any] = Field(default_factory=dict)
    respondent: Optional[RespondentIn] = None
    process_sync: bool = False


class BatchResponseSubmitRequest(BaseModel):
    batch_id: Optional[str] = None
    items: List[ResponseSubmitRequest] = Field(min_length=1, max_length=5000)
    process_sync: bool = False


# ---------------- QUALITY ----------------
class AnswerCorrectionRequest(BaseModel):
    corrected_value: Any
    correction_reason: str = Field(min_length=3, max_length=500)
    reprocess: bool = True


class ResponseDecisionRequest(BaseModel):
    decision: str = Field(pattern="^(approve|reject|flag)$")
    review_notes: str = Field(default="", max_length=1000)
    resolve_open_issues: bool = True


class IssueActionRequest(BaseModel):
    status: str = Field(pattern="^(resolved|dismissed|open)$")
    resolution_note: str = Field(default="", max_length=500)


class BulkApproveRequest(BaseModel):
    response_ids: List[uuid.UUID] = Field(min_length=1, max_length=500)
    review_notes: str = "Bulk approved after analyst quality verification."


# ---------------- REPORTS ----------------
class ReportCreateRequest(BaseModel):
    survey_id: uuid.UUID
    survey_version_id: Optional[uuid.UUID] = None
    title: str = Field(min_length=3, max_length=255)
    report_type: str = Field(default="full_insight", pattern="^(executive_summary|data_quality_audit|field_operations|full_insight)$")
    district: Optional[str] = None
    status_filter: str = Field(default="valid", pattern="^(valid|approved|all)$")
    analyst_notes: str = ""


class ReportUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, min_length=3, max_length=255)
    analyst_notes: Optional[str] = None
    status: Optional[str] = Field(default=None, pattern="^(draft|published)$")
