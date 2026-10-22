import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AtsAdapter } from "../ats/types.js";
import { detectAts } from "../ats/detector.js";
import { enterApplicationForm } from "../browser/navigation.js";
import { connectStage2Browser, pageTargetId } from "../browser/cdp.js";
import { findOrOpenJobPage } from "../browser/tabRegistry.js";
import type { Stage2Config } from "../config.js";
import { executeAction } from "../forms/executor.js";
import { fieldSemanticKey, waitForDomSettled } from "../forms/fieldRuntime.js";
import { planAiResolution } from "../forms/actionPlanner.js";
import { fieldFingerprint, fieldIsEmpty } from "../forms/fieldDescriptor.js";
import { discoverInteractiveOptions } from "../forms/interactiveControls.js";
import { buildFormModel, validatePlannedTargets } from "../forms/formModel.js";
import { matchField } from "../forms/matcher.js";
import { guardedNavigationDecision } from "../safety/submissionGuard.js";
import { scanPage } from "../forms/pageScanner.js";
import { resolveField } from "../forms/profileResolver.js";
import { isResumeUpload, selectResumePath, uploadResume } from "../forms/resumeUploader.js";
import { expandKnownRepeaters } from "../forms/repeaters.js";
import { toUncertainField } from "../forms/unresolvedCollector.js";
import type { RuntimeProfile } from "../profile/loader.js";
import { isSensitiveOrManual } from "../safety/sensitiveFields.js";
import { redactValue } from "../safety/redaction.js";
import { triggerSimplifyMultipageAutofill, waitForSimplifyAutofillButton } from "../simplify/panelController.js";
import type { FieldDescriptor, FieldMatch, FieldResolution, FillAction, JobStatus, StoredJob, UncertainField } from "../types.js";
import type { Stage2Repository } from "../state/repositories.js";
import { valuesMatch } from "../forms/verifier.js";

type ExecutableAction = Exclude<FillAction, { kind: "skip" }>;

type FieldPlanItem = { fieldKey: string } & (
  | { field: FieldDescriptor; match: FieldMatch; kind: "ACTION"; action: ExecutableAction }
  | { field: FieldDescriptor; match: FieldMatch; kind: "UPLOAD_RESUME"; resumePath: string }
  | { field: FieldDescriptor; match: FieldMatch; kind: "UNRESOLVED"; reason: string; priorState?: string; alwaysSave?: boolean }
);

export interface WaveSnapshot {
  waveId: string;
  state: string;
  processed: number;
  ready: number;
  needsAi: number;
  blocked: number;
  skipped: number;
  unresolved: UncertainField[];
  askUser: UncertainField[];
}

export class WaveProcessor {
  private browser?: Browser;
  private context?: BrowserContext;
  private tasks = new Map<string, Promise<WaveSnapshot>>();

  constructor(
    private readonly config: Stage2Config,
    private readonly repository: Stage2Repository,
    private readonly profile: RuntimeProfile,
    session?: { browser: Browser; context: BrowserContext },
  ) {
    this.browser = session?.browser;
    this.context = session?.context;
  }

  private async browserContext(): Promise<BrowserContext> {
    if (this.browser?.isConnected() && this.context) return this.context;
    const connected = await connectStage2Browser(this.config);
    this.browser = connected.browser;
    this.context = connected.context;
    return connected.context;
  }

  start(waveId: string, jobs: StoredJob[]): Promise<WaveSnapshot> {
    const existing = this.tasks.get(waveId);
    if (existing) return existing;
    const task = this.run(waveId, jobs).finally(() => this.tasks.delete(waveId));
    this.tasks.set(waveId, task);
    return task;
  }

  active(waveId: string): boolean {
    return this.tasks.has(waveId);
  }

  private saveUnresolvedArtifact(batchDate: string, waveId: string, fields: UncertainField[], askUser: UncertainField[]): string {
    const runDir = path.join(this.config.dataDir, "runs", batchDate);
    mkdirSync(runDir, { recursive: true });
    const outputPath = path.join(runDir, "unresolved_fields.json");
    writeFileSync(outputPath, `${JSON.stringify({ wave_id: waveId, fields, ask_user: askUser }, null, 2)}\n`, "utf8");
    return outputPath;
  }

