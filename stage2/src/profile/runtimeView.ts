import type { RuntimeProfile } from "./loader.js";
import type { RuntimeProfileField } from "./schema.js";

const ALWAYS_MANUAL_KEYS = new Set([
  "application_password",
  "captcha_mfa",
  "email_verification",
  "electronic_signature",
  "application_submission",
  "privacy_notice_acknowledge",
  "data_retention_consent",
  "terms_of_use_acceptance",
  "truthfulness_attestation",
  "background_check_consent",
  "drug_screen_consent",
  "resume_per_job",
  "cover_letter_per_job",
  "social_security_number",
  "passport_number",
  "visa_document_number",
  "bank_routing_account",
  "photo_identification",
  "full_date_of_birth",
  "personal_health_details",
  "unusual_upfront_payment",
]);

export function hasUsableValue(field: RuntimeProfileField | undefined): field is RuntimeProfileField {
  if (!field || ALWAYS_MANUAL_KEYS.has(field.key)) return false;
  if (field.policy_category === "HUMAN_ONLY" || field.approval === "NEVER_AUTOFILL") return false;
  if (["UNANSWERED", "NOT_APPLICABLE"].includes(field.status ?? "")) return false;
  // Only explicitly approved values may enter the deterministic autofill plan.
  // ASK_EACH_TIME and NOT_APPROVED remain available to the structured review path.
  if (field.approval && field.approval !== "AUTO_FILL_APPROVED") return false;
  if (!field.approval && field.status !== "APPROVED") return false;
  if (field.value === undefined || field.value === null || field.value === "") return false;
  return true;
}

export function getRuntimeField(profile: RuntimeProfile, key: string): RuntimeProfileField | undefined {
  return profile.fields.get(key);
}

export function safeProfileValue(field: RuntimeProfileField): string | boolean | undefined {
  if (!hasUsableValue(field)) return undefined;
  if (typeof field.value === "boolean" || typeof field.value === "string") return field.value;
  if (typeof field.value === "number") return String(field.value);
  if (Array.isArray(field.value)) return field.value.filter((item: unknown) => typeof item === "string").join(", ");
  return undefined;
}

export function candidateKeys(profile: RuntimeProfile, terms: string[]): string[] {
  const normalizedTerms = terms.map((term) => term.toLowerCase());
  return [...profile.fields.values()]
    .filter(hasUsableValue)
    .filter((field) => normalizedTerms.some((term) => field.key.includes(term)))
    .map((field) => field.key)
    .slice(0, 8);
}
