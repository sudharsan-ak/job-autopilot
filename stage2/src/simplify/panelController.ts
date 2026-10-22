import type { Page } from "playwright";
import { detectAts } from "../ats/detector.js";
import { waitForDomSettled } from "../forms/fieldRuntime.js";
import { decideNavigation } from "../forms/navigationGuard.js";

const PANEL_HOST_SELECTOR = ".simplify-jobs-shadow-root";
const AUTOFILL_BUTTON_SELECTOR = "#fill-button";

export interface SimplifyPanelState {
  hostCount: number;
  buttonFound: boolean;
  buttonVisible: boolean;
  buttonEnabled: boolean;
  running: boolean;
  completedSignal: boolean;
  requiredReviewCount: number;
}

export interface SimplifyAutofillResult {
  buttonDetected: boolean;
  clicked: boolean;
  started: boolean;
  completed: boolean;
  timedOut: boolean;
  initialUrl: string;
  finalUrl: string;
  beforeFilledControls: number;
  afterFilledControls: number;
  filledControlDelta: number;
  trackingUrlCleaned: boolean;
  reloadPerformed: boolean;
  cleanedUrl?: string;
  panelState: SimplifyPanelState;
}

export interface SimplifyMultipageResult extends SimplifyAutofillResult {
  steps: SimplifyAutofillResult[];
  safeTransitions: number;
  stopKind: "FINAL_BOUNDARY" | "BLOCKED" | "WAIT" | "SIMPLIFY_TIMEOUT" | "MAX_STEPS";
  stopReason: string;
}

export function stripSimplifyTrackingParameters(value: string): string {
  const url = new URL(value);
  for (const key of ["utm_source", "gh_src"]) {
    const parameterValue = url.searchParams.get(key);
    if (parameterValue?.toLowerCase() === "simplify") url.searchParams.delete(key);
  }
  return url.toString();
}

export function isNavigationRaceError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("execution context was destroyed")
    || message.includes("cannot find context with specified id")
    || message.includes("cannot find context with id")
    || message.includes("frame was detached");
}

async function retryAcrossNavigation<T>(page: Page, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isNavigationRaceError(error)) throw error;
      lastError = error;
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(200);
    }
  }
  throw lastError;
}

async function inspectPanel(page: Page): Promise<SimplifyPanelState> {
  return retryAcrossNavigation(page, () => page.evaluate(({ hostSelector, buttonSelector }) => {
    const hosts = [...document.querySelectorAll<HTMLElement>(hostSelector)];
    const roots = hosts
      .map((host) => host.shadowRoot)
      .filter((root): root is ShadowRoot => Boolean(root));
    const button = roots
      .map((root) => root.querySelector<HTMLButtonElement>(buttonSelector))
      .find((candidate): candidate is HTMLButtonElement => Boolean(candidate));
    const panelText = roots.map((root) => root.textContent ?? "").join(" ");
    const reviewCounts = [...panelText.matchAll(/(\d+)\s+required fields?\s+need review/gi)]
      .map((match) => Number(match[1]));

    return {
      hostCount: hosts.length,
      buttonFound: Boolean(button),
      buttonVisible: Boolean(button && button.getClientRects().length > 0),
      buttonEnabled: Boolean(button && !button.disabled),
      running: /autofill is still running|autofilling this page|detecting questions|generating answers/i.test(panelText),
      completedSignal: /autofill complete|finished autofilling|autofill finished/i.test(panelText),
      requiredReviewCount: reviewCounts.length ? Math.max(...reviewCounts) : 0,
    };
  }, {
    hostSelector: PANEL_HOST_SELECTOR,
    buttonSelector: AUTOFILL_BUTTON_SELECTOR,
  }));
}

export async function waitForSimplifyAutofillButton(page: Page, timeoutMs: number): Promise<boolean> {
  return page.locator(AUTOFILL_BUTTON_SELECTOR).first()
    .waitFor({ state: "visible", timeout: timeoutMs })
    .then(() => true)
    .catch(() => false);
}