  private async run(waveId: string, jobs: StoredJob[]): Promise<WaveSnapshot> {
    const wave = this.repository.getWave(waveId);
    if (!wave) throw new Error(`Unknown wave: ${waveId}`);
    const batchId = String(wave.batch_id);
    const batch = this.repository.getBatch(batchId);
    if (!batch) throw new Error(`Unknown batch: ${batchId}`);
    this.repository.setWaveState(waveId, "RUNNING", null);
    this.repository.addStateEvent("WAVE_STARTED", { batchId, waveId, details: { rows: jobs.map((job) => job.queueNumber) } });

    let processed = 0;
    let ready = 0;
    let needsAi = 0;
    let blocked = 0;
    let skipped = 0;
    try {
      const context = await this.browserContext();
      for (const job of jobs) {
        const checkpoint = await this.processJob(context, batchId, waveId, job);
        processed += 1;
        if (checkpoint === "READY_FOR_REVIEW") ready += 1;
        else if (checkpoint === "NEEDS_AI_REVIEW" || checkpoint === "PARTIAL_READY_FOR_REVIEW") needsAi += 1;
        else if (checkpoint === "BLOCKED") blocked += 1;
        else if (checkpoint === "SKIPPED_WORKDAY") skipped += 1;

        const control = this.repository.requestedControl(waveId);
        if (control === "PAUSE") {
          this.repository.setWaveState(waveId, "PAUSED", null);
          this.repository.addStateEvent("WAVE_PAUSED", { batchId, waveId, jobId: job.id });
          return this.snapshot(waveId, "PAUSED", processed, ready, needsAi, blocked, skipped, batch.batchDate);
        }
        if (control === "STOP") {
          this.repository.setWaveState(waveId, "STOPPED", null);
          this.repository.addStateEvent("WAVE_STOPPED", { batchId, waveId, jobId: job.id });
          return this.snapshot(waveId, "STOPPED", processed, ready, needsAi, blocked, skipped, batch.batchDate);
        }
      }
      this.repository.setWaveState(waveId, "COMPLETED", null);
      this.repository.addStateEvent("WAVE_COMPLETED", { batchId, waveId });
      return this.snapshot(waveId, "COMPLETED", processed, ready, needsAi, blocked, skipped, batch.batchDate);
    } catch (error) {
      this.repository.setWaveState(waveId, "FAILED", null);
      this.repository.addStateEvent("WAVE_FAILED", { batchId, waveId, details: { error: String(error) } });
      throw error;
    }
  }

  private snapshot(
    waveId: string,
    state: string,
    processed: number,
    ready: number,
    needsAi: number,
    blocked: number,
    skipped: number,
    batchDate: string,
  ): WaveSnapshot {
    const unresolved = this.repository.listUnresolved(waveId).map(({ fieldFingerprint: _fingerprint, ...field }) => field);
    const askUser = this.repository.listUserQuestions(waveId).map(({ fieldFingerprint: _fingerprint, ...field }) => field);
    this.saveUnresolvedArtifact(batchDate, waveId, unresolved, askUser);
    return { waveId, state, processed, ready, needsAi, blocked, skipped, unresolved, askUser };
  }

