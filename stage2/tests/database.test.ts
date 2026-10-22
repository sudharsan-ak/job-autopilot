import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadManifest } from "../src/application/manifestLoader.js";
import { Stage2Database } from "../src/state/database.js";
import { Stage2Repository } from "../src/state/repositories.js";
import { withTempDirAsync } from "./helpers.js";

test("database migrations, import idempotency, wave state, and explicit applied confirmation", async () => {
  await withTempDirAsync(async (directory) => {
    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(path.join(directory, "r.pdf"), "fixture");
    writeFileSync(path.join(directory, "r2.pdf"), "fixture");
    writeFileSync(manifestPath, JSON.stringify({ date: "2026-10-17", jobs: [
      { classification: "APPLY", title: "Engineer", company: "Acme", job_url: "https://example.com/1", resume_path: "r.pdf" },
      { classification: "BORDERLINE", title: "Developer", company: "Beta", job_url: "https://example.com/2", resume_path: "r2.pdf" },
    ] }));
    const database = new Stage2Database(path.join(directory, "data"));
    const repository = new Stage2Repository(database.connection);
    const first = repository.importManifest(loadManifest(manifestPath));
    const second = repository.importManifest(loadManifest(manifestPath));
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(repository.listJobs(first.batch.id).length, 2);
    const wave = repository.createWave(first.batch.id, [1]);
    const unresolved = {
      batchId: first.batch.id,
      waveId: wave.id,
      jobId: first.jobs[0]!.id,
      queueNumber: 1,
      fieldId: "field-1",
      controlType: "text" as const,
      question: "Unknown question",
      options: [],
      required: true,
      candidateProfileFields: [],
      confidence: 0,
      reason: "Unknown",
      capturedAt: new Date().toISOString(),
    };
    repository.saveUnresolved(unresolved, "fingerprint");
    repository.closeUnresolved(wave.id, first.jobs[0]!.id, "field-1", "ASK_USER");
    assert.equal(repository.listUserQuestions(wave.id).length, 1);
    assert.equal(repository.listPendingResolutions(wave.id).length, 1);
    repository.setWaveState(wave.id, "RUNNING");
    repository.setWaveState(wave.id, "COMPLETED");
    assert.equal(repository.getWave(wave.id)?.state, "COMPLETED");
    repository.markApplied(first.batch.id, [1], "manual confirmation");
    assert.equal(repository.listJobs(first.batch.id)[0]?.status, "APPLIED");
    assert.equal(repository.listJobs(first.batch.id)[1]?.status, "PENDING");
    repository.updateJob(first.jobs[1]!.id, "NEEDS_AI_REVIEW", "fixture retry");
    assert.deepEqual(repository.selectJobs(first.batch.id, [2]).map((job) => job.queueNumber), [2]);
    assert.equal(repository.selectJobs(first.batch.id).length, 0);
    const history = repository.historicalResults({ dateFrom: "2026-10-01", dateTo: "2026-10-31", status: ["APPLIED"] });
    assert.equal(history.length, 1);
    assert.equal(history[0]?.company, "Acme");
    database.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
