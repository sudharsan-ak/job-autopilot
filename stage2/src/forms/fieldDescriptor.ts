import type { FieldDescriptor } from "../types.js";
import { sha256 } from "../utils/identity.js";

export function fieldFingerprint(field: FieldDescriptor): string {
  return sha256(
    JSON.stringify({
      controlType: field.controlType,
      semanticId: field.semanticId,
      label: field.label.replace(/\s+/g, " ").trim().toLowerCase(),
      name: field.name?.toLowerCase(),
      required: field.required,
      options: field.options.map((option) => option.replace(/\s+/g, " ").trim().toLowerCase()),
      currentValue: typeof field.currentValue === "string"
        ? field.currentValue.replace(/\s+/g, " ").trim().toLowerCase()
        : field.currentValue,
      repeatGroup: field.repeatGroup,
    }),
  );
}

export function fieldIsEmpty(field: FieldDescriptor): boolean {
  if (field.controlType === "checkbox") return true;
  if (field.currentValue === undefined || field.currentValue === null) return true;
  if (typeof field.currentValue === "boolean") return !field.currentValue;
  const value = field.currentValue.trim().toLowerCase();
  return value === "" || value === "select" || value.startsWith("select ") || value.startsWith("choose ");
}
