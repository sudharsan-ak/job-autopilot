import { sha256 } from "../utils/identity.js";

export function redactValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "[EMPTY]";
  const text = String(value);
  return `[REDACTED length=${text.length} sha256=${sha256(text).slice(0, 12)}]`;
}

export function sanitizeDomContext(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/\s+/g, " ").trim().slice(0, 320);
}
