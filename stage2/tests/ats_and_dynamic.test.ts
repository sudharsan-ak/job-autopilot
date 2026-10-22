import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { ATS_ADAPTERS } from "../src/ats/registry.js";
import type { AtsSignals } from "../src/ats/types.js";
import { scanPage } from "../src/forms/pageScanner.js";
import { decideNavigation } from "../src/forms/navigationGuard.js";

const baseSignals: AtsSignals = { url: "https://example.com", title: "Job", bodyText: "", formActions: [], scriptSources: [] };

test("every initial ATS adapter has a positive structural or URL signature", () => {
  const cases: Record<string, Partial<AtsSignals>> = {
    GREENHOUSE: { url: "https://job-boards.greenhouse.io/acme/jobs/1" },
    ASHBY: { url: "https://jobs.ashbyhq.com/acme/1" },
    LEVER: { url: "https://jobs.lever.co/acme/1" },
    WORKABLE: { url: "https://apply.workable.com/acme/j/1" },
    RIPPLING: { url: "https://ats.rippling.com/acme/jobs/1" },
    GEM: { url: "https://jobs.gem.com/acme/1" },
    WORKDAY: { url: "https://acme.wd5.myworkdayjobs.com/jobs/job/1" },
    GENERIC: { url: "https://careers.example.com/jobs/1" },
  };
  for (const adapter of ATS_ADAPTERS) {
    assert.ok(adapter.score({ ...baseSignals, ...cases[adapter.kind] }) > 0, `${adapter.kind} should match`);
  }
});

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

test("scanner includes same-origin iframe, repeaters, and dynamically inserted fields", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div data-automation-id="workExperienceSection">
      <label for="company-0">Company</label><input id="company-0">
      <label for="title-0">Job title</label><input id="title-0">
    </div>
    <iframe srcdoc='<label for="school">Institution name</label><input id="school">'></iframe>
    <script>setTimeout(() => { const i=document.createElement('input'); i.id='late'; i.setAttribute('aria-label','LinkedIn URL'); document.body.append(i); }, 25)</script>
  `);
  await page.waitForTimeout(100);
  const fields = await scanPage(page);
  assert.equal(fields.length, 4);
  assert.ok(fields.some((field) => field.label === "Institution name"));
  assert.ok(fields.some((field) => field.label === "LinkedIn URL"));
  await page.close();
});

test("all final-action labels stop even when a continue control is also present", async () => {
  const page = await browser.newPage();
  for (const label of ["Submit", "Submit Application", "Apply", "Finish", "Complete", "Send", "Final Review", "Review and Submit"]) {
    await page.setContent(`<button type="button">Continue</button><button type="button">${label}</button>`);
    assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY", label);
  }
  await page.close();
});

test("unknown type=submit is treated as a final boundary", async () => {
  const page = await browser.newPage();
  await page.setContent(`<button type="submit">Proceed</button>`);
  assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY");
  await page.close();
});

test("final actions inside an iframe are still detected", async () => {
  const page = await browser.newPage();
  await page.setContent(`<iframe srcdoc='<button type="submit">Submit Application</button>'></iframe><button type="button">Continue</button>`);
  const decision = await decideNavigation(page);
  assert.equal(decision.kind, "FINAL_BOUNDARY");
  assert.notEqual(decision.frameUrl, page.mainFrame().url());
  await page.close();
});
