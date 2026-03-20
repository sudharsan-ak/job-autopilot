import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  ManualOutreachBlock,
  getManualOutreachDir,
  getManualOutreachInputPath,
  parseManualOutreachInput,
  readManualOutreachInput
} from "../../utils/manual/manualOutreach";
import { createManualOutreachDraftsForJobs } from "./createManualOutreachDrafts";

type WatchLogEntry = {
  company: string;
  role: string;
  fingerprint: string;
  status: "drafted" | "failed";
  draftedAt?: string;
  lastAttemptAt: string;
  error?: string;
};

type WatchLog = {
  entries: WatchLogEntry[];
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const LOG_PATH = path.join(getManualOutreachDir(), "manualOutreachLog.json");

function getArg(name: string): string | null {
  const hit = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return null;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? null;
}

function getIntervalMs() {
  const minutesArg = getArg("intervalMinutes");
  if (!minutesArg) {
    return DEFAULT_INTERVAL_MS;
  }

  const minutes = Number.parseFloat(minutesArg);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid --intervalMinutes value: ${minutesArg}`);
  }

  return Math.max(10_000, Math.round(minutes * 60 * 1000));
}

function ensureManualDir() {
  fs.mkdirSync(getManualOutreachDir(), { recursive: true });
}

function loadLog(): WatchLog {
  ensureManualDir();
  if (!fs.existsSync(LOG_PATH)) {
    return { entries: [] };
  }

  try {
    const raw = fs.readFileSync(LOG_PATH, "utf8").trim();
    if (!raw) {
      return { entries: [] };
    }
    const parsed = JSON.parse(raw) as Partial<WatchLog>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries as WatchLogEntry[] : [] };
  } catch {
    return { entries: [] };
  }
}

function saveLog(log: WatchLog) {
  ensureManualDir();
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");
}

function fingerprintBlock(job: ManualOutreachBlock) {
  const payload = JSON.stringify({
    company: job.company.trim(),
    role: job.role.trim(),
    emails: job.emails ?? [],
    versions: job.versions
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function hasDraftedEntry(log: WatchLog, job: ManualOutreachBlock, fingerprint: string) {
  return log.entries.some(
    (entry) =>
      entry.company === job.company &&
      entry.role === job.role &&
      entry.fingerprint === fingerprint &&
      entry.status === "drafted"
  );
}

function upsertLogEntry(log: WatchLog, nextEntry: WatchLogEntry) {
  const index = log.entries.findIndex(
    (entry) =>
      entry.company === nextEntry.company &&
      entry.role === nextEntry.role &&
      entry.fingerprint === nextEntry.fingerprint
  );

  if (index === -1) {
    log.entries.push(nextEntry);
  } else {
    log.entries[index] = nextEntry;
  }
}

async function processManualOutreach() {
  const inputPath = getManualOutreachInputPath();
  if (!fs.existsSync(inputPath)) {
    console.log(`No manual outreach file found at ${inputPath}`);
    return;
  }

  const raw = readManualOutreachInput();
  const jobs = parseManualOutreachInput(raw);
  if (jobs.length === 0) {
    console.log(`No parseable manual outreach entries found in ${inputPath}`);
    return;
  }

  const log = loadLog();
  const pending = jobs.filter((job) => !hasDraftedEntry(log, job, fingerprintBlock(job)));

  if (pending.length === 0) {
    console.log("No new manual outreach entries detected.");
    return;
  }

  console.log(`Detected ${pending.length} new or changed manual outreach block(s). Running draft creation...`);

  for (const job of pending) {
    const fingerprint = fingerprintBlock(job);
    const attemptedAt = new Date().toISOString();

    try {
      const result = await createManualOutreachDraftsForJobs([job]);
      if (result.failureCount > 0 && result.successCount === 0) {
        throw new Error("Draft creation failed for all versions in this block.");
      }
      upsertLogEntry(log, {
        company: job.company,
        role: job.role,
        fingerprint,
        status: "drafted",
        draftedAt: attemptedAt,
        lastAttemptAt: attemptedAt
      });
      saveLog(log);
      console.log(`Drafted manual outreach for ${job.company} | ${job.role}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      upsertLogEntry(log, {
        company: job.company,
        role: job.role,
        fingerprint,
        status: "failed",
        lastAttemptAt: attemptedAt,
        error: message
      });
      saveLog(log);
      console.error(`Failed manual outreach for ${job.company} | ${job.role}: ${message}`);
    }
  }
}

async function main() {
  const intervalMs = getIntervalMs();
  console.log(`Watching ${getManualOutreachInputPath()} every ${Math.round(intervalMs / 1000)}s`);
  console.log(`Log file: ${LOG_PATH}`);

  await processManualOutreach();

  setInterval(() => {
    processManualOutreach().catch((error) => {
      console.error("watchManualOutreach iteration failed:", error);
    });
  }, intervalMs);
}

main().catch((error) => {
  console.error("watchManualOutreach failed:", error);
  process.exit(1);
});
