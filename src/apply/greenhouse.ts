import { Page } from "playwright";
import { Profile } from "../utils/config";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getFirstLastName(profile: Profile): { first: string; last: string } {
  if (profile.firstName || profile.lastName) {
    return { first: profile.firstName ?? "", last: profile.lastName ?? "" };
  }
  const parts = (profile.fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function normalizeYesNo(value: string | undefined, fallback: "Yes" | "No"): "Yes" | "No" {
  if (!value) return fallback;
  const v = value.toString().trim().toLowerCase();
  if (v.startsWith("y")) return "Yes";
  if (v.startsWith("n")) return "No";
  return fallback;
}

function normalizeGenderOptions(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const t = v.toLowerCase();
    if (t === "man" || t === "male") out.add("Male");
    else if (t === "woman" || t === "female") out.add("Female");
    else out.add(v);
  }
  return Array.from(out);
}

function extractStateOptions(location: string | undefined): string[] {
  if (!location) return [];
  const parts = location.split(",").map((p) => p.trim());
  if (parts.length < 2) return [];
  const state = parts[1];
  const map: Record<string, string> = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "Florida": "FL",
    "Georgia": "GA",
    "Hawaii": "HI",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY"
  };
  const abbr = map[state] ?? "";
  return abbr ? [state, abbr] : [state];
}

function normalizeVeteranOptions(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const t = v.toLowerCase();
    if (t.includes("not a veteran") || t.includes("not a protected")) {
      out.add("I am not a protected veteran");
    } else if (t.includes("protected veteran") || t.includes("identify")) {
      out.add("I identify as one or more of the classifications of a protected veteran");
    } else if (t.includes("don't wish") || t.includes("prefer not")) {
      out.add("I don't wish to answer");
    } else {
      out.add(v);
    }
  }
  return Array.from(out);
}

function normalizeDisabilityOptions(value: string | string[] | undefined): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const out = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    const t = v.toLowerCase();
    if (t.includes("no disability") || (t.includes("no") && t.includes("disability"))) {
      out.add("No, I do not have a disability and have not had one in the past");
    } else if (t.includes("yes") || t.includes("disability")) {
      out.add("Yes, I have a disability, or have had one in the past");
    } else if (t.includes("prefer not") || t.includes("do not want")) {
      out.add("I do not want to answer");
    } else {
      out.add(v);
    }
  }
  return Array.from(out);
}

async function fillInputIfEmpty(page: Page, selector: string, value: string) {
  if (!value) return false;
  const loc = page.locator(selector).first();
  try {
    if (!(await loc.isVisible({ timeout: 1200 }))) return false;
    const existing = await loc.inputValue().catch(() => "");
    if (existing && existing.trim().length > 0) return false;
    const existingAgain = await loc.inputValue().catch(() => "");
    if (existingAgain && existingAgain.trim().length > 0) return false;
    await loc.fill(value);
    return true;
  } catch {
    return false;
  }
}

async function readFirstVisibleValue(page: Page, selectors: string[]): Promise<string> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) {
        const val = await loc.inputValue().catch(() => "");
        if (typeof val === "string") return val.trim();
      }
    } catch {}
  }
  return "";
}

async function greenhouseAlreadyFilled(page: Page): Promise<boolean> {
  const first = await readFirstVisibleValue(page, [
    "input[name='job_application[first_name]']",
    "input[autocomplete='given-name']",
    "input[name*='first' i]"
  ]);
  const last = await readFirstVisibleValue(page, [
    "input[name='job_application[last_name]']",
    "input[autocomplete='family-name']",
    "input[name*='last' i]"
  ]);
  const email = await readFirstVisibleValue(page, ["input[name='job_application[email]']", "input[type='email']"]);
  const phone = await readFirstVisibleValue(page, ["input[name='job_application[phone]']", "input[type='tel']"]);

  return Boolean(first || last || email || phone);
}

async function myGreenhouseToastVisible(page: Page): Promise<boolean> {
  const toast = page.getByText(/Autofilled from MyGreenhouse/i).first();
  return await toast.isVisible({ timeout: 500 }).catch(() => false);
}

function normalizeDigits(input: string): string {
  return (input || "").replace(/\D/g, "");
}

