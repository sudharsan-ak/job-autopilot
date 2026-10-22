import type { Page } from "playwright";
import type { AtsKind } from "../types.js";
import type { RuntimeProfile } from "../profile/loader.js";

async function addRows(page: Page, selectors: string[], desired: number, existingLabels: RegExp): Promise<number> {
  if (desired <= 1) return 0;
  const existing = await page.locator("label, legend").filter({ hasText: existingLabels }).count().catch(() => 0);
  let additions = Math.max(0, desired - existing);
  let clicked = 0;
  while (additions > 0) {
    let buttonFound = false;
    for (const selector of selectors) {
      const button = page.locator(selector).last();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        await page.waitForTimeout(150);
        clicked += 1;
        additions -= 1;
        buttonFound = true;
        break;
      }
    }
    if (!buttonFound) break;
  }
  return clicked;
}

async function countGenericRecords(page: Page, kind: "employment" | "education"): Promise<number> {
  return page.evaluate((recordKind) => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>("input,textarea,select,[role='combobox']"));
    const pattern = recordKind === "employment"
      ? /(?:employment|experience|work(?:_|-)?history|jobs?)[_\[\]-]*(\d+)/i
      : /(?:education|schools?)[_\[\]-]*(\d+)/i;
    const indexes = new Set<string>();
    for (const control of controls) {
      const identity = `${control.id} ${(control as HTMLInputElement).name ?? ""}`;
      const match = identity.match(pattern);
      if (match?.[1]) indexes.add(match[1]);
    }
    if (indexes.size > 0) return indexes.size;

    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const labels = Array.from(document.querySelectorAll("label,legend"))
      .map((element) => clean(element.textContent).replace(/\*+$/, "").trim());
    const recordLabel = recordKind === "employment"
      ? /^(company name|company|employer)$/i
      : /^(school|school name|university|institution|institution name)$/i;
    return labels.filter((label) => recordLabel.test(label)).length;
  }, kind);
}

async function findGenericAddButton(page: Page, kind: "employment" | "education") {
  const buttons = page.locator("button");
  const count = await buttons.count();
  let best: { index: number; score: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const score = await button.evaluate((element, recordKind) => {
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = clean([
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
      ].filter(Boolean).join(" "));
      let ancestor: Element | null = element.parentElement;
      let context = "";
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        context += ` ${clean(ancestor.querySelector("h1,h2,h3,h4,legend,[role='heading']")?.textContent)}`;
      }
      const buttonTop = element.getBoundingClientRect().top;
      const precedingLabels = Array.from(document.querySelectorAll("label,legend"))
        .map((label) => ({ text: clean(label.textContent), distance: buttonTop - label.getBoundingClientRect().top }))
        .filter((candidate) => candidate.distance >= 0)
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 8)
        .map((candidate) => candidate.text)
        .join(" ");
      const kindWords = recordKind === "employment" ? /employment|work experience/ : /education|school/;
      const fieldWords = recordKind === "employment"
        ? /company name|job title|start date|end date|current role/
        : /school|university|degree|discipline|field of study/;
      let value = 0;
      if (/add|another/.test(text)) value += 2;
      if (kindWords.test(text)) value += 6;
      if (kindWords.test(context)) value += 4;
      if (fieldWords.test(precedingLabels)) value += 4;
      if (/submit|apply|delete|remove|clear/.test(text)) value = -100;
      return value;
    }, kind);
    if (score > (best?.score ?? 0)) best = { index, score };
  }
  return best && best.score >= 4 ? buttons.nth(best.index) : undefined;
}

async function expandGenericRecords(page: Page, kind: "employment" | "education", desired: number): Promise<number> {
  if (desired <= 1) return 0;
  let existing = await countGenericRecords(page, kind);
  let added = 0;
  while (existing > 0 && existing < desired) {
    const button = await findGenericAddButton(page, kind);
    if (!button) break;
    await button.click({ timeout: 2_000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    const updated = await countGenericRecords(page, kind);
    if (updated <= existing) break;
    added += updated - existing;
    existing = updated;
  }
  return added;
}

export async function expandKnownRepeaters(page: Page, ats: AtsKind, profile: RuntimeProfile): Promise<{ employment: number; education: number }> {
  if (ats === "WORKDAY") {
    const employment = await addRows(
      page,
      [
        "button[data-automation-id='addAnotherWorkExperience']",
        "button[data-automation-id='workExperienceAddButton']",
        "button:has-text('Add Another Work Experience')",
        "button:has-text('Add Work Experience')",
      ],
      profile.employmentHistory.length,
      /^(Employer|Company|Company Name)$/i,
    );
    const education = await addRows(
      page,
      [
        "button[data-automation-id='addAnotherEducation']",
        "button[data-automation-id='educationAddButton']",
        "button:has-text('Add Another Education')",
        "button:has-text('Add Education')",
      ],
      profile.educationHistory.length,
      /^(Institution|Institution Name|School|University)$/i,
    );
    return { employment, education };
  }

  const employment = await expandGenericRecords(page, "employment", profile.employmentHistory.length);
  const education = await expandGenericRecords(page, "education", profile.educationHistory.length);
  return { employment, education };
}
