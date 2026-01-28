import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { autofillAshby } from "../apply/ashby_windows";
import { autofillGreenhouse } from "../apply/greenhouse";
import { autofillLever } from "../apply/lever";

function isTrue(v: string | undefined) {
  return (v ?? "").trim().toLowerCase() === "true";
}

function detectPlatform(url: string): "greenhouse" | "lever" | "ashby" | "unknown" {
  const u = url.toLowerCase();
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("jobs.lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  return "unknown";
}

// Keep candidates broad but still oriented around LinkedIn apply UI.
const APPLY_CANDIDATES = [
  // External apply anchor on top card
  "a[data-control-name='jobdetails_topcard_inapply']",
  "a[data-control-name='jobdetails_topcard_inapply-apply-button']",
  "a[data-control-name='jobdetails_topcard_inapply_apply_button']",
  // External apply sometimes in other areas
  "a.jobs-apply-button",
  // Button variants (may not have href)
  "button[data-control-name='jobdetails_topcard_inapply']",
  "button.jobs-apply-button",
  // last resort (can match Easy Apply too)
  "a:has-text('Apply')",
  "button:has-text('Apply')"
] as const;

/**
 * Best-effort: extract an external apply href without clicking.
 * Returns:
 * - string URL if we can find an anchor href that looks external
 * - null if we can't determine (button-only, SPA, easy apply, etc.)
 */
async function extractExternalApplyHref(liPage: Page): Promise<string | null> {
  for (const sel of APPLY_CANDIDATES) {
    const loc = liPage.locator(sel).first();
    try {
      if (!(await loc.isVisible({ timeout: 900 }))) continue;

      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (tag !== "a") continue;

      const href = await loc.getAttribute("href");
      if (!href) continue;

      // Normalize relative href
      const abs = new URL(href, liPage.url()).toString();

      // Heuristic: External apply often redirects out of LinkedIn
      // (Could still be linkedin.com redirect URL, that's OK; we can check if it contains ashby)
      return abs;
    } catch {
      // try next
    }
  }
  return null;
}

async function clickApplyBestEffort(liPage: Page): Promise<boolean> {
  for (const sel of APPLY_CANDIDATES) {
    const loc = liPage.locator(sel).first();
    try {
      if (!(await loc.isVisible({ timeout: 900 }))) continue;
      await loc.click({ timeout: 2500 });
      return true;
    } catch {
      // keep trying
    }
  }
  return false;
}

/**
 * After clicking Apply, LinkedIn often opens ATS in a NEW TAB.
 * This helper returns the page that likely contains the ATS.
 */
async function clickApplyAndFindAtsPage(context: BrowserContext, liPage: Page): Promise<Page> {
  const before = liPage.url();

  // Watch for a new tab after click
  const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);

  const clicked = await clickApplyBestEffort(liPage);
  if (!clicked) return liPage;

  // If a popup opened, use it
  const popup = await popupPromise;
  if (popup) {
    try {
      await popup.waitForLoadState("domcontentloaded", { timeout: 12000 });
    } catch {}
    return popup;
  }

  // Otherwise, maybe same-tab navigation. Wait a bit.
  try {
    await liPage.waitForTimeout(800);
    await liPage.waitForFunction((prev) => window.location.href !== prev, before, { timeout: 6000 });
  } catch {
    // could still be SPA/no URL change
  }

  return liPage;
}