async function fillPhoneIfEmptyOrFix(page: Page, phone: string) {
  if (!phone) return;
  const loc = page.locator("input[name='job_application[phone]'], input[type='tel']").first();
  if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return;

  const targetDigits = normalizeDigits(phone);
  const existing = await loc.inputValue().catch(() => "");
  const existingDigits = normalizeDigits(existing);

  if (existingDigits && targetDigits && existingDigits.includes(targetDigits)) {
    if (existingDigits === targetDigits + targetDigits) {
      await loc.fill(phone);
    }
    return;
  }

  if (!existingDigits) {
    await loc.fill(phone);
  }
}

async function uploadResumeIfPossible(page: Page, resumePdfPath: string) {
  if (!resumePdfPath) return false;
  const inputs = page.locator(
    "input[type='file'][name*='resume' i], input[type='file'][id*='resume' i], input[type='file']"
  );
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      await input.setInputFiles(resumePdfPath, { timeout: 7000 });
      return true;
    } catch {}
  }
  return false;
}

async function fillByLabelText(page: Page, labelText: string, value: string) {
  if (!value) return false;
  let label = page.locator("label", { hasText: new RegExp(escapeRegex(labelText), "i") }).first();
  try {
    if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) {
      label = page.getByText(new RegExp(escapeRegex(labelText), "i")).first();
      if (!(await label.isVisible({ timeout: 1200 }))) return false;
    }
    const forId = await label.getAttribute("for");
    if (forId) {
      return await fillInputIfEmpty(page, `#${forId}`, value);
    }
    const container = label.locator("xpath=ancestor::*[self::div or self::section][1]");
    const input = container.locator("input, textarea").first();
    if (await input.isVisible({ timeout: 1200 }).catch(() => false)) {
      const existing = await input.inputValue().catch(() => "");
      if (existing && existing.trim().length > 0) return false;
      await input.fill(value);
      return true;
    }
  } catch {}
  return false;
}

async function getFieldContainer(label: ReturnType<Page["getByText"]>) {
  const container = label.locator(
    "xpath=ancestor::*[self::div or self::section or self::fieldset][.//select or .//*[@role='combobox'] or .//div[contains(@class,'select__control')] or .//button[@aria-haspopup='listbox'] or .//input[@aria-autocomplete or @type='search']][1]"
  );
  try {
    if (await container.isVisible({ timeout: 1200 }).catch(() => false)) return container;
  } catch {}
  return null;
}

async function pickOptionFromOpenMenu(page: Page, optionText: string) {
  const menu = page
    .locator("div.select__menu, [role='listbox'], ul[role='listbox'], div.select__menu-list")
    .first();
  try {
    await menu.waitFor({ state: "visible", timeout: 2000 });
  } catch {
    return false;
  }

  const optionNodes = menu.locator("div.select__option, [role='option'], li[role='option']");

  const exact = menu.getByText(new RegExp(`^${escapeRegex(optionText)}$`, "i")).first();
  if (await exact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await exact.click({ force: true });
    return true;
  }

  const wordMatch = menu.getByText(new RegExp(`\\b${escapeRegex(optionText)}\\b`, "i")).first();
  if (await wordMatch.isVisible({ timeout: 1200 }).catch(() => false)) {
    await wordMatch.click({ force: true });
    return true;
  }

  const contains = menu.getByText(new RegExp(escapeRegex(optionText), "i")).first();
  if (await contains.isVisible({ timeout: 1200 }).catch(() => false)) {
    await contains.click({ force: true });
    return true;
  }

  const globalExact = page.locator("div.select__option, [role='option']").filter({
    hasText: new RegExp(`^${escapeRegex(optionText)}$`, "i")
  }).first();
  if (await globalExact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await globalExact.click({ force: true });
    return true;
  }

  const globalContains = page.locator("div.select__option, [role='option']").filter({
    hasText: new RegExp(`\\b${escapeRegex(optionText)}\\b`, "i")
  }).first();
  if (await globalContains.isVisible({ timeout: 1200 }).catch(() => false)) {
    await globalContains.click({ force: true });
    return true;
  }

  return false;
}

