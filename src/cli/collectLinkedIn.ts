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

function parseFirstCsvField(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith('"')) {
    const idx = trimmed.indexOf(",");
    return idx === -1 ? trimmed : trimmed.slice(0, idx);
  }
  let i = 1;
  let out = "";
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === '"') {
      if (trimmed[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      break;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function getNextId(filePath: string, headers: string[]): number {
  if (!fs.existsSync(filePath)) return 1;
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return 1;
  if (lines[0].trim() !== headers.join(",")) return 1;

  let maxId = 0;
  for (let i = 1; i < lines.length; i++) {
    const first = parseFirstCsvField(lines[i]);
    const num = parseInt(first, 10);
    if (!Number.isNaN(num)) maxId = Math.max(maxId, num);
  }
  return maxId + 1;
}

function getExistingLinks(filePath: string, headers: string[]): Set<string> {
  const links = new Set<string>();
  if (!fs.existsSync(filePath)) return links;
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return links;
  if (lines[0].trim() !== headers.join(",")) return links;

  const linkIndex = headers.indexOf("link");
  if (linkIndex === -1) return links;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const link = (fields[linkIndex] ?? "").trim();
    if (link) links.add(link);
  }
  return links;
}

function appendCsv(filePath: string, rows: Record<string, string>[], headers: string[]) {
  if (!fs.existsSync(filePath)) {
    writeCsv(filePath, rows, headers);
    return;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const hasHeader = content.split(/\r?\n/)[0]?.trim() === headers.join(",");
  const lines: string[] = [];
  if (!hasHeader) {
    lines.push(headers.join(","));
  }
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h] ?? "")).join(","));
  }
  const prefix = content.endsWith("\n") || content.length === 0 ? "" : "\n";
  fs.appendFileSync(filePath, prefix + lines.join("\n"), "utf-8");
}

async function autoScroll(page: any, times: number) {
  for (let i = 0; i < times; i++) {
    const didScroll = await page.evaluate(() => {
      const scrollCandidates = [
        "div.jobs-search-results-list",
        "div.scaffold-layout__list",
        "ul.jobs-search__results-list"
      ];

      for (const sel of scrollCandidates) {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) continue;
        if (el.scrollHeight <= el.clientHeight) continue;
        const before = el.scrollTop;
        el.scrollTop = before + el.clientHeight * 0.9;
        return el.scrollTop !== before;
      }

      const before = window.scrollY;
      window.scrollBy(0, 900);
      return window.scrollY !== before;
    });

    if (!didScroll) {
      await page.mouse.wheel(0, 1200);
    }
    await page.waitForTimeout(900);
  }
}

async function extractJobs(page: any): Promise<JobRow[]> {
  return page.evaluate(() => {
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

    const isEasyApply = (card: Element | null | undefined) => {
      if (!card) return false;

      const label =
        (card.querySelector("[aria-label*='Easy Apply' i]") as HTMLElement | null)?.innerText ?? "";
      if (/easy apply/i.test(label)) return true;

      const badge =
        (card.querySelector(".job-card-container__apply-method, .job-card-list__apply-method") as
          | HTMLElement
          | null)?.innerText ?? "";
      if (/easy apply/i.test(badge)) return true;

      const cardText = (card as HTMLElement).innerText ?? "";
      return /easy apply/i.test(cardText);
    };

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

      if (isEasyApply(card)) continue;

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
}

function normalizeSearchUrl(inputUrl: string): string {
  try {
    const u = new URL(inputUrl);
    if (u.searchParams.has("f_AL")) {
      u.searchParams.delete("f_AL");
      return u.toString();
    }
    return inputUrl;
  } catch {
    return inputUrl;
  }
}

async function main() {
  loadProfile();

  const countStr = getArg("count") ?? "10";
  const count = Math.max(1, Math.min(50, parseInt(countStr, 10) || 10));

  const rawUrl =
    getArg("url") ??
    "https://www.linkedin.com/jobs/search/?keywords=frontend%20engineer&location=United%20States";
  const url = normalizeSearchUrl(rawUrl);

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
  if (rawUrl !== url) {
    console.log("Adjusted URL to avoid Easy Apply filter (removed f_AL).");
  }
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

  const maxScrolls = 60;
  const initialScrolls = 18;
  const scrollChunk = 3;
  const maxPages = 10;
  const pageSize = 25;
  const headers = ["id", "source", "title", "company", "location", "link", "approved", "notes"];
  const existingLinks = getExistingLinks(outPath, headers);
  const nextId = getNextId(outPath, headers);

  console.log("Scrolling to load job cards...");
  let jobs: JobRow[] = [];
  const seen = new Set<string>();

  const collectFromCurrentPage = async (pageLabel: string) => {
    let totalScrolls = 0;
    let noProgressStreak = 0;

    while (jobs.length < count && totalScrolls < maxScrolls && noProgressStreak < 3) {
      const nextScrolls = totalScrolls === 0 ? initialScrolls : scrollChunk;
      await autoScroll(page, nextScrolls);
      totalScrolls += nextScrolls;

      const before = jobs.length;
      const batch = await extractJobs(page);
      for (const j of batch) {
        if (!j.link || !j.link.includes("/jobs/view/")) continue;
        if (seen.has(j.link)) continue;
        seen.add(j.link);
        jobs.push(j);
      }

      noProgressStreak = jobs.length === before ? noProgressStreak + 1 : 0;

      console.log(
        `Collected ${jobs.length}/${count} non-Easy Apply jobs after ${totalScrolls} scrolls on ${pageLabel}.`
      );
    }
  };

  await collectFromCurrentPage("page 1");

  const baseUrl = (() => {
    try {
      const u = new URL(url);
      u.searchParams.delete("start");
      return u;
    } catch {
      return null;
    }
  })();

  if (baseUrl === null) {
    console.log("Skipping pagination: URL could not be parsed.");
  } else {
    for (let pageIndex = 1; jobs.length < count && pageIndex < maxPages; pageIndex++) {
      const pageUrl = new URL(baseUrl.toString());
      pageUrl.searchParams.set("start", String(pageIndex * pageSize));

      console.log(`Navigating to page ${pageIndex + 1}...`);
      await page.goto(pageUrl.toString(), { waitUntil: "domcontentloaded" });

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
        console.log("ƒsÿ‹,? Could not confidently find the results container.");
        console.log("We will still attempt to scrape /jobs/view links from the page.");
      }

      await collectFromCurrentPage(`page ${pageIndex + 1}`);
    }
  }

  console.log(`Raw extracted job links (non-Easy Apply): ${jobs.length}`);

  const trimmed = jobs.slice(0, count);

  console.log(`Using first ${trimmed.length} jobs (requested ${count}).`);

  const rowsForCsv = trimmed
    .filter((j) => !existingLinks.has(j.link))
    .map((j, idx) => ({
      id: String(nextId + idx),
      source: "linkedin",
      title: j.title || "",
      company: j.company || "",
      location: j.location || "",
      link: j.link,
      approved: "true",
      notes: ""
    }));

  appendCsv(outPath, rowsForCsv, headers);

  console.log(`✅ Wrote CSV: ${outPath}`);
  console.log("Open data/jobs.csv to review. Mark approved=true to apply later.");

  await browser.close();
}

main().catch((err) => {
  console.error("❌ collect:linkedin failed:", err);
  process.exit(1);
});
