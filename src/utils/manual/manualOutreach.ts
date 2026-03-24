import fs from "fs";
import path from "path";

export type ManualOutreachBlock = {
  company: string;
  role: string;
  emails?: string[];
  versions: string[];
};

const MANUAL_DIR = path.join(process.cwd(), "data", "manual-outreach");
const INPUT_PATH = path.join(MANUAL_DIR, "manualOutreach.txt");

export function getManualOutreachDir() {
  return MANUAL_DIR;
}

export function getManualOutreachInputPath() {
  return INPUT_PATH;
}

export function getManualOutreachTemplate() {
  return [
    "Company name - Lyft",
    "Role - L4 Full Stack Engineer - Fleets Tooling",
    "",
    "Emails:",
    "recruiter1@company.com",
    "recruiter2@company.com",
    "",
    "Version 1:",
    "Paste your first middle paragraph here.",
    "",
    "Version 2:",
    "Paste your second middle paragraph here.",
    "",
    "Company name - Plaid",
    "Role - Senior Software Engineer - Fullstack",
    "",
    "Version 1:",
    "Paste your first middle paragraph here."
  ].join("\n");
}

export function readManualOutreachInput() {
  if (!fs.existsSync(INPUT_PATH)) {
    throw new Error(`Missing manual outreach input file at ${INPUT_PATH}. Run npm run prepareManualOutreach first.`);
  }

  return fs.readFileSync(INPUT_PATH, "utf8");
}

function cleanParagraph(value: string) {
  return value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function extractEmails(blockText: string) {
  const lines = blockText.replace(/\r/g, "").split("\n");
  const startIndex = lines.findIndex((line) => /^Emails:\s*$/i.test(line.trim()));
  if (startIndex === -1) {
    return [];
  }

  const emails: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    if (
      /^Version\s+\d+\s*:?\s*$/i.test(line) ||
      /^Company name\s*-\s*/i.test(line) ||
      /^Company\s*:\s*/i.test(line) ||
      /^Role\s*-\s*/i.test(line) ||
      /^Role\s*:\s*/i.test(line)
    ) {
      break;
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) {
      emails.push(line);
    }
  }

  return emails;
}

export function parseManualOutreachInput(raw: string): ManualOutreachBlock[] {
  const normalized = raw.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const starts = [...normalized.matchAll(/(^|\n)(?:Company name\s*-\s*|Company\s*:\s*)/g)].map(
    (match) => (match.index ?? 0) + (match[1]?.length ?? 0)
  );
  if (starts.length === 0) {
    return [];
  }

  const blocks: ManualOutreachBlock[] = [];

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : normalized.length;
    const blockText = normalized.slice(start, end).trim();

    const companyMatch = blockText.match(/^(?:Company name\s*-\s*|Company\s*:\s*)(.+)$/m);
    const roleMatch = blockText.match(/^(?:Role\s*-\s*|Role\s*:\s*)(.+)$/m);
    if (!companyMatch || !roleMatch) {
      continue;
    }

    const emails = extractEmails(blockText);

    const versions: string[] = [];
    const versionRegex = /Version\s+\d+\s*:?\s*([\s\S]*?)(?=\nVersion\s+\d+\s*:?\s*|\s*$)/g;
    let match: RegExpExecArray | null;

    while ((match = versionRegex.exec(blockText)) !== null) {
      const paragraph = cleanParagraph(match[1] ?? "");
      if (paragraph) {
        versions.push(paragraph);
      }
    }

    if (versions.length === 0) {
      continue;
    }

    blocks.push({
      company: companyMatch[1].trim(),
      role: roleMatch[1].trim(),
      emails: emails.length > 0 ? emails : undefined,
      versions
    });
  }

  return blocks;
}
