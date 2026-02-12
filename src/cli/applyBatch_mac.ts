import { chromium, Page, BrowserContext } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import { loadProfile } from "../utils/config";
import { readCsv } from "../utils/csv";
import { autofillAshby } from "../apply/ashby_mac";
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
async function clickApplyAndFindAtsPage(context: BrowserContext, liPage: Page): Promise<Page | null> {
  const before = liPage.url();

  // Watch for a new tab after click
  const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);

  const clicked = await tryClickExternalApply(liPage);

  if (!clicked) return null;

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

type UnknownJob = { id: string; role?: string; company?: string; link: string };

function readUnknownLinks(filePath: string): UnknownJob[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/export const unknownJobs\s*=\s*(\[[\s\S]*\]);/);
  if (!match) return [];

  const jsonLike = match[1].replace(/,\s*]/g, "]");
  try {
    const parsed = JSON.parse(jsonLike) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((v) => v as Partial<UnknownJob>)
        .filter((v) => typeof v.link === "string")
        .map((v) => ({
          id: String(v.id ?? ""),
          role: v.role ? String(v.role) : undefined,
          company: v.company ? String(v.company) : undefined,
          link: String(v.link)
        }));
    }
  } catch {}

  const lines = raw.split(/\r?\n/);
  const jobs: UnknownJob[] = [];
  for (const line of lines) {
    const idMatch = line.match(/"id"\s*:\s*"([^"]+)"/);
    const roleMatch = line.match(/"role"\s*:\s*"([^"]+)"/);
    const companyMatch = line.match(/"company"\s*:\s*"([^"]+)"/);
    const linkMatch = line.match(/"link"\s*:\s*"([^"]+)"/);
    if (linkMatch) {
      jobs.push({ id: idMatch?.[1] ?? "", role: roleMatch?.[1], company: companyMatch?.[1], link: linkMatch[1] });
    }
  }
  return jobs;
}

function mergeUnknownLinks(existing: UnknownJob[], incoming: UnknownJob[]): UnknownJob[] {
  const byLink = new Map(existing.map((v) => [v.link, v]));
  for (const item of incoming) {
    const current = byLink.get(item.link);
    if (!current) {
      byLink.set(item.link, item);
      continue;
    }
    if (!current.role && item.role) {
      current.role = item.role;
    }
    if (!current.company && item.company) {
      current.company = item.company;
    }
  }
  return Array.from(byLink.values());
}

function writeUnknownLinks(filePath: string, jobs: UnknownJob[]) {
  const unknownLines = jobs.map((item) => JSON.stringify(item)).join(",\n");
  const unknownPayload = `export const unknownJobs = [\n${unknownLines}\n];\n`;
  fs.writeFileSync(filePath, unknownPayload, "utf-8");
}

function recordUnknownJob(filePath: string, job: UnknownJob) {
  const existing = readUnknownLinks(filePath);
  const merged = mergeUnknownLinks(existing, [job]);
  writeUnknownLinks(filePath, merged);
  return merged.length;
}

