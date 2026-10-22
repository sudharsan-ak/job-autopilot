import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { loadManifest } from "../src/application/manifestLoader.js";
import type { Stage2Config } from "../src/config.js";
import { loadApplicantProfile } from "../src/profile/loader.js";
import { Stage2Database } from "../src/state/database.js";
import { Stage2Repository } from "../src/state/repositories.js";
import { writeBatchResults } from "../src/state/reporting.js";
import { WaveProcessor } from "../src/worker/waveProcessor.js";
import { withTempDirAsync } from "./helpers.js";

test("offline workflow loads, fills, uploads fallback resume, stops for review, and records completion", async () => {
  await withTempDirAsync(async (directory) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><form>
        <label for="first">First name</label><input id="first" autocomplete="given-name" required>
        <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
        <div data-automation-id="resumeUpload"><h3>Resume/CV</h3><label for="resume">Upload a file</label><input id="resume" type="file" required style="display:none"></div>
        <button type="button">Review Application</button>
      </form>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");

    const defaultResumePath = path.join(directory, "default-resume.pdf");
    writeFileSync(defaultResumePath, "%PDF-1.7 fixture");
    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-18", jobs: [{
      classification: "APPLY",
      title: "Fixture Engineer",
      company: "Fixture Company",
      application_url: `http://127.0.0.1:${address.port}/apply`,
      resume_path: "missing-tailored.pdf",
    }] }));

    const dataDir = path.join(directory, "data");
    const database = new Stage2Database(dataDir);
    const repository = new Stage2Repository(database.connection);
    const imported = repository.importManifest(loadManifest(manifestPath));
    const wave = repository.createWave(imported.batch.id, [1]);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const config: Stage2Config = {
      rootDir: directory,
      dataDir,
      profilePath: path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"),
      defaultResumePath,
      cdpEndpoint: "http://127.0.0.1:9224",
      chromeProfile: path.join(directory, "chrome"),
      chromeExecutable: path.join(directory, "chrome.exe"),
      chromeLaunchTimeoutMs: 100,
      simplifyDetectionTimeoutMs: 50,
      simplifyAutofillTimeoutMs: 5_000,
    };

    try {
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath!), { browser, context });
      const snapshot = await processor.start(wave.id, imported.jobs);
      assert.equal(snapshot.state, "COMPLETED");
      assert.equal(snapshot.ready, 1);
      assert.equal(snapshot.unresolved.length, 0);
      assert.equal(repository.getJob(imported.jobs[0]!.id)?.status, "READY_FOR_REVIEW");
      const applicationPage = context.pages().find((page) => page.url().includes("/apply"))!;
      assert.equal(await applicationPage.locator("#first").inputValue(), "Test");
      assert.equal(await applicationPage.locator("#email").inputValue(), "test@example.com");
      assert.equal(await applicationPage.locator("#resume").evaluate((element: HTMLInputElement) => element.files?.[0]?.name), "default-resume.pdf");
      repository.markApplied(imported.batch.id, [1], "fixture confirmation");
      const files = writeBatchResults(dataDir, imported.batch, repository.listJobs(imported.batch.id), repository);
      assert.equal(repository.getJob(imported.jobs[0]!.id)?.status, "APPLIED");
      assert.equal(existsSync(files.jsonPath) && existsSync(files.markdownPath) && existsSync(files.seenJobsPath), true);
    } finally {
      await browser.close();
      database.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("production workflow uses Simplify first and does not run the legacy filler", async () => {
  await withTempDirAsync(async (directory) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><form>
        <label for="first">First name</label><input id="first" required>
        <label for="email">Email address</label><input id="email" type="email" required>
        <button type="button">Review Application</button>
      </form><div class="simplify-jobs-shadow-root"></div><script>
        const root = document.querySelector('.simplify-jobs-shadow-root').attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="fill-button">Autofill This Page</button><div id="status"></div>';
        root.querySelector('#fill-button').addEventListener('click', () => {
          root.querySelector('#status').textContent = 'Autofilling this page';
          setTimeout(() => {
            document.querySelector('#first').value = 'Filled by Simplify';
            document.querySelector('#email').value = 'simplify@example.com';
            root.querySelector('#status').textContent = 'Autofill complete';
          }, 50);
        });
      </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");

    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-21", jobs: [{
      classification: "APPLY",
      title: "Simplify Fixture Engineer",
      company: "Fixture Company",
      application_url: `http://127.0.0.1:${address.port}/apply`,
    }] }));
    const dataDir = path.join(directory, "data");
    const database = new Stage2Database(dataDir);
    const repository = new Stage2Repository(database.connection);
    const imported = repository.importManifest(loadManifest(manifestPath));
    const wave = repository.createWave(imported.batch.id, [1]);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const config: Stage2Config = {
      rootDir: directory,
      dataDir,
      profilePath: path.join(process.cwd(), "tests", "fixtures", "applicant_profile.json"),
      defaultResumePath: path.join(directory, "default-resume.pdf"),
      cdpEndpoint: "http://127.0.0.1:9224",
      chromeProfile: path.join(directory, "chrome"),
      chromeExecutable: path.join(directory, "chrome.exe"),
      chromeLaunchTimeoutMs: 100,
      simplifyDetectionTimeoutMs: 1_000,
      simplifyAutofillTimeoutMs: 5_000,
    };

    try {
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath!), { browser, context });
      const snapshot = await processor.start(wave.id, imported.jobs);
      assert.equal(snapshot.ready, 1);
      assert.equal(snapshot.skipped, 0);
      assert.equal(repository.getJob(imported.jobs[0]!.id)?.status, "READY_FOR_REVIEW");
      const applicationPage = context.pages().find((page) => page.url().includes("/apply"))!;
      assert.equal(await applicationPage.locator("#first").inputValue(), "Filled by Simplify");
      assert.equal(await applicationPage.locator("#email").inputValue(), "simplify@example.com");
    } finally {
      await browser.close();
      database.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

test("production workflow skips and closes resolved Workday applications", async () => {
  await withTempDirAsync(async (directory) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><form>
        <label for="first">First name</label><input id="first" required>
        <label for="email">Email address</label><input id="email" type="email" required>
      </form>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");

    const manifestPath = path.join(directory, "jobs.json");
    writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-21", jobs: [{
      classification: "APPLY",
      title: "Workday Fixture Engineer",
      company: "Fixture Company",
      application_url: `http://127.0.0.1:${address.port}/apply?provider=myworkdayjobs.com`,
    }] }));
    const dataDir = path.join(directory, "data");
    const database = new Stage2Database(dataDir);
    const repository = new Stage2Repository(database.connection);
    const imported = repository.importManifest(loadManifest(manifestPath));
    const wave = repository.createWave(imported.batch.id, [1]);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath!), { browser, context });
      const snapshot = await processor.start(wave.id, imported.jobs);
      assert.equal(snapshot.skipped, 1);
      assert.equal(snapshot.ready, 0);
      assert.equal(repository.getJob(imported.jobs[0]!.id)?.status, "SKIPPED_WORKDAY");
      assert.equal(context.pages().some((page) => page.url().includes("myworkdayjobs.com")), false);
    } finally {
      await browser.close();
      database.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
