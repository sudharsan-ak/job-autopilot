export const JOB_STATUSES = [
  "PENDING",
  "PENDING_RESUME_REQUIRED",
  "OPENING",
  "FILLING",
  "NEEDS_AI_REVIEW",
  "READY_FOR_REVIEW",
  "PARTIAL_READY_FOR_REVIEW",
  "BLOCKED_MISSING_URL",
  "BLOCKED_DUPLICATE",
  "SKIPPED_WORKDAY",
  "BLOCKED",
  "PAUSED",
  "STOPPED",
  "APPLIED",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type Classification = "APPLY" | "BORDERLINE";
export type AtsKind =
  | "GREENHOUSE"
  | "ASHBY"
  | "LEVER"
  | "WORKABLE"
  | "RIPPLING"
  | "GEM"
  | "WORKDAY"
  | "GENERIC";

export interface ImportedJob {
  queueNumber: number;
  jobKey: string;
  title: string;
  company: string;
  classification: Classification;
  sourceUrl?: string;
  applicationUrl?: string;
  resumePath?: string;
  status: JobStatus;
  statusDetail?: string;
  rawIndex: number;
}

export interface StoredJob extends ImportedJob {
  id: string;
  batchId: string;
  ats?: AtsKind;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRecord {
  id: string;
  batchDate: string;
  sourcePath: string;
  fingerprint: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type ControlType =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "date"
  | "file"
  | "combobox"
  | "unknown";

export type WidgetKind =
  | "native"
  | "aria-combobox"
  | "react-select"
  | "native-radio-group"
  | "role-radio-group"
  | "role-checkbox"
  | "file-upload";

export type RepeatGroupKind = "EMPLOYMENT" | "EDUCATION";

export interface RepeatGroupBinding {
  kind: RepeatGroupKind;
  groupKey: string;
  recordKey: string;
  recordIndex: number;
}

export interface FieldDescriptor {
  fieldId: string;
  /** Stable logical identity. Unlike fieldId, this does not depend on a live DOM marker. */
  semanticId?: string;
  frameUrl: string;
  frameIndex?: number;
  selector: string;
  controlType: ControlType;
  inputType?: string;
  label: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  required: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  options: string[];
  currentValue?: string | boolean;
  containerText?: string;
  section?: string;
  widgetKind?: WidgetKind;
  fieldRootSelector?: string;
  optionContainerSelector?: string;
  selectedValueSelectors?: string[];
  domPath?: string;
  atsQuestionId?: string;
  repeatGroup?: RepeatGroupBinding;
  /** @deprecated Repeated records must use repeatGroup.recordIndex. */
  occurrenceIndex?: number;
}

export interface FormModelIssue {
  code:
    | "DUPLICATE_LIVE_ID"
    | "DUPLICATE_SEMANTIC_ID"
    | "INVALID_REPEAT_INDEX"
    | "REPEAT_GROUP_MISMATCH"
    | "MISSING_REPEAT_GROUP"
    | "DUPLICATE_PROFILE_TARGET";
  message: string;
  fieldIds: string[];
}

export interface FormRepeatGroup {
  kind: RepeatGroupKind;
  groupKey: string;
  records: Array<{ recordKey: string; recordIndex: number; fieldIds: string[] }>;
}

export interface FormModel {
  fields: FieldDescriptor[];
  repeatGroups: FormRepeatGroup[];
  issues: FormModelIssue[];
}

export interface FieldMatch {
  profileKey?: string;
  confidence: number;
  evidence: string[];
  reason?: string;
}

export type FillAction =
  | { kind: "fill"; value: string; profileKey: string }
  | { kind: "select"; value: string; profileKey: string }
  | { kind: "check"; value: boolean; profileKey: string }
  | { kind: "skip"; reason: string };

export interface FillVerification {
  fieldId: string;
  success: boolean;
  expected: string | boolean;
  observed?: string | boolean;
  error?: string;
}

export interface UncertainField {
  batchId: string;
  waveId: string;
  jobId: string;
  queueNumber: number;
  fieldId: string;
  controlType: ControlType;
  question: string;
  options: string[];
  required: boolean;
  domContext?: string;
  candidateProfileFields: string[];
  proposedProfileField?: string;
  confidence: number;
  reason: string;
  capturedAt: string;
}

export interface FieldResolution {
  fieldId: string;
  action: "FILL" | "SKIP" | "ASK_USER";
  answer?: string | boolean;
  profileField?: string;
  confidence?: number;
}

export interface NavigationDecision {
  kind: "ADVANCE" | "FINAL_BOUNDARY" | "WAIT" | "BLOCKED";
  selector?: string;
  frameUrl?: string;
  frameIndex?: number;
  reason: string;
}
