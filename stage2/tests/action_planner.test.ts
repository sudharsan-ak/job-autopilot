import assert from "node:assert/strict";
import test from "node:test";
import { planAiResolution } from "../src/forms/actionPlanner.js";
import { fieldFingerprint } from "../src/forms/fieldDescriptor.js";
import type { FieldDescriptor } from "../src/types.js";

function field(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    fieldId: "f1",
    frameUrl: "about:blank",
    selector: "#f1",
    controlType: "text",
    label: "Question",
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    options: [],
    ...overrides,
  };
}

test("required AI fields cannot be skipped while optional fields can", () => {
  assert.deepEqual(planAiResolution(field({ required: true }), { fieldId: "f1", action: "SKIP" }), {
    kind: "REJECT",
    error: "A required field cannot be skipped.",
  });
  assert.deepEqual(planAiResolution(field(), { fieldId: "f1", action: "SKIP" }), { kind: "SKIP" });
});

test("AI cannot fill protected fields and must choose exact options", () => {
  assert.equal(
    planAiResolution(field({ label: "Electronic signature" }), { fieldId: "f1", action: "FILL", answer: "Test" }).kind,
    "REJECT",
  );
  assert.equal(
    planAiResolution(field({ controlType: "file", label: "Resume" }), { fieldId: "f1", action: "FILL", answer: "x.pdf" }).kind,
    "REJECT",
  );
  assert.equal(
    planAiResolution(field({ controlType: "select", options: ["Yes", "No"] }), { fieldId: "f1", action: "FILL", answer: "Maybe" }).kind,
    "REJECT",
  );
  assert.deepEqual(
    planAiResolution(field({ controlType: "select", options: ["Yes", "No"] }), { fieldId: "f1", action: "FILL", answer: " yes " }),
    { kind: "ACTION", action: { kind: "select", value: "Yes", profileKey: "ai_resolution" } },
  );
});

test("checkbox AI answers require explicit booleans", () => {
  assert.deepEqual(
    planAiResolution(field({ controlType: "checkbox" }), { fieldId: "f1", action: "FILL", answer: "false" }),
    { kind: "ACTION", action: { kind: "check", value: false, profileKey: "ai_resolution" } },
  );
  assert.equal(
    planAiResolution(field({ controlType: "checkbox" }), { fieldId: "f1", action: "FILL", answer: "sometimes" }).kind,
    "REJECT",
  );
});

test("field fingerprints change after a user edits the current value", () => {
  const empty = field({ currentValue: "" });
  const edited = field({ currentValue: "User supplied answer" });
  assert.notEqual(fieldFingerprint(empty), fieldFingerprint(edited));
});
