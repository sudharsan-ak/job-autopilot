import * as fs from "fs";
import * as path from "path";
import { chromium } from "playwright";
import { loadProfile } from "../utils/config";
import { CsvRow, readCsv, writeCsv } from "../utils/csv";
import { extractJobDescription } from "../utils/automated/extractJobDescription";
import { scoreJobFit, summarizeFit } from "../utils/jobFit";

const JOB_HEADERS = ["id", "source", "title", "company", "location", "link", "approved", "notes"];

function sanitizeLinkedInJobUrl(raw: string) {
  const trimmed = (raw ?? "").trim();
  const match = trimmed.match(/https:\/\/www\.linkedin\.com\/jobs\/view\/[^,\s]+\/?/i);
  return match ? match[0] : trimmed;
}

function getStoragePath() {
  const combinedPath = path.join(process.cwd(), "storage", "combined.json");
  if (fs.existsSync(combinedPath)) {
    return combinedPath;
  }

  return path.join(process.cwd(), "storage", "linkedin.json");
}

function getOutputPath(fileName: string) {
  return path.join(process.cwd(), "data", fileName);
}

function getAnalyzedDataDir() {
  return path.join(process.cwd(), "data", "analyzed-jobs");
}

function getAnalyzedDataPath() {
  return path.join(getAnalyzedDataDir(), "JDInfo.txt");
}

function appendFitNote(row: CsvRow, fitSummary: string) {
  const existing = (row.notes ?? "").trim();
  return existing ? `${existing} | ${fitSummary}` : fitSummary;
}

function resetAnalyzedDataFile(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf-8");
}

type AnalyzedJobEntry = {
  company: string;
  title: string;
  link: string;
  descriptionText: string;
  bucket: "strong" | "partial" | "skip";
  score: number;
};

function formatAnalyzedJobBlock(details: AnalyzedJobEntry) {
  return [
    `Company: ${details.company || "Unknown company"}`,
    `Role: ${details.title || "Unknown title"}`,
    `Link: ${details.link || ""}`,
    "",
    "JD",
    details.descriptionText || "",
    "",
    ""
  ].join("\n");
}

function writeAnalyzedJobs(filePath: string, jobs: AnalyzedJobEntry[]) {
  const sections: Array<{ label: string; bucket: AnalyzedJobEntry["bucket"] }> = [
    { label: "Strong fits:", bucket: "strong" },
    { label: "Partial fits:", bucket: "partial" },
    { label: "Skip fits:", bucket: "skip" }
  ];

  const content = sections
    .map(({ label, bucket }) => {
      const sectionJobs = jobs
        .filter((job) => job.bucket === bucket)
        .sort((left, right) => right.score - left.score);

      const blocks = sectionJobs.map((job) => formatAnalyzedJobBlock(job)).join("");
      return `${label}\n\n${blocks}`;
    })
    .join("\n");

  fs.writeFileSync(filePath, content, "utf-8");
}

async function main() {
  const profile = loadProfile();
  const jobsPath = getOutputPath("jobs.csv");
  const strongPath = getOutputPath("jobsStrong.csv");
  const partialPath = getOutputPath("jobsMedium.csv");
  const skipPath = getOutputPath("jobsSkip.csv");
  const analyzedDataPath = getAnalyzedDataPath();

  if (!fs.existsSync(jobsPath)) {
    throw new Error(`Missing CSV: ${jobsPath}`);
  }

  const storagePath = getStoragePath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(`LinkedIn session not found. Run: npm run authLinkedIn`);
  }

  const rows = readCsv(jobsPath);
  if (rows.length === 0) {
    writeCsv(strongPath, [], JOB_HEADERS);
    writeCsv(partialPath, [], JOB_HEADERS);
    writeCsv(skipPath, [], JOB_HEADERS);
    resetAnalyzedDataFile(analyzedDataPath);
    console.log("No jobs found in data/jobs.csv.");
    return;
  }

  resetAnalyzedDataFile(analyzedDataPath);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: storagePath });

  const strongMatches: Array<{ row: CsvRow; score: number }> = [];
  const partialMatches: Array<{ row: CsvRow; score: number }> = [];
  const skippedMatches: Array<{ row: CsvRow; score: number }> = [];
  const analyzedJobs: AnalyzedJobEntry[] = [];

  console.log(`Analyzing ${rows.length} job(s) against your JS/TS + Meteor/React full-stack profile...`);
  console.log("Headless mode enabled. Progress will be printed here for each job.\n");

  for (const [index, row] of rows.entries()) {
    const page = await context.newPage();
    const jobUrl = sanitizeLinkedInJobUrl(row.link);

    try {
      console.log(`[${index + 1}/${rows.length}] ${row.title || "Unknown title"} @ ${row.company || "Unknown company"}`);
      console.log(` -> opening ${jobUrl}`);
      await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(1800);

      console.log(" -> extracting title/company/location/about-the-job from rendered DOM");
      const details = await extractJobDescription(page);
      console.log(" -> scoring fit");
      const fit = scoreJobFit(profile, {
        ...details,
        fallbackTitle: row.title,
        fallbackLocation: row.location || details.location
      });

      const updatedRow: CsvRow = {
        ...row,
        link: jobUrl,
        notes: appendFitNote(row, summarizeFit(fit))
      };

      if (fit.bucket === "strong") {
        strongMatches.push({ row: updatedRow, score: fit.score });
      } else if (fit.bucket === "partial") {
        partialMatches.push({ row: updatedRow, score: fit.score });
      } else {
        skippedMatches.push({ row: updatedRow, score: fit.score });
      }

      analyzedJobs.push({
        company: details.company || row.company,
        title: details.title || row.title,
        link: jobUrl,
        descriptionText: details.descriptionText,
        bucket: fit.bucket,
        score: fit.score
      });

      console.log(` -> ${fit.bucket.toUpperCase()} (${fit.score})`);
      console.log(" -> closed analysis tab");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(` -> PARTIAL (fetch/extract issue: ${message})`);
      partialMatches.push({
        row: {
          ...row,
          link: jobUrl,
          notes: appendFitNote(row, `fit=30 partial | extraction issue ${message}`)
        },
        score: 30
      });
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();

  const sortByScoreDesc = (items: Array<{ row: CsvRow; score: number }>) =>
    items.sort((left, right) => right.score - left.score).map((item) => item.row);

  writeCsv(strongPath, sortByScoreDesc(strongMatches), JOB_HEADERS);
  writeCsv(partialPath, sortByScoreDesc(partialMatches), JOB_HEADERS);
  writeCsv(skipPath, sortByScoreDesc(skippedMatches), JOB_HEADERS);
  writeAnalyzedJobs(analyzedDataPath, analyzedJobs);

  console.log("");
  console.log(`Original data/jobs.csv left unchanged: ${rows.length}`);
  console.log(`Strong matches written to data/jobsStrong.csv: ${strongMatches.length}`);
  console.log(`Medium matches written to data/jobsMedium.csv: ${partialMatches.length}`);
  console.log(`Skipped matches written to data/jobsSkip.csv: ${skippedMatches.length}`);
  console.log(`Analyzed job text written to data/analyzed-jobs/JDInfo.txt`);
}

main().catch((error) => {
  console.error("analyzeJobs failed:", error);
  process.exit(1);
});
