import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { executeAction } from "../src/forms/executor.js";
import { decideNavigation } from "../src/forms/navigationGuard.js";
import { scanPage } from "../src/forms/pageScanner.js";
import { isResumeUpload, uploadResume } from "../src/forms/resumeUploader.js";
import { withTempDirAsync } from "./helpers.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("Workable-style hidden resume and custom yes/no controls are detected and interacted with", async () => {
  await withTempDirAsync(async (directory) => {
    const resumePath = path.join(directory, "resume.pdf");
    writeFileSync(resumePath, "%PDF-smoke");
    const page = await browser.newPage();
    await page.setContent(`
      <section data-ui="resume-field"><label for="resume">Resume</label><input id="resume" data-ui="resume" type="file" hidden required></section>
      <fieldset><legend>Are you authorized to work in the US?</legend>
        <div role="radiogroup" aria-label="Are you authorized to work in the US?" aria-required="true">
          <button role="radio" aria-checked="false" onclick="this.parentElement.querySelectorAll('[role=radio]').forEach(x=>x.setAttribute('aria-checked','false'));this.setAttribute('aria-checked','true')">YES</button>
          <button role="radio" aria-checked="false" onclick="this.parentElement.querySelectorAll('[role=radio]').forEach(x=>x.setAttribute('aria-checked','false'));this.setAttribute('aria-checked','true')">NO</button>
        </div>
      </fieldset>
    `);
    const fields = await scanPage(page, { ats: "WORKABLE" });
    const upload = fields.find((field) => field.controlType === "file")!;
    const authorization = fields.find((field) => field.widgetKind === "role-radio-group")!;
    assert.equal(isResumeUpload(upload), true);
    assert.equal((await uploadResume(page, upload, resumePath, "WORKABLE")).success, true);
    assert.equal((await executeAction(page, authorization, { kind: "select", value: "YES", profileKey: "authorized_to_work_current" }, "WORKABLE")).success, true);
    assert.equal(await page.getByRole("radio", { name: "YES" }).getAttribute("aria-checked"), "true");
    await page.close();
  });
});

test("Greenhouse-style React select verifies the committed sibling value", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="select__container application-question">
      <label id="country-label">Country</label>
      <input id="country" role="combobox" aria-labelledby="country-label" aria-controls="country-menu"
        onclick="document.querySelector('#country-menu').hidden=false">
      <span class="select__single-value"></span>
      <div id="country-menu" role="listbox" hidden>
        <div role="option" onclick="document.querySelector('.select__single-value').textContent=this.textContent;this.parentElement.hidden=true">United States</div>
      </div>
    </div>
  `);
  const field = (await scanPage(page, { ats: "GREENHOUSE" }))[0]!;
  const result = await executeAction(page, field, { kind: "select", value: "United States", profileKey: "country" }, "GREENHOUSE");
  assert.equal(result.success, true);
  assert.equal(result.observed, "United States");
  assert.equal(await page.locator("#country").inputValue(), "");
  await page.close();
});

test("portal dropdown options remain scoped to their owning field", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="field"><label id="country-label">Country</label><input id="country" role="combobox" aria-labelledby="country-label" aria-controls="countries" onclick="countries.hidden=false"></div>
    <div class="field"><label id="source-label">Source</label><input id="source" role="combobox" aria-labelledby="source-label" aria-controls="sources" onclick="sources.hidden=false"></div>
    <div id="countries" role="listbox" hidden><div role="option" onclick="country.value=this.textContent;countries.hidden=true">United States</div></div>
    <div id="sources" role="listbox" hidden><div role="option" onclick="source.value=this.textContent;sources.hidden=true">United States</div></div>
  `);
  const fields = await scanPage(page, { ats: "GREENHOUSE" });
  const country = fields.find((field) => field.id === "country")!;
  assert.equal((await executeAction(page, country, { kind: "select", value: "United States", profileKey: "country" }, "GREENHOUSE")).success, true);
  assert.equal(await page.locator("#country").inputValue(), "United States");
  assert.equal(await page.locator("#source").inputValue(), "");
  await page.close();
});

test("field identity recovers after a framework remount", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="field" id="root"><label for="first">First name</label><input id="first" name="first_name"></div>
    <script>
      first.addEventListener('input', () => {
        const value = first.value;
        root.innerHTML = '<label for="first">First name</label><input id="first" name="first_name" value="' + value + '">';
      }, { once: true });
    </script>
  `);
  const field = (await scanPage(page))[0]!;
  const result = await executeAction(page, field, { kind: "fill", value: "Taylor", profileKey: "legal_first_name" });
  assert.equal(result.success, true);
  assert.equal(await page.locator("#first").inputValue(), "Taylor");
  await page.close();
});

test("virtualized option list can reveal and select a later option", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="field"><label id="degree-label">Degree</label><input id="degree" role="combobox" aria-labelledby="degree-label" aria-controls="degree-options" onclick="document.querySelector('#degree-options').hidden=false"></div>
    <div id="degree-options" role="listbox" style="height:40px;overflow:auto" hidden onscroll="this.innerHTML='<div role=option onclick=&quot;degree.value=this.textContent;this.parentElement.hidden=true&quot;>Master of Science</div>'">
      <div role="option">High School</div><div style="height:400px"></div>
    </div>
  `);
  const field = (await scanPage(page, { ats: "WORKDAY" }))[0]!;
  const result = await executeAction(page, field, { kind: "select", value: "Master of Science", profileKey: "degree_name" }, "WORKDAY");
  assert.equal(result.success, true);
  assert.equal(await page.locator("#degree").inputValue(), "Master of Science");
  await page.close();
});

test("navigation blocks unanswered required fields and visible CAPTCHA", async () => {
  const page = await browser.newPage();
  await page.setContent(`<label>Required<input required></label><button type="button">Continue</button>`);
  assert.equal((await decideNavigation(page)).kind, "BLOCKED");
  await page.setContent(`<div class="g-recaptcha" style="width:100px;height:40px"></div><button type="button">Continue</button>`);
  const captcha = await decideNavigation(page);
  assert.equal(captcha.kind, "BLOCKED");
  assert.match(captcha.reason, /CAPTCHA/);
  await page.close();
});