function setupControls() {
  let paused = false;
  let stopped = false;
  let inputLocked = false;
  let pauseMessageShown = false;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  process.stdin.on("keypress", (_str, key) => {
    if (inputLocked) return;
    if (key?.name === "c" && key.ctrl) {
      stopped = true;
      return;
    }

    if (key?.name === "return") {
      paused = !paused;
      if (paused) {
        console.log("⏸️  Pause requested. Will pause after current step.");
        pauseMessageShown = false;
      } else {
        console.log("▶️  Resumed.");
      }
      return;
    }

    const name = (key?.name || "").toLowerCase();
    if (name === "p") {
      paused = true;
      console.log("⏸️  Pause requested. Will pause after current step.");
      pauseMessageShown = false;
    } else if (name === "r") {
      paused = false;
      console.log("▶️  Resumed.");
    } else if (name === "s" || name === "q") {
      stopped = true;
      console.log("🛑 Stop requested. Finishing current step...");
      inputLocked = true;
    }
  });

  const waitIfPaused = async () => {
    while (paused && !stopped) {
      if (!pauseMessageShown) {
        console.log("⏸️  Paused. Press Enter or 'r' to resume, or 's' to stop.");
        pauseMessageShown = true;
      }
      await new Promise((res) => setTimeout(res, 300));
    }
  };

  return {
    waitIfPaused,
    isStopped: () => stopped,
    lockInput: () => {
      inputLocked = true;
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }
  };
}

type UnknownJob = { id: string; link: string };

function readUnknownLinks(filePath: string): UnknownJob[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/export const unknownJobs\\s*=\\s*(\\[[\\s\\S]*\\]);/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => v as Partial<UnknownJob>)
        .filter((v) => typeof v.link === "string")
        .map((v) => ({ id: String(v.id ?? ""), link: String(v.link) }));
    }
  } catch {}
  return [];
}

function mergeUnknownLinks(existing: UnknownJob[], incoming: UnknownJob[]): UnknownJob[] {
  const seen = new Set(existing.map((v) => v.link));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.link)) {
      seen.add(item.link);
      merged.push(item);
    }
  }
  return merged;
}