async function pickExactOptionFromOpenMenu(page: Page, optionText: string) {
  const menu = page
    .locator("div.select__menu, [role='listbox'], ul[role='listbox'], div.select__menu-list")
    .first();
  try {
    await menu.waitFor({ state: "visible", timeout: 2000 });
  } catch {
    return false;
  }

  const exact = menu.getByRole("option", { name: optionText, exact: true }).first();
  if (await exact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await exact.click({ force: true });
    return true;
  }

  const fallbackExact = menu.getByText(new RegExp(`^${escapeRegex(optionText)}$`, "i")).first();
  if (await fallbackExact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await fallbackExact.click({ force: true });
    return true;
  }

  const globalExact = page
    .locator("div.select__option, [role='option']")
    .filter({ hasText: new RegExp(`^${escapeRegex(optionText)}$`, "i") })
    .first();
  if (await globalExact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await globalExact.click({ force: true });
    return true;
  }

  return false;
}

async function selectByLabelDropdownInternal(
  page: Page,
  label: ReturnType<Page["locator"]>,
  options: string[],
  strict: boolean
) {
  try {
    if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) return false;
    await label.scrollIntoViewIfNeeded().catch(() => {});
    const container = await getFieldContainer(label);
    if (!container) return false;

    const selectValue = await container.locator("select").first().inputValue().catch(() => "");
    if (selectValue && selectValue.trim().length > 0) return true;

    const singleValue = await container.locator(".select__single-value").first().textContent().catch(() => "");
    if (singleValue && singleValue.trim().length > 0) return true;

    const inputValue = await container
      .locator("input[aria-autocomplete], input[type='search'], div.select__input input")
      .first()
      .inputValue()
      .catch(() => "");
    if (inputValue && inputValue.trim().length > 0) return true;

    const select = label.locator("xpath=following::select[1]");
    if (await select.isVisible({ timeout: 800 }).catch(() => false)) {
      for (const opt of options) {
        if (!opt) continue;
        try {
          await select.selectOption({ label: opt });
          return true;
        } catch {}
      }
    }

    const control = label.locator(
      "xpath=following::*[self::div[contains(@class,'select__control')] or self::button[@aria-haspopup='listbox'] or self::input[@aria-autocomplete or @type='search'] or self::*[@role='combobox']][1]"
    );
    const combo = (await control.isVisible({ timeout: 800 }).catch(() => false))
      ? control
      : container
          .locator(
            "div.select__control, [role='combobox'], button[aria-haspopup='listbox'], input[aria-autocomplete], input[type='search']"
          )
          .first();

    if (await combo.isVisible({ timeout: 800 }).catch(() => false)) {
      await combo.click();
      for (const opt of options) {
        if (!opt) continue;
        const input = container.locator("input[aria-autocomplete], input[type='search'], div.select__input input").first();
        if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
          await input.fill("");
          await input.type(opt, { delay: 30 });
          await page.waitForTimeout(150);
        }
        if (!strict) {
          await page.keyboard.press("ArrowDown").catch(() => {});
          await page.keyboard.press("Enter").catch(() => {});
        }
        if (await pickOptionFromOpenMenu(page, opt)) return true;
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
  } catch {}

  return false;
}

async function selectByLabelDropdown(page: Page, labelText: string, optionText: string | string[]) {
  const options = Array.isArray(optionText) ? optionText : [optionText];
  let label = page.locator("label", { hasText: new RegExp(escapeRegex(labelText), "i") }).first();
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) {
    label = page.getByText(new RegExp(escapeRegex(labelText), "i")).first();
  }
  return selectByLabelDropdownInternal(page, label, options, false);
}

async function selectByLabelDropdownExact(page: Page, labelText: string, optionText: string | string[]) {
  const options = Array.isArray(optionText) ? optionText : [optionText];
  let label = page.locator("label", { hasText: new RegExp(escapeRegex(labelText), "i") }).first();
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) {
    label = page.getByText(new RegExp(escapeRegex(labelText), "i")).first();
  }
  try {
    if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) return false;
    await label.scrollIntoViewIfNeeded().catch(() => {});
    const container = await getFieldContainer(label);
    if (!container) return false;

    const control = label.locator(
      "xpath=following::*[self::div[contains(@class,'select__control')] or self::button[@aria-haspopup='listbox'] or self::input[@aria-autocomplete or @type='search'] or self::*[@role='combobox']][1]"
    );
    const combo = (await control.isVisible({ timeout: 800 }).catch(() => false))
      ? control
      : container
          .locator(
            "div.select__control, [role='combobox'], button[aria-haspopup='listbox'], input[aria-autocomplete], input[type='search']"
          )
          .first();

    if (!(await combo.isVisible({ timeout: 800 }).catch(() => false))) return false;
    await combo.click();
    for (const opt of options) {
      if (!opt) continue;
      const input = container.locator("input[aria-autocomplete], input[type='search'], div.select__input input").first();
      if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
        await input.fill("");
        await input.type(opt, { delay: 30 });
        await page.keyboard.press("Enter").catch(() => {});
      }
      if (await pickExactOptionFromOpenMenu(page, opt)) return true;
    }
    await page.keyboard.press("Escape").catch(() => {});
  } catch {}

  return false;
}

