import type { FieldDescriptor, FieldMatch, FillAction } from "../types.js";
import type { RuntimeProfile } from "../profile/loader.js";
import { getRuntimeField, hasUsableValue, safeProfileValue } from "../profile/runtimeView.js";
import { isSafeMatch } from "./matcher.js";

const EMPLOYMENT_KEYS = new Set([
  "employer_name", "position_title", "company_location", "start_month", "start_year",
  "end_month", "end_year", "is_current_job",
]);
const EDUCATION_KEYS = new Set([
  "institution_name", "degree_level", "degree_name", "field_of_study", "study_start_month",
  "study_start_year", "study_end_month", "study_end_year", "education_current", "gpa",
]);

function datePart(value: unknown, part: "month" | "year"): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})/);
  if (iso) return part === "year" ? iso[1] : String(Number(iso[2]));
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return part === "year" ? String(parsed.getFullYear()) : String(parsed.getMonth() + 1);
  const year = trimmed.match(/\b(19|20)\d{2}\b/)?.[0];
  return part === "year" ? year : undefined;
}

function repeatValue(profile: RuntimeProfile, key: string, index: number): string | boolean | undefined {
  if (EMPLOYMENT_KEYS.has(key)) {
    const record = profile.employmentHistory[index];
    if (!record) return undefined;
    const map: Record<string, unknown> = {
      employer_name: record.employer,
      position_title: record.job_title,
      company_location: record.location,
      start_month: datePart(record.start, "month"),
      start_year: datePart(record.start, "year"),
      end_month: datePart(record.end, "month"),
      end_year: datePart(record.end, "year"),
      is_current_job: record.current,
    };
    const value = map[key];
    return typeof value === "string" || typeof value === "boolean" ? value : undefined;
  }
  if (EDUCATION_KEYS.has(key)) {
    const record = profile.educationHistory[index];
    if (!record) return undefined;
    const map: Record<string, unknown> = {
      institution_name: record.institution,
      degree_level: record.degree_level,
      degree_name: record.degree_name,
      field_of_study: record.field_of_study_screenshot ?? record.field_of_study_resume,
      study_start_month: datePart(record.start, "month"),
      study_start_year: datePart(record.start, "year"),
      study_end_month: datePart(record.end, "month"),
      study_end_year: datePart(record.end, "year"),
      education_current: record.current,
      gpa: record.gpa,
    };
    const value = map[key];
    if (typeof value === "boolean") return value;
    return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
  }
  return undefined;
}

function normalized(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function matchOption(value: string | boolean, options: string[]): string | undefined {
  const wanted = normalized(typeof value === "boolean" ? (value ? "yes" : "no") : value);
  const exact = options.find((option) => normalized(option) === wanted);
  if (exact) return exact;
  if (typeof value === "string" && /^\d{1,2}$/.test(value)) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][Number(value) - 1];
    if (month) {
      const monthOption = options.find((option) => normalized(option) === month || normalized(option).startsWith(month.slice(0, 3)));
      if (monthOption) return monthOption;
    }
  }
  const booleanAliases = value === true ? ["yes", "true", "authorized", "willing"] : ["no", "false", "not authorized", "not willing"];
  return options.find((option) => booleanAliases.includes(normalized(option)));
}

export function resolveField(
  descriptor: FieldDescriptor,
  match: FieldMatch,
  profile: RuntimeProfile,
): { action?: FillAction; reason?: string } {
  if (!isSafeMatch(match) || !match.profileKey) return { reason: match.reason ?? "Semantic match was not safe." };
  const field = getRuntimeField(profile, match.profileKey);
  const expectedRepeatKind = EMPLOYMENT_KEYS.has(match.profileKey)
    ? "EMPLOYMENT"
    : EDUCATION_KEYS.has(match.profileKey)
      ? "EDUCATION"
      : undefined;
  if (expectedRepeatKind && descriptor.repeatGroup?.kind !== expectedRepeatKind) {
    return { reason: `${match.profileKey} requires a verified ${expectedRepeatKind.toLowerCase()} record container.` };
  }
  const repeated = expectedRepeatKind
    ? repeatValue(profile, match.profileKey, descriptor.repeatGroup!.recordIndex)
    : undefined;
  if (!hasUsableValue(field) && repeated === undefined) return { reason: `Profile field ${match.profileKey} has no approved usable value.` };
  const value = repeated ?? (field ? safeProfileValue(field) : undefined);
  if (value === undefined) return { reason: `Profile field ${match.profileKey} is not a scalar value.` };

  if (field?.policy_category === "EXACT_QUESTION_APPROVAL" && match.confidence < 0.98) {
    return { reason: `${match.profileKey} requires an exact question match.` };
  }
  if (descriptor.controlType === "file") return { reason: "File uploads are always manual." };
  if (["select", "radio"].includes(descriptor.controlType)) {
    const option = matchOption(value, descriptor.options);
    if (!option) return { reason: `No exact supported option for ${match.profileKey}.` };
    return { action: { kind: "select", value: option, profileKey: match.profileKey } };
  }
  if (descriptor.controlType === "combobox") {
    const option = descriptor.options.length > 0
      ? matchOption(value, descriptor.options)
      : (typeof value === "boolean" ? (value ? "Yes" : "No") : String(value));
    if (!option) return { reason: `No exact supported option for ${match.profileKey}.` };
    return { action: { kind: "select", value: option, profileKey: match.profileKey } };
  }
  if (descriptor.controlType === "checkbox") {
    if (typeof value !== "boolean") return { reason: "Checkbox value is not boolean." };
    return { action: { kind: "check", value, profileKey: match.profileKey } };
  }
  return { action: { kind: "fill", value: String(value), profileKey: match.profileKey } };
}