async function main() {
  const profile = loadProfile();
  let ashbyCount = 0;
  let greenhouseCount = 0;
  let leverCount = 0;
  const unknownLinks: UnknownJob[] = [];

  const jobsPath = path.join(process.cwd(), "data", "jobs.csv");
  if (!fs.existsSync(jobsPath)) throw new Error(`Missing CSV: ${jobsPath}`);

  const rows = readCsv(jobsPath);
  const approved = rows.filter((r) => isTrue(r.approved));

  if (approved.length === 0) {
    console.log("No approved jobs found. Open data/jobs.csv and set approved=true for a few rows.");
    process.exit(0);
  }

  const combinedPath = path.join(process.cwd(), "storage", "combined.json");
  const storagePath = fs.existsSync(combinedPath)
    ? combinedPath
    : path.join(process.cwd(), "storage", "linkedin.json");
  if (!fs.existsSync(storagePath)) {
    throw new Error(`LinkedIn session not found. Run: npm run auth:linkedin`);
  }

  const browser = await chromium.launch({ headless: false, slowMo: 25 });
  const context = await browser.newContext({ storageState: storagePath });

  console.log(`Approved jobs: ${approved.length}`);
  console.log("Controls: Enter or 'p' to pause/resume, 'r' to resume, 's' or 'q' to stop.\n");

  const controls = setupControls();
  console.log(
    "Flow: open each job in NEW tab -> (pre-check external apply href if possible) -> skip non-Ashby/Greenhouse/Lever and close LI tab -> click Apply -> ATS tab -> autofill -> wait 2s -> continue."
  );
  console.log("Greenhouse/Lever detection kept intact for later.\n");

  for (const job of approved) {
    if (controls.isStopped()) break;
    await controls.waitIfPaused();

    const link = job.link;
    const title = job.title || "";
    const company = job.company || "";
    const jobId = job.id || "";

    console.log("\n===============================================");
    const label = jobId ? `${jobId}. ${title}` : title;
    console.log(`Opening LinkedIn job: ${label}${company ? ` @ ${company}` : ""}`);
    console.log(link);
    console.log("===============================================\n");

    // New LI job tab
    const liPage = await context.newPage();
    await liPage.goto(link, { waitUntil: "domcontentloaded" });
    await liPage.waitForTimeout(1200);
    if (controls.isStopped()) break;
    await controls.waitIfPaused();

    // ✅ Pre-check: if we can extract external apply href and it clearly isn't Ashby, skip early.
    /*
    const extHref = await extractExternalApplyHref(liPage);
    if (extHref) {
      const extLower = extHref.toLowerCase();

      // If the external apply link itself already indicates it's not Ashby, skip.
      // (Some hrefs are linkedin redirect URLs; still OK if they contain ashby somewhere)
      const looksAshby = extLower.includes("ashbyhq.com") || extLower.includes("ashby");
      const looksGreenhouse = extLower.includes("greenhouse.io") || extLower.includes("greenhouse");
      const looksLever = extLower.includes("jobs.lever.co") || extLower.includes("lever.co");
      if (!looksAshby && !looksGreenhouse && !looksLever) {
        console.log(`Pre-check external apply URL: ${extHref}`);
        console.log("➡️  External apply does not look like Ashby/Greenhouse/Lever. Skipping this job and closing LinkedIn tab.\n");
        continue;
      } else {
        console.log(`Pre-check external apply URL looks like Ashby/Greenhouse/Lever: ${extHref}`);
      }
    } else {
      console.log("Pre-check: Could not extract external apply href (button-only/Easy Apply/etc). Will click Apply and detect after.");
    }

    */
    // Click apply and get the ATS page (popup/new tab possible)
    const atsPage = await clickApplyAndFindAtsPage(context, liPage);
    await atsPage.waitForTimeout(1500);
    if (controls.isStopped()) break;
    await controls.waitIfPaused();

    const landedUrl = atsPage.url();
    const platform = detectPlatform(landedUrl);

    console.log(`Landed on: ${landedUrl}`);
    console.log(`Detected platform: ${platform}`);

    // ✅ If it is not Ashby/Greenhouse/Lever, skip but keep the LinkedIn tab open.
    // (Keep ATS tab open only for Ashby; for others, we may keep for later, but user asked to skip non-ashby.)
    if (platform !== "ashby" && platform !== "greenhouse" && platform !== "lever") {
      console.log("Not Ashby/Greenhouse/Lever. Skipping this job.");
      unknownLinks.push({ id: jobId || "", link });
      if (atsPage !== liPage) {
        await atsPage.close().catch(() => {});
      }
      await liPage.close().catch(() => {});
      continue;
    }

    if (platform === "ashby") {
      console.log("Running Ashby autofill...");
      await autofillAshby(atsPage, profile);
      ashbyCount += 1;
    } else if (platform === "greenhouse") {
      console.log("Running Greenhouse autofill...");
      await autofillGreenhouse(atsPage, profile);
      greenhouseCount += 1;
    } else {
      console.log("Running Lever autofill...");
      await autofillLever(atsPage, profile);
      leverCount += 1;
    }

    // Step 2 requirement: wait 2 seconds then proceed
    await atsPage.waitForTimeout(2000);
    if (!liPage.isClosed() && liPage !== atsPage) {
      await liPage.close().catch(() => {});
    }
    console.log("✅ Finished this job (left ATS tab open). Moving to next...\n");

    if (controls.isStopped()) break;
    await controls.waitIfPaused();

  }

  console.log("✅ All jobs processed for Ashby/Greenhouse/Lever flow (tabs left open).");
  console.log(`Ashby opened: ${ashbyCount} | Greenhouse opened: ${greenhouseCount} | Lever opened: ${leverCount}`);
  const unknownOutPath = path.join(process.cwd(), "unknownJobs.js");
  const existingUnknown = readUnknownLinks(unknownOutPath);
  const mergedUnknown = mergeUnknownLinks(existingUnknown, unknownLinks);
  const unknownLines = mergedUnknown.map((item) => JSON.stringify(item)).join(",\n");
  const unknownPayload = `export const unknownJobs = [\n${unknownLines}\n];\n`;
  fs.writeFileSync(unknownOutPath, unknownPayload, "utf-8");
  console.log(`${mergedUnknown.length} Unknown job links saved to: ${unknownOutPath}`);
  controls.lockInput();
  // Not closing browser; later steps will refine.
}
main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});



