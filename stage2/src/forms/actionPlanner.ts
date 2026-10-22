import type { FieldDescriptor, FieldResolution, FillAction } from "../types.js";
import { isSensitiveOrManual } from "../safety/sensitiveFields.js";

type ExecutableAction = Exclude<FillAction, { kind: "skip" }>;

export type ResolutionPlan =
  | { kind: "ACTION"; action: ExecutableAction }
  | { kind: "SKIP" }
  | { kind: "ASK_USER" }
  | { kind: "REJECT"; error: string };

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function checkboxValue(value: string | boolean): boolean | undefined {
  if (typeof value === "boolean") return value;
  const normalized = normalize(value);
  if (["yes", "true", "checked"].includes(normalized)) return true;
  if (["no", "false", "unchecked"].includes(normalized)) return false;
  return undefined;
}

export function planAiResolution(field: FieldDescriptor, resolution: FieldResolution): ResolutionPlan {
  if (resolution.action === "ASK_USER") return { kind: "ASK_USER" };
  if (resolution.action === "SKIP") {
    return field.required
      ? { kind: "REJECT", error: "A required field cannot be skipped." }
      : { kind: "SKIP" };
  }
  if (resolution.answer === undefined) return { kind: "REJECT", error: "FILL requires an answer." };
  if (isSensitiveOrManual(field)) {
    return { kind: "REJECT", error: "Protected, consent, attachment, signature, or human-only field." };
  }

  const profileKey = resolution.profileField ?? "ai_resolution";
  if (field.controlType === "checkbox") {
    const value = checkboxValue(resolution.answer);
    return value === undefined
      ? { kind: "REJECT", error: "Checkbox answer must be an explicit boolean." }
      : { kind: "ACTION", action: { kind: "check", value, profileKey } };
  }

  const answer = String(resolution.answer);
  if (["select", "radio", "combobox"].includes(field.controlType) && field.options.length > 0) {
    const exact = field.options.find((option) => normalize(option) === normalize(answer));
    if (!exact) return { kind: "REJECT", error: "Answer is not an exact currently available option." };
    return { kind: "ACTION", action: { kind: "select", value: exact, profileKey } };
  }

  return { kind: "ACTION", action: { kind: "fill", value: answer, profileKey } };
}
