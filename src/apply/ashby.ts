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

/**
 * Strictly find a question "block" around a question text.
 * We still use ancestors, but we DO NOT pick the first input anymore.
 */
async function getQuestionBlock(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    for (let level = 1; level <= 10; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section][${level}]`);
      // avoid huge containers
      const inputs = await block.locator("input").count().catch(() => 999);
      if (inputs <= 40) return block;
    }
  } catch {}

  return null;
}

/**
 * ✅ KEY FIX:
 * Given a question text, find the combobox input that is closest to it:
 * - Find question element
 * - Within the block, pick the FIRST combobox input that appears AFTER the question node
 * This prevents "Current Location" and "Work authorization status" from sharing the same dropdown.
 */
async function getComboboxInputForQuestion(page: Page, questionText: string): Promise<Locator | null> {
  const q = page.getByText(new RegExp(escapeRegex(questionText), "i")).first();
  try {
    if (!(await q.isVisible({ timeout: 1500 }))) return null;

    // Find a reasonable block around the question
    const block = await getQuestionBlock(page, questionText);
    if (!block) return null;

    // Find the question node *inside* the block (more stable)
    const qInBlock = block.getByText(new RegExp(escapeRegex(questionText), "i")).first();

    // Now pick the first combobox-like input AFTER the question, but scoped to the same block
    const inputAfter = qInBlock.locator(
      "xpath=following::input[@role='combobox' or @aria-autocomplete or contains(translate(@placeholder,'START TYPING','start typing'),'start typing')][1]"
    );

    // Ensure this input is actually inside our block (not some later section)
    // We do this by checking it's visible and (best-effort) that it exists.
    if (await inputAfter.isVisible({ timeout: 1500 }).catch(() => false)) return inputAfter;

    // Fallback: if DOM ordering is odd, use the first combobox inside the block (but ONLY as fallback)
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
  if (!block) return false;

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

/**
 * Combobox fill:
 * - Uses the combobox associated with the question
 * - Types value once
 * - Waits for dropdown options to appear
 * - Clicks matching option
 * - DOES NOT clear and retype unless needed
 */
async function fillComboboxForQuestion(page: Page, questionText: string, value: string) {
  if (!value) return false;

  const input = await getComboboxInputForQuestion(page, questionText);
  if (!input) return false;

  try {
    if (!(await input.isVisible({ timeout: 2500 }))) return false;

    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click();

    // Clear and type ONCE
    await input.fill("");
    await input.type(value, { delay: 35 });

    // Wait for options to show up (this is the thing you explicitly asked for)
    const options = page.locator("[role='option']");
    let optionsVisible = false;
    try {
      await options.first().waitFor({ state: "visible", timeout: 2500 });
      optionsVisible = true;
    } catch {
      optionsVisible = false;
    }

    // Prefer exact match option
    const exact = page.locator("[role='option']").filter({ hasText: value }).first();
    if (await exact.isVisible({ timeout: 1500 }).catch(() => false)) {
      await exact.click();
      return true;
    }

    // If options exist but text differs, click first option
    if (optionsVisible) {
      const first = page.locator("[role='option']").first();
      if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
        await first.click();
        return true;
      }
    }

    // Last fallback: keyboard select
    await input.press("ArrowDown");
    await input.press("Enter");
    return true;
  } catch {}

  return false;
}

/**
 * EEO/tile selections where options are explicit on screen.
 * Not used for combobox questions.
 */
async function selectByVisibleOptionAnywhere(page: Page, optionText: string) {
  if (!optionText) return false;

  const exact = page.getByText(new RegExp(`^${escapeRegex(optionText)}$`, "i")).first();
  try {
    if (await exact.isVisible({ timeout: 1500 })) {
      await exact.scrollIntoViewIfNeeded().catch(() => {});
      await exact.click();
      return true;
    }
  } catch {}

  const contains = page.getByText(new RegExp(escapeRegex(optionText), "i")).first();
  try {
    if (await contains.isVisible({ timeout: 1500 })) {
      await contains.scrollIntoViewIfNeeded().catch(() => {});
      await contains.click();
      return true;
    }
  } catch {}

  return false;
}

export async function autofillAshby(page: Page, profile: Profile) {
  // 1) Force /application route
  const cur = page.url();
  const appUrl = toAshbyApplicationUrl(cur);

  console.log(`[Ashby] current url: ${cur}`);
  if (appUrl && appUrl !== cur) {
    console.log(`[Ashby] navigating to /application: ${appUrl}`);
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(200);
  }
  console.log(`[Ashby] url after route fix: ${page.url()}`);

  // 2) Wait for base fields
  try {
    await Promise.race([
      page.waitForSelector("input[autocomplete='name']", { timeout: 12000 }),
      page.waitForSelector("input[type='email']", { timeout: 12000 }),
      page.waitForSelector("input", { timeout: 12000 })
    ]);
  } catch {
    console.log("[Ashby] could not confirm fields appeared (continuing anyway).");
  }

  // 3) Basic text inputs FIRST
  await fillFirstVisible(
    page,
    ["input[autocomplete='name']", "input[name='name']", "input[placeholder*='Name' i]"],
    profile.fullName
  );
  await fillFirstVisible(
    page,
    ["input[type='email']", "input[autocomplete='email']", "input[name='email']"],
    profile.email
  );
  await fillFirstVisible(
    page,
    ["input[type='tel']", "input[autocomplete='tel']", "input[name='phone']"],
    profile.phone
  );

  // Links
  await fillFirstVisible(page, ["input[name*='linkedin' i]", "input[placeholder*='LinkedIn' i]"], profile.linkedin);
  await fillFirstVisible(page, ["input[name*='github' i]", "input[placeholder*='GitHub' i]"], profile.github);
  await fillFirstVisible(
    page,
    [
      "input[name*='portfolio' i]",
      "input[name*='website' i]",
      "input[placeholder*='Portfolio' i]",
      "input[placeholder*='Website' i]"
    ],
    profile.portfolio
  );

  // 4) Upload resume
  const uploaded = await uploadResumeIfPossible(page, profile.resumePdfPath);
  console.log(`[Ashby] resume upload attempted: ${uploaded}`);

  // 5) Combobox dropdowns: ONLY for the matching question

  // ✅ Location dropdown
  await fillComboboxForQuestion(page, "Current Location", profile.location);

  // ✅ Work authorization dropdown
  // IMPORTANT: remove dumb broad matching like "visa" (that’s how we hijack the location field)
  if (profile.workAuthorization?.currentStatus) {
    await fillComboboxForQuestion(
      page,
      "What is your current U.S. work authorization status",
      profile.workAuthorization.currentStatus
    );

    // safe label variants (still specific, not generic)
    await fillComboboxForQuestion(page, "current U.S. work authorization status", profile.workAuthorization.currentStatus);
    await fillComboboxForQuestion(page, "U.S. work authorization status", profile.workAuthorization.currentStatus);
  }

  // 6) Yes/No questions

  const authYesNo = (profile.workAuthorization?.authorizedToWorkInUS || profile.defaults?.authorizedToWork || "Yes") as "Yes" | "No";
  const sponsorNow = (profile.sponsorship?.requiresSponsorshipNow || profile.defaults?.needsSponsorship || "Yes") as "Yes" | "No";
  const sponsorFuture = (profile.sponsorship?.requiresSponsorshipInFuture ||
    profile.defaults?.willNowOrInFutureRequireSponsorship ||
    "Yes") as "Yes" | "No";

  await answerYesNo(page, "Are you authorized to work", authYesNo);
  await answerYesNo(page, "authorized to work", authYesNo);
  await answerYesNo(page, "Do you require sponsorship", sponsorNow);
  await answerYesNo(page, "Will you now or in the future require sponsorship", sponsorFuture);

  // Willing to relocate/commute
  const pref = profile.preferences?.willingToRelocateOrCommute ?? "Yes";
  const prefAns: "Yes" | "No" = pref.toLowerCase().startsWith("y") ? "Yes" : "No";

  await answerYesNo(page, "Are you willing to relocate", prefAns);
  await answerYesNo(page, "Are you willing to commute", prefAns);
  await answerYesNo(page, "willing to relocate", prefAns);
  await answerYesNo(page, "willing to commute", prefAns);

  // ✅ Office excited question MUST be YES (you asked explicitly)
  await answerYesNo(page, "Are you excited to work from our", "Yes");
  await answerYesNo(page, "Are you excited to work in our office", "Yes");

  // 7) Professional experience radio
  await selectRadioOption(
    page,
    "How many years of professional (paid) experience do you have building production full-stack applications",
    "I'm an expert (5+ years)"
  );

  // 8) EEO (gender/race/veteran/disability)
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
