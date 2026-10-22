import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getAtsBehavior } from "../ats/behavior.js";
import type { AtsKind, FieldDescriptor, FillVerification, StoredJob } from "../types.js";
import { liveFieldLocator, refindField, waitForDomSettled } from "./fieldRuntime.js";
import { frameForField, readFieldValue } from "./verifier.js";

const RESUME_FIELD = /\b(resume|curriculum vitae|cv)\b/i;
const OTHER_ATTACHMENT = /cover letter|portfolio|transcript|certificate|passport|visa|identification|\bid\b/i;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx"]);

export function isResumeUpload(field: FieldDescriptor): boolean {
  if (field.controlType !== "file") return false;
  const primary = [field.label, field.name, field.id, field.ariaLabel].filter(Boolean).join(" ");
  if (OTHER_ATTACHMENT.test(primary)) return false;
  if (RESUME_FIELD.test(primary)) return true;
  return !OTHER_ATTACHMENT.test(field.containerText ?? "") && RESUME_FIELD.test(field.containerText ?? "");
}

export function selectResumePath(job: StoredJob, defaultResumePath: string): string | undefined {
  for (const candidate of [job.resumePath, defaultResumePath]) {
    if (!candidate || !existsSync(candidate)) continue;
    const extension = path.extname(candidate).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) continue;
    try {
      const header = readFileSync(candidate).subarray(0, 8);
      const valid = extension === ".pdf"
        ? header.toString("ascii").startsWith("%PDF-")
        : extension === ".docx"
          ? header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
          : header.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
      if (valid) return path.resolve(candidate);
    } catch {
      // Try the configured fallback when a candidate cannot be read.
    }
  }
  return undefined;
}

export async function uploadResume(
  page: Page,
  field: FieldDescriptor,
  resumePath: string,
  ats?: AtsKind,
): Promise<FillVerification> {
  const expected = path.basename(resumePath);
  try {
    const live = await liveFieldLocator(page, field, ats);
    if (!live) throw new Error("Resume file input is no longer available.");
    await live.locator.setInputFiles(resumePath);
    const behavior = getAtsBehavior(ats);
    let observed: string | undefined;
    const deadline = Date.now() + behavior.uploadTimeoutMs;
    while (Date.now() < deadline) {
      const current = (await refindField(page, field, ats)) ?? live.field;
      const value = await readFieldValue(page, current, ats);
      observed = typeof value === "string" ? value : undefined;
      if (observed === expected) break;
      const frame = frameForField(page, current);
      const root = current.fieldRootSelector ? frame.locator(current.fieldRootSelector).first() : frame.locator("body");
      const rootText = await root.innerText().catch(() => "");
      if (rootText.toLowerCase().includes(expected.toLowerCase())) {
        observed = expected;
        break;
      }
      if (await page.getByText(expected, { exact: false }).first().isVisible().catch(() => false)) {
        observed = expected;
        break;
      }
      for (const selector of behavior.uploadSuccessSelectors) {
        const success = root.locator(selector).first();
        if (!await success.isVisible().catch(() => false)) continue;
        const text = await success.innerText().catch(() => "");
        if (!text || /uploaded|attached|complete|success|remove|delete/i.test(text)) {
          observed = expected;
          break;
        }
      }
      if (observed === expected) break;
      await page.waitForTimeout(50);
    }
    if (observed === expected) await waitForDomSettled(page, 100, 800);
    return {
      fieldId: field.fieldId,
      success: observed === expected,
      expected,
      observed,
      error: observed === expected ? undefined : "Resume attachment read-back did not match.",
    };
  } catch (error) {
    return { fieldId: field.fieldId, success: false, expected, error: String(error) };
  }
}