async function selectCountry(page: Page, value: string) {
  let label = page.locator("label", { hasText: /^Country\b/i }).first();
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) {
    label = page.getByText(/^Country\b/i).first();
  }
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) return false;
  const options = [value, `${value} (+1)`, "+1", "US (+1)"];
  if (await selectByLabelDropdownInternal(page, label, options, true)) return true;
  return fillByLabelText(page, "Country", value);
}

async function tryMyGreenhouseAutofill(page: Page) {
  const btn = page.getByRole("button", { name: /Autofill with My\s*Greenhouse/i }).first();
  for (let i = 0; i < 3; i++) {
    try {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ force: true });
        await page.waitForTimeout(1500);
        return true;
      }
    } catch {}
    await page.waitForTimeout(800);
  }
  return false;
}

async function selectState(page: Page, options: string[]) {
  let label = page.locator("label", { hasText: /^State\b/i }).first();
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) {
    label = page.getByText(/^State\b/i).first();
  }
  if (!(await label.isVisible({ timeout: 1200 }).catch(() => false))) return false;
  if (await selectByLabelDropdownInternal(page, label, options, true)) return true;
  return fillByLabelText(page, "State", options[0] ?? "");
}

async function selectByLabelText(page: Page, labelText: string, optionText: string | string[]) {
  const options = Array.isArray(optionText) ? optionText : [optionText];
  const label = page.getByText(new RegExp(escapeRegex(labelText), "i")).first();
  try {
    if (!(await label.isVisible({ timeout: 1200 }))) return false;
    const forId = await label.getAttribute("for");
    if (forId) {
      const select = page.locator(`#${forId}`).first();
      if (await select.isVisible({ timeout: 1200 }).catch(() => false)) {
        for (const opt of options) {
          if (!opt) continue;
          try {
            await select.selectOption({ label: opt });
            return true;
          } catch {}
        }
      }
    }

    const container = label.locator("xpath=ancestor::*[self::div or self::section][1]");
    const select = container.locator("select").first();
    if (await select.isVisible({ timeout: 1200 }).catch(() => false)) {
      for (const opt of options) {
        if (!opt) continue;
        try {
          await select.selectOption({ label: opt });
          return true;
        } catch {}
      }
    }
  } catch {}

  return false;
}

async function answerYesNo(page: Page, questionText: string, answer: "Yes" | "No") {
  const label = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await label.isVisible({ timeout: 1200 }))) return false;
    const container = label.locator("xpath=ancestor::*[self::fieldset or self::div or self::section][1]");
    const radios = container.locator("input[type='radio']");
    const radioCount = await radios.count().catch(() => 0);
    if (radioCount > 0) {
      const optLabel = container.getByText(new RegExp(`^${escapeRegex(answer)}$`, "i")).first();
      if (await optLabel.isVisible({ timeout: 1200 }).catch(() => false)) {
        await optLabel.click();
        return true;
      }
    }

    if (await selectByLabelDropdown(page, questionText, answer)) return true;
  } catch {}
  return false;
}

async function defaultYesForYesNoSelects(page: Page) {
  const selects = page.locator("select");
  const count = await selects.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const sel = selects.nth(i);
    try {
      if (!(await sel.isVisible({ timeout: 800 }))) continue;
      const current = await sel.inputValue().catch(() => "");
      if (current && current.trim().length > 0) continue;
      const options = await sel.locator("option").allTextContents();
      const hasYes = options.some((t) => /^yes$/i.test(t.trim()));
      const hasNo = options.some((t) => /^no$/i.test(t.trim()));
      if (hasYes && hasNo) {
        await sel.selectOption({ label: "Yes" });
      }
    } catch {}
  }
}

