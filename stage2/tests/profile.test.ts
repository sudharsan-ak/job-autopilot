import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { loadApplicantProfile } from "../src/profile/loader.js";
import { hasUsableValue, safeProfileValue } from "../src/profile/runtimeView.js";

const profilePath = path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json");

test("canonical profile loads without copying it into Stage 2", () => {
  const profile = loadApplicantProfile(path.resolve(profilePath));
  assert.equal(profile.fields.size, 4);
  assert.equal(profile.employmentHistory.length, 1);
  assert.equal(profile.educationHistory.length, 1);
  const firstName = profile.fields.get("legal_first_name");
  assert.equal(hasUsableValue(firstName), true);
  assert.equal(typeof (firstName && safeProfileValue(firstName)), "string");
  assert.equal(hasUsableValue(profile.fields.get("social_security_number")), false);
  assert.equal(hasUsableValue(profile.fields.get("application_password")), false);
});
