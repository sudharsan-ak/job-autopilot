import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectAts } from "../ats/detector.js";
import { connectStage2Browser } from "../browser/cdp.js";
import { enterApplicationForm } from "../browser/navigation.js";
import { writeQueueMarkdown } from "../application/queueMarkdown.js";
import { loadManifest } from "../application/manifestLoader.js";
import { getConfig, type Stage2Config } from "../config.js";
import { fieldFingerprint, fieldIsEmpty } from "../forms/fieldDescriptor.js";
import { buildFormModel, validatePlannedTargets } from "../forms/formModel.js";
import { inspectForm } from "../forms/formInspector.js";
import { discoverInteractiveOptions } from "../forms/interactiveControls.js";
import { matchField } from "../forms/matcher.js";
import { decideNavigation } from "../forms/navigationGuard.js";
import { scanPage } from "../forms/pageScanner.js";
import { resolveField } from "../forms/profileResolver.js";
import { isResumeUpload } from "../forms/resumeUploader.js";
import { loadApplicantProfile } from "../profile/loader.js";
import { isSensitiveOrManual } from "../safety/sensitiveFields.js";
import { Stage2Database } from "../state/database.js";
import { Stage2Repository } from "../state/repositories.js";
import { writeBatchResults } from "../state/reporting.js";
import type { BatchRecord, FieldDescriptor } from "../types.js";
import { valuesMatch } from "../forms/verifier.js";
import { requestWorkerControl } from "../worker/controls.js";
import { launchPrepareWorker, launchResolutionWorker, processExists, waitForResultFile } from "../worker/launcher.js";
import { triggerSimplifyMultipageAutofill, waitForSimplifyAutofillButton } from "../simplify/panelController.js";
import type { BatchApplicationInput, TestToolInput } from "./schema.js";

export class Stage2Runtime {
  readonly config: Stage2Config;
  readonly database: Stage2Database;
  readonly repository: Stage2Repository;

  constructor(config = getConfig()) {
    this.config = config;
    this.database = new Stage2Database(config.dataDir);
    this.repository = new Stage2Repository(this.database.connection);
  }

  close(): void {
    this.database.close();
  }

  private requireProfile(): string {
    if (!this.config.profilePath) throw new Error("STAGE2_PROFILE_PATH is required for browser preparation.");
    if (!existsSync(this.config.profilePath)) throw new Error(`Applicant profile not found: ${this.config.profilePath}`);
    return this.config.profilePath;
  }

  private batchFor(selector: { batch_id?: string; batch_date?: string }): BatchRecord {
    const batch = selector.batch_id
      ? this.repository.getBatch(selector.batch_id)
      : selector.batch_date
        ? this.repository.getBatchByDate(selector.batch_date)
        : this.repository.latestBatch();
    if (!batch) throw new Error("No matching Stage 2 batch was found.");
    return batch;
  }

  private queue(batch: BatchRecord): string {
    return writeQueueMarkdown(this.config.dataDir, batch.batchDate, this.repository.listJobs(batch.id));
  }

  private waveFor(input: { wave_id?: string; batch_id?: string; batch_date?: string }): Record<string, unknown> {
    if (input.wave_id) {
      const wave = this.repository.getWave(input.wave_id);
      if (!wave) throw new Error(`Unknown wave: ${input.wave_id}`);
      return wave;
    }
    const batch = this.batchFor(input);
    const wave = this.repository.latestWave(batch.id);
    if (!wave) throw new Error(`Batch ${batch.id} has no wave.`);
    return wave;
  }

  private async waitForWave(waveId: string, waitMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + waitMs;
    let wave = this.repository.getWave(waveId);
    while (wave && Date.now() < deadline && !["COMPLETED", "PAUSED", "STOPPED", "FAILED"].includes(String(wave.state))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      wave = this.repository.getWave(waveId);
    }
    if (!wave) throw new Error(`Unknown wave: ${waveId}`);
    const unresolved = this.repository.listUnresolved(waveId).map(({ fieldFingerprint: _fingerprint, ...field }) => field);
    const askUser = this.repository.listUserQuestions(waveId).map(({ fieldFingerprint: _fingerprint, ...field }) => field);
    return {
      wave_id: waveId,
      state: String(wave.state),
      worker_pid: wave.worker_pid ? Number(wave.worker_pid) : undefined,
      worker_alive: processExists(wave.worker_pid ? Number(wave.worker_pid) : undefined),
      unresolved,
      ask_user: askUser,
    };
  }

