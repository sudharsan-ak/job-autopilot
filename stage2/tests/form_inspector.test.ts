import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { inspectForm } from "../src/forms/formInspector.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("read-only inspection produces stable unique identities and repeated-record groups", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <section><h2>Personal information</h2>
      <div class="field"><label for="first">First name</label><input id="first" name="first_name" required></div>
      <div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required></div>
    </section>
    <section class="employment"><h2>Employment</h2>
      <div class="field"><label for="company-1">Company name</label><input id="company-1" name="jobs[0][company]"></div>
      <div class="field"><label for="title-1">Title</label><input id="title-1" name="jobs[0][title]"></div>
    </section>
    <section class="employment"><h2>Employment</h2>
      <div class="field"><label for="company-2">Company name</label><input id="company-2" name="jobs[1][company]"></div>
      <div class="field"><label for="title-2">Title</label><input id="title-2" name="jobs[1][title]"></div>
    </section>
    <fieldset><legend>Authorized to work?</legend>
      <label><input type="radio" name="authorized" value="yes">Yes</label>
      <label><input type="radio" name="authorized" value="no">No</label>
    </fieldset>
  `);

  const first = await inspectForm(page, "GREENHOUSE");
  assert.equal(first.diagnostics.total, 7);
  assert.deepEqual(first.diagnostics.duplicateStableIds, []);
  assert.equal(first.fields.filter((field) => field.controlType === "radio").length, 1);
  assert.deepEqual(
    first.fields.filter((field) => field.groupKind === "employment" && field.label === "Company name").map((field) => field.groupIndex),
    [0, 1],
  );
  assert.equal(await page.locator("[data-job-autopilot-field-id]").count(), 0);

  const firstNameId = first.fields.find((field) => field.label === "First name")!.stableId;
  await page.locator("body").evaluate((body) => body.insertAdjacentHTML("beforeend", "<label for='extra'>Optional note</label><input id='extra'>"));
  const second = await inspectForm(page, "GREENHOUSE");
  assert.equal(second.fields.find((field) => field.label === "First name")!.stableId, firstNameId);
  assert.deepEqual(second.diagnostics.duplicateStableIds, []);
  assert.equal(await page.locator("[data-job-autopilot-field-id]").count(), 0);
  await page.close();
});

test("inspection reports weak and missing anchors instead of inventing a target", async () => {
  const page = await browser.newPage();
  await page.setContent(`<div class="field"><input></div>`);
  const result = await inspectForm(page, "GENERIC");
  assert.equal(result.fields[0]?.label, "Unlabelled field");
  assert.equal(result.fields[0]?.anchorStrength, "weak");
  assert.deepEqual(result.fields[0]?.warnings.sort(), ["missing_label", "weak_anchor"]);
  await page.close();
});

test("Greenhouse discovery expands repeaters, groups records, and reveals dropdown options without selecting", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <section id="employment"><h2>Employment</h2>
      <div class="employment-record">
        <label for="employment_0_company_name">Company name</label><input id="employment_0_company_name" name="employment[0][company_name]">
        <label for="employment_0_title">Title</label><input id="employment_0_title" name="employment[0][title]">
      </div>
      <button id="add-employment" type="button">Add Another Employment</button>
    </section>
    <section><h2>Personal information</h2>
      <label for="country">Country</label>
      <input id="country" name="country" role="combobox" aria-controls="countries" aria-expanded="false">
      <div id="countries" role="listbox" style="display:none">
        <div role="option">United States</div><div role="option">Canada</div>
      </div>
    </section>
    <label for="sponsorship">Will you require sponsorship for employment visa status?</label>
    <select id="sponsorship"><option>Select...</option><option>Yes</option><option>No</option></select>
    <label for="hispanic">Are you Hispanic or Latino?</label>
    <select id="hispanic"><option>Select...</option><option>Yes</option><option>No</option></select>
    <label for="resume">Attach</label><input id="resume" name="resume" type="file">
    <script>
      let employmentIndex = 1;
      document.querySelector('#add-employment').addEventListener('click', () => {
        const record = document.createElement('div');
        record.className = 'employment-record';
        record.innerHTML = '<label for="employment_' + employmentIndex + '_company_name">Company name</label>'
          + '<input id="employment_' + employmentIndex + '_company_name" name="employment[' + employmentIndex + '][company_name]">'
          + '<label for="employment_' + employmentIndex + '_title">Title</label>'
          + '<input id="employment_' + employmentIndex + '_title" name="employment[' + employmentIndex + '][title]">';
        document.querySelector('#employment').insertBefore(record, document.querySelector('#add-employment'));
        employmentIndex += 1;
      });
      const country = document.querySelector('#country');
      const countries = document.querySelector('#countries');
      country.addEventListener('click', () => { countries.style.display = 'block'; country.setAttribute('aria-expanded', 'true'); });
      country.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { countries.style.display = 'none'; country.setAttribute('aria-expanded', 'false'); }
      });
    </script>
  `);

  const result = await inspectForm(page, "GREENHOUSE", {
    desiredEmploymentRecords: 3,
    desiredEducationRecords: 0,
    discoverOptions: true,
  });
  assert.equal(result.diagnostics.repeaters.employmentBefore, 1);
  assert.equal(result.diagnostics.repeaters.employmentAfter, 3);
  assert.equal(result.diagnostics.repeaters.employmentAdded, 2);
  assert.equal(result.diagnostics.optionDiscovery.populated, 1);
  assert.deepEqual(result.diagnostics.duplicateStableIds, []);
  assert.deepEqual(
    result.fields.filter((field) => field.semanticRole === "employment.company").map((field) => field.groupIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    result.fields.find((field) => field.semanticRole === "country")?.options,
    ["United States", "Canada"],
  );
  assert.equal(result.fields.find((field) => field.semanticRole === "work_authorization.sponsorship")?.groupKind, "work_authorization");
  assert.equal(result.fields.find((field) => field.semanticRole === "demographic.hispanic_latino")?.groupKind, "demographic");
  assert.equal(result.fields.find((field) => field.semanticRole === "resume")?.label, "Resume/CV");
  assert.equal(await page.locator("#country").inputValue(), "");
  assert.equal(await page.locator("#country").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("[data-stage2-inspection-id]").count(), 0);
  await page.close();
});

