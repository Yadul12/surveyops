export type UserRole = 'admin' | 'analyst' | 'field_agent';

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  permissions: string[];
  department: string;
  region: string;
  is_active: boolean;
  last_login_at?: string | null;
}

export type QuestionType =
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'single_choice'
  | 'multi_choice'
  | 'rating'
  | 'date'
  | 'boolean'
  | 'location';

export interface QuestionOption {
  value: string;
  label: string;
}

export interface ConditionalRule {
  question_key: string;
  condition: 'equals' | 'not_equals' | 'contains' | 'in' | 'greater_than' | 'less_than' | 'is_answered';
  value: unknown;
}

export interface ConditionalLogic {
  operator: 'all' | 'any';
  rules: ConditionalRule[];
}

export interface ValidationRule {
  id?: string;
  rule_type: 'min_value' | 'max_value' | 'min_length' | 'max_length' | 'regex' | 'outlier_bounds' | 'allowed_values';
  rule_config: Record<string, unknown>;
  severity: 'critical' | 'warning' | 'info';
  error_message: string;
  is_active: boolean;
}

export interface Question {
  id?: string;
  survey_version_id?: string;
  question_key: string;
  section_title: string;
  prompt: string;
  help_text: string;
  question_type: QuestionType;
  order_index: number;
  is_required: boolean;
  options: QuestionOption[];
  conditional_logic: ConditionalLogic | null;
  config: Record<string, unknown>;
  validation_rules: ValidationRule[];
}

export interface SurveyVersion {
  id: string;
  survey_id: string;
  version_number: number;
  status: 'draft' | 'published' | 'retired';
  schema_hash?: string | null;
  change_notes: string;
  published_at?: string | null;
  created_at: string;
  question_count: number;
  questions: Question[];
}

