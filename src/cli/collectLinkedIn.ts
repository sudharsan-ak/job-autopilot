import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { loadProfile } from "../utils/config";

type JobRow = {
  title: string;
  company: string;
  location: string;
  link: string;
};

function getArg(name: string): string | null {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;

  if (hit.includes("=")) return hit.split("=").slice(1).join("=");

  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? null;
}

function csvEscape(value: string): string {
  const v = (value ?? "").toString();
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function writeCsv(filePath: string, rows: Record<string, string>[], headers: string[]) {
  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h] ?? "")).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

async function autoScroll(page: any, times: number) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(900);
  }
}

async function main() {
  loadProfile();

  const countStr = getArg("count") ?? "10";
  const count = Math.max(1, Math.min(50, parseInt(countStr, 10) || 10));

  const url =
    getArg("url") ??
    "https://www.linkedin.com/jobs/search/?keywords=frontend%20engineer&location=United%20States";

  const storagePath = path.join(process.cwd(), "storage", "linkedin.json");
  if (!fs.existsSync(storagePath)) {
    throw new Error(`LinkedIn session not found. Run: npm run auth:linkedin`);
  }

  const outPath = path.join(process.cwd(), "data", "jobs.csv");
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({ storageState: storagePath });
  const page = await context.newPage();

  console.log("Going to URL:");
  console.log(url);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  console.log("Waiting for job results to appear...");
  // LinkedIn changes markup often; try a few known containers
  await page.waitForTimeout(2000);

  // If redirected to login, session failed
  const currentUrl = page.url();
  if (currentUrl.includes("/login")) {
    throw new Error("Redirected to LinkedIn login. Re-run: npm run auth:linkedin");
  }

  // Try to wait for any of these selectors
  const possibleSelectors = [
    "ul.jobs-search__results-list",
    "div.jobs-search-results-list",
    "div.scaffold-layout__list",
    "main"
  ];

  let found = false;
  for (const sel of possibleSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 8000 });
      console.log(`Found results container: ${sel}`);
      found = true;
      break;
    } catch {}
  }

  if (!found) {
    console.log("⚠️ Could not confidently find the results container.");
    console.log("We will still attempt to scrape /jobs/view links from the page.");
  }

  console.log("Scrolling to load job cards...");
  await autoScroll(page, 18);

  console.log("Extracting job cards...");
  const jobs: JobRow[] = await page.evaluate(() => {
    // Grab anchors that point to job view pages
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href*='/jobs/view/']"));

    const normalize = (href: string) => {
      // remove tracking params for uniqueness
      try {
        const u = new URL(href);
        u.search = "";
        return u.toString();
      } catch {
        return href;
      }
    };

    const seen = new Set<string>();
    const rows: JobRow[] = [];

    for (const a of anchors) {
      const hrefRaw = a.href;
      if (!hrefRaw) continue;

      const href = normalize(hrefRaw);
      if (seen.has(href)) continue;
      seen.add(href);

      // Job card container is often an <li> in results list
      const card =
        a.closest("li") ||
        a.closest("div.jobs-search-results__list-item") ||
        a.closest("div.job-card-container") ||
        a.parentElement;

      const text = (el: Element | null | undefined) => (el as HTMLElement | null)?.innerText?.trim() ?? "";

      const title =
        text(card?.querySelector("span[aria-hidden='true']")) ||
        text(card?.querySelector("a.job-card-list__title")) ||
        text(card?.querySelector("h3")) ||
        text(a);

      const company =
        text(card?.querySelector(".job-card-container__primary-description")) ||
        text(card?.querySelector(".job-card-container__company-name")) ||
        text(card?.querySelector("h4")) ||
        "";

      const location =
        text(card?.querySelector(".job-card-container__metadata-item")) ||
        text(card?.querySelector(".job-card-container__metadata-wrapper")) ||
        "";

      rows.push({ title, company, location, link: href });
    }

    return rows;
  });

  console.log(`Raw extracted job links: ${jobs.length}`);

  const trimmed = jobs
    .filter((j) => j.link && j.link.includes("/jobs/view/"))
    .slice(0, count);

  console.log(`Using first ${trimmed.length} jobs (requested ${count}).`);

  const rowsForCsv = trimmed.map((j, idx) => ({
    id: String(idx + 1),
    source: "linkedin",
    title: j.title || "",
    company: j.company || "",
    location: j.location || "",
    link: j.link,
    approved: "",
    notes: ""
  }));

  const headers = ["id", "source", "title", "company", "location", "link", "approved", "notes"];
  writeCsv(outPath, rowsForCsv, headers);

  console.log(`✅ Wrote CSV: ${outPath}`);
  console.log("Open data/jobs.csv to review. Mark approved=true to apply later.");

  await browser.close();
}

main().catch((err) => {
  console.error("❌ collect:linkedin failed:", err);
  process.exit(1);
});
