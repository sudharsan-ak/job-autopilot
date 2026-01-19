import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { waitForEnter } from "../utils/prompt";
import { autofillAshby } from "../apply/ashby";

function isTrue(v: string | undefined) {
  return (v ?? "").trim().toLowerCase() === "true";
}

function detectPlatform(url: string): "greenhouse" | "lever" | "ashby" | "unknown" {
  const u = (url ?? "").toLowerCase();
  if (u.includes("greenhouse.io")) return "greenhouse";
  if (u.includes("jobs.lever.co")) return "lever";
  if (u.includes("ashbyhq.com")) return "ashby";
  return "unknown";
}

async function clickApplyBestEffort(page: Page) {
  // Keep your broad fallbacks (these worked for you)
  const candidates = [
    "a[data-control-name='jobdetails_topcard_inapply']",
    "a[data-control-name='jobdetails_topcard_inapply-apply-button']",
    "a[data-control-name='jobdetails_topcard_inapply'] span",
    "button[data-control-name='jobdetails_topcard_inapply']",
    "a:has-text('Apply')",
    "button:has-text('Apply')"
  ];

  for (const sel of candidates) {
    const el = await page.$(sel);
    if (!el) continue;

    try {
      await el.click({ timeout: 1500 });
      await page.waitForTimeout(900);
      return true;
    } catch {}
  }
  return false;
}

async function findAtsPage(context: BrowserContext): Promise<Page | null> {
  const pages = context.pages();

  // Prefer any page that is already on ATS domains
  for (const p of pages) {
    const url = p.url();
    if (
      url.includes("ashbyhq.com") ||
      url.includes("jobs.lever.co") ||
      url.includes("greenhouse.io")
    ) {
      return p;
    }
  }

  return null;
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

  // Use a fresh LinkedIn page
  let page = await context.newPage();

  console.log(`Approved jobs: ${approved.length}`);
  console.log("Flow: open LinkedIn job -> click Apply -> switch to ATS tab -> run platform autofill -> pause.\n");

  for (const job of approved) {
    const link = job.link;
    const title = job.title || "";

    console.log("\n===============================================");
    console.log(`Opening LinkedIn job: ${title}`);
    console.log(link);
    console.log("===============================================\n");

    // If page got closed for any reason, recreate it
    if (page.isClosed()) {
      page = await context.newPage();
    }

    await page.goto(link, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Click apply on LinkedIn (your working behavior)
    const clicked = await clickApplyBestEffort(page);
    console.log(`Clicked Apply? ${clicked}`);
    console.log(`LinkedIn page URL after click: ${page.url()}`);

    // Give time for new tab to open / nav to happen
    await page.waitForTimeout(2500);

    // Switch to ATS page/tab if present
    let atsPage = await findAtsPage(context);

    if (!atsPage) {
      console.log("⚠️ Could not find an ATS tab automatically.");
      console.log("If an ATS tab opened, click that tab now.");
      await waitForEnter("➡️  After you focus the ATS tab/page, press ENTER...");
      atsPage = await findAtsPage(context);
    }

    if (!atsPage) {
      console.log("Still no ATS detected. Skipping this job.");
      await waitForEnter("Press ENTER to continue...");
      continue;
    }

    // Switch our active page to ATS
    page = atsPage;
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(1200);

    console.log(`✅ ATS URL: ${page.url()}`);
    const platform = detectPlatform(page.url());
    console.log(`Detected platform: ${platform}`);

    if (platform === "ashby") {
      console.log("➡️ Running Ashby: forcing /application + autofill...");
      await autofillAshby(page, profile);
    } else if (platform === "lever") {
      console.log("Lever detected (autofill not added yet).");
    } else if (platform === "greenhouse") {
      console.log("Greenhouse detected (autofill not added yet).");
    } else {
      console.log("Unknown ATS platform.");
    }

    await waitForEnter("➡️  Review the application, submit if ready, then press ENTER to continue...");
  }

  await browser.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});
