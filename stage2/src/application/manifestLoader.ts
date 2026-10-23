import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Classification, ImportedJob } from "../types.js";
import { createJobKey, normalizeNavigableUrl, normalizeText, sha256 } from "../utils/identity.js";

const UnknownObjectSchema = z.record(z.string(), z.unknown());

interface ParsedSource {
  parsed: unknown;
  issues: string[];
}

export interface ManifestLoadResult {
  sourcePath: string;
  fingerprint: string;
  batchDate: string;
  jobs: ImportedJob[];
  issues: string[];
}

function splitMarkdownRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells;
}

function normalizeMarkdownHeader(value: string): string {
  return value
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function markdownText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownUrl(value: string): string | undefined {
  const linked = value.match(/\[[^\]]*]\((https?:\/\/[^\s)]+)\)/i)?.[1];
  const bracketed = value.match(/<(https?:\/\/[^>]+)>/i)?.[1];
  const bare = value.match(/https?:\/\/[^\s|>]+/i)?.[0];
  return linked ?? bracketed ?? bare;
}

function columnIndex(headers: string[], names: string[]): number {
  return headers.findIndex((header) => names.includes(header));
}

function parseMarkdownJobs(markdown: string): Record<string, unknown>[] | undefined {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index]!;
    const dividerLine = lines[index + 1]!;
    if (!headerLine.includes("|") || !dividerLine.includes("|")) continue;
    const rawHeaders = splitMarkdownRow(headerLine);
    const divider = splitMarkdownRow(dividerLine);
    if (rawHeaders.length !== divider.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;

    const headers = rawHeaders.map(normalizeMarkdownHeader);
    const titleIndex = columnIndex(headers, ["role", "title", "job title", "position"]);
    const companyIndex = columnIndex(headers, ["company", "company name", "employer", "organization"]);
    const sourceUrlIndex = columnIndex(headers, ["job url", "url", "source url", "listing url", "hiringcafe url"]);
    const classificationIndex = columnIndex(headers, ["classification", "recommendation", "decision", "disposition", "fit status", "status"]);
    if ([titleIndex, companyIndex, sourceUrlIndex, classificationIndex].some((value) => value < 0)) continue;

    const applicationUrlIndex = columnIndex(headers, ["application url", "apply url", "employer url"]);
    const resumePathIndex = columnIndex(headers, ["resume path", "resume", "pdf path", "tailored resume path"]);
    const jobKeyIndex = columnIndex(headers, ["job key", "provider job id", "source job id"]);
    const atsIndex = columnIndex(headers, ["ats", "platform"]);
    const jobs: Record<string, unknown>[] = [];

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex]!;
      if (!line.trim() || !line.includes("|")) break;
      const cells = splitMarkdownRow(line);
      if (cells.length !== headers.length) continue;
      const sourceUrl = markdownUrl(cells[sourceUrlIndex]!) ?? markdownText(cells[sourceUrlIndex]!);
      const record: Record<string, unknown> = {
        title: markdownText(cells[titleIndex]!),
        company: markdownText(cells[companyIndex]!),
        job_url: sourceUrl,
        classification: markdownText(cells[classificationIndex]!),
      };
      if (applicationUrlIndex >= 0) record.application_url = markdownUrl(cells[applicationUrlIndex]!) ?? markdownText(cells[applicationUrlIndex]!);
      if (resumePathIndex >= 0) record.resume_path = markdownText(cells[resumePathIndex]!);
      if (jobKeyIndex >= 0) record.job_key = markdownText(cells[jobKeyIndex]!);
      if (atsIndex >= 0) record.ats_hint = markdownText(cells[atsIndex]!);
      jobs.push(record);
    }
    return jobs;
  }
  return undefined;
}

function parseSource(raw: Buffer, sourcePath: string): ParsedSource {
  const text = raw.toString("utf8");
  const extension = path.extname(sourcePath).toLowerCase();
  if ([".md", ".markdown"].includes(extension)) {
    const jobs = parseMarkdownJobs(text);
    return jobs
      ? { parsed: { jobs }, issues: [] }
      : { parsed: { jobs: [] }, issues: ["No compatible Markdown job table was found."] };
  }
  try {
    return { parsed: JSON.parse(text) as unknown, issues: [] };
  } catch (error) {
    throw new Error(`Stage 1 input must be valid JSON or a Markdown table: ${String(error)}`);
  }
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = normalizeText(record[key]);
    if (value) return value;
  }
  return undefined;
}

function sourceArrayUrl(record: Record<string, unknown>): string | undefined {
  if (!Array.isArray(record.sources)) return undefined;
  for (const source of record.sources) {
    if (!source || typeof source !== "object") continue;
    const url = firstText(source as Record<string, unknown>, ["employer_url", "application_url", "url"]);
    if (url) return url;
  }
  return undefined;
}

