import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Classification, ImportedJob } from "../types.js";
import { createJobKey, normalizeNavigableUrl, normalizeText, sha256 } from "../utils/identity.js";

const UnknownObjectSchema = z.record(z.string(), z.unknown());

export interface ManifestLoadResult {
  sourcePath: string;
  fingerprint: string;
  batchDate: string;
  jobs: ImportedJob[];
  issues: string[];
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
  const parsed: unknown = JSON.parse(raw.toString("utf8"));
  const candidates = candidateArray(parsed);
  const issues: string[] = [];
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
