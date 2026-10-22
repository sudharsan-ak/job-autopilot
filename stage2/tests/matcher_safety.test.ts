import assert from "node:assert/strict";
import test from "node:test";
import { matchField, isSafeMatch } from "../src/forms/matcher.js";
import { isSensitiveOrManual } from "../src/safety/sensitiveFields.js";
import type { FieldDescriptor } from "../src/types.js";

function field(overrides: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    fieldId: "f1",
    frameUrl: "about:blank",
    selector: "#f1",
    controlType: "text",
    label: "",
    required: false,
    disabled: false,
    readOnly: false,
    visible: true,
    options: [],
    ...overrides,
  };
}

test("autocomplete and exact labels produce high-confidence profile matches", () => {
  const email = matchField(field({ label: "Contact", autocomplete: "email", controlType: "email" }));
  assert.equal(email.profileKey, "primary_email");
  assert.equal(email.confidence, 1);
  assert.equal(isSafeMatch(email), true);

  const sponsorship = matchField(field({ label: "Will you now or in the future require sponsorship?", controlType: "radio", options: ["Yes", "No"] }));
  assert.equal(sponsorship.profileKey, "need_sponsorship_future");
  assert.equal(isSafeMatch(sponsorship), true);
});

test("unknown and sensitive fields are not auto-filled", () => {
  assert.equal(isSafeMatch(matchField(field({ label: "Tell us something surprising" }))), false);
  assert.equal(isSensitiveOrManual(field({ label: "Type your electronic signature" })), true);
  assert.equal(isSensitiveOrManual(field({ label: "Social Security Number" })), true);
  assert.equal(isSensitiveOrManual(field({ label: "Upload resume", controlType: "file" })), true);
  assert.equal(isSensitiveOrManual(field({ label: "First name" })), false);
});