  private async processJob(
    context: BrowserContext,
    batchId: string,
    waveId: string,
    job: StoredJob,
  ): Promise<JobStatus> {
    const originalUrl = job.applicationUrl ?? job.sourceUrl;
    if (!originalUrl) {
      this.repository.updateJob(job.id, "BLOCKED", "No application URL is available.");
      return "BLOCKED";
    }
    this.repository.updateJob(job.id, "OPENING", "Opening retained Stage 2 tab.");
    try {
      const priorTab = this.repository.getTab(job.id);
      const recoveryUrls = priorTab ? [String(priorTab.current_url), String(priorTab.recovery_url)] : [];
      let { page } = await findOrOpenJobPage(context, job, recoveryUrls);
      page = await enterApplicationForm(page);
      const adapter = await detectAts(page);
      if (adapter.kind === "WORKDAY") {
        const detail = "Skipped automatically because the resolved employer application is hosted on Workday.";
        await this.recordTab(job, waveId, page, adapter, "WORKDAY_SKIPPED", "CLOSED", detail);
        this.repository.updateJob(job.id, "SKIPPED_WORKDAY", detail, adapter.kind);
        this.repository.addStateEvent("JOB_SKIPPED_WORKDAY", { batchId, waveId, jobId: job.id, details: { url: page.url() } });
        await page.close().catch(() => undefined);
        return "SKIPPED_WORKDAY";
      }

      const simplifyAvailable = await waitForSimplifyAutofillButton(page, this.config.simplifyDetectionTimeoutMs);
      if (simplifyAvailable) {
        this.repository.updateJob(job.id, "FILLING", "Simplify autofill is running.", adapter.kind);
        const simplify = await triggerSimplifyMultipageAutofill(page, this.config.simplifyAutofillTimeoutMs);
        const panelComplete = simplify.completed
          && !simplify.timedOut
          && simplify.panelState.completedSignal
          && !simplify.panelState.running;
        if (!panelComplete) {
          const detail = "Simplify did not reach a confirmed idle Autofill complete state; the tab was retained without running the fallback filler.";
          await this.recordTab(job, waveId, page, adapter, `SIMPLIFY_STEP_${simplify.steps.length}`, "BLOCKED", detail);
          this.repository.updateJob(job.id, "BLOCKED", detail, adapter.kind);
          return "BLOCKED";
        }

        const reviewCount = simplify.panelState.requiredReviewCount;
        const status: JobStatus = reviewCount > 0 || simplify.stopKind !== "FINAL_BOUNDARY"
          ? "PARTIAL_READY_FOR_REVIEW"
          : "READY_FOR_REVIEW";
        const detail = reviewCount > 0
          ? `Simplify completed; ${reviewCount} required field${reviewCount === 1 ? "" : "s"} need review.`
          : simplify.stopKind === "FINAL_BOUNDARY"
            ? "Simplify completed and stopped at the final submission boundary."
            : `Simplify completed; manual review is required because navigation stopped at ${simplify.stopKind}.`;
        await this.recordTab(job, waveId, page, adapter, `SIMPLIFY_STEP_${simplify.steps.length}`, status, detail);
        this.repository.updateJob(job.id, status, detail, adapter.kind);
        this.repository.addStateEvent("SIMPLIFY_COMPLETED", {
          batchId,
          waveId,
          jobId: job.id,
          details: { reviewCount, safeTransitions: simplify.safeTransitions, stopKind: simplify.stopKind },
        });
        return status;
      }

      this.repository.addStateEvent("SIMPLIFY_UNAVAILABLE_FALLBACK", {
        batchId,
        waveId,
        jobId: job.id,
        details: { url: page.url() },
      });
      await expandKnownRepeaters(page, adapter.kind, this.profile);
      await this.recordTab(job, waveId, page, adapter, "OPENED", "ACTIVE", "Opened application page");
      this.repository.updateJob(job.id, "FILLING", "Simplify was unavailable; filling empty supported fields with the internal fallback.", adapter.kind);

      for (let step = 0; step < 12; step += 1) {
        const { unresolved } = await this.fillCurrentStep(page, batchId, waveId, job, adapter.kind);
        if (unresolved.length || this.repository.jobHasPendingReview(waveId, job.id)) {
          const required = unresolved.some((field) => field.required);
          const detail = required
            ? "Required fields need structured AI or user resolution."
            : "Unresolved fields need one grouped AI or user resolution before navigation.";
          await this.recordTab(job, waveId, page, adapter, `STEP_${step + 1}`, "NEEDS_AI_REVIEW", detail);
          this.repository.updateJob(job.id, "NEEDS_AI_REVIEW", detail, adapter.kind);
          return "NEEDS_AI_REVIEW";
        }

        const decision = await guardedNavigationDecision(page, adapter.navigationHints);
        if (decision.kind === "FINAL_BOUNDARY") {
          const status: JobStatus = unresolved.length ? "PARTIAL_READY_FOR_REVIEW" : "READY_FOR_REVIEW";
          await this.recordTab(job, waveId, page, adapter, `STEP_${step + 1}`, status, decision.reason);
          this.repository.updateJob(job.id, status, decision.reason, adapter.kind);
          return status;
        }
        if (decision.kind !== "ADVANCE" || !decision.selector) {
          const status: JobStatus = unresolved.length ? "PARTIAL_READY_FOR_REVIEW" : "BLOCKED";
          await this.recordTab(job, waveId, page, adapter, `STEP_${step + 1}`, status, decision.reason);
          this.repository.updateJob(job.id, status, decision.reason, adapter.kind);
          return status;
        }

        const navigationFrame = decision.frameIndex !== undefined
          ? (page.frames()[decision.frameIndex] ?? page.mainFrame())
          : (page.frames().find((frame) => frame.url() === decision.frameUrl) ?? page.mainFrame());
        await navigationFrame.locator(decision.selector).first().click();
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
        await waitForDomSettled(page, 250, 2_500);
        await this.recordTab(job, waveId, page, adapter, `STEP_${step + 1}`, "ACTIVE", decision.reason);
      }

      this.repository.updateJob(job.id, "BLOCKED", "Stopped after 12 safe step transitions.", adapter.kind);
      return "BLOCKED";
    } catch (error) {
      this.repository.updateJob(job.id, "BLOCKED", String(error));
      this.repository.addStateEvent("JOB_ERROR", { batchId, waveId, jobId: job.id, details: { error: String(error) } });
      return "BLOCKED";
    }
  }

