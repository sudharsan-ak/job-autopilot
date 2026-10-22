import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Stage2Runtime } from "../src/mcp/dispatcher.js";
import { withTempDirAsync } from "./helpers.js";

test("load mode creates queue and database without touching Chrome", async () => {
  await withTempDirAsync(async (directory) => {
    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-17", jobs: [
      { classification: "APPLY", title: "Engineer", company: "Acme", application_url: "https://example.com/apply", resume_path: "resume.pdf" },
    ] }));
    const runtime = new Stage2Runtime({
      rootDir: directory,
      dataDir: path.join(directory, "data"),
      defaultResumePath: path.join(directory, "default-resume.pdf"),
      cdpEndpoint: "http://127.0.0.1:9224",
      chromeProfile: path.join(directory, "chrome"),
      chromeExecutable: "C:/missing/chrome.exe",
      chromeLaunchTimeoutMs: 100,
      simplifyDetectionTimeoutMs: 50,
      simplifyAutofillTimeoutMs: 5_000,
    });
    try {
      const output = await runtime.dispatch({ mode: "load", batch_path: manifestPath });
      assert.equal(output.ok, true);
      assert.equal(output.browser_opened, false);
      assert.equal(output.total_jobs, 1);
      assert.equal(typeof output.queue_path, "string");
    } finally {
      runtime.close();
    }
  });
});
