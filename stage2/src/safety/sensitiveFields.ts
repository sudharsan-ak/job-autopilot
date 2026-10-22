import type { FieldDescriptor } from "../types.js";
import { normalizeFieldText } from "../forms/taxonomy.js";

const SENSITIVE = [
  /social security|\bssn\b/,
  /passport( number)?/,
  /bank|routing|account number/,
  /credit card|payment/,
  /password|passcode/,
  /captcha|verification code|one.time code|\botp\b/,
  /electronic signature|type.*signature|sign here/,
  /date of birth|birth date|\bdob\b/,
  /upload.*(id|passport|visa|document)/,
  /consent|agree to|certify|attest|terms of use|privacy notice/,
];

export function isSensitiveOrManual(field: FieldDescriptor): boolean {
  const text = normalizeFieldText([field.label, field.name, field.id, field.containerText].filter(Boolean).join(" "));
  return field.controlType === "file" || SENSITIVE.some((pattern) => pattern.test(text));
}
