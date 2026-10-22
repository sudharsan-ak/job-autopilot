import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { isResumeUpload, selectResumePath, uploadResume } from "../src/forms/resumeUploader.js";
import { scanPage } from "../src/forms/pageScanner.js";
import type { StoredJob } from "../src/types.js";
import { withTempDirAsync } from "./helpers.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

function job(resumePath?: string): StoredJob {
  return {
    id: "job-1",
    batchId: "batch-1",
    queueNumber: 1,
    jobKey: "job-key",
    title: "Engineer",
    company: "Example",
    classification: "APPLY",
    sourceUrl: "https://example.com/job",
    resumePath,
    status: "PENDING",
    rawIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("job-specific resume wins and the default is a fallback", async () => {
  await withTempDirAsync(async (directory) => {
    const tailored = path.join(directory, "tailored.pdf");
    const fallback = path.join(directory, "default.pdf");
    writeFileSync(tailored, "%PDF-tailored");
    writeFileSync(fallback, "%PDF-default");
    assert.equal(selectResumePath(job(tailored), fallback), tailored);
    assert.equal(selectResumePath(job(path.join(directory, "missing.pdf")), fallback), fallback);
    const corrupt = path.join(directory, "corrupt.pdf");
    writeFileSync(corrupt, "not-a-pdf");
    assert.equal(selectResumePath(job(corrupt), fallback), fallback);
  });
});

test("only resume or CV file fields qualify for automatic upload", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <label for="resume">Resume</label><input id="resume" type="file" required style="display:none">
    <label for="cover">Cover letter</label><input id="cover" type="file">
  `);
  const fields = await scanPage(page);
  assert.equal(fields.length, 2);
  assert.equal(fields.find((field) => field.id === "resume")?.visible, false);
  assert.equal(isResumeUpload(fields.find((field) => field.id === "resume")!), true);
  assert.equal(isResumeUpload(fields.find((field) => field.id === "cover")!), false);
  await page.close();
});

test("Workday-style upload containers provide resume semantics", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <div data-automation-id="resumeUpload"><h3>Resume/CV</h3><label for="upload">Upload a file</label><input id="upload" type="file" style="display:none"></div>
  `);
  const field = (await scanPage(page))[0]!;
  assert.equal(isResumeUpload(field), true);
  await page.close();
});

test("hidden required resume input can be uploaded and verified", async () => {
  await withTempDirAsync(async (directory) => {
    const resumePath = path.join(directory, "resume.pdf");
    writeFileSync(resumePath, "%PDF-test");
    const page = await browser.newPage();
    await page.setContent(`<label for="resume">Upload resume</label><input id="resume" type="file" required style="display:none">`);
    const field = (await scanPage(page))[0]!;
    const result = await uploadResume(page, field, resumePath);
    assert.equal(result.success, true);
    assert.equal(result.observed, "resume.pdf");
    await page.close();
  });
});

test("resume verification survives an upload control rerender without a long timeout", async () => {
  await withTempDirAsync(async (directory) => {
    const resumePath = path.join(directory, "resume.pdf");
    writeFileSync(resumePath, "%PDF-test");
    const page = await browser.newPage();
    await page.setContent(`<label for="resume">Resume</label><input id="resume" type="file" onchange="const name=this.files[0].name; const done=document.createElement('span'); done.textContent=name; this.replaceWith(done)">`);
    const field = (await scanPage(page))[0]!;
    const started = Date.now();
    const result = await uploadResume(page, field, resumePath);
    assert.equal(result.success, true);
    assert.ok(Date.now() - started < 4_000);
    await page.close();
  });
});