  private planField(
    batchId: string,
    waveId: string,
    job: StoredJob,
    field: FieldDescriptor,
  ): FieldPlanItem | undefined {
    const priorState = this.repository.unresolvedState(waveId, job.id, field.semanticId ?? field.fieldId);
    if (["SKIPPED", "RESOLVED"].includes(priorState ?? "")) return undefined;

    if (isResumeUpload(field) && fieldIsEmpty(field)) {
      const resumePath = selectResumePath(job, this.config.defaultResumePath);
      if (resumePath) return { fieldKey: fieldSemanticKey(field), field, match: { confidence: 1, evidence: [] }, kind: "UPLOAD_RESUME", resumePath };
      return this.unresolvedPlanItem(batchId, waveId, job, field, { confidence: 0, evidence: [] }, priorState, "No usable job-specific or default resume file is available.");
    }

    const match = matchField(field);
    if (isSensitiveOrManual(field)) {
      return field.required
        ? this.unresolvedPlanItem(batchId, waveId, job, field, match, priorState, "Sensitive, consent, signature, attachment, or human-only field.")
        : undefined;
    }

    const resolution = resolveField(field, match, this.profile);
    if (resolution.action && resolution.action.kind !== "skip" && valuesMatch(resolution.action.value, field.currentValue)) {
      return undefined;
    }
    if (!resolution.action && field.required) {
      return this.unresolvedPlanItem(batchId, waveId, job, field, match, priorState, resolution.reason ?? "Required field could not be deterministically validated.");
    }
    if (!fieldIsEmpty(field)) {
      if (resolution.action && resolution.action.kind !== "skip") {
        return this.unresolvedPlanItem(batchId, waveId, job, field, match, priorState, "Existing field value differs from the approved profile value; it was not overwritten.", true);
      }
      return undefined;
    }
    if (!resolution.action || resolution.action.kind === "skip") {
      return this.unresolvedPlanItem(batchId, waveId, job, field, match, priorState, resolution.reason ?? "No deterministic action available.");
    }
    return { fieldKey: fieldSemanticKey(field), field, match, kind: "ACTION", action: resolution.action };
  }

  private unresolvedPlanItem(
    batchId: string,
    waveId: string,
    job: StoredJob,
    field: FieldDescriptor,
    match: FieldMatch,
    priorState: string | undefined,
    reason: string,
    alwaysSave = false,
  ): FieldPlanItem {
    return { fieldKey: fieldSemanticKey(field), field, match, kind: "UNRESOLVED", reason, priorState, alwaysSave };
  }

