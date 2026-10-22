import { readFileSync } from "node:fs";
import path from "node:path";
import { ApplicantProfileSchema, type ApplicantProfile, type RuntimeProfileField } from "./schema.js";

export interface RuntimeProfile {
  sourcePath: string;
  raw: ApplicantProfile;
  fields: Map<string, RuntimeProfileField>;
  employmentHistory: Array<Record<string, unknown>>;
  educationHistory: Array<Record<string, unknown>>;
}

export function loadApplicantProfile(profilePath: string): RuntimeProfile {
  const sourcePath = path.resolve(profilePath);
  const parsed = ApplicantProfileSchema.parse(JSON.parse(readFileSync(sourcePath, "utf8")));
  const fields = new Map<string, RuntimeProfileField>();
  for (const [category, categoryFields] of Object.entries(parsed.fields)) {
    for (const [key, field] of Object.entries(categoryFields)) {
      fields.set(key, { ...field, key, category });
    }
  }
  return {
    sourcePath,
    raw: parsed,
    fields,
    employmentHistory: parsed.employment_history,
    educationHistory: parsed.education_history,
  };
}
