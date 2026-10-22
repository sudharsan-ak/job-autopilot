import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { scanPage } from "../src/forms/pageScanner.js";
import { matchField } from "../src/forms/matcher.js";
import { expandKnownRepeaters } from "../src/forms/repeaters.js";
import { executeAction } from "../src/forms/executor.js";
import { loadApplicantProfile } from "../src/profile/loader.js";
import { WaveProcessor } from "../src/worker/waveProcessor.js";
import { loadManifest } from "../src/application/manifestLoader.js";
import { Stage2Database } from "../src/state/database.js";
import { Stage2Repository } from "../src/state/repositories.js";
import type { Stage2Config } from "../src/config.js";
import { withTempDirAsync } from "./helpers.js";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("Greenhouse-style repeater expands employment records (previously Workday-only)", async () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  profile.employmentHistory.push({ ...profile.employmentHistory[0], record_id: "employment-2" });
  profile.employmentHistory.push({ ...profile.employmentHistory[0], record_id: "employment-3" });
  const page = await browser.newPage();
  await page.setContent(`
    <section id="employment"><h2>Employment</h2>
      <div class="employment-record">
        <label for="company_0">Company name</label><input id="company_0" name="employment[0][company_name]">
      </div>
      <button id="add-employment" type="button">Add Another Work Experience</button>
    </section>
    <script>
      let employmentIndex = 1;
      document.querySelector('#add-employment').addEventListener('click', () => {
        const record = document.createElement('div');
        record.className = 'employment-record';
        record.innerHTML = '<label for="company_' + employmentIndex + '">Company name</label>'
          + '<input id="company_' + employmentIndex + '" name="employment[' + employmentIndex + '][company_name]">';
        document.querySelector('#employment').insertBefore(record, document.querySelector('#add-employment'));
        employmentIndex += 1;
      });
    </script>
  `);
  const result = await expandKnownRepeaters(page, "GREENHOUSE", profile);
  assert.equal(result.employment, 2);
  assert.equal(await page.locator(".employment-record").count(), 3);
  await page.close();
});