  private async fillCurrentStep(
    page: Page,
    batchId: string,
    waveId: string,
    job: StoredJob,
    ats: StoredJob["ats"],
  ): Promise<{ unresolved: UncertainField[]; acted: number }> {
    const unresolved = new Map<string, UncertainField>();
    const processed = new Set<string>();
    let acted = 0;
    for (let pass = 0; pass < 200; pass += 1) {
      const model = buildFormModel(await discoverInteractiveOptions(page, await scanPage(page, { ats }), ats));
      const fields = model.fields;

      let plan: FieldPlanItem[] = [];
      for (const field of fields) {
        const fieldKey = fieldSemanticKey(field);
        if (processed.has(fieldKey) || (field.controlType !== "file" && !field.visible) || field.disabled || field.readOnly) continue;
        const item = this.planField(batchId, waveId, job, field);
        if (!item) {
          processed.add(fieldKey);
          continue;
        }
        plan.push(item);
      }

      const planIssues = [
        ...model.issues,
        ...validatePlannedTargets(plan.flatMap((item) => item.kind === "ACTION"
          ? [{ field: item.field, profileKey: item.action.profileKey }]
          : [])),
      ];
      const issueByField = new Map<string, string[]>();
      for (const issue of planIssues) {
        for (const fieldId of issue.fieldIds) {
          const messages = issueByField.get(fieldId) ?? [];
          messages.push(issue.message);
          issueByField.set(fieldId, messages);
        }
      }
      plan = plan.map((item) => {
        const messages = issueByField.get(item.field.semanticId ?? item.field.fieldId);
        if (!messages?.length || item.kind === "UNRESOLVED") return item;
        return this.unresolvedPlanItem(
          batchId,
          waveId,
          job,
          item.field,
          item.match,
          this.repository.unresolvedState(waveId, job.id, item.field.semanticId ?? item.field.fieldId),
          `Form-model validation rejected this action: ${messages.join(" ")}`,
          true,
        );
      });

      let passActions = 0;
      for (const item of plan) {
        const { field, fieldKey } = item;
        if (item.kind === "UNRESOLVED") {
          const packet = toUncertainField({ batchId, waveId, jobId: job.id, queueNumber: job.queueNumber, field, match: item.match, profile: this.profile, reason: item.reason });
          if (item.alwaysSave || item.priorState !== "ASK_USER") this.repository.saveUnresolved(packet, fieldFingerprint(field));
          unresolved.set(fieldKey, packet);
          processed.add(fieldKey);
          continue;
        }
        if (item.kind === "UPLOAD_RESUME") {
          const verification = await uploadResume(page, field, item.resumePath, ats);
          this.repository.addFieldEvent({
            jobId: job.id,
            waveId,
            fieldId: field.fieldId,
            controlType: field.controlType,
            question: field.label,
            action: "upload_resume",
            expected: redactValue(verification.expected),
            observed: redactValue(verification.observed),
            confidence: 1,
            evidence: [job.resumePath === item.resumePath ? "job-specific resume" : "configured default resume"],
            success: verification.success,
            error: verification.error,
          });
          processed.add(fieldKey);
          if (verification.success) {
            passActions += 1;
            acted += 1;
          } else {
            const packet = toUncertainField({
              batchId, waveId, jobId: job.id, queueNumber: job.queueNumber, field, match: item.match, profile: this.profile,
              reason: verification.error ?? "Resume attachment verification failed.",
            });
            this.repository.saveUnresolved(packet, fieldFingerprint(field));
            unresolved.set(fieldKey, packet);
          }
          // Uploads commonly remount or reveal controls. Rebuild the remaining plan.
          break;
        }

        const verification = await executeAction(page, field, item.action, ats);
        this.repository.addFieldEvent({
          jobId: job.id,
          waveId,
          fieldId: field.fieldId,
          profileKey: item.action.profileKey,
          controlType: field.controlType,
          question: field.label,
          action: item.action.kind,
          expected: redactValue(verification.expected),
          observed: redactValue(verification.observed),
          confidence: item.match.confidence,
          evidence: item.match.evidence,
          success: verification.success,
          error: verification.error,
        });
        if (!verification.success) {
          const packet = toUncertainField({
            batchId, waveId, jobId: job.id, queueNumber: job.queueNumber, field, match: item.match, profile: this.profile,
            reason: verification.error ?? "Post-fill verification failed.",
          });
          this.repository.saveUnresolved(packet, fieldFingerprint(field));
          unresolved.set(fieldKey, packet);
        }
        processed.add(fieldKey);
        if (verification.success) {
          passActions += 1;
          acted += 1;
        }
        // Any interaction may mutate a framework-managed form. Never execute a
        // descriptor planned against the prior DOM snapshot.
        break;
      }
      if (passActions === 0) break;
      await waitForDomSettled(page, 180, 1_800);
    }
    return { unresolved: [...unresolved.values()], acted };
  }

