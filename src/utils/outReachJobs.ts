import fs from "fs";
import path from "path";

const OUTREACH_JOBS_PATH = path.join(process.cwd(), "outReachJobs.js");

export function getOutReachJobsPath() {
  return OUTREACH_JOBS_PATH;
}

export function readOutReachJobs(): string[] {
  if (!fs.existsSync(OUTREACH_JOBS_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(OUTREACH_JOBS_PATH, "utf8");
  const match = raw.match(/export const outReachJobs\s*=\s*(\[[\s\S]*?\]);/);

  if (!match) {
    return [];
  }

  try {
    const parsed = JSON.parse(match[1].replace(/,\s*]/g, "]")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
}