export interface SurveyListItem {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  status: 'draft' | 'published' | 'archived';
  active_version_id: string | null;
  active_version_number: number;
  latest_version_number: number;
  question_count: number;
  target_responses: number;
  requires_consent: boolean;
  allow_location_capture: boolean;
  active_assignments: number;
  response_stats: {
    total: number;
    valid: number;
    flagged: number;
    rejected: number;
    valid_rate: number;
    avg_quality_score: number;
  };
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface SurveyAssignmentItem {
  id: string;
  survey_id: string;
  survey_code?: string;
  survey_title?: string;
  survey_category?: string;
  survey_version_id?: string;
  version_number?: number;
  agent_id: string;
  agent_name: string;
  agent_email: string;
  region: string;
  target_count: number;
  collected_count: number;
  completion_pct?: number;
  status: 'active' | 'paused' | 'completed';
  due_date: string | null;
  notes: string;
  created_at?: string;
  survey_schema?: {
    id: string;
    code: string;
    title: string;
    description: string;
    instructions: string;
    consent_text: string;
    requires_consent: boolean;
    allow_location_capture: boolean;
    version_id: string;
    version_number: number;
    questions: Question[];
  };
}

export interface SurveyDetail {
  id: string;
  code: string;
  title: string;
  description: string;
  category: string;
  status: 'draft' | 'published' | 'archived';
  active_version_id: string | null;
  target_responses: number;
  requires_consent: boolean;
  allow_location_capture: boolean;
  instructions: string;
  consent_text: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  versions: SurveyVersion[];
  assignments: SurveyAssignmentItem[];
}

export interface ResponseListItem {
  id: string;
  client_submission_id: string;
  survey_id: string;
  survey_code: string;
  survey_title: string;
  agent_name: string;
  district: string;
  processing_status: 'ingested' | 'processing' | 'validated' | 'flagged' | 'rejected' | 'approved' | 'failed';
  pipeline_stage: string;
  quality_score: number | null;
  is_duplicate: boolean;
  open_issue_count: number;
  total_issue_count: number;
  duration_seconds: number | null;
  source_channel: string;
  location_consent_given: boolean;
  submitted_at: string;
  synced_at: string | null;
}

export interface ResponseAnswerDetail {
  id: string;
  question_id: string;
  question_key: string;
  prompt: string;
  question_type: QuestionType;
  options: QuestionOption[];
  raw_value: unknown;
  normalized_value: unknown;
  corrected_value: unknown;
  effective_value: unknown;
  is_valid: boolean;
  is_missing: boolean;
  is_skipped?: boolean;
  is_outlier: boolean;
  corrected_at: string | null;
  correction_reason: string | null;
}

export interface QualityIssueItem {
  id: string;
  response_id: string;
  client_submission_id?: string;
  survey_id?: string;
  survey_code?: string;
  survey_title?: string;
  district?: string;
  response_status?: string;
  quality_score?: number | null;
  question_key: string | null;
  issue_type: string;
  severity: 'critical' | 'warning' | 'info';
  status: 'open' | 'resolved' | 'dismissed';
  rule_code: string;
  message: string;
  detected_value: unknown;
  expected_constraint: unknown;
  resolution_note: string | null;
  resolved_at?: string | null;
  created_at: string;
}

export interface AuditEventItem {
  id: string;
  entity_type?: string;
  entity_id?: string;
  action: string;
  actor_type: string;
  actor_name: string;
  summary: string;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

export interface ProcessingJobItem {
  id: string;
  batch_id: string | null;
  response_id: string | null;
  job_type: string;
  status: string;
  current_stage: string;
  stages_completed: Array<{ stage: string; status: string; duration_ms: number; [k: string]: unknown }>;
  total_items: number;
  processed_items: number;
  failed_items: number;
  attempt_count: number;
  max_attempts: number;
  celery_task_id: string | null;
  error_message: string | null;
  duration_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ResponseDetail {
  id: string;
  client_submission_id: string;
  survey_id: string;
  survey_code: string;
  survey_title: string;
  survey_version_id: string;
  version_number: number;
  agent_name: string;
  agent_email: string;
  district: string;
  processing_status: string;
  pipeline_stage: string;
  quality_score: number | null;
  is_duplicate: boolean;
  duplicate_of_id: string | null;
  fingerprint_hash: string | null;
  consent_given: boolean;
  location_consent_given: boolean;
  latitude: number | null;
  longitude: number | null;
  location_accuracy_m: number | null;
  duration_seconds: number | null;
  source_channel: string;
  device_info: Record<string, unknown>;
  started_at: string | null;
  submitted_at: string;
  synced_at: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  respondent: {
    external_ref: string;
    ward: string;
    age_bracket: string | null;
    household_size: number | null;
  } | null;
  raw_payload: Record<string, unknown>;
  normalized_payload: Record<string, unknown> | null;
  answers: ResponseAnswerDetail[];
  quality_issues: QualityIssueItem[];
  processing_jobs: ProcessingJobItem[];
  audit_history: AuditEventItem[];
}

export interface OverviewKpis {
  total_responses: number;
  valid_responses: number;
  approved_responses: number;
  flagged_responses: number;
  rejected_responses: number;
  processing_backlog: number;
  duplicate_responses: number;
  open_quality_issues: number;
  target_responses: number;
  completion_rate: number;
  raw_target_attainment_pct: number;
  valid_rate: number;
  avg_quality_score: number;
  avg_duration_seconds: number;
  geo_consented_pct: number;
  active_agents: number;
  active_surveys: number;
}

export interface TrendPoint {
  date: string;
  total: number;
  valid: number;
  flagged: number;
  rejected: number;
  avg_quality_score: number;
  issue_rate: number;
}

export interface GeoDistrictStat {
  district: string;
  total: number;
  valid: number;
  flagged: number;
  rejected: number;
  valid_rate: number;
  avg_quality_score: number;
  gps_coverage_pct: number;
  centroid: { lat: number | null; lng: number | null };
}

export interface QuestionDistribution {
  question_id: string;
  question_key: string;
  section_title: string;
  prompt: string;
  question_type: QuestionType;
  is_required: boolean;
  answered_count: number;
  missing_count: number;
  outlier_count: number;
  response_rate: number;
  numeric_stats: { mean: number; min: number | null; max: number | null } | null;
  distribution: Array<{ key: string; label: string; count: number; pct: number }>;
}

export interface InsightReport {
  id: string;
  survey_id: string;
  survey_code: string;
  survey_title: string;
  survey_category: string;
  survey_version_id: string | null;
  title: string;
  report_type: string;
  status: string;
  filters_json: Record<string, unknown>;
  summary_stats: OverviewKpis;
  question_insights?: QuestionDistribution[];
  quality_summary?: {
    by_type: Array<{ issue_type: string; total: number; open: number; resolved: number; dismissed: number }>;
    by_severity: Record<string, number>;
  };
  geo_summary?: GeoDistrictStat[];
  analyst_notes: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationItem {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  level: 'info' | 'warning' | 'critical';
  summary: string;
  actor_name: string;
  is_read: boolean;
  created_at: string;
}
