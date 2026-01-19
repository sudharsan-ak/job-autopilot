import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { autofillAshby } from "../apply/ashby";

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

async function tryClickExternalApply(page: Page) {
  // Prefer external apply on LinkedIn job page (best-effort)
  const candidates = [
    "a[data-control-name='jobdetails_topcard_inapply']",
    "a[data-control-name='jobdetails_topcard_inapply-apply-button']",
    "a[data-control-name='jobdetails_topcard_inapply'] span",
    "button[data-control-name='jobdetails_topcard_inapply']",
    "button.jobs-apply-button",
    "a.jobs-apply-button",
    "a:has-text('Apply')",
    "button:has-text('Apply')"
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      if (!(await loc.isVisible({ timeout: 1200 }))) continue;
      await loc.click({ timeout: 2500 });
      return true;
    } catch {
      // keep trying
    }
  }
  return false;
}

/**
 * ✅ Step-2 critical fix:
 * After clicking Apply, LinkedIn often opens ATS in a NEW TAB.
 * This helper returns the page that likely contains the ATS.
 */
async function clickApplyAndFindAtsPage(context: BrowserContext, liPage: Page): Promise<Page> {
  const before = liPage.url();

  // Watch for a new tab after click
  const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);

  const clicked = await tryClickExternalApply(liPage);

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
    await liPage.waitForFunction(
      (prev) => window.location.href !== prev,
      before,
      { timeout: 6000 }
    );
  } catch {
    // could still be SPA/no URL change
  }

  return liPage;
}

async function main() {
  const profile = loadProfile();

  const jobsPath = path.join(process.cwd(), "data", "jobs.csv");
  if (!fs.existsSync(jobsPath)) throw new Error(`Missing CSV: ${jobsPath}`);

  const rows = readCsv(jobsPath);
  const approved = rows.filter((r) => isTrue(r.approved));

  if (approved.length === 0) {
    console.log("No approved jobs found. Open data/jobs.csv and set approved=true for a few rows.");
    process.exit(0);
  }

  const storagePath = path.join(process.cwd(), "storage", "linkedin.json");
  if (!fs.existsSync(storagePath)) {
    throw new Error(`LinkedIn session not found. Run: npm run auth:linkedin`);
  }

  const browser = await chromium.launch({ headless: false, slowMo: 25 });
  const context = await browser.newContext({ storageState: storagePath });

  console.log(`Approved jobs: ${approved.length}`);
  console.log("Step 2 flow: open each job in a NEW TAB -> click Apply -> switch to ATS tab if it opens -> autofill -> wait 2s -> continue.");
  console.log("NOTE: We DO NOT close previous tabs.\n");

  for (const job of approved) {
    const link = job.link;
    const title = job.title || "";
    const company = job.company || "";

    console.log("\n===============================================");
    console.log(`Opening LinkedIn job: ${title}${company ? ` @ ${company}` : ""}`);
    console.log(link);
    console.log("===============================================\n");

    // ✅ NEW TAB for the LinkedIn job (keeps previous app tabs open)
    const liPage = await context.newPage();

    await liPage.goto(link, { waitUntil: "domcontentloaded" });
    await liPage.waitForTimeout(1500);

    // ✅ Click apply and get the ATS page (could be popup/new tab)
    const atsPage = await clickApplyAndFindAtsPage(context, liPage);

    // Let the ATS page settle
    await atsPage.waitForTimeout(1500);

    const landedUrl = atsPage.url();
    const platform = detectPlatform(landedUrl);

    console.log(`Landed on: ${landedUrl}`);
    console.log(`Detected platform: ${platform}`);

    // If not ATS, skip (Step 2 behavior)
    if (platform === "unknown") {
      console.log("Not on Greenhouse/Lever/Ashby yet. Skipping this job.\n");
      await atsPage.waitForTimeout(2000);
      continue;
    }

    // ✅ This should now log correctly when ATS page is Ashby
    if (platform === "ashby") {
      console.log("Running Ashby autofill...");
      await autofillAshby(atsPage, profile);
    } else if (platform === "lever") {
      console.log("Lever detected (autofill not added yet). Skipping autofill.");
    } else if (platform === "greenhouse") {
      console.log("Greenhouse detected (autofill not added yet). Skipping autofill.");
    }

    // ✅ Step 2: wait 2 seconds then proceed
    await atsPage.waitForTimeout(2000);
    console.log("✅ Finished this job (left tabs open). Moving to next...\n");
  }

  console.log("✅ Step 2 complete: processed all approved jobs (tabs left open).");
  // Not closing browser in Step 2 yet. Step 3 will finalize "keep open".
}

main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});
