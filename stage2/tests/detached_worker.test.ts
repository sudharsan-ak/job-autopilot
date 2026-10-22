import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/application/manifestLoader.js";
import type { Stage2Config } from "../src/config.js";
import { Stage2Database } from "../src/state/database.js";
import { Stage2Repository } from "../src/state/repositories.js";
import { launchWorkerSelfTest, processExists } from "../src/worker/launcher.js";
import { withTempDirAsync } from "./helpers.js";

test("detached worker updates durable state independently of the caller", async () => {
  await withTempDirAsync(async (directory) => {
    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ jobs: [
      { classification: "APPLY", title: "Engineer", company: "Example", application_url: "https://example.com/apply", resume_path: "resume.pdf" },
    ] }));
    const dataDir = path.join(directory, "data");
    const database = new Stage2Database(dataDir);
    const repository = new Stage2Repository(database.connection);
    const imported = repository.importManifest(loadManifest(manifestPath));
    const wave = repository.createWave(imported.batch.id, [1]);
    const rootDir = process.cwd();
    const config: Stage2Config = {
      rootDir,
      dataDir,
      profilePath: path.join(rootDir, "tests", "fixtures", "applicant_profile.json"),
      defaultResumePath: path.join(directory, "default-resume.pdf"),
      cdpEndpoint: "http://127.0.0.1:9224",
      chromeProfile: path.join(directory, "chrome"),
      chromeExecutable: path.join(directory, "missing-chrome.exe"),
      chromeLaunchTimeoutMs: 100,
      simplifyDetectionTimeoutMs: 50,
      simplifyAutofillTimeoutMs: 5_000,
    };
    const pid = launchWorkerSelfTest(config, wave.id);
    assert.ok(pid > 0);
    // The complete suite launches several Playwright workers in parallel.
    // Keep this a liveness assertion without making it CPU-contention flaky.
    const deadline = Date.now() + 15_000;
    let state = String(repository.getWave(wave.id)?.state);
    while (Date.now() < deadline && state !== "COMPLETED") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = String(repository.getWave(wave.id)?.state);
    }
    assert.equal(state, "COMPLETED");
    assert.equal(Number(repository.getWave(wave.id)?.worker_pid), pid);
    while (Date.now() < deadline && processExists(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    database.close();
  });
});
