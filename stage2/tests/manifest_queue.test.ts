import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/application/manifestLoader.js";
import { renderQueueMarkdown } from "../src/application/queueMarkdown.js";
import type { StoredJob } from "../src/types.js";
import { withTempDir } from "./helpers.js";

test("manifest loader includes APPLY and BORDERLINE while retaining blockers", () => {
  withTempDir((directory) => {
    const manifestPath = path.join(directory, "2026-10-17-jobs_manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ jobs: [
      { classification: "APPLY", title: "Engineer", company: "Acme", application_url: "https://example.com/jobs/1?utm_source=x", resume_path: "resume.pdf" },
      { recommendation: "Borderline", role: "Developer", employer: "Beta", job_url: "https://example.org/jobs/2" },
      { decision: "SKIP", title: "Skip", company: "Nope", url: "https://example.net/3" },
      { status: "APPLY", title: "Missing URL", company: "Gamma" },
      { status: "APPLY", title: "Engineer", company: "Acme", application_url: "https://example.com/jobs/1" },
    ] }));
    const result = loadManifest(manifestPath);
    assert.equal(result.jobs.length, 4);
    assert.deepEqual(result.jobs.map((job) => job.queueNumber), [1, 2, 3, 4]);
    assert.equal(result.jobs[0]?.applicationUrl, "https://example.com/jobs/1");
    assert.equal(result.jobs[1]?.status, "PENDING_RESUME_REQUIRED");
    assert.equal(result.jobs[2]?.status, "BLOCKED_MISSING_URL");
    assert.equal(result.jobs[3]?.status, "BLOCKED_DUPLICATE");
  });
});

test("queue markdown dynamically pads every column and right-aligns row numbers", () => {
  const base = {
    batchId: "batch",
    classification: "APPLY" as const,
    rawIndex: 0,
    createdAt: "now",
    updatedAt: "now",
    jobKey: "key",
    status: "PENDING" as const,
  };
  const jobs: StoredJob[] = [
    { ...base, id: "1", queueNumber: 1, title: "A", company: "Very Long Company", applicationUrl: "https://example.com/one" },
    { ...base, id: "2", jobKey: "key2", queueNumber: 20, title: "A much longer role", company: "B", sourceUrl: "https://example.com/two", status: "READY_FOR_REVIEW" },
  ];
  const output = renderQueueMarkdown(jobs, "2026-10-17");
  const table = output.split("\n").filter((line) => line.startsWith("|"));
  assert.equal(new Set(table.map((line) => line.length)).size, 1);
  assert.match(table[2]!, /^\|\s+1\s+\|/);
  assert.match(table[3]!, /^\|\s+20\s+\|/);
});

test("loader accepts the exact Stage 1 nested sources and resume schema", () => {
  withTempDir((directory) => {
    const resumeDirectory = path.join(directory, "resumes");
    mkdirSync(resumeDirectory);
    writeFileSync(path.join(resumeDirectory, "resume.pdf"), "fixture");
    const manifestPath = path.join(directory, "jobs_manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      batch_date: "2026-10-17",
      jobs: [{
        job_key: "provider-stable-key",
        company: "Example Company",
        title: "Software Engineer",
        sources: [{ source: "hiringcafe", url: "https://hiring.cafe/job/example" }],
        employer_url: "https://careers.example.com/jobs/123",
        classification: "APPLY",
        selected_for_tailoring: true,
        resume: { pdf: "resumes/resume.pdf", tex: "resumes/resume.tex", validation: "PASSED" },
      }],
    }));
    const result = loadManifest(manifestPath);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]?.jobKey, "provider-stable-key");
    assert.equal(result.jobs[0]?.applicationUrl, "https://careers.example.com/jobs/123");
    assert.equal(result.jobs[0]?.sourceUrl, "https://hiring.cafe/job/example");
    assert.equal(result.jobs[0]?.resumePath, path.join(resumeDirectory, "resume.pdf"));
    assert.equal(result.jobs[0]?.status, "PENDING");
  });
});