  async dispatch(input: BatchApplicationInput): Promise<Record<string, unknown>> {
    switch (input.mode) {
      case "load": {
        const manifest = loadManifest(input.batch_path);
        const imported = this.repository.importManifest(manifest);
        const queuePath = writeQueueMarkdown(this.config.dataDir, imported.batch.batchDate, imported.jobs);
        return {
          ok: true,
          mode: input.mode,
          batch_id: imported.batch.id,
          batch_date: imported.batch.batchDate,
          reused: imported.reused,
          total_jobs: imported.jobs.length,
          apply: imported.jobs.filter((job) => job.classification === "APPLY").length,
          borderline: imported.jobs.filter((job) => job.classification === "BORDERLINE").length,
          status_counts: this.repository.statusCounts(imported.batch.id),
          validation_issues: manifest.issues,
          queue_path: queuePath,
          browser_opened: false,
        };
      }
      case "prepare": {
        const batch = this.batchFor(input);
        this.requireProfile();
        const priorWave = this.repository.latestWave(batch.id);
        if (priorWave && ["QUEUED", "RUNNING"].includes(String(priorWave.state)) && processExists(Number(priorWave.worker_pid))) {
          throw new Error(`Wave ${String(priorWave.id)} is already running.`);
        }
        const jobs = this.repository.selectJobs(batch.id, input.rows, input.count);
        if (jobs.length === 0) throw new Error("No eligible rows matched the requested wave.");
        const wave = this.repository.createWave(batch.id, jobs.map((job) => job.queueNumber));
        const workerPid = launchPrepareWorker(this.config, wave.id);
        this.repository.setWaveWorker(wave.id, workerPid);
        const result = input.wait_ms === 0 ? await this.waitForWave(wave.id, 0) : await this.waitForWave(wave.id, input.wait_ms);
        const queuePath = this.queue(batch);
        return {
          ok: true,
          mode: input.mode,
          batch_id: batch.id,
          wave_id: wave.id,
          requested_rows: jobs.map((job) => job.queueNumber),
          worker_state: result.state,
          worker_pid: workerPid,
          wave_result: result,
          queue_path: queuePath,
        };
      }
      case "resolve_fields": {
        const normalized = input.resolutions.map((resolution) => ({
          fieldId: resolution.field_id,
          jobId: resolution.job_id,
          action: resolution.action,
          answer: resolution.answer,
          profileField: resolution.profile_field,
          confidence: resolution.confidence,
        }));
        this.requireProfile();
        const launched = launchResolutionWorker(this.config, input.wave_id, normalized);
        this.repository.setWaveWorker(input.wave_id, launched.pid);
        const result = await waitForResultFile<Record<string, unknown>>(launched.resultPath, 120_000);
        const wave = this.repository.getWave(input.wave_id);
        if (!wave) throw new Error(`Unknown wave: ${input.wave_id}`);
        const batch = this.repository.getBatch(String(wave.batch_id))!;
        return {
          ok: true,
          mode: input.mode,
          wave_id: input.wave_id,
          worker_pid: launched.pid,
          worker_state: result ? "COMPLETED" : "RUNNING",
          resolution_result: result,
          queue_path: this.queue(batch),
        };
      }
      case "status": {
        const batch = this.batchFor(input);
        const wave = input.wave_id ? this.repository.getWave(input.wave_id) : this.repository.latestWave(batch.id);
        return {
          ok: true,
          mode: input.mode,
          batch,
          status_counts: this.repository.statusCounts(batch.id),
          jobs: this.repository.listJobs(batch.id),
          wave,
          worker_alive: wave ? processExists(wave.worker_pid ? Number(wave.worker_pid) : undefined) : false,
          tabs: this.repository.listTabs(batch.id),
          unresolved: wave ? this.repository.listUnresolved(String(wave.id)).map(({ fieldFingerprint: _fingerprint, ...field }) => field) : [],
          ask_user: wave ? this.repository.listUserQuestions(String(wave.id)).map(({ fieldFingerprint: _fingerprint, ...field }) => field) : [],
          queue_path: this.queue(batch),
        };
      }
      case "pause":
      case "stop": {
        const wave = this.waveFor(input);
        const waveId = String(wave.id);
        const workerAlive = processExists(wave.worker_pid ? Number(wave.worker_pid) : undefined);
        if (workerAlive) requestWorkerControl(this.repository, waveId, input.mode === "pause" ? "PAUSE" : "STOP");
        else this.repository.setWaveState(waveId, input.mode === "pause" ? "PAUSED" : "STOPPED", null);
        return {
          ok: true,
          mode: input.mode,
          wave_id: waveId,
          accepted: true,
          worker_alive: workerAlive,
          takes_effect: "After the current job reaches a safe checkpoint.",
        };
      }
      case "resume": {
        const wave = this.waveFor(input);
        const waveId = String(wave.id);
        const state = String(wave.state);
        const existingAlive = processExists(wave.worker_pid ? Number(wave.worker_pid) : undefined);
        if (existingAlive) throw new Error(`Wave ${waveId} already has a live worker.`);
        if (!["PAUSED", "STOPPED", "FAILED", "RUNNING", "QUEUED"].includes(state)) throw new Error(`Wave ${waveId} cannot resume from ${state}.`);
        this.requireProfile();
        const batch = this.repository.getBatch(String(wave.batch_id))!;
        const rows = JSON.parse(String(wave.requested_rows_json)) as number[];
        const jobs = this.repository.selectJobs(batch.id, rows);
        if (jobs.length === 0) throw new Error(`Wave ${waveId} has no unfinished eligible jobs.`);
        this.repository.setWaveState(waveId, "QUEUED", null);
        const workerPid = launchPrepareWorker(this.config, waveId);
        this.repository.setWaveWorker(waveId, workerPid);
        const result = input.wait_ms === 0 ? await this.waitForWave(waveId, 0) : await this.waitForWave(waveId, input.wait_ms);
        return { ok: true, mode: input.mode, wave_id: waveId, worker_pid: workerPid, worker_state: result.state, wave_result: result, queue_path: this.queue(batch) };
      }
      case "mark_applied": {
        const batch = this.batchFor(input);
        const jobs = this.repository.markApplied(batch.id, input.rows, input.note);
        return {
          ok: true,
          mode: input.mode,
          batch_id: batch.id,
          marked_rows: input.rows,
          status_counts: this.repository.statusCounts(batch.id),
          queue_path: writeQueueMarkdown(this.config.dataDir, batch.batchDate, jobs),
          next_wave_started: false,
        };
      }
      case "results": {
        const filters = input.filters ?? {};
        if (!input.batch_id && !input.batch_date && !input.finalize && (input.filters || input.group_by)) {
          const jobs = this.repository.historicalResults({
            dateFrom: filters.date_from,
            dateTo: filters.date_to,
            company: filters.company,
            title: filters.title,
            status: filters.status,
            ats: filters.ats,
          });
          const grouped = input.group_by
            ? Object.fromEntries(
                [...new Set(jobs.map((job) => String(job[input.group_by === "day" ? "batch_date" : input.group_by!] ?? "UNKNOWN")))]
                  .sort()
                  .map((key) => [key, jobs.filter((job) => String(job[input.group_by === "day" ? "batch_date" : input.group_by!] ?? "UNKNOWN") === key).length]),
              )
            : undefined;
          return { ok: true, mode: input.mode, historical: true, count: jobs.length, jobs, group_by: input.group_by, grouped };
        }
        const batch = this.batchFor(input);
        const jobs = this.repository.listJobs(batch.id).filter((job) => {
          if (input.filters?.company && !job.company.toLowerCase().includes(input.filters.company.toLowerCase())) return false;
          if (input.filters?.title && !job.title.toLowerCase().includes(input.filters.title.toLowerCase())) return false;
          if (input.filters?.status && !input.filters.status.includes(job.status)) return false;
          if (input.filters?.ats && job.ats !== input.filters.ats) return false;
          return true;
        });
        const files = input.finalize ? writeBatchResults(this.config.dataDir, batch, this.repository.listJobs(batch.id), this.repository) : undefined;
        return {
          ok: true,
          mode: input.mode,
          batch,
          status_counts: this.repository.statusCounts(batch.id),
          jobs,
          group_by: input.group_by,
          finalized: input.finalize,
          files,
        };
      }
    }
  }