export async function autofillGreenhouse(page: Page, profile: Profile) {
  await page.waitForTimeout(1200);
  if (await myGreenhouseToastVisible(page)) {
    console.log("[Greenhouse] MyGreenhouse already autofilled; skipping manual fill.");
    return;
  }
  console.log("[Greenhouse] Running manual autofill (MyGreenhouse disabled).");

  const { first, last } = getFirstLastName(profile);

  await fillInputIfEmpty(page, "input[name='job_application[first_name]']", first);
  await fillInputIfEmpty(page, "input[name='job_application[last_name]']", last);
  await fillInputIfEmpty(page, "input[name='job_application[email]']", profile.email);
  await fillPhoneIfEmptyOrFix(page, profile.phone);

  await fillInputIfEmpty(page, "input[name*='first' i]", first);
  await fillInputIfEmpty(page, "input[name*='last' i]", last);
  await fillInputIfEmpty(page, "input[type='email']", profile.email);
  await fillPhoneIfEmptyOrFix(page, profile.phone);

  await fillByLabelText(page, "First Name", first);
  await fillByLabelText(page, "Last Name", last);
  await fillByLabelText(page, "Email", profile.email);
  await fillPhoneIfEmptyOrFix(page, profile.phone);
  if (await myGreenhouseToastVisible(page)) {
    console.log("[Greenhouse] MyGreenhouse autofill detected mid-run; stopping manual fill.");
    return;
  }
  await selectCountry(page, "United States");
  const stateOptions = extractStateOptions(profile.location);
  if (stateOptions.length > 0) {
    await selectState(page, stateOptions);
  }
  await selectByLabelDropdown(page, "Location", profile.location);
  await selectByLabelDropdown(page, "Location (City)", profile.location);
  await selectByLabelDropdown(page, "Current Location", profile.location);
  await fillByLabelText(page, "Location", profile.location);
  await fillByLabelText(page, "Location (City)", profile.location);
  await fillByLabelText(page, "Current Location", profile.location);

  await fillByLabelText(page, "LinkedIn", profile.linkedin);
  await fillByLabelText(page, "LinkedIn Profile", profile.linkedin);
  await fillByLabelText(page, "Website", profile.portfolio);
  await fillByLabelText(page, "Portfolio", profile.portfolio);
  await fillByLabelText(page, "GitHub", profile.github);

  const uploaded = await uploadResumeIfPossible(page, profile.resumePdfPath);
  if (!uploaded) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await uploadResumeIfPossible(page, profile.resumePdfPath);
  }

  const authYesNo = normalizeYesNo(
    profile.workAuthorization?.authorizedToWorkInUS ?? profile.defaults?.authorizedToWork,
    "Yes"
  );
  const sponsorNow = normalizeYesNo(profile.sponsorship?.requiresSponsorshipNow ?? profile.defaults?.needsSponsorship, "Yes");
  const sponsorFuture = normalizeYesNo(
    profile.sponsorship?.requiresSponsorshipInFuture ?? profile.defaults?.willNowOrInFutureRequireSponsorship,
    "Yes"
  );
  const veteranYesNo = normalizeYesNo(profile.veteran ?? profile.eeo?.veteranStatus, "No");

  await answerYesNo(page, "Are you authorized to work", authYesNo);
  await answerYesNo(page, "authorized to work", authYesNo);
  await answerYesNo(page, "Do you require sponsorship", sponsorNow);
  await answerYesNo(page, "Will you now or in the future require sponsorship", sponsorFuture);
  await answerYesNo(page, "Do you identify as a veteran", veteranYesNo);
  await answerYesNo(page, "Are you a veteran", veteranYesNo);

  if (profile.eeo) {
    const eeoAnchor = page.getByText(/Voluntary Self-Identification|Gender|Veteran Status|Disability Status/i).first();
    await eeoAnchor.scrollIntoViewIfNeeded().catch(() => {});
    await selectByLabelDropdownExact(page, "Gender", normalizeGenderOptions(profile.eeo.gender));
    await selectByLabelDropdown(page, "Are you Hispanic/Latino", profile.eeo.hispanicOrLatino);
    await selectByLabelDropdown(page, "Race", profile.eeo.raceEthnicity);
    await selectByLabelDropdown(page, "Please identify your race", profile.eeo.raceEthnicity);
    await selectByLabelDropdown(page, "Veteran Status", normalizeVeteranOptions(profile.eeo.veteranStatus));
    await selectByLabelDropdown(page, "Disability Status", normalizeDisabilityOptions(profile.eeo.disabilityStatus));
  }

  await fillPhoneIfEmptyOrFix(page, profile.phone);

  console.log("[Greenhouse] autofill completed (best-effort).");
}