function resumeReference(record: Record<string, unknown>, manifestDirectory: string): string | undefined {
  const direct = firstText(record, ["resume_path", "tailored_resume_path", "pdf_path"]);
  let candidate = direct;
  if (!candidate && record.resume && typeof record.resume === "object" && !Array.isArray(record.resume)) {
    candidate = firstText(record.resume as Record<string, unknown>, ["pdf", "pdf_path", "path"]);
  }
  if (!candidate) return undefined;
  return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(manifestDirectory, candidate);
}

function normalizeClassification(record: Record<string, unknown>): Classification | undefined {
  const value = firstText(record, ["classification", "recommendation", "decision", "disposition", "fit_status", "status"]);
  if (!value) return undefined;
  const normalized = value.toUpperCase().replace(/[^A-Z]+/g, " ").trim();
  if (normalized.includes("BORDERLINE")) return "BORDERLINE";
  if (/\bAPPLY\b/.test(normalized) && !/(DO NOT APPLY|SKIP|REJECT)/.test(normalized)) return "APPLY";
  return undefined;
}

function candidateArray(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (!root || typeof root !== "object") return [];
  const object = root as Record<string, unknown>;
  for (const key of ["jobs", "roles", "applications", "results", "items", "queue"]) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  for (const key of ["stage1", "output", "data", "batch"]) {
    const nested = object[key];
    if (!nested || typeof nested !== "object") continue;
    const result = candidateArray(nested);
    if (result.length > 0) return result;
  }
  return [];
}

function inferDate(root: unknown, sourcePath: string): string {
  if (root && typeof root === "object" && !Array.isArray(root)) {
    const record = root as Record<string, unknown>;
    const value = firstText(record, ["batch_date", "date", "run_date", "generated_on"]);
    if (value && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  }
  const pathMatch = sourcePath.match(/\d{4}-\d{2}-\d{2}/);
  return pathMatch?.[0] ?? new Date().toISOString().slice(0, 10);
}

export function loadManifest(manifestPath: string): ManifestLoadResult {
  const sourcePath = path.resolve(manifestPath);
  const manifestDirectory = path.dirname(sourcePath);
  const raw = readFileSync(sourcePath);
  const source = parseSource(raw, sourcePath);
  const parsed = source.parsed;
  const candidates = candidateArray(parsed);
  const issues: string[] = [...source.issues];
  const jobs: ImportedJob[] = [];
  const firstByKey = new Map<string, number>();

  candidates.forEach((candidate, rawIndex) => {
    const result = UnknownObjectSchema.safeParse(candidate);
    if (!result.success) {
      issues.push(`Row ${rawIndex + 1}: ignored because it is not an object.`);
      return;
    }
    const record = result.data;
    const classification = normalizeClassification(record);
    if (!classification) return;

    const title = firstText(record, ["title", "role", "job_title", "position", "name"]) ?? "Unknown role";
    const company = firstText(record, ["company", "company_name", "employer", "organization"]) ?? "Unknown company";
    const applicationUrl = normalizeNavigableUrl(firstText(record, ["application_url", "apply_url", "employer_url", "original_employer_url"]));
    const sourceUrl = normalizeNavigableUrl(
      firstText(record, ["job_url", "url", "source_url", "hiringcafe_url", "listing_url"]) ?? sourceArrayUrl(record),
    );
    const resumePath = resumeReference(record, manifestDirectory);
    const bestUrl = applicationUrl ?? sourceUrl;
    const jobKey = firstText(record, ["job_key", "provider_job_id", "source_job_id"]) ?? createJobKey(company, title, bestUrl);
    const duplicateOf = firstByKey.get(jobKey);
    const queueNumber = jobs.length + 1;
    if (duplicateOf === undefined) firstByKey.set(jobKey, queueNumber);

    let status: ImportedJob["status"] = "PENDING";
    let statusDetail: string | undefined;
    if (!bestUrl) {
      status = "BLOCKED_MISSING_URL";
      statusDetail = "No valid HTTP(S) job or application URL was supplied.";
    } else if (duplicateOf !== undefined) {
      status = "BLOCKED_DUPLICATE";
      statusDetail = `Duplicate of queue row ${duplicateOf}.`;
    } else if (!resumePath || !existsSync(resumePath)) {
      status = "PENDING_RESUME_REQUIRED";
      statusDetail = resumePath
        ? "The tailored resume reference does not exist locally; preparation may use the configured default resume."
        : "No tailored resume reference supplied; preparation may use the configured default resume.";
    }

    jobs.push({
      queueNumber,
      jobKey,
      title,
      company,
      classification,
      sourceUrl,
      applicationUrl,
      resumePath,
      status,
      statusDetail,
      rawIndex,
    });
  });

  if (candidates.length === 0) issues.push("No recognizable job array was found.");
  if (jobs.length === 0) issues.push("No APPLY or BORDERLINE jobs were found.");

  return {
    sourcePath,
    fingerprint: sha256(raw),
    batchDate: inferDate(parsed, sourcePath),
    jobs,
    issues,
  };
}
