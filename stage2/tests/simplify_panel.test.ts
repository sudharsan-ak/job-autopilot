import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import {
  stripSimplifyTrackingParameters,
  isNavigationRaceError,
  triggerSimplifyAutofill,
  triggerSimplifyMultipageAutofill,
} from "../src/simplify/panelController.js";

test("Simplify controller recognizes only retryable navigation context errors", () => {
  assert.equal(isNavigationRaceError(new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation")), true);
  assert.equal(isNavigationRaceError(new Error("Cannot find context with specified id")), true);
  assert.equal(isNavigationRaceError(new Error("Frame was detached")), true);
  assert.equal(isNavigationRaceError(new Error("Target page, context or browser has been closed")), false);
});

test("Simplify tracking parameters are removed without disturbing required job parameters", () => {
  assert.equal(
    stripSimplifyTrackingParameters("https://job-boards.greenhouse.io/ketch/jobs/4456718009?utm_source=Simplify&gh_src=Simplify"),
    "https://job-boards.greenhouse.io/ketch/jobs/4456718009",
  );
  assert.equal(
    stripSimplifyTrackingParameters("https://job-boards.greenhouse.io/embed/job_app?token=8285182&for=coinbase&utm_source=Simplify&gh_src=Simplify"),
    "https://job-boards.greenhouse.io/embed/job_app?token=8285182&for=coinbase",
  );
});

test("Simplify controller detects the injected shadow-root button and waits for completion", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input id="candidate-name" value="">
      <div class="simplify-jobs-shadow-root"></div>
    `);
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".simplify-jobs-shadow-root")!;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="fill-button">Autofill This Page</button><div id="status"></div>';
      root.querySelector("#fill-button")!.addEventListener("click", () => {
        root.querySelector("#status")!.textContent = "Autofilling this page";
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>("#candidate-name")!;
          input.value = "Filled by Simplify";
          root.querySelector("#status")!.textContent = "Autofill complete";
        }, 100);
      });
    });

    const result = await triggerSimplifyAutofill(page, 5_000);

    assert.equal(result.buttonDetected, true);
    assert.equal(result.clicked, true);
    assert.equal(result.started, true);
    assert.equal(result.completed, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.filledControlDelta, 1);
  } finally {
    await browser.close();
  }
});

test("Simplify controller does not treat filled controls as panel completion", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <input id="candidate-name" value="">
      <div class="simplify-jobs-shadow-root"></div>
    `);
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".simplify-jobs-shadow-root")!;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="fill-button">Autofill This Page</button><div id="status"></div>';
      root.querySelector("#fill-button")!.addEventListener("click", () => {
        document.querySelector<HTMLInputElement>("#candidate-name")!.value = "Filled but still running";
        root.querySelector("#status")!.textContent = "Autofilling this page";
      });
    });

    const result = await triggerSimplifyAutofill(page, 1_500);

    assert.equal(result.filledControlDelta, 1);
    assert.equal(result.completed, false);
    assert.equal(result.timedOut, true);
  } finally {
    await browser.close();
  }
});

test("Simplify controller advances safe multipage forms and stops at submit", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main id="form-step"><label>First name<input id="first-name" required></label><button id="continue" type="button">Continue</button></main>
      <div class="simplify-jobs-shadow-root"></div>
    `);
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".simplify-jobs-shadow-root")!;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<button id="fill-button">Autofill This Page</button><div id="status"></div>';
      const status = root.querySelector<HTMLElement>("#status")!;
      root.querySelector("#fill-button")!.addEventListener("click", () => {
        status.textContent = "Autofilling this page";
        window.setTimeout(() => {
          document.querySelector<HTMLInputElement>("#first-name")!.value = "Taylor";
          status.textContent = "Autofill complete";
        }, 50);
      });
      document.querySelector("#continue")!.addEventListener("click", () => {
        document.querySelector<HTMLElement>("#form-step")!.innerHTML = `
          <label>Last name<input id="last-name" required></label>
          <button id="submit" type="submit">Submit Application</button>
        `;
        status.textContent = "Autofilling this page";
        window.setTimeout(() => {
          document.querySelector<HTMLInputElement>("#last-name")!.value = "Srinivasan";
          status.textContent = "Autofill complete";
        }, 50);
      });
    });

    const result = await triggerSimplifyMultipageAutofill(page, 10_000);

    assert.equal(result.safeTransitions, 1);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1]!.clicked, false);
    assert.equal(result.stopKind, "FINAL_BOUNDARY");
    assert.equal(result.completed, true);
    assert.equal(await page.locator("#last-name").inputValue(), "Srinivasan");
    assert.equal(await page.evaluate(() => Boolean((window as typeof window & { submitted?: boolean }).submitted)), false);
  } finally {
    await browser.close();
  }
});
