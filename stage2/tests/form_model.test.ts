import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { buildFormModel, validatePlannedTargets } from "../src/forms/formModel.js";
import { scanPage } from "../src/forms/pageScanner.js";
import { matchField } from "../src/forms/matcher.js";
import { resolveField } from "../src/forms/profileResolver.js";
import { loadApplicantProfile } from "../src/profile/loader.js";
import type { FieldDescriptor } from "../src/types.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("scanner scopes identical date labels to their employment and education records", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <section id="employment"><h2>Employment</h2>
      <div class="employment-record"><label>Start date month<input name="employment[0][start_month]"></label></div>
      <div class="employment-record"><label>Start date month<input name="employment[1][start_month]"></label></div>
    </section>
    <section id="education"><h2>Education</h2>
      <div class="education-record"><label>Start date month<input name="education[0][start_month]"></label></div>
      <div class="education-record"><label>Start date month<input name="education[1][start_month]"></label></div>
    </section>
  `);
  const fields = await scanPage(page);
  assert.deepEqual(
    fields.map((field) => [field.repeatGroup?.kind, field.repeatGroup?.recordIndex]),
    [["EMPLOYMENT", 0], ["EMPLOYMENT", 1], ["EDUCATION", 0], ["EDUCATION", 1]],
  );
  assert.equal(new Set(fields.map((field) => field.semanticId)).size, 4);
  await page.close();
});

test("profile resolution uses group-local record indexes instead of page-wide label occurrence", async () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  profile.employmentHistory.push({ ...profile.employmentHistory[0], start: "2021-03", record_id: "employment-2" });
  profile.educationHistory.push({ ...profile.educationHistory[0], start: "2020-09", record_id: "education-2" });
  const page = await browser.newPage();
  await page.setContent(`
    <section id="employment"><h2>Employment</h2>
      <div class="employment-record"><label>Start date month<input name="employment[0][start_month]"></label></div>
      <div class="employment-record"><label>Start date month<input name="employment[1][start_month]"></label></div>
    </section>
    <section id="education"><h2>Education</h2>
      <div class="education-record"><label>Start date month<input name="education[0][start_month]"></label></div>
      <div class="education-record"><label>Start date month<input name="education[1][start_month]"></label></div>
    </section>
  `);
  const fields = await scanPage(page);
  const values = fields.map((field) => resolveField(field, matchField(field), profile).action);
  assert.deepEqual(values.map((action) => action && "value" in action ? action.value : undefined), ["8", "3", "8", "9"]);
  await page.close();
});

test("scanner repairs duplicate retained DOM ids and never exposes colliding selectors", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <label for="first">First name</label><input id="first" data-job-autopilot-field-id="s2-0-7">
    <label for="last">Last name</label><input id="last" data-job-autopilot-field-id="s2-0-7">
  `);
  const fields = await scanPage(page);
  assert.equal(fields.length, 2);
  assert.equal(new Set(fields.map((field) => field.fieldId)).size, 2);
  assert.equal(await page.locator("[data-job-autopilot-field-id='s2-0-7']").count(), 1);
  await page.close();
});

test("semantic identity survives a framework remount while the live locator id changes", async () => {
  const page = await browser.newPage();
  await page.setContent(`<div id="root"><label for="first">First Name</label><input id="first" name="first_name"></div>`);
  const first = (await scanPage(page))[0]!;
  await page.evaluate(() => {
    document.querySelector("#root")!.innerHTML = `<label for="first">First Name</label><input id="first" name="first_name">`;
  });
  const remounted = (await scanPage(page))[0]!;
  assert.notEqual(remounted.fieldId, first.fieldId);
  assert.equal(remounted.semanticId, first.semanticId);
  await page.close();
});

test("plan validation rejects missing groups, cross-group mappings, and duplicate targets", () => {
  const base = (overrides: Partial<FieldDescriptor>): FieldDescriptor => ({
    fieldId: "f", semanticId: "s", frameUrl: "about:blank", selector: "#f", controlType: "text",
    label: "", required: true, disabled: false, readOnly: false, visible: true, options: [], ...overrides,
  });
  const missing = base({ fieldId: "missing", semanticId: "missing", label: "Company name" });
  const wrong = base({
    fieldId: "wrong", semanticId: "wrong", label: "Company name",
    repeatGroup: { kind: "EDUCATION", groupKey: "education", recordKey: "education:0", recordIndex: 0 },
  });
  const first = base({ fieldId: "a", semanticId: "a", label: "First name" });
  const duplicate = base({ fieldId: "b", semanticId: "b", label: "Given name" });
  const issues = validatePlannedTargets([
    { field: missing, profileKey: "employer_name" },
    { field: wrong, profileKey: "employer_name" },
    { field: first, profileKey: "legal_first_name" },
    { field: duplicate, profileKey: "legal_first_name" },
  ]);
  assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set([
    "MISSING_REPEAT_GROUP", "REPEAT_GROUP_MISMATCH", "DUPLICATE_PROFILE_TARGET",
  ]));
});

test("form model reports duplicate semantic identities before execution", () => {
  const field: FieldDescriptor = {
    fieldId: "one", frameUrl: "about:blank", selector: "#one", controlType: "text", label: "First name",
    name: "first_name", required: true, disabled: false, readOnly: false, visible: true, options: [],
  };
  const model = buildFormModel([field, { ...field, fieldId: "two", selector: "#two" }]);
  assert.equal(model.issues.some((issue) => issue.code === "DUPLICATE_SEMANTIC_ID"), true);
});

test("production scanner recognizes Greenhouse generated repeat-field ids", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div><label for="company-name-1">Company name</label><input id="company-name-1"></div>
    <div><label for="title-1">Title</label><input id="title-1"></div>
    <div><label for="start-date-month-1">Start date month</label><input id="start-date-month-1" role="combobox"></div>
    <div><label for="school--2">School</label><input id="school--2" role="combobox"></div>
    <div><label for="degree--2">Degree</label><input id="degree--2" role="combobox"></div>
    <div><label for="discipline--2">Discipline</label><input id="discipline--2" role="combobox"></div>
  `);
  const fields = await scanPage(page, { ats: "GREENHOUSE" });
  assert.deepEqual(fields.map((field) => [field.repeatGroup?.kind, field.repeatGroup?.recordIndex]), [
    ["EMPLOYMENT", 1], ["EMPLOYMENT", 1], ["EMPLOYMENT", 1],
    ["EDUCATION", 2], ["EDUCATION", 2], ["EDUCATION", 2],
  ]);
  await page.close();
});
