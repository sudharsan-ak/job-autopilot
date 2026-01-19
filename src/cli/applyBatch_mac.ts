import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { autofillAshby } from "../apply/ashby_mac";

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
  const isMac = os.platform() === "darwin";
  
  console.log("🔍 Looking for Apply button...");
  
  // Wait for page to load
  await page.waitForTimeout(isMac ? 2000 : 1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  
  // Simple: Use JavaScript to find and click - it was working before
  const clicked = await page.evaluate(() => {
    // First try: Find in job title area (most likely)
    const topCard = document.querySelector('.jobs-details-top-card, [data-test-id="job-details"]');
    if (topCard) {
      const applyBtn = topCard.querySelector('button.jobs-apply-button, a.jobs-apply-button, button[data-control-name="jobdetails_topcard_inapply"], a[data-control-name="jobdetails_topcard_inapply"]') as HTMLElement;
      if (applyBtn) {
        const href = applyBtn.getAttribute('href') || '';
        if (!href.includes('similar-jobs') && !href.includes('collections')) {
          applyBtn.style.display = 'block';
          applyBtn.style.visibility = 'visible';
          applyBtn.click();
          return true;
        }
      }
    }
    
    // Fallback: Find any Apply button that's not similar jobs
    const allButtons = Array.from(document.querySelectorAll('button, a'));
    for (const btn of allButtons) {
      const text = (btn.textContent || '').toLowerCase();
      const href = (btn as HTMLElement).getAttribute('href') || '';
      
      if (text.includes('apply') && !href.includes('similar-jobs') && !href.includes('collections')) {
        // Prefer buttons with jobs-apply-button class
        if ((btn as HTMLElement).classList.contains('jobs-apply-button') || 
            (btn as HTMLElement).getAttribute('data-control-name')?.includes('apply')) {
          (btn as HTMLElement).style.display = 'block';
          (btn as HTMLElement).style.visibility = 'visible';
          (btn as HTMLElement).click();
          return true;
        }
      }
    }
    
    // Last resort: Any Apply button
    for (const btn of allButtons) {
      const text = (btn.textContent || '').toLowerCase();
      const href = (btn as HTMLElement).getAttribute('href') || '';
      if (text.includes('apply') && !href.includes('similar-jobs') && !href.includes('collections')) {
        (btn as HTMLElement).style.display = 'block';
        (btn as HTMLElement).style.visibility = 'visible';
        (btn as HTMLElement).click();
        return true;
      }
    }
    
    return false;
  });
  
  if (clicked) {
    await page.waitForTimeout(1000);
    console.log("✅ Successfully clicked Apply button");
    return true;
  }
  
  console.log("❌ Could not find Apply button");
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

    // If not ATS, close tabs and skip
    if (platform === "unknown") {
      console.log("Not on Greenhouse/Lever/Ashby yet. Closing tabs and skipping this job.\n");
      try {
        if (!atsPage.isClosed() && atsPage !== liPage) {
          await atsPage.close();
        }
      } catch {}
      try {
        if (!liPage.isClosed()) {
          await liPage.close();
        }
      } catch {}
      continue;
    }

    // ✅ This should now log correctly when ATS page is Ashby
    if (platform === "ashby") {
      console.log("Running Ashby autofill...");
      await autofillAshby(atsPage, profile);
      // ✅ Step 2: wait 2 seconds then proceed (keep tabs open for Ashby)
      await atsPage.waitForTimeout(2000);
      console.log("✅ Finished this job (left tabs open). Moving to next...\n");
    } else {
      // For non-Ashby platforms (lever, greenhouse), close both tabs
      console.log(`${platform === "lever" ? "Lever" : "Greenhouse"} detected (autofill not added yet). Closing tabs.\n`);
      try {
        if (!atsPage.isClosed() && atsPage !== liPage) {
          await atsPage.close();
          console.log("  → Closed ATS tab");
        }
      } catch {}
      try {
        if (!liPage.isClosed()) {
          await liPage.close();
          console.log("  → Closed LinkedIn job tab");
        }
      } catch {}
      console.log("✅ Closed tabs and moving to next job...\n");
    }
  }

  console.log("✅ Step 2 complete: processed all approved jobs (tabs left open).");
  // Not closing browser in Step 2 yet. Step 3 will finalize "keep open".
}

main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});