  private async recordTab(
    job: StoredJob,
    waveId: string,
    page: Page,
    adapter: AtsAdapter,
    formStep: string,
    tabState: string,
    lastAction: string,
  ): Promise<void> {
    this.repository.upsertTab({
      jobId: job.id,
      waveId,
      originalUrl: job.applicationUrl ?? job.sourceUrl!,
      currentUrl: page.url(),
      recoveryUrl: page.url(),
      targetId: await pageTargetId(page),
      ats: adapter.kind,
      formStep,
      checkpoint: tabState,
      tabState,
      lastAction,
    });
  }

  async applyResolutions(
    waveId: string,
    resolutions: Array<FieldResolution & { jobId?: string }>,
  ): Promise<{ applied: number; skipped: number; askUser: number; failed: number; remaining: UncertainField[] }> {
    const open = this.repository.listPendingResolutions(waveId);
    const context = await this.browserContext();
    const requestId = this.repository.createResolutionRequestId(waveId, resolutions);
    let applied = 0;
    let skipped = 0;
    let askUser = 0;
    let failed = 0;

    for (const resolution of resolutions) {
      const matches = open.filter((field) => field.fieldId === resolution.fieldId && (!resolution.jobId || field.jobId === resolution.jobId));
      if (matches.length !== 1) {
        failed += 1;
        continue;
      }
      const captured = matches[0]!;
      const page = await this.pageForJob(context, captured.jobId);
      if (!page) {
        failed += 1;
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "FAILED", error: "Retained tab not found." });
        continue;
      }
      const job = this.repository.getJob(captured.jobId);
      const ats = job?.ats;
      const currentFields = buildFormModel(await discoverInteractiveOptions(page, await scanPage(page, { ats }), ats)).fields;
      const current = currentFields.find((field) => (field.semanticId ?? field.fieldId) === captured.fieldId)
        ?? currentFields.find((field) => field.fieldId === captured.fieldId);
      if (!current || fieldFingerprint(current) !== captured.fieldFingerprint) {
        failed += 1;
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "STALE", error: "Field changed after capture." });
        continue;
      }
      const plan = planAiResolution(current, resolution);
      if (plan.kind === "ASK_USER") {
        askUser += 1;
        this.repository.closeUnresolved(waveId, captured.jobId, captured.fieldId, "ASK_USER");
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "ASK_USER" });
        continue;
      }
      if (plan.kind === "SKIP") {
        skipped += 1;
        this.repository.closeUnresolved(waveId, captured.jobId, captured.fieldId, "SKIPPED");
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "SKIPPED" });
        continue;
      }
      if (plan.kind === "REJECT") {
        failed += 1;
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "REJECTED", error: plan.error });
        continue;
      }
      const verification = await executeAction(page, current, plan.action, ats);
      if (verification.success) {
        applied += 1;
        this.repository.closeUnresolved(waveId, captured.jobId, captured.fieldId, "RESOLVED");
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "APPLIED" });
      } else {
        failed += 1;
        this.repository.addResolution({ requestId, waveId, jobId: captured.jobId, resolution, result: "FAILED", error: verification.error });
      }
    }

    const affectedJobs = [...new Set(open.filter((field) => resolutions.some((resolution) => resolution.fieldId === field.fieldId && (!resolution.jobId || resolution.jobId === field.jobId))).map((field) => field.jobId))];
    const wave = this.repository.getWave(waveId);
    if (wave) {
      const batchId = String(wave.batch_id);
      for (const jobId of affectedJobs) {
        if (this.repository.jobHasPendingReview(waveId, jobId)) continue;
        const job = this.repository.getJob(jobId);
        if (job) await this.processJob(context, batchId, waveId, job);
      }
    }
    const refreshedRemaining = this.repository.listUnresolved(waveId).map(({ fieldFingerprint: _fingerprint, ...field }) => field);
    return { applied, skipped, askUser, failed, remaining: refreshedRemaining };
  }

  private async pageForJob(context: BrowserContext, jobId: string): Promise<Page | undefined> {
    const tab = this.repository.getTab(jobId);
    if (!tab) return undefined;
    const urls = new Set([String(tab.current_url), String(tab.recovery_url)].map((value) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return value;
      }
    }));
    return context.pages().find((page) => {
      try {
        const parsed = new URL(page.url());
        parsed.hash = "";
        return urls.has(parsed.toString());
      } catch {
        return urls.has(page.url());
      }
    });
  }
}