async function countFilledControls(page: Page): Promise<number> {
  return retryAcrossNavigation(page, async () => {
    const counts = await Promise.all(page.frames().map((frame) => frame.evaluate(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input:not([type='hidden']), textarea, select",
    )].filter((control) => {
      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) return control.checked;
      if (control instanceof HTMLInputElement && control.type === "file") return (control.files?.length ?? 0) > 0;
      return control.value.trim().length > 0;
    }).length)));
    return counts.reduce((total, count) => total + count, 0);
  });
}

export async function triggerSimplifyAutofill(page: Page, timeoutMs: number): Promise<SimplifyAutofillResult> {
  const initialUrl = page.url();
  const startedAt = Date.now();
  const detectionTimeout = Math.min(timeoutMs, 30_000);
  const button = page.locator(AUTOFILL_BUTTON_SELECTOR).first();

  await button.waitFor({ state: "visible", timeout: detectionTimeout });
  const beforeFilledControls = await countFilledControls(page);
  const beforePanelState = await inspectPanel(page);
  if (!beforePanelState.buttonEnabled) throw new Error("Simplify Autofill button is visible but disabled.");

  await button.click({ timeout: 5_000 });

  let state = await inspectPanel(page);
  let afterFilledControls = beforeFilledControls;
  let sawRunning = state.running;
  let sawActivity = state.running || state.completedSignal;
  let triggerObserved = sawActivity;
  let completedSignalSamples = 0;
  let completed = false;
  let trackingUrlCleaned = false;
  let reloadPerformed = false;
  let cleanedUrl: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    const currentUrl = page.url();
    const cleanCurrentUrl = stripSimplifyTrackingParameters(currentUrl);
    if (!trackingUrlCleaned && cleanCurrentUrl !== currentUrl) {
      triggerObserved = true;
      trackingUrlCleaned = true;
      reloadPerformed = true;
      cleanedUrl = cleanCurrentUrl;
      await page.goto(cleanCurrentUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      state = await inspectPanel(page);
      afterFilledControls = await countFilledControls(page);
      sawRunning = state.running;
      sawActivity = state.running || state.completedSignal || afterFilledControls > beforeFilledControls;
      completedSignalSamples = 0;
      continue;
    }

    state = await inspectPanel(page);
    afterFilledControls = await countFilledControls(page);
    sawRunning ||= state.running;
    sawActivity ||= state.running
      || state.completedSignal
      || afterFilledControls > beforeFilledControls
      || page.url() !== initialUrl;

    completedSignalSamples = state.completedSignal && !state.running
      ? completedSignalSamples + 1
      : 0;
    if (completedSignalSamples >= 2 && stripSimplifyTrackingParameters(page.url()) === page.url()) {
      completed = true;
      break;
    }
  }

  return {
    buttonDetected: true,
    clicked: true,
    started: triggerObserved || sawActivity,
    completed,
    timedOut: !completed,
    initialUrl,
    finalUrl: page.url(),
    beforeFilledControls,
    afterFilledControls,
    filledControlDelta: afterFilledControls - beforeFilledControls,
    trackingUrlCleaned,
    reloadPerformed,
    cleanedUrl,
    panelState: state,
  };
}