test("Greenhouse generated ids keep every employment and education field in its record", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div><label for="company-name-0">Company name</label><input id="company-name-0" aria-describedby="company-name-0-description company-name-0-error"></div>
    <div><label for="title-0">Title</label><input id="title-0" aria-describedby="title-0-description title-0-error"></div>
    <div><label for="start-date-month-0">Start date month</label><input id="start-date-month-0" role="combobox" aria-describedby="react-select-start-date-month-0-placeholder"></div>
    <div><label for="start-date-year-0">Start date year</label><input id="start-date-year-0"></div>
    <div><label for="end-date-month-0">End date month</label><input id="end-date-month-0" role="combobox"></div>
    <div><label for="end-date-year-0">End date year</label><input id="end-date-year-0"></div>
    <div><label for="current-role-0_1">Current role</label><input id="current-role-0_1" name="current-role-0" type="checkbox"></div>
    <div><label for="school--2">School</label><input id="school--2" role="combobox"></div>
    <div><label for="degree--2">Degree</label><input id="degree--2" role="combobox"></div>
    <div><label for="discipline--2">Discipline</label><input id="discipline--2" role="combobox"></div>
  `);
  const result = await inspectForm(page, "GREENHOUSE", { discoverOptions: false });
  const compact = result.fields.map((field) => [field.semanticRole, field.groupKind, field.groupIndex]);
  assert.deepEqual(compact, [
    ["employment.company", "employment", 0],
    ["employment.title", "employment", 0],
    ["employment.start_month", "employment", 0],
    ["employment.start_year", "employment", 0],
    ["employment.end_month", "employment", 0],
    ["employment.end_year", "employment", 0],
    ["employment.current", "employment", 0],
    ["education.school", "education", 2],
    ["education.degree", "education", 2],
    ["education.discipline", "education", 2],
  ]);
  await page.close();
});
