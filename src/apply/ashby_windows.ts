import { Page, Locator } from "playwright";
import { Profile } from "../utils/config";

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toAshbyApplicationUrl(currentUrl: string): string | null {
  try {
    const u = new URL(currentUrl);
    if (!u.hostname.includes("ashbyhq.com")) return null;

    if (u.pathname.endsWith("/application")) return u.toString();

    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    const company = parts[0];
    const jobId = parts[1];

    u.pathname = `/${company}/${jobId}/application`;
    return u.toString();
  } catch {
    return null;
  }
}

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  if (!value) return false;

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) {
        await loc.fill(value);
        return true;
      }
    } catch {}
  }
  return false;
}

async function clickFirstVisible(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1200 })) {
        await loc.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function uploadResumeIfPossible(page: Page, resumePdfPath: string) {
  if (!resumePdfPath) return false;

  const inputs = page.locator("input[type='file']");
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

function shouldFill(existing: string) {
  return !existing || existing.trim().length === 0;
}

function normalizeYesNo(value: string | undefined, fallback: "Yes" | "No"): "Yes" | "No" {
  if (!value) return fallback;
  const v = value.toString().trim().toLowerCase();
  if (v.startsWith("y")) return "Yes";
  if (v.startsWith("n")) return "No";
  return fallback;
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

/**
 * Detect "ALL CAPS NAME" (allow spaces, hyphens, apostrophes, dots).
 * We want to avoid treating emails/ids as names, so require at least 2 words.
 */
function looksAllCapsName(s: string) {
  const t = (s || "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  // If it has any lowercase letters, it's not ALL CAPS
  if (/[a-z]/.test(t)) return false;
  // Must have at least one A-Z
  if (!/[A-Z]/.test(t)) return false;
  // Only allow typical name punctuation
  if (!/^[A-Z\s.'-]+$/.test(t)) return false;
  return true;
}

/**
 * Convert ALL CAPS name to "Title Case" while preserving:
 * - hyphens: "ANNA-MARIA" -> "Anna-Maria"
 * - apostrophes: "O'NEIL" -> "O'Neil"
 * - suffixes: II, III, IV stay uppercase
 * - common particles: "de", "van", "von", "da", "dos", "del" stay lowercase (unless first word)
 */
function toProperNameCase(allCaps: string) {
  const suffixes = new Set(["II", "III", "IV", "V"]);
  const lowercaseParticles = new Set(["DE", "DA", "DOS", "DEL", "VAN", "VON", "DI", "LA", "LE"]);

  const parts = allCaps.trim().split(/\s+/).filter(Boolean);

  const cased = parts.map((p, idx) => {
    const raw = p.trim();

    // Preserve suffixes like II/III/IV
    if (suffixes.has(raw)) return raw;

    // Preserve Jr/Sr if present in caps
    if (raw === "JR" || raw === "SR") return raw[0] + raw.slice(1).toLowerCase() + ".";

    // Particles lowercased when not first token
    if (idx !== 0 && lowercaseParticles.has(raw)) return raw.toLowerCase();

    // Handle hyphenated and apostrophe names
    const subParts = raw.split(/([-'’])/); // keep separators
    const fixed = subParts
      .map((seg) => {
        if (seg === "-" || seg === "'" || seg === "’") return seg;
        if (!seg) return seg;
        return seg[0].toUpperCase() + seg.slice(1).toLowerCase();
      })
      .join("");

    // Handle things like "MCGEE" -> "Mcgee" (good enough for most; custom rules can be added)
    return fixed;
  });

  return cased.join(" ");
}

/**
 * Strictly find a question "block" around a question text.
 */
async function getQuestionBlock(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    for (let level = 1; level <= 10; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section][${level}]`);
      const inputs = await block.locator("input").count().catch(() => 999);
      if (inputs <= 40) return block;
    }
  } catch {}

  return null;
}

async function getComboboxInputForQuestion(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    const block = await getQuestionBlock(page, questionText);
    if (!block) return null;

    const qInBlock = block.getByText(new RegExp(escapeRegex(questionText), "i")).first();

    const inputAfter = qInBlock.locator(
      "xpath=following::input[@role='combobox' or @aria-autocomplete or contains(translate(@placeholder,'START TYPING','start typing'),'start typing')][1]"
    );

    if (await inputAfter.isVisible({ timeout: 1500 }).catch(() => false)) return inputAfter;

    const fallback = block
      .locator("input[role='combobox'], input[aria-autocomplete], input[placeholder*='Start typing' i]")
      .first();

    if (await fallback.isVisible({ timeout: 1500 }).catch(() => false)) return fallback;
  } catch {}

  return null;
}

async function getYesNoQuestionBlock(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    for (let level = 1; level <= 10; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section][${level}]`);
      const yesOk = (await block.locator("button:has-text('Yes')").count().catch(() => 0)) > 0;
      const noOk = (await block.locator("button:has-text('No')").count().catch(() => 0)) > 0;
      if (yesOk && noOk) return block;
    }
  } catch {}

  return null;
}

async function getRadioQuestionBlock(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    for (let level = 1; level <= 12; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section][${level}]`);
      const inputs = await block.locator("input").count().catch(() => 999);
      if (inputs <= 60) return block;
    }
  } catch {}

  return null;
}

async function answerYesNo(page: Page, questionText: string, answer: "Yes" | "No") {
  const block = await getYesNoQuestionBlock(page, questionText);
  if (!block) {
    return selectRadioOption(page, questionText, answer);
  }

  const btn = block.locator(`button:has-text("${answer}")`).first();
  try {
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click();
      return true;
    }
  } catch {}

  return false;
}

async function selectRadioOption(page: Page, questionText: string, optionText: string) {
  const block = await getRadioQuestionBlock(page, questionText);
  if (!block) return false;

  const optExact = block.getByText(new RegExp(`^${escapeRegex(optionText)}$`, "i")).first();
  try {
    if (await optExact.isVisible({ timeout: 2000 })) {
      await optExact.scrollIntoViewIfNeeded().catch(() => {});
      await optExact.click();
      return true;
    }
  } catch {}

  const optContains = block.getByText(new RegExp(escapeRegex(optionText), "i")).first();
  try {
    if (await optContains.isVisible({ timeout: 2000 })) {
      await optContains.scrollIntoViewIfNeeded().catch(() => {});
      await optContains.click();
      return true;
    }
  } catch {}

  return false;
}

async function fillComboboxForQuestion(page: Page, questionText: string, value: string) {
  if (!value) return false;

  const input = await getComboboxInputForQuestion(page, questionText);
  if (!input) return false;

  try {
    if (!(await input.isVisible({ timeout: 2500 }))) return false;

    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click();

    await input.fill("");
    await input.type(value, { delay: 35 });

    const options = page.locator("[role='option']");
    let optionsVisible = false;
    try {
      await options.first().waitFor({ state: "visible", timeout: 2500 });
      optionsVisible = true;
    } catch {
      optionsVisible = false;
    }

    const exact = page.locator("[role='option']").filter({ hasText: value }).first();
    if (await exact.isVisible({ timeout: 1500 }).catch(() => false)) {
      await exact.click();
      return true;
    }

    if (optionsVisible) {
      const first = page.locator("[role='option']").first();
      if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
        await first.click();
        return true;
      }
    }

    await input.press("ArrowDown");
    await input.press("Enter");
    return true;
  } catch {}

  return false;
}

async function selectByVisibleOptionAnywhere(page: Page, optionText: string | string[]) {
  const options = Array.isArray(optionText) ? optionText : [optionText];
  for (const opt of options) {
    if (!opt) continue;

    const exact = page.getByText(new RegExp(`^${escapeRegex(opt)}$`, "i")).first();
    try {
      if (await exact.isVisible({ timeout: 1500 })) {
        await exact.scrollIntoViewIfNeeded().catch(() => {});
        await exact.click();
        return true;
      }
    } catch {}

    const contains = page.getByText(new RegExp(escapeRegex(opt), "i")).first();
    try {
      if (await contains.isVisible({ timeout: 1500 })) {
        await contains.scrollIntoViewIfNeeded().catch(() => {});
        await contains.click();
        return true;
      }
    } catch {}
  }

  return false;
}

export async function autofillAshby(page: Page, profile: Profile) {
  const cur = page.url();
  const appUrl = toAshbyApplicationUrl(cur);

  console.log(`[Ashby] current url: ${cur}`);
  if (appUrl && appUrl !== cur) {
    console.log(`[Ashby] navigating to /application: ${appUrl}`);
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);
  }
  console.log(`[Ashby] url after route fix: ${page.url()}`);

  try {
    await Promise.race([
      page.waitForSelector("input[autocomplete='name']", { timeout: 12000 }),
      page.waitForSelector("input[type='email']", { timeout: 12000 }),
      page.waitForSelector("input", { timeout: 12000 })
    ]);
  } catch {
    console.log("[Ashby] could not confirm fields appeared (continuing anyway).");
  }

  // Upload resume early
  const uploaded = await uploadResumeIfPossible(page, profile.resumePdfPath);
  console.log(`[Ashby] resume upload attempted: ${uploaded}`);
  if (uploaded) await page.waitForTimeout(2200);

  const nameSelectors = ["input[autocomplete='name']", "input[name='name']", "input[placeholder*='Name' i]"];
  const firstNameSelectors = [
    "input[autocomplete='given-name']",
    "input[name*='first' i]",
    "input[placeholder*='First' i]",
    "input[id*='first' i]"
  ];
  const lastNameSelectors = [
    "input[autocomplete='family-name']",
    "input[name*='last' i]",
    "input[placeholder*='Last' i]",
    "input[id*='last' i]"
  ];
  const emailSelectors = ["input[type='email']", "input[autocomplete='email']", "input[name='email']"];
  const phoneSelectors = ["input[type='tel']", "input[autocomplete='tel']", "input[name='phone']"];

  const existingName = await readFirstVisibleValue(page, nameSelectors);
  const existingFirst = await readFirstVisibleValue(page, firstNameSelectors);
  const existingLast = await readFirstVisibleValue(page, lastNameSelectors);
  const existingEmail = await readFirstVisibleValue(page, emailSelectors);
  const existingPhone = await readFirstVisibleValue(page, phoneSelectors);

  const { first, last } = getFirstLastName(profile);

  // ✅ If Ashby filled ALL CAPS name, fix casing to proper-case
  if (looksAllCapsName(existingName)) {
    const fixed = toProperNameCase(existingName);
    console.log(`[Ashby] fixing ALL CAPS name "${existingName}" -> "${fixed}"`);
    await fillFirstVisible(page, nameSelectors, fixed);
  } else if (shouldFill(existingName)) {
    await fillFirstVisible(page, nameSelectors, profile.fullName);
  } else {
    console.log(`[Ashby] keeping name: "${existingName}"`);
  }

  if (shouldFill(existingFirst)) {
    await fillFirstVisible(page, firstNameSelectors, first);
  }

  if (shouldFill(existingLast)) {
    await fillFirstVisible(page, lastNameSelectors, last);
  }

  if (shouldFill(existingEmail)) {
    await fillFirstVisible(page, emailSelectors, profile.email);
  }

  if (shouldFill(existingPhone)) {
    await fillFirstVisible(page, phoneSelectors, profile.phone);
  }

  // Links
  await fillFirstVisible(page, ["input[name*='linkedin' i]", "input[placeholder*='LinkedIn' i]"], profile.linkedin);
  await fillFirstVisible(page, ["input[name*='github' i]", "input[placeholder*='GitHub' i]"], profile.github);
  await fillFirstVisible(
    page,
    ["input[name*='portfolio' i]", "input[name*='website' i]", "input[placeholder*='Portfolio' i]", "input[placeholder*='Website' i]"],
    profile.portfolio
  );

  // Dropdowns
  await fillComboboxForQuestion(page, "Current Location", profile.location);

  if (profile.workAuthorization?.currentStatus) {
    await fillComboboxForQuestion(page, "What is your current U.S. work authorization status", profile.workAuthorization.currentStatus);
    await fillComboboxForQuestion(page, "current U.S. work authorization status", profile.workAuthorization.currentStatus);
    await fillComboboxForQuestion(page, "U.S. work authorization status", profile.workAuthorization.currentStatus);
  }

  // Yes/No questions
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

  const pref = profile.preferences?.willingToRelocateOrCommute ?? "Yes";
  const prefAns: "Yes" | "No" = pref.toLowerCase().startsWith("y") ? "Yes" : "No";

  await answerYesNo(page, "Are you willing to relocate", prefAns);
  await answerYesNo(page, "Are you willing to commute", prefAns);
  await answerYesNo(page, "willing to relocate", prefAns);
  await answerYesNo(page, "willing to commute", prefAns);

  await answerYesNo(page, "Are you excited to work from our", "Yes");
  await answerYesNo(page, "Are you excited to work in our office", "Yes");

  // Experience radio
  await selectRadioOption(
    page,
    "How many years of professional (paid) experience do you have building production full-stack applications",
    "I'm an expert (5+ years)"
  );

  // EEO
  if (profile.eeo) {
    await clickFirstVisible(page, [
      "button:has-text('Voluntary')",
      "button:has-text('Self-Identification')",
      "button:has-text('Equal Opportunity')",
      "button:has-text('EEO')"
    ]);

    await selectByVisibleOptionAnywhere(page, profile.eeo.gender);
    await selectByVisibleOptionAnywhere(page, profile.eeo.raceEthnicity);
    await selectByVisibleOptionAnywhere(page, profile.eeo.hispanicOrLatino);
    await selectByVisibleOptionAnywhere(page, profile.eeo.veteranStatus);
    await selectByVisibleOptionAnywhere(page, profile.eeo.disabilityStatus);
  }

  console.log("[Ashby] autofill completed (best-effort).");
  await page.waitForTimeout(400);
}
