import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { executeAction } from "../src/forms/executor.js";
import { matchField } from "../src/forms/matcher.js";
import { scanPage } from "../src/forms/pageScanner.js";
import { discoverInteractiveOptions } from "../src/forms/interactiveControls.js";
import { resolveField } from "../src/forms/profileResolver.js";
import { expandKnownRepeaters } from "../src/forms/repeaters.js";
import { loadApplicantProfile } from "../src/profile/loader.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("repeatable employment fields resolve against the matching history record", () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  const descriptor = {
    fieldId: "company-0",
    frameUrl: "about:blank",
    selector: "#company-0",
    controlType: "text" as const,
    label: "Company",
    required: true,
    disabled: false,
    readOnly: false,
    visible: true,
    options: [],
    repeatGroup: {
      kind: "EMPLOYMENT" as const,
      groupKey: "employment",
      recordKey: "employment:0",
      recordIndex: 0,
    },
  };
  const resolved = resolveField(descriptor, matchField(descriptor), profile);
  assert.deepEqual(resolved.action, { kind: "fill", value: "Example Company", profileKey: "employer_name" });
});

test("Workday repeaters are expanded only through known add controls", async () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  profile.employmentHistory.push({ ...profile.employmentHistory[0], record_id: "employment-2" });
  profile.educationHistory.push({ ...profile.educationHistory[0], record_id: "education-2" });
  const page = await browser.newPage();
  await page.setContent(`
    <div id="work"><label>Company</label></div>
    <button data-automation-id="addAnotherWorkExperience" onclick="document.querySelector('#work').insertAdjacentHTML('beforeend','<label>Company</label>')">Add Another Work Experience</button>
    <div id="education"><label>Institution Name</label></div>
    <button data-automation-id="addAnotherEducation" onclick="document.querySelector('#education').insertAdjacentHTML('beforeend','<label>Institution Name</label>')">Add Another Education</button>
  `);
  const result = await expandKnownRepeaters(page, "WORKDAY", profile);
  assert.deepEqual(result, { employment: 1, education: 1 });
  assert.equal(await page.locator("#work label").count(), 2);
  assert.equal(await page.locator("#education label").count(), 2);
  await page.close();
});

test("custom combobox selects only an exact visible option", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <label id="state-label">State</label>
    <button id="state" role="combobox" aria-labelledby="state-label" onclick="document.querySelector('#options').hidden=false">Choose</button>
    <div id="options" role="listbox" hidden>
      <div role="option" onclick="document.querySelector('#state').textContent=this.textContent; document.querySelector('#options').hidden=true">Texas</div>
      <div role="option">California</div>
    </div>
  `);
  const field = (await scanPage(page))[0]!;
  const result = await executeAction(page, field, { kind: "fill", value: "Texas", profileKey: "physical_state" });
  assert.equal(result.success, true);
  assert.equal(await page.locator("#state").textContent(), "Texas");
  await page.close();
});

test("closed comboboxes are clicked to discover options before resolution", async () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  const page = await browser.newPage();
  await page.setContent(`
    <label id="auth-label">Are you legally authorized to work?</label>
    <input id="auth" role="combobox" aria-labelledby="auth-label" readonly onclick="document.querySelector('#auth-options').hidden=false">
    <div id="auth-options" role="listbox" hidden>
      <div role="option" onclick="document.querySelector('#auth').value=this.textContent; document.querySelector('#auth-options').hidden=true">Yes</div>
      <div role="option">No</div>
    </div>
  `);
  const fields = await discoverInteractiveOptions(page, await scanPage(page));
  const field = fields[0]!;
  assert.deepEqual(field.options, ["Yes", "No"]);
  const resolution = resolveField(field, matchField(field), profile);
  assert.deepEqual(resolution.action, { kind: "select", value: "Yes", profileKey: "authorized_to_work_current" });
  assert.equal((await executeAction(page, field, resolution.action!)).success, true);
  await page.close();
});

test("location autocomplete is classified from helper text and requires a real suggestion", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <label id="address_label" for="address">*Address <span>SVGs not supported by this browser.</span></label>
    <input id="address" name="address" data-ui="address" aria-labelledby="address_label" aria-describedby="address_helper"
      oninput="document.querySelector('#suggestions').hidden=false">
    <div id="address_helper">Include your city, region, and country so employers can manage your application.</div>
    <div id="suggestions" role="listbox" hidden>
      <div role="option" onclick="document.querySelector('#address').value=this.textContent; document.querySelector('#suggestions').hidden=true">Lewisville, Texas, United States</div>
    </div>
  `);
  const field = (await scanPage(page))[0]!;
  assert.equal(field.label, "*Address");
  assert.equal(matchField(field).profileKey, "current_location_display");
  const result = await executeAction(page, field, { kind: "fill", value: "Lewisville, Texas", profileKey: "current_location_display" });
  assert.equal(result.success, true);
  assert.equal(await page.locator("#address").inputValue(), "Lewisville, Texas, United States");
  await page.close();
});
