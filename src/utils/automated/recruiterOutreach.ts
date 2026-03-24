import fs from "fs";
import path from "path";

export type RecruiterOutreachGroup = {
  role: string;
  links: string[];
};

export type RecruiterOutreachSessionState = {
  cdpEndpoint: string;
  browserPid?: number;
  createdAt: string;
};

const RECRUITER_OUTREACH_PATH = path.join(process.cwd(), "src", "cli", "recruiterOutreach.js");
const RECRUITER_OUTREACH_SESSION_PATH = path.join(
  process.cwd(),
  "data",
  "recruiter-outreach",
  "session.json"
);

export function getRecruiterOutreachPath() {
  return RECRUITER_OUTREACH_PATH;
}

export function getRecruiterOutreachSessionPath() {
  return RECRUITER_OUTREACH_SESSION_PATH;
}

export function saveRecruiterOutreachSession(state: RecruiterOutreachSessionState) {
  fs.mkdirSync(path.dirname(RECRUITER_OUTREACH_SESSION_PATH), { recursive: true });
  fs.writeFileSync(RECRUITER_OUTREACH_SESSION_PATH, JSON.stringify(state, null, 2), "utf8");
}

export function readRecruiterOutreachSession() {
  if (!fs.existsSync(RECRUITER_OUTREACH_SESSION_PATH)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(RECRUITER_OUTREACH_SESSION_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<RecruiterOutreachSessionState>;
    if (typeof parsed.cdpEndpoint !== "string" || !parsed.cdpEndpoint.trim()) {
      return null;
    }
    return {
      cdpEndpoint: parsed.cdpEndpoint.trim(),
      browserPid: typeof parsed.browserPid === "number" ? parsed.browserPid : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
    } satisfies RecruiterOutreachSessionState;
  } catch {
    return null;
  }
}

export function clearRecruiterOutreachSession() {
  if (fs.existsSync(RECRUITER_OUTREACH_SESSION_PATH)) {
    fs.unlinkSync(RECRUITER_OUTREACH_SESSION_PATH);
  }
}

export function readRecruiterOutreach(): RecruiterOutreachGroup[] {
  if (!fs.existsSync(RECRUITER_OUTREACH_PATH)) {
    return [];
  }

  const raw = fs.readFileSync(RECRUITER_OUTREACH_PATH, "utf8");
  const match = raw.match(/export const recruiterOutreach\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    return [];
  }

  try {
    const parsed = Function(`"use strict"; return (${match[1]});`)() as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => item as Partial<RecruiterOutreachGroup>)
      .filter((item) => typeof item.role === "string" && Array.isArray(item.links))
      .map((item) => ({
        role: String(item.role).trim(),
        links: (item.links ?? [])
          .filter((link): link is string => typeof link === "string")
          .map((link) => link.trim())
          .filter((link) => link.length > 0)
      }))
      .filter((item) => item.role.length > 0 && item.links.length > 0);
  } catch {
    return [];
  }
}
