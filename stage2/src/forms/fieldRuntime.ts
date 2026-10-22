import type { Frame, Locator, Page } from "playwright";
import type { AtsKind, FieldDescriptor } from "../types.js";
import { scanPage } from "./pageScanner.js";

function runtimeFrame(page: Page, field: FieldDescriptor): Frame {
  if (field.frameIndex !== undefined) {
    const indexed = page.frames()[field.frameIndex];
    if (indexed) return indexed;
  }
  return page.frames().find((frame) => frame.url() === field.frameUrl) ?? page.mainFrame();
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export function fieldSemanticKey(field: FieldDescriptor): string {
  if (field.semanticId) return field.semanticId;
  return [
    field.frameIndex ?? field.frameUrl,
    field.controlType,
    normalized(field.label),
    normalized(field.name),
    normalized(field.id),
    field.repeatGroup?.kind ?? "",
    field.repeatGroup?.groupKey ?? "",
    field.repeatGroup?.recordIndex ?? "",
    normalized(field.domPath),
  ].join("|");
}

export function fieldsSemanticallyMatch(left: FieldDescriptor, right: FieldDescriptor): boolean {
  if (left.frameIndex !== undefined && right.frameIndex !== undefined && left.frameIndex !== right.frameIndex) return false;
  if (left.controlType !== right.controlType) return false;
  if (left.semanticId && right.semanticId) return left.semanticId === right.semanticId;
  if (left.id && right.id && left.id === right.id) return true;
  if (left.name && right.name && left.name === right.name && normalized(left.label) === normalized(right.label)) return true;
  if (normalized(left.label) !== normalized(right.label)) return false;
  if (left.repeatGroup || right.repeatGroup) {
    return left.repeatGroup?.kind === right.repeatGroup?.kind
      && left.repeatGroup?.groupKey === right.repeatGroup?.groupKey
      && left.repeatGroup?.recordIndex === right.repeatGroup?.recordIndex;
  }
  return normalized(left.domPath) === normalized(right.domPath);
}

function liveIdentityMatchesField(
  field: FieldDescriptor,
  live: { name?: string; id?: string; label?: string; controlType?: string },
): boolean {
  if (live.controlType && live.controlType !== field.controlType) return false;
  if (field.id && live.id) return field.id === live.id;
  if (field.name && live.name) return field.name === live.name;
  // Neither original anchor is available (or the live element has none), so the
  // only remaining signal is the field's own label text, which must be compared
  // directly rather than trusted implicitly.
  return Boolean(field.label) && Boolean(live.label) && normalized(field.label) === normalized(live.label);
}

export async function refindField(page: Page, field: FieldDescriptor, ats?: AtsKind): Promise<FieldDescriptor | undefined> {
  // A direct id-selector hit is only trusted after confirming the live element's
  // own identity (id/name, or failing that, label text) still matches the
  // original field. The scanner's data-job-autopilot-field-id counter restarts
  // at 0 on every scan, so once a framework (e.g. Greenhouse's React form)
  // replaces a DOM node, a brand-new, semantically unrelated element can be
  // assigned the same recycled id. Without this check a stale selector can
  // silently resolve to the wrong live field and write one field's value into
  // another (observed live: a race-question answer landing in First Name after
  // id "s2-0-0" was reassigned to a different element with no id/name of its
  // own, which an anchor-only check cannot catch).
  const existing = runtimeFrame(page, field).locator(field.selector).first();
  if (await existing.count().catch(() => 0)) {
    const liveIdentity = await existing.evaluate((element) => {
      if (!element.isConnected) return undefined;
      const input = element as HTMLInputElement;
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const role = clean(element.getAttribute("role")).toLowerCase();
      const type = clean(element.getAttribute("type")).toLowerCase();
      const controlType = role === "combobox" || element.getAttribute("aria-haspopup") === "listbox"
        ? "combobox"
        : element.tagName === "SELECT" ? "select"
          : element.tagName === "TEXTAREA" ? "textarea"
            : ["checkbox", "radio", "email", "tel", "url", "date", "file"].includes(type) ? type
              : "text";
      const label = clean(
        (input.labels && input.labels[0]?.textContent)
        || element.getAttribute("aria-label")
        || element.closest("label")?.textContent,
      );
      return { name: input.name || undefined, id: element.id || undefined, label: label || undefined, controlType };
    }).catch(() => undefined);
    if (liveIdentity && liveIdentityMatchesField(field, liveIdentity)) return field;
  }
  const fields = await scanPage(page, { ats });
  return fields.find((candidate) => candidate.semanticId === field.semanticId)
    ?? fields.find((candidate) => candidate.fieldId === field.fieldId && fieldsSemanticallyMatch(candidate, field))
    ?? fields.find((candidate) => fieldsSemanticallyMatch(candidate, field));
}

export async function liveFieldLocator(
  page: Page,
  field: FieldDescriptor,
  ats?: AtsKind,
): Promise<{ field: FieldDescriptor; locator: Locator } | undefined> {
  const current = await refindField(page, field, ats);
  if (!current) return undefined;
  return { field: current, locator: runtimeFrame(page, current).locator(current.selector).first() };
}

export async function waitForDomSettled(page: Page, quietMs = 180, maximumMs = 1_800): Promise<void> {
  await page.evaluate(({ quiet, maximum }) => new Promise<void>((resolve) => {
    const root = document.body ?? document.documentElement;
    if (!root) return resolve();
    let quietTimer: ReturnType<typeof setTimeout>;
    let maximumTimer: ReturnType<typeof setTimeout>;
    const finish = () => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maximumTimer);
      resolve();
    };
    const arm = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quiet);
    };
    const observer = new MutationObserver(arm);
    observer.observe(root, { childList: true, subtree: true, attributes: true });
    maximumTimer = setTimeout(finish, maximum);
    arm();
  }), { quiet: quietMs, maximum: maximumMs }).catch(() => undefined);
}
