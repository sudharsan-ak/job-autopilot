import type { FieldDescriptor, FieldMatch, UncertainField } from "../types.js";
import type { RuntimeProfile } from "../profile/loader.js";
import { candidateKeys } from "../profile/runtimeView.js";
import { sanitizeDomContext } from "../safety/redaction.js";

export function toUncertainField(input: {
  batchId: string;
  waveId: string;
  jobId: string;
  queueNumber: number;
  field: FieldDescriptor;
  match: FieldMatch;
  profile: RuntimeProfile;
  reason: string;
}): UncertainField {
  const terms = [input.field.label, input.field.name ?? "", input.match.profileKey ?? ""]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4);
  return {
    batchId: input.batchId,
    waveId: input.waveId,
    jobId: input.jobId,
    queueNumber: input.queueNumber,
    fieldId: input.field.semanticId ?? input.field.fieldId,
    controlType: input.field.controlType,
    question: input.field.label || "Unlabelled field",
    options: input.field.options,
    required: input.field.required,
    domContext: sanitizeDomContext(input.field.containerText),
    candidateProfileFields: candidateKeys(input.profile, terms),
    proposedProfileField: input.match.profileKey,
    confidence: input.match.confidence,
    reason: input.reason,
    capturedAt: new Date().toISOString(),
  };
}
