import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { autofillAshby } from "../apply/ashby_windows";

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
  console.log(
    "Flow: open each job in NEW tab -> (pre-check external apply href if possible) -> skip non-Ashby and close LI tab -> click Apply -> ATS tab -> autofill -> wait 2s -> continue."
  );
  console.log("Greenhouse/Lever detection kept intact for later.\n");

  for (const job of approved) {
    const link = job.link;
    const title = job.title || "";
    const company = job.company || "";

    console.log("\n===============================================");
    console.log(`Opening LinkedIn job: ${title}${company ? ` @ ${company}` : ""}`);
    console.log(link);
    console.log("===============================================\n");

    // New LI job tab
    const liPage = await context.newPage();
    await liPage.goto(link, { waitUntil: "domcontentloaded" });
    await liPage.waitForTimeout(1200);

    // ✅ Pre-check: if we can extract external apply href and it clearly isn't Ashby, skip early.
    const extHref = await extractExternalApplyHref(liPage);
    if (extHref) {
      const extLower = extHref.toLowerCase();

      // If the external apply link itself already indicates it's not Ashby, skip.
      // (Some hrefs are linkedin redirect URLs; still OK if they contain ashby somewhere)
      const looksAshby = extLower.includes("ashbyhq.com") || extLower.includes("ashby");
      if (!looksAshby) {
        console.log(`Pre-check external apply URL: ${extHref}`);
        console.log("➡️  External apply does not look like Ashby. Skipping this job and closing LinkedIn tab.\n");
        await liPage.close().catch(() => {});
        continue;
      } else {
        console.log(`Pre-check external apply URL looks like Ashby: ${extHref}`);
      }
    } else {
      console.log("Pre-check: Could not extract external apply href (button-only/Easy Apply/etc). Will click Apply and detect after.");
    }

    // Click apply and get the ATS page (popup/new tab possible)
    const atsPage = await clickApplyAndFindAtsPage(context, liPage);
    await atsPage.waitForTimeout(1500);

    const landedUrl = atsPage.url();
    const platform = detectPlatform(landedUrl);

    console.log(`Landed on: ${landedUrl}`);
    console.log(`Detected platform: ${platform}`);

    // ✅ If it is not Ashby, close the LinkedIn tab as requested.
    // (Keep ATS tab open only for Ashby; for others, we may keep for later, but user asked to skip non-ashby.)
    if (platform !== "ashby") {
      console.log("➡️  Not Ashby. Skipping this job.");
      await liPage.close().catch(() => {});

      // Leave ATS tab behavior unchanged for now:
      // - If ATS opened in a new tab and it's not Ashby, we can optionally close it too.
      // You asked specifically to close the LinkedIn job tab; leaving ATS tab open can clutter.
      // We'll close ATS tab too if it's not the same as LinkedIn page.
      if (atsPage !== liPage) {
        await atsPage.close().catch(() => {});
      }

      await liPage.waitForTimeout(0).catch(() => {});
      continue;
    }

    // ✅ Ashby: run autofill
    console.log("Running Ashby autofill...");
    await autofillAshby(atsPage, profile);

    // Step 2 requirement: wait 2 seconds then proceed
    await atsPage.waitForTimeout(2000);
    console.log("✅ Finished this job (left Ashby tab open). Moving to next...\n");

    // You did NOT ask to close LI tab when Ashby is reached; you only asked to not close previous tabs.
    // We'll keep LI tab open too. If you want LI tab closed even for Ashby, say so.
  }

  console.log("✅ All jobs processed for Ashby-only flow (tabs left open).");
  // Not closing browser; later steps will refine.
}

main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});