  async dispatchTest(input: TestToolInput): Promise<Record<string, unknown>> {
    switch (input.mode) {
      case "health": {
        const cdpReachable = await fetch(`${this.config.cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(1_000) })
          .then((response) => response.ok)
          .catch(() => false);
        return {
          ok: true,
          mode: input.mode,
          database_path: this.database.path,
          profile_configured: Boolean(this.config.profilePath),
          profile_exists: Boolean(this.config.profilePath && existsSync(this.config.profilePath)),
          default_resume_path: this.config.defaultResumePath,
          default_resume_exists: existsSync(this.config.defaultResumePath),
          cdp_endpoint: this.config.cdpEndpoint,
          cdp_reachable: cdpReachable,
          production_state_mutated: false,
        };
      }
      case "validate_manifest": {
        const manifest = loadManifest(input.batch_path);
        return {
          ok: true,
          mode: input.mode,
          batch_date: manifest.batchDate,
          fingerprint: manifest.fingerprint,
          eligible_jobs: manifest.jobs.length,
          validation_issues: manifest.issues,
          sample: manifest.jobs.slice(0, 5).map((job) => ({
            row: job.queueNumber,
            title: job.title,
            company: job.company,
            classification: job.classification,
            status: job.status,
          })),
          production_state_mutated: false,
        };
      }
      case "dry_run_fixture": {
        const fixtures: FieldDescriptor[] = [
          { fieldId: "first", frameUrl: "about:blank", selector: "#first", controlType: "text", label: "First name", required: true, disabled: false, readOnly: false, visible: true, options: [] },
          { fieldId: "email", frameUrl: "about:blank", selector: "#email", controlType: "email", label: "Email address", autocomplete: "email", required: true, disabled: false, readOnly: false, visible: true, options: [] },
          { fieldId: "mystery", frameUrl: "about:blank", selector: "#mystery", controlType: "text", label: "Describe your favorite product", required: false, disabled: false, readOnly: false, visible: true, options: [] },
        ];
        return {
          ok: true,
          mode: input.mode,
          fields: fixtures.map((field) => ({ field_id: field.fieldId, fingerprint: fieldFingerprint(field), match: matchField(field) })),
          production_state_mutated: false,
        };
      }
      case "database_check": {
        const temp = mkdtempSync(path.join(tmpdir(), "application-automation-"));
        try {
          const testDb = new Stage2Database(temp);
          const version = testDb.connection.prepare("PRAGMA user_version").get();
          const tables = testDb.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
          testDb.close();
          return { ok: true, mode: input.mode, version, tables, isolated_database_removed: true, production_state_mutated: false };
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
      }
      case "inspect_url": {
        const { context } = await connectStage2Browser(this.config);
        const page = await context.newPage();
        try {
          await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
          const adapter = await detectAts(page);
          const fields = await scanPage(page);
          const navigation = await decideNavigation(page, adapter.navigationHints);
          return {
            ok: true,
            mode: input.mode,
            final_url: page.url(),
            ats: adapter.kind,
            field_count: fields.length,
            fields: fields.map((field) => ({
              field_id: field.fieldId,
              label: field.label,
              control_type: field.controlType,
              required: field.required,
              options: field.options,
              match: matchField(field),
            })),
            navigation,
            retained: input.retain_tab,
            production_state_mutated: false,
          };
        } finally {
          if (!input.retain_tab) await page.close().catch(() => undefined);
        }
      }
      case "dry_plan": {
        const profile = loadApplicantProfile(this.requireProfile());
        const { context } = await connectStage2Browser(this.config);
        const page = await context.newPage();
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        try {
          const adapter = await detectAts(page);
          const inspection = await inspectForm(page, adapter.kind, {
            discoverOptions: true,
            desiredEmploymentRecords: profile.employmentHistory.length,
            desiredEducationRecords: profile.educationHistory.length,
          });
          const model = buildFormModel(await discoverInteractiveOptions(
            page,
            await scanPage(page, { ats: adapter.kind }),
            adapter.kind,
          ));
          const entries = model.fields
            .filter((field) => (field.controlType === "file" || field.visible) && !field.disabled && !field.readOnly)
            .map((field) => {
              const match = matchField(field);
              if (isResumeUpload(field)) return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: "RESUME_UPLOAD",
                reason: "Resume selection requires the queued job context; no upload was performed.",
              };
              if (isSensitiveOrManual(field)) return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: "MANUAL",
                profile_key: match.profileKey,
                reason: "Sensitive, consent, signature, attachment, or human-only field.",
              };
              const resolution = resolveField(field, match, profile);
              if (!resolution.action || resolution.action.kind === "skip") return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: field.required ? "UNRESOLVED" : "OPTIONAL_UNRESOLVED",
                profile_key: match.profileKey,
                confidence: match.confidence,
                reason: resolution.reason ?? match.reason ?? "No deterministic action is available.",
              };
              if (!fieldIsEmpty(field) && valuesMatch(resolution.action.value, field.currentValue)) return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: "ALREADY_SET",
                profile_key: resolution.action.profileKey,
                action: resolution.action.kind,
              };
              if (!fieldIsEmpty(field)) return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: "CONFLICT",
                profile_key: resolution.action.profileKey,
                action: resolution.action.kind,
                reason: "Existing value differs from the approved profile value.",
              };
              return {
                field_id: field.semanticId ?? field.fieldId,
                label: field.label,
                required: field.required,
                status: "ACTION",
                profile_key: resolution.action.profileKey,
                action: resolution.action.kind,
                repeat_group: field.repeatGroup,
              };
            });
          const actionEntries = entries.filter((entry) => entry.status === "ACTION");
          const validationIssues = validatePlannedTargets(actionEntries.flatMap((entry) => {
            const field = model.fields.find((candidate) => (candidate.semanticId ?? candidate.fieldId) === entry.field_id);
            return field && entry.profile_key ? [{ field, profileKey: entry.profile_key }] : [];
          }));
          const rejected = new Set(validationIssues.flatMap((issue) => issue.fieldIds));
          for (const entry of actionEntries) {
            if (!rejected.has(entry.field_id)) continue;
            entry.status = "VALIDATION_REJECTED";
            entry.reason = validationIssues
              .filter((issue) => issue.fieldIds.includes(entry.field_id))
              .map((issue) => issue.message)
              .join(" ");
          }
          const counts = Object.fromEntries([...new Set(entries.map((entry) => entry.status))]
            .sort()
            .map((status) => [status, entries.filter((entry) => entry.status === status).length]));
          return {
            ok: true,
            mode: input.mode,
            requested_url: input.url,
            final_url: page.url(),
            ats: adapter.kind,
            inspection_diagnostics: inspection.diagnostics,
            form_model_issues: model.issues,
            plan_validation_issues: validationIssues,
            counts,
            entries,
            retained: input.retain_tab,
            values_exposed: false,
            fields_filled: false,
            existing_tabs_mutated: false,
            production_state_mutated: false,
          };
        } finally {
          if (!input.retain_tab) await page.close().catch(() => undefined);
        }
      }
      case "simplify_autofill": {
        const { context } = await connectStage2Browser(this.config);
        const existingPage = input.reuse_existing_tab
          ? context.pages().find((candidate) => candidate.url() === input.url)
          : undefined;
        let page = existingPage ?? await context.newPage();
        if (!existingPage) await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        try {
          const simplifyButtonReady = await waitForSimplifyAutofillButton(page, 5_000);
          if (!simplifyButtonReady) page = await enterApplicationForm(page);
          const result = await triggerSimplifyMultipageAutofill(page, input.wait_ms);
          return {
            ok: result.clicked && result.started,
            mode: input.mode,
            requested_url: input.url,
            reused_existing_tab: Boolean(existingPage),
            retained: Boolean(existingPage) || input.retain_tab,
            simplify: result,
            legacy_filler_used: false,
            submitted: false,
            production_state_mutated: false,
          };
        } finally {
          if (!existingPage && !input.retain_tab) await page.close().catch(() => undefined);
        }
      }
      case "inspect_form": {
        const { context } = await connectStage2Browser(this.config);
        // Deep discovery uses an isolated tab because repeater expansion and
        // dropdown inspection are transient interactions. Existing user tabs
        // must not be reloaded or have partially completed answers disturbed.
        const page = await context.newPage();
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        try {
          const adapter = await detectAts(page);
          const profile = this.config.profilePath && existsSync(this.config.profilePath)
            ? loadApplicantProfile(this.config.profilePath)
            : undefined;
          const inspection = await inspectForm(page, adapter.kind, {
            discoverOptions: true,
            desiredEmploymentRecords: profile?.employmentHistory.length ?? 0,
            desiredEducationRecords: profile?.educationHistory.length ?? 0,
          });
          return {
            ok: true,
            mode: input.mode,
            requested_url: input.url,
            final_url: page.url(),
            reused_existing_tab: false,
            isolated_inspection_tab: true,
            ats: adapter.kind,
            diagnostics: inspection.diagnostics,
            fields: inspection.fields.map((field) => ({
              stable_id: field.stableId,
              semantic_key: field.semanticKey,
              semantic_role: field.semanticRole,
              section: field.section,
              group_kind: field.groupKind,
              group_index: field.groupIndex,
              label: field.label,
              control_type: field.controlType,
              widget_kind: field.widgetKind,
              required: field.required,
              visible: field.visible,
              current_value: field.currentValue,
              options: field.options,
              anchors: field.anchors,
              label_evidence: field.labelEvidence,
              anchor_strength: field.anchorStrength,
              warnings: field.warnings,
            })),
            retained: input.retain_tab,
            transient_interactions: true,
            existing_tabs_mutated: false,
            production_state_mutated: false,
          };
        } finally {
          if (!input.retain_tab) await page.close().catch(() => undefined);
        }
      }
    }
  }
}