async function observeContinuousSimplifyAutofill(page: Page, timeoutMs: number): Promise<SimplifyAutofillResult> {
  const initialUrl = page.url();
  const startedAt = Date.now();
  const beforeFilledControls = await countFilledControls(page);
  let state = await inspectPanel(page);
  let afterFilledControls = beforeFilledControls;
  let sawRunning = state.running;
  let sawActivity = state.running || state.completedSignal || beforeFilledControls > 0;
  let completedSignalSamples = 0;
  let completed = false;
  let trackingUrlCleaned = false;
  let reloadPerformed = false;
  let cleanedUrl: string | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    const currentUrl = page.url();
    const cleanCurrentUrl = stripSimplifyTrackingParameters(currentUrl);
    if (!trackingUrlCleaned && cleanCurrentUrl !== currentUrl) {
      trackingUrlCleaned = true;
      reloadPerformed = true;
      cleanedUrl = cleanCurrentUrl;
      await page.goto(cleanCurrentUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      state = await inspectPanel(page);
      afterFilledControls = await countFilledControls(page);
      sawRunning ||= state.running;
      sawActivity ||= state.running || state.completedSignal || afterFilledControls > 0;
      completedSignalSamples = 0;
      continue;
    }

    state = await inspectPanel(page);
    afterFilledControls = await countFilledControls(page);
    sawRunning ||= state.running;
    sawActivity ||= state.running || state.completedSignal || afterFilledControls !== beforeFilledControls;

    completedSignalSamples = state.completedSignal && !state.running
      ? completedSignalSamples + 1
      : 0;
    if (sawRunning && completedSignalSamples >= 2 && stripSimplifyTrackingParameters(page.url()) === page.url()) {
      completed = true;
      break;
    }
  }

  return {
    buttonDetected: state.buttonFound,
    clicked: false,
    started: sawActivity,
    completed,
    timedOut: !completed,
    initialUrl,
    finalUrl: page.url(),
    beforeFilledControls,
    afterFilledControls,
    filledControlDelta: afterFilledControls - beforeFilledControls,
    trackingUrlCleaned,
    reloadPerformed,
    cleanedUrl,
    panelState: state,
  };
}

export async function triggerSimplifyMultipageAutofill(
  page: Page,
  timeoutMs: number,
  maxSteps = 12,
): Promise<SimplifyMultipageResult> {
  const deadline = Date.now() + timeoutMs;
  const initial = await triggerSimplifyAutofill(page, timeoutMs);
  const steps = [initial];
  let safeTransitions = 0;
  let stopKind: SimplifyMultipageResult["stopKind"] = initial.completed ? "WAIT" : "SIMPLIFY_TIMEOUT";
  let stopReason = initial.completed
    ? "Simplify completed the current page; checking for a safe next step."
    : "Simplify did not finish the initial page before the timeout.";

  while (initial.completed && safeTransitions < maxSteps) {
    const adapter = await retryAcrossNavigation(page, () => detectAts(page));
    const decision = await retryAcrossNavigation(page, () => decideNavigation(page, adapter.navigationHints));
    if (decision.kind !== "ADVANCE") {
      stopKind = decision.kind;
      stopReason = decision.reason;
      break;
    }
    if (!decision.selector) {
      stopKind = "WAIT";
      stopReason = "A safe transition was detected without an actionable selector.";
      break;
    }

    const frame = decision.frameIndex !== undefined
      ? (page.frames()[decision.frameIndex] ?? page.mainFrame())
      : (page.frames().find((candidate) => candidate.url() === decision.frameUrl) ?? page.mainFrame());
    await frame.locator(decision.selector).first().click({ timeout: 5_000 });
    safeTransitions += 1;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      stopKind = "SIMPLIFY_TIMEOUT";
      stopReason = "The multipage Simplify workflow reached its overall timeout.";
      break;
    }
    const stepResult = await observeContinuousSimplifyAutofill(page, Math.min(remaining, 45_000));
    steps.push(stepResult);
    if (!stepResult.completed) {
      stopKind = "SIMPLIFY_TIMEOUT";
      stopReason = "Simplify did not automatically finish the next page after the safe transition.";
      break;
    }
    await waitForDomSettled(page, 250, 2_500);
  }

  if (safeTransitions >= maxSteps && stopKind === "WAIT") {
    stopKind = "MAX_STEPS";
    stopReason = `Stopped after ${maxSteps} safe step transitions.`;
  }

  const last = steps.at(-1) ?? initial;
  return {
    ...initial,
    completed: steps.every((step) => step.completed),
    timedOut: steps.some((step) => step.timedOut),
    finalUrl: page.url(),
    afterFilledControls: last.afterFilledControls,
    filledControlDelta: steps.reduce((total, step) => total + step.filledControlDelta, 0),
    trackingUrlCleaned: steps.some((step) => step.trackingUrlCleaned),
    reloadPerformed: steps.some((step) => step.reloadPerformed),
    cleanedUrl: [...steps].reverse().find((step) => step.cleanedUrl)?.cleanedUrl,
    panelState: last.panelState,
    steps,
    safeTransitions,
    stopKind,
    stopReason,
  };
}
