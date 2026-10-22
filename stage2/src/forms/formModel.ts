import type {
  FieldDescriptor,
  FormModel,
  FormModelIssue,
  FormRepeatGroup,
  RepeatGroupKind,
} from "../types.js";
import { sha256 } from "../utils/identity.js";

const EMPLOYMENT_KEYS = new Set([
  "employer_name", "position_title", "company_location", "start_month", "start_year",
  "end_month", "end_year", "is_current_job",
]);
const EDUCATION_KEYS = new Set([
  "institution_name", "degree_level", "degree_name", "field_of_study", "study_start_month",
  "study_start_year", "study_end_month", "study_end_year", "education_current", "gpa",
]);

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function semanticIdentity(field: FieldDescriptor): string {
  const repeat = field.repeatGroup;
  const strongestAnchor = field.atsQuestionId
    ? `ats:${normalized(field.atsQuestionId)}`
    : field.name
      ? `name:${normalized(field.name)}`
      : field.id
        ? `id:${normalized(field.id)}`
        : `path:${normalized(field.domPath)}`;
  return sha256(JSON.stringify({
    frame: field.frameIndex ?? field.frameUrl,
    repeatKind: repeat?.kind,
    repeatGroup: repeat?.groupKey,
    recordIndex: repeat?.recordIndex,
    anchor: strongestAnchor,
    controlType: field.controlType,
    label: normalized(field.label),
  }));
}

function groupedRecords(fields: FieldDescriptor[]): FormRepeatGroup[] {
  const groups = new Map<string, FormRepeatGroup>();
  for (const field of fields) {
    const repeat = field.repeatGroup;
    if (!repeat) continue;
    const key = `${repeat.kind}|${repeat.groupKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind: repeat.kind, groupKey: repeat.groupKey, records: [] };
      groups.set(key, group);
    }
    let record = group.records.find((candidate) => candidate.recordKey === repeat.recordKey);
    if (!record) {
      record = { recordKey: repeat.recordKey, recordIndex: repeat.recordIndex, fieldIds: [] };
      group.records.push(record);
    }
    record.fieldIds.push(field.semanticId ?? field.fieldId);
  }
  for (const group of groups.values()) group.records.sort((a, b) => a.recordIndex - b.recordIndex);
  return [...groups.values()];
}

export function buildFormModel(input: FieldDescriptor[]): FormModel {
  const fields = input.map((field) => ({ ...field }));
  for (const field of fields) field.semanticId = semanticIdentity(field);

  const issues: FormModelIssue[] = [];
  const liveIds = new Map<string, FieldDescriptor[]>();
  const semanticIds = new Map<string, FieldDescriptor[]>();
  for (const field of fields) {
    const live = liveIds.get(field.fieldId) ?? [];
    live.push(field);
    liveIds.set(field.fieldId, live);
    const semantic = semanticIds.get(field.semanticId!) ?? [];
    semantic.push(field);
    semanticIds.set(field.semanticId!, semantic);
    if (field.repeatGroup && (!Number.isInteger(field.repeatGroup.recordIndex) || field.repeatGroup.recordIndex < 0)) {
      issues.push({
        code: "INVALID_REPEAT_INDEX",
        message: `Repeat record has an invalid index for ${field.label || field.fieldId}.`,
        fieldIds: [field.semanticId!],
      });
    }
  }
  for (const [fieldId, duplicates] of liveIds) {
    if (duplicates.length > 1) issues.push({
      code: "DUPLICATE_LIVE_ID",
      message: `Live DOM field id ${fieldId} identifies multiple logical controls.`,
      fieldIds: duplicates.map((field) => field.semanticId!),
    });
  }
  for (const [semanticId, duplicates] of semanticIds) {
    if (duplicates.length > 1) issues.push({
      code: "DUPLICATE_SEMANTIC_ID",
      message: "Multiple controls resolve to the same semantic identity.",
      fieldIds: [semanticId],
    });
  }
  return { fields, repeatGroups: groupedRecords(fields), issues };
}

export interface PlannedFieldTarget {
  field: FieldDescriptor;
  profileKey: string;
}

function expectedRepeatKind(profileKey: string): RepeatGroupKind | undefined {
  if (EMPLOYMENT_KEYS.has(profileKey)) return "EMPLOYMENT";
  if (EDUCATION_KEYS.has(profileKey)) return "EDUCATION";
  return undefined;
}

export function validatePlannedTargets(targets: PlannedFieldTarget[]): FormModelIssue[] {
  const issues: FormModelIssue[] = [];
  const usedTargets = new Map<string, PlannedFieldTarget[]>();
  for (const target of targets) {
    const expected = expectedRepeatKind(target.profileKey);
    const repeat = target.field.repeatGroup;
    if (expected && !repeat) {
      issues.push({
        code: "MISSING_REPEAT_GROUP",
        message: `${target.profileKey} cannot be filled without a verified repeated-record container.`,
        fieldIds: [target.field.semanticId ?? target.field.fieldId],
      });
      continue;
    }
    if (expected && repeat?.kind !== expected) {
      issues.push({
        code: "REPEAT_GROUP_MISMATCH",
        message: `${target.profileKey} was mapped into a ${repeat?.kind ?? "non-repeat"} record.`,
        fieldIds: [target.field.semanticId ?? target.field.fieldId],
      });
      continue;
    }
    const targetKey = expected
      ? `${expected}|${repeat!.groupKey}|${repeat!.recordIndex}|${target.profileKey}`
      : `SINGLE|${target.profileKey}`;
    const existing = usedTargets.get(targetKey) ?? [];
    existing.push(target);
    usedTargets.set(targetKey, existing);
  }
  for (const [targetKey, duplicates] of usedTargets) {
    if (duplicates.length > 1) issues.push({
      code: "DUPLICATE_PROFILE_TARGET",
      message: `Multiple controls target the same profile value: ${targetKey}.`,
      fieldIds: duplicates.map((target) => target.field.semanticId ?? target.field.fieldId),
    });
  }
  return issues;
}