test("Ashby-style repeater expands education records through generic button scoring", async () => {
  const profile = loadApplicantProfile(path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"));
  profile.educationHistory.push({ ...profile.educationHistory[0], record_id: "education-2" });
  const page = await browser.newPage();
  await page.setContent(`
    <section id="education"><h2>Education</h2>
      <div class="education-record">
        <label for="school_0">School name</label><input id="school_0" name="education[0][school]">
      </div>
      <button id="add-education" type="button">Add another school</button>
    </section>
    <button id="unrelated-submit" type="submit">Submit Application</button>
    <script>
      let educationIndex = 1;
      document.querySelector('#add-education').addEventListener('click', () => {
        const record = document.createElement('div');
        record.className = 'education-record';
        record.innerHTML = '<label for="school_' + educationIndex + '">School name</label>'
          + '<input id="school_' + educationIndex + '" name="education[' + educationIndex + '][school]">';
        document.querySelector('#education').insertBefore(record, document.querySelector('#add-education'));
        educationIndex += 1;
      });
    </script>
  `);
  const result = await expandKnownRepeaters(page, "ASHBY", profile);
  assert.equal(result.education, 1);
  assert.equal(await page.locator(".education-record").count(), 2);
  // the scorer must never choose the submit button
  assert.equal(await page.locator("#unrelated-submit").isVisible(), true);
  await page.close();
});

test("generic custom-site form-group and selected-value conventions are now detected", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="form-group">
      <label for="city">City</label>
      <input id="city" name="city">
    </div>
    <div class="form-group">
      <label id="level-label">Experience level</label>
      <div id="level" role="combobox" aria-labelledby="level-label" aria-controls="level-options" aria-haspopup="listbox"
        onclick="document.querySelector('#level-options').style.display='block'">
        <span class="selected-value">Choose...</span>
      </div>
      <div id="level-options" role="listbox" style="display:none">
        <div role="option" onclick="document.querySelector('.selected-value').textContent=this.textContent;document.querySelector('#level-options').style.display='none'">Senior</div>
      </div>
    </div>
  `);
  const fields = await scanPage(page, { ats: "GENERIC" });
  const city = fields.find((field) => field.label === "City");
  assert.ok(city, "city field inside a form-group container should be detected");
  const level = fields.find((field) => field.controlType === "combobox");
  assert.ok(level?.fieldRootSelector, "combobox inside form-group should have a resolved field root for option discovery");
  await page.close();
});

test("plan-then-execute: entire form is scanned and resolved before any field is touched", async () => {
  await withTempDirAsync(async (directory) => {
    const touchedOrder: string[] = [];
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><form>
        <label for="first">First name</label><input id="first" autocomplete="given-name" required>
        <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
        <button type="button">Review Application</button>
        <script>
          for (const el of document.querySelectorAll('input')) {
            el.addEventListener('input', () => { window.__touched = window.__touched || []; window.__touched.push(el.id); });
          }
        </script>
      </form>`);
      void request;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");

    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-19", jobs: [{
      classification: "APPLY",
      title: "Fixture Engineer",
      company: "Fixture Company",
      application_url: `http://127.0.0.1:${address.port}/apply`,
    }] }));

    const dataDir = path.join(directory, "data");
    const database = new Stage2Database(dataDir);
    const repository = new Stage2Repository(database.connection);
    const imported = repository.importManifest(loadManifest(manifestPath));
    const wave = repository.createWave(imported.batch.id, [1]);
    const browserInstance = await chromium.launch({ headless: true });
    const context = await browserInstance.newContext();
    const config: Stage2Config = {
      rootDir: directory,
      dataDir,
      profilePath: path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"),
      defaultResumePath: path.join(directory, "default-resume.pdf"),
      cdpEndpoint: "http://127.0.0.1:9224",
      chromeProfile: path.join(directory, "chrome"),
      chromeExecutable: path.join(directory, "chrome.exe"),
      chromeLaunchTimeoutMs: 100,
      simplifyDetectionTimeoutMs: 50,
      simplifyAutofillTimeoutMs: 5_000,
    };
    try {
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath!), { browser: browserInstance, context });
      const snapshot = await processor.start(wave.id, imported.jobs);
      assert.equal(snapshot.state, "COMPLETED");
      assert.equal(snapshot.ready, 1);
      const applicationPage = context.pages().find((page) => page.url().includes("/apply"))!;
      const touched = await applicationPage.evaluate(() => (window as unknown as { __touched?: string[] }).__touched ?? []);
      assert.deepEqual(touched, ["first", "email"]);
      assert.equal(await applicationPage.locator("#first").inputValue(), "Test");
      assert.equal(await applicationPage.locator("#email").inputValue(), "test@example.com");
      void touchedOrder;
    } finally {
      await browserInstance.close();
      database.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("matcher still correctly rejects capacity/ethnicity as location fields (regression guard)", () => {
  const capacity = {
    fieldId: "f1", frameUrl: "about:blank", selector: "#f1", controlType: "text" as const,
    label: "Have you previously been employed by this company in any capacity",
    required: false, disabled: false, readOnly: false, visible: true, options: [],
  };
  const ethnicity = {
    fieldId: "f2", frameUrl: "about:blank", selector: "#f2", controlType: "select" as const,
    label: "Race/Ethnicity", required: false, disabled: false, readOnly: false, visible: true, options: ["White", "Black", "Asian"],
  };
  assert.notEqual(matchField(capacity).profileKey, "physical_city");
  assert.notEqual(matchField(ethnicity).profileKey, "physical_city");
  assert.equal(matchField(capacity).profileKey, "previous_employee_of_company");
  assert.equal(matchField(ethnicity).profileKey, "race");
});

test("trailing question marks no longer block exact taxonomy matches (live Coinbase bug)", () => {
  const field = (label: string) => ({
    fieldId: "f", frameUrl: "about:blank", selector: "#f", controlType: "select" as const,
    label, required: true, disabled: false, readOnly: false, visible: true, options: ["Yes", "No"],
  });
  assert.equal(matchField(field("Are you at least 18 years of age?")).profileKey, "age_18_or_over");
  assert.equal(
    matchField(field("Have you previously been employed by Coinbase in any capacity?")).profileKey,
    "previous_employee_of_company",
  );
});

test("bare Title/Discipline/date labels resolve, and section context disambiguates employment vs education", () => {
  const field = (label: string, section: string | undefined, options: string[] = []) => ({
    fieldId: "f", frameUrl: "about:blank", selector: "#f", controlType: options.length ? "combobox" as const : "text" as const,
    label, section, required: true, disabled: false, readOnly: false, visible: true, options,
  });
  assert.equal(matchField(field("Title", "Employment")).profileKey, "position_title");
  assert.equal(matchField(field("Discipline", "Education", ["Computer Science"])).profileKey, "field_of_study");
  assert.equal(matchField(field("Start date month", "Employment", ["January"])).profileKey, "start_month");
  assert.equal(matchField(field("Start date month", "Education", ["January"])).profileKey, "study_start_month");
  // with no section at all, the tie is a real ambiguity and must not silently guess
  const ambiguous = matchField(field("Start date month", undefined, ["January"]));
  assert.equal(ambiguous.profileKey, undefined);
  assert.equal(ambiguous.reason, "Conflicting semantic matches.");
});

test("a dial-code combobox (phone country) is never matched to physical residence country", () => {
  const phoneCountry = {
    fieldId: "f1", frameUrl: "about:blank", selector: "#f1", controlType: "combobox" as const,
    label: "Country", required: true, disabled: false, readOnly: false, visible: true,
    options: ["United States +1", "Canada +1", "Mexico +52"],
  };
  const residenceCountry = {
    fieldId: "f2", frameUrl: "about:blank", selector: "#f2", controlType: "combobox" as const,
    label: "Country", required: true, disabled: false, readOnly: false, visible: true,
    options: ["United States", "Canada", "Mexico"],
  };
  assert.equal(matchField(phoneCountry).profileKey, "phone_country_code");
  assert.equal(matchField(residenceCountry).profileKey, "physical_country");
});

test("only approved values enter deterministic autofill", async () => {
  const { hasUsableValue } = await import("../src/profile/runtimeView.js");
  const approved = { key: "k1", category: "c", value: true, status: "APPROVED", approval: "AUTO_FILL_APPROVED" };
  const neverAutofill = { key: "k2", category: "c", value: "x", status: "ANSWERED_UNAPPROVED", approval: "NEVER_AUTOFILL" };
  const notApproved = { key: "k3", category: "c", value: "x", status: "ANSWERED_UNAPPROVED", approval: "NOT_APPROVED" };
  const askEachTime = { key: "k4", category: "c", value: "x", status: "APPROVED", approval: "ASK_EACH_TIME" };
  const legacyApproved = { key: "k5", category: "c", value: "x", status: "APPROVED" };
  assert.equal(hasUsableValue(approved as never), true);
  assert.equal(hasUsableValue(neverAutofill as never), false);
  assert.equal(hasUsableValue(notApproved as never), false);
  assert.equal(hasUsableValue(askEachTime as never), false);
  assert.equal(hasUsableValue(legacyApproved as never), true);
});

test("a recycled field id from a framework re-render must never let a value land on the wrong field (live Coinbase data-corruption bug)", async () => {
  const page = await browser.newPage();
  // Mirrors exactly what happened live: a scanned "First Name" field (id s2-0-0)
  // gets removed and replaced by React with an unrelated field at the same DOM
  // position. The scanner's id counter restarts at 0 on the next scan, so the
  // new element is free to be reassigned the same "s2-0-0" selector even though
  // it is now a completely different control. Both are plain text inputs so a
  // naive id-only refind would happily fill either one - the fix must catch the
  // name/id mismatch, not rely on a control-type difference to fail safely.
  await page.setContent(`
    <div id="root">
      <label for="first">First Name</label><input id="first" name="first_name">
    </div>
  `);
  const scanned = await scanPage(page);
  const firstNameField = scanned.find((field) => field.label === "First Name")!;
  assert.equal(firstNameField.fieldId, "s2-0-0");

  // Simulate the framework tearing down the first-name field entirely and
  // replacing it with a different field at the exact same position - the new
  // element has no data-job-autopilot-field-id attribute of its own yet, so
  // the scanner's restarted-at-0 counter is free to recycle "s2-0-0" onto it.
  await page.evaluate(() => {
    const root = document.querySelector("#root")!;
    root.innerHTML = `<label for="freeform_race">Please identify your race (free text)</label>
      <input id="freeform_race" name="race_text">`;
  });
  const rescanned = await scanPage(page);
  const raceField = rescanned.find((field) => field.label.includes("race"))!;
  // Live ids are monotonic and cannot be recycled after a framework remount.
  assert.notEqual(raceField.fieldId, firstNameField.fieldId);
  assert.notEqual(raceField.name, firstNameField.name);

  // Attempting to act on the STALE firstNameField descriptor (as a plan item
  // built from the earlier scan would, after the live DOM mutated underneath
  // it) must not silently resolve via the recycled selector to the race field
  // and must not write "Asian" into it.
  const result = await executeAction(page, firstNameField, { kind: "fill", value: "Asian", profileKey: "legal_first_name" });
  assert.equal(result.success, false);
  const raceInputValue = await page.locator("#freeform_race").inputValue().catch(() => undefined);
  assert.notEqual(raceInputValue, "Asian");
  await page.close();
});

test("recycled id survives even when NEITHER the original nor the replacement element has a name/id (real live Coinbase pattern, confirmed still broken after the first fix)", async () => {
  const page = await browser.newPage();
  // The real Coinbase markup for First Name and the race combobox both lack a
  // plain name/id anchor on the control itself (React-managed, aria-labelledby
  // only). The first refindField fix compared field.id/field.name when present
  // but silently trusted a match whenever BOTH sides had neither - which is
  // exactly this case - so it kept letting "Asian" land back in First Name.
  await page.setContent(`
    <div id="root">
      <label id="first_label">First Name</label>
      <input aria-labelledby="first_label">
    </div>
  `);
  const scanned = await scanPage(page);
  const firstNameField = scanned.find((field) => field.label === "First Name")!;
  assert.equal(firstNameField.fieldId, "s2-0-0");
  assert.equal(firstNameField.name, undefined);
  assert.equal(firstNameField.id, undefined);

  await page.evaluate(() => {
    const root = document.querySelector("#root")!;
    root.innerHTML = `<label id="race_label">Please identify your race</label>
      <select aria-labelledby="race_label" role="combobox">
        <option>Select...</option><option>Asian</option><option>White</option>
      </select>`;
  });
  const rescanned = await scanPage(page);
  const raceField = rescanned.find((field) => field.label === "Please identify your race")!;
  assert.notEqual(raceField.fieldId, firstNameField.fieldId);
  assert.equal(raceField.name, undefined);
  assert.equal(raceField.id, undefined);

  const result = await executeAction(page, firstNameField, { kind: "fill", value: "Asian", profileKey: "legal_first_name" });
  assert.equal(result.success, false);
  const anyFirstNameInputHasAsianValue = await page.locator("input").evaluateAll(
    (inputs) => inputs.some((input) => (input as HTMLInputElement).value === "Asian"),
  );
  assert.equal(anyFirstNameInputHasAsianValue, false);
  await page.close();
});