async function main() {
  const profile = loadProfile();
  let ashbyCount = 0;
  let greenhouseCount = 0;
  let leverCount = 0;
  const unknownLinks: UnknownJob[] = [];
  const unknownOutPath = path.join(process.cwd(), "unknownJobs.js");

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
  console.log("Step 2 flow: open each job in a NEW TAB -> click Apply -> switch to ATS tab if it opens -> autofill -> wait 2s -> continue.");
  console.log("NOTE: We DO NOT close previous tabs.\n");
  console.log("Controls: Enter or 'p' to pause/resume, 'r' to resume, 's' or 'q' to stop.\n");

  const controls = setupControls();

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

    // ✅ NEW TAB for the LinkedIn job (keeps previous app tabs open)
    const liPage = await context.newPage();

    try {
      await liPage.goto(link, { waitUntil: "domcontentloaded", timeout: 60000 });
      await liPage.waitForTimeout(1500);
    } catch {
      console.log("❌ Timed out loading job page. Skipping this job.\n");
      const unknownJob = { id: jobId || "", role: title || "", company: company || "", link };
      unknownLinks.push(unknownJob);
      const total = recordUnknownJob(unknownOutPath, unknownJob);
      console.log(`Unknown job saved immediately. Total: ${total}`);
      await liPage.close().catch(() => {});
      continue;
    }
    if (controls.isStopped()) break;
    await controls.waitIfPaused();

    // ✅ Click apply and get the ATS page (could be popup/new tab)
    const atsPage = await clickApplyAndFindAtsPage(context, liPage);
    if (!atsPage) {
      console.log("❌ Could not click Apply. Skipping this job.\n");
      const unknownJob = { id: jobId || "", role: title || "", company: company || "", link };
      unknownLinks.push(unknownJob);
      const total = recordUnknownJob(unknownOutPath, unknownJob);
      console.log(`Unknown job saved immediately. Total: ${total}`);
      await liPage.close().catch(() => {});
      continue;
    }
    if (controls.isStopped()) break;
    await controls.waitIfPaused();

    // Let the ATS page settle
    await atsPage.waitForTimeout(1500);

    const landedUrl = atsPage.url();
    const platform = detectPlatform(landedUrl);

    console.log(`Landed on: ${landedUrl}`);
    console.log(`Detected platform: ${platform}`);

    // If not ATS, close LinkedIn tab and record link
    if (platform === "unknown") {
      console.log("Not on Greenhouse/Lever/Ashby yet. Skipping this job.\n");
      const unknownJob = { id: jobId || "", role: title || "", company: company || "", link };
      unknownLinks.push(unknownJob);
      const total = recordUnknownJob(unknownOutPath, unknownJob);
      console.log(`Unknown job saved immediately. Total: ${total}`);
      try {
        if (!atsPage.isClosed() && atsPage !== liPage) {
          await atsPage.close();
        }
      } catch {}
      await liPage.close().catch(() => {});
      continue;
    }

    // ✅ This should now log correctly when ATS page is Ashby
    if (platform === "ashby") {
      console.log("Running Ashby autofill...");
      await autofillAshby(atsPage, profile);
      ashbyCount += 1;
      if (!liPage.isClosed() && liPage !== atsPage) {
        await liPage.close().catch(() => {});
      }
      // ✅ Step 2: wait 2 seconds then proceed (keep tabs open for Ashby)
      await atsPage.waitForTimeout(2000);
      console.log("✅ Finished this job (left tabs open). Moving to next...\n");
    } else if (platform === "greenhouse") {
      console.log("Running Greenhouse autofill...");
      await autofillGreenhouse(atsPage, profile);
      greenhouseCount += 1;
      await atsPage.waitForTimeout(2000);
      if (!liPage.isClosed() && liPage !== atsPage) {
        await liPage.close().catch(() => {});
      }
      if (!liPage.isClosed() && liPage !== atsPage) {
        await liPage.close().catch(() => {});
      }
      console.log("ƒo. Finished this job (left tabs open). Moving to next...\n");
    } else if (platform === "lever") {
      console.log("Running Lever autofill...");
      await autofillLever(atsPage, profile);
      leverCount += 1;
      await atsPage.waitForTimeout(2000);
      if (!liPage.isClosed() && liPage !== atsPage) {
        await liPage.close().catch(() => {});
      }
      console.log("ƒo. Finished this job (left tabs open). Moving to next...\n");
    } else {
      // For unsupported platforms, close tabs and record link
      console.log("Unsupported platform detected. Skipping this job.\n");
      const unknownJob = { id: jobId || "", role: title || "", company: company || "", link };
      unknownLinks.push(unknownJob);
      const total = recordUnknownJob(unknownOutPath, unknownJob);
      console.log(`Unknown job saved immediately. Total: ${total}`);
      try {
        if (!atsPage.isClosed() && atsPage !== liPage) {
          await atsPage.close();
        }
      } catch {}
      await liPage.close().catch(() => {});
    }

    if (controls.isStopped()) break;
    await controls.waitIfPaused();
  }

  if (controls.isStopped()) {
    controls.lockInput();
  }

  console.log("✅ Step 2 complete: processed all approved jobs (tabs left open).");
  console.log(`Ashby opened: ${ashbyCount} | Greenhouse opened: ${greenhouseCount} | Lever opened: ${leverCount}`);
  const existingUnknown = readUnknownLinks(unknownOutPath);
  const mergedUnknown = mergeUnknownLinks(existingUnknown, unknownLinks);
  writeUnknownLinks(unknownOutPath, mergedUnknown);
  console.log(`${mergedUnknown.length} Unknown job links saved to: ${unknownOutPath}`);
  controls.lockInput();
  // Not closing browser in Step 2 yet. Step 3 will finalize "keep open".
}

main().catch((err) => {
  console.error("❌ apply:batch failed:", err);
  process.exit(1);
});



