import type { Frame, Locator, Page } from "playwright";
import type { AtsKind, FieldDescriptor } from "../types.js";
import { liveFieldLocator } from "./fieldRuntime.js";

export function frameForField(page: Page, field: FieldDescriptor): Frame {
  if (field.frameIndex !== undefined) {
    const indexed = page.frames()[field.frameIndex];
    if (indexed) return indexed;
  }
  return page.frames().find((frame) => frame.url() === field.frameUrl) ?? page.mainFrame();
}

async function checkedOption(locator: Locator, roleBased: boolean): Promise<string | undefined> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const option = locator.nth(index);
    const checked = roleBased
      ? await option.getAttribute("aria-checked").then((value) => value === "true").catch(() => false)
      : await option.isChecked().catch(() => false);
    if (!checked) continue;
    return option.evaluate((element: HTMLElement) => {
      const input = element as HTMLInputElement;
      return (input.labels?.[0]?.textContent
        ?? element.getAttribute("aria-label")
        ?? element.textContent
        ?? input.value
        ?? "").replace(/\s+/g, " ").trim();
    });
  }
  return undefined;
}

async function committedComboboxValue(page: Page, field: FieldDescriptor, locator: Locator): Promise<string | undefined> {
  const direct = await locator.inputValue().catch(async () =>
    (await locator.getAttribute("aria-valuetext")) ?? (await locator.textContent()) ?? "",
  );
  if (direct?.trim()) return direct.replace(/\s+/g, " ").trim();
  const frame = frameForField(page, field);
  const root = field.fieldRootSelector ? frame.locator(field.fieldRootSelector).first() : locator;
  for (const selector of field.selectedValueSelectors ?? []) {
    const selected = root.locator(selector).first();
    if (!await selected.count().catch(() => 0)) continue;
    const value = ((await selected.getAttribute("aria-label").catch(() => null))
      ?? (await selected.textContent().catch(() => null))
      ?? "").replace(/\s+/g, " ").trim();
    if (value && !/^(select|choose)(\.{3})?$/i.test(value)) return value;
  }
  return undefined;
}

export async function readFieldValue(
  page: Page,
  field: FieldDescriptor,
  ats?: AtsKind,
): Promise<string | boolean | undefined> {
  const live = await liveFieldLocator(page, field, ats);
  if (!live) return undefined;
  const current = live.field;
  const locator = frameForField(page, current).locator(current.selector);
  if (current.controlType === "radio") {
    return checkedOption(locator, current.widgetKind === "role-radio-group");
  }
  if (current.controlType === "checkbox") {
    if (current.widgetKind === "role-checkbox") {
      return locator.first().getAttribute("aria-checked").then((value) => value === "true");
    }
    return locator.first().isChecked().catch(() => false);
  }
  if (current.controlType === "select") {
    return locator.first().evaluate((element: HTMLSelectElement) =>
      Array.from(element.selectedOptions).map((option) => option.textContent?.trim() ?? option.value).join(", "),
    );
  }
  if (current.controlType === "combobox") return committedComboboxValue(page, current, locator.first());
  if (current.controlType === "file") {
    const fileName = await locator.first().evaluate((element: HTMLInputElement) => element.files?.[0]?.name).catch(() => undefined);
    if (fileName) return fileName;
    if (current.fieldRootSelector) {
      const text = await frameForField(page, current).locator(current.fieldRootSelector).first().innerText().catch(() => "");
      const match = text.match(/[^\\/]+\.(?:pdf|docx?|rtf)\b/i);
      if (match) return match[0];
    }
    return undefined;
  }
  return locator.first().inputValue().catch(() => locator.first().textContent().then((value) => value?.trim()));
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export function valuesMatch(expected: string | boolean, observed: string | boolean | undefined): boolean {
  if (typeof expected === "boolean") {
    if (typeof observed === "boolean") return observed === expected;
    if (typeof observed !== "string") return false;
    const actual = normalized(observed);
    return expected ? ["yes", "true", "authorized", "willing"].includes(actual) : ["no", "false", "not authorized", "not willing"].includes(actual);
  }
  if (typeof observed !== "string") return false;
  const wanted = normalized(expected);
  const actual = normalized(observed);
  if (wanted === actual) return true;
  const wantedDigits = expected.replace(/\D/g, "");
  const actualDigits = observed.replace(/\D/g, "");
  if (wantedDigits.length >= 7 && wantedDigits === actualDigits) return true;
  if (actual.startsWith(`${wanted} `)) return true;
  const countryAliases: Record<string, string[]> = {
    "united states": ["united states of america", "usa", "us"],
    usa: ["united states", "united states of america", "us"],
  };
  return (countryAliases[wanted] ?? []).includes(actual);
}
