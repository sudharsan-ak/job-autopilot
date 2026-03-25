import fs from "fs";
import path from "path";

export type RecruiterOutreachGroup = {
  role: string;
  links: string[];
};

const RECRUITER_OUTREACH_PATH = path.join(process.cwd(), "src", "cli", "recruiterOutreach.js");

export function getRecruiterOutreachPath() {
  return RECRUITER_OUTREACH_PATH;
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
