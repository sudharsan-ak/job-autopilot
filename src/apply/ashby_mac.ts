import { Page, Locator } from "playwright";
import * as os from "os";
import { Profile } from "../utils/config";

// Track which question blocks we've already interacted with to prevent double-clicking
const answeredQuestionBlocks = new Set<string>();

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
  const isMac = os.platform() === "darwin";
  const timeout = isMac ? 2000 : 1200;

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout })) {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(isMac ? 200 : 100);
        await loc.fill(value);
        // macOS may need a small delay after filling
        await page.waitForTimeout(isMac ? 300 : 100);
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
 * Require at least 2 words to avoid matching IDs.
 */
function looksAllCapsName(s: string) {
  const t = (s || "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (/[a-z]/.test(t)) return false;
  if (!/[A-Z]/.test(t)) return false;
  if (!/^[A-Z\s.'-]+$/.test(t)) return false;
  return true;
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
      if (yesOk && noOk) {
        // Get a unique identifier for this block to track if we've already answered it
        const blockId = await block.evaluate((el: HTMLElement) => {
          // Use a combination of question text and block position as identifier
          const rect = el.getBoundingClientRect();
          return `${el.textContent?.substring(0, 100)}|${rect.top}|${rect.left}`;
        }).catch(() => null);
        
        if (blockId && answeredQuestionBlocks.has(blockId)) {
          console.log(`[Ashby] Skipping already answered question block: "${questionText.substring(0, 50)}..."`);
          return null; // Already answered this block
        }
        
        if (blockId) {
          answeredQuestionBlocks.add(blockId);
        }
        
        return block;
      }
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
    const radioOk = await selectRadioOption(page, questionText, answer);
    if (!radioOk) {
      console.log(`[Ashby] Could not find Yes/No block for question: "${questionText}"`);
    }
    return radioOk;
  }

  // Find both buttons
  const btn = block.locator(`button:has-text("${answer}")`).first();
  const otherAnswer = answer === "Yes" ? "No" : "Yes";
  const otherBtn = block.locator(`button:has-text("${otherAnswer}")`).first();
  
  try {
    if (!(await btn.isVisible({ timeout: 2000 }))) {
      console.log(`[Ashby] ${answer} button not visible for question: "${questionText}"`);
      return false;
    }
    
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(200);
    
    // Check which button is currently selected by checking background color
    const btnState = await btn.evaluate((el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      const bgColor = style.backgroundColor.toLowerCase();
      // Check if it's black/dark (selected)
      const isBlack = bgColor.includes('rgb(0, 0, 0)') || bgColor.includes('rgb(0,0,0)') || 
                      bgColor === 'rgb(0, 0, 0)' || bgColor === 'rgb(0,0,0)' ||
                      bgColor.includes('#000');
      return {
        isSelected: isBlack || el.classList.contains('selected') || el.getAttribute('aria-pressed') === 'true',
        bgColor: bgColor
      };
    }).catch(() => ({ isSelected: false, bgColor: 'unknown' }));
    
    const otherBtnState = await otherBtn.evaluate((el: HTMLElement) => {
      const style = window.getComputedStyle(el);
      const bgColor = style.backgroundColor.toLowerCase();
      const isBlack = bgColor.includes('rgb(0, 0, 0)') || bgColor.includes('rgb(0,0,0)') || 
                      bgColor === 'rgb(0, 0, 0)' || bgColor === 'rgb(0,0,0)' ||
                      bgColor.includes('#000');
      return {
        isSelected: isBlack || el.classList.contains('selected') || el.getAttribute('aria-pressed') === 'true',
        bgColor: bgColor
      };
    }).catch(() => ({ isSelected: false, bgColor: 'unknown' }));
    
    console.log(`[Ashby] Question: "${questionText}" | Desired: ${answer} | ${answer} selected: ${btnState.isSelected} (bg: ${btnState.bgColor}) | ${otherAnswer} selected: ${otherBtnState.isSelected} (bg: ${otherBtnState.bgColor})`);
    
    // If our desired button is already selected, we're good
    if (btnState.isSelected && !otherBtnState.isSelected) {
      console.log(`[Ashby] ✓ ${answer} already selected for "${questionText}"`);
      return true;
    }
    
    // If the wrong button is selected OR neither is selected, click our desired button
    if (otherBtnState.isSelected || !btnState.isSelected) {
      console.log(`[Ashby] → Clicking ${answer} button for "${questionText}"`);
      await btn.click({ force: true });
      await page.waitForTimeout(400); // Wait after click to ensure state changes
      
      // Verify it worked
      const verifyState = await btn.evaluate((el: HTMLElement) => {
        const style = window.getComputedStyle(el);
        const bgColor = style.backgroundColor.toLowerCase();
        const isBlack = bgColor.includes('rgb(0, 0, 0)') || bgColor.includes('rgb(0,0,0)') || 
                        bgColor === 'rgb(0, 0, 0)' || bgColor === 'rgb(0,0,0)' ||
                        bgColor.includes('#000');
        return isBlack || el.classList.contains('selected') || el.getAttribute('aria-pressed') === 'true';
      }).catch(() => false);
      
      if (verifyState) {
        console.log(`[Ashby] ✓ Successfully selected ${answer} for "${questionText}"`);
      } else {
        console.log(`[Ashby] ⚠ Warning: ${answer} may not be selected after click for "${questionText}"`);
      }
      
      return true;
    }
    
    return true;
  } catch (e) {
    console.log(`[Ashby] Error clicking ${answer} button for "${questionText}": ${e instanceof Error ? e.message : String(e)}`);
  }

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
  const isMac = os.platform() === "darwin";

  const input = await getComboboxInputForQuestion(page, questionText);
  if (!input) return false;

  try {
    const visibilityTimeout = isMac ? 3500 : 2500;
    if (!(await input.isVisible({ timeout: visibilityTimeout }))) return false;

    // Wait a bit before interacting with dropdown (especially important for location)
    await page.waitForTimeout(isMac ? 1000 : 500);
    
    await input.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(isMac ? 400 : 200);
    await input.click();
    await page.waitForTimeout(isMac ? 500 : 300); // Longer wait after click for dropdown to open

    // Clear and type ONCE
    await input.fill("");
    await page.waitForTimeout(isMac ? 300 : 150);
    // macOS may need slower typing
    await input.type(value, { delay: isMac ? 50 : 35 });
    await page.waitForTimeout(isMac ? 800 : 500); // Longer wait after typing for options to appear

    // Wait for options to show up (longer timeout on macOS)
    const options = page.locator("[role='option']");
    let optionsVisible = false;
    try {
      await options.first().waitFor({ state: "visible", timeout: isMac ? 4000 : 3000 });
      optionsVisible = true;
      await page.waitForTimeout(isMac ? 500 : 300); // Extra wait after options appear
    } catch {
      optionsVisible = false;
    }

    // Prefer exact match option
    const exact = page.locator("[role='option']").filter({ hasText: value }).first();
    if (await exact.isVisible({ timeout: isMac ? 2000 : 1500 }).catch(() => false)) {
      await exact.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(isMac ? 300 : 150);
      await exact.click();
      await page.waitForTimeout(isMac ? 400 : 200);
      return true;
    }

    // If options exist but text differs, click first option
    if (optionsVisible) {
      const first = page.locator("[role='option']").first();
      if (await first.isVisible({ timeout: isMac ? 2000 : 1500 }).catch(() => false)) {
        await first.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(isMac ? 300 : 150);
        await first.click();
        await page.waitForTimeout(isMac ? 400 : 200);
        return true;
      }
    }

    // Last fallback: keyboard select
    await input.press("ArrowDown");
    await page.waitForTimeout(isMac ? 300 : 150);
    await input.press("Enter");
    await page.waitForTimeout(isMac ? 400 : 200);
    return true;
  } catch {}

  return false;
}

/**
 * EEO/tile selections where options are explicit on screen.
 * Not used for combobox questions.
 */
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
  const isMac = os.platform() === "darwin";
  
  console.log(`[Ashby] Filling name: ${profile.fullName}`);
  const { first, last } = getFirstLastName(profile);
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
  const existingFirst = await readFirstVisibleValue(page, firstNameSelectors);
  const existingLast = await readFirstVisibleValue(page, lastNameSelectors);

  const nameFilled = await fillFirstVisible(
    page,
    ["input[autocomplete='name']", "input[name='name']", "input[placeholder*='Name' i]", "input[id*='name' i]"],
    profile.fullName
  );
  console.log(`[Ashby] Name filled: ${nameFilled}`);

  if (shouldFill(existingFirst)) {
    await fillFirstVisible(page, firstNameSelectors, first);
  }

  if (shouldFill(existingLast)) {
    await fillFirstVisible(page, lastNameSelectors, last);
  }
  
  console.log(`[Ashby] Filling email: ${profile.email}`);
  const emailFilled = await fillFirstVisible(
    page,
    ["input[type='email']", "input[autocomplete='email']", "input[name='email']", "input[id*='email' i]"],
    profile.email
  );
  console.log(`[Ashby] Email filled: ${emailFilled}`);
  
  console.log(`[Ashby] Filling phone: ${profile.phone}`);
  // Phone number - try more selectors and formats
  const phoneFilled = await fillFirstVisible(
    page,
    [
      "input[type='tel']", 
      "input[autocomplete='tel']", 
      "input[name='phone']",
      "input[id*='phone' i]",
      "input[placeholder*='phone' i]",
      "input[placeholder*='Phone' i]"
    ],
    profile.phone
  );
  console.log(`[Ashby] Phone filled: ${phoneFilled}`);
  
  // If phone not filled, try with formatted version
  if (!phoneFilled && profile.phone) {
    const formattedPhone = profile.phone.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3");
    console.log(`[Ashby] Trying formatted phone: ${formattedPhone}`);
    await fillFirstVisible(
      page,
      ["input[type='tel']", "input[autocomplete='tel']", "input[name='phone']"],
      formattedPhone
    );
  }

  // Links
  console.log(`[Ashby] Filling LinkedIn: ${profile.linkedin}`);
  const linkedinFilled = await fillFirstVisible(
    page, 
    [
      "input[name*='linkedin' i]", 
      "input[placeholder*='LinkedIn' i]",
      "input[id*='linkedin' i]",
      "input[type='url'][name*='linkedin' i]"
    ], 
    profile.linkedin
  );
  console.log(`[Ashby] LinkedIn filled: ${linkedinFilled}`);
  
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
  // Wait a bit before starting dropdowns to let page settle
  await page.waitForTimeout(isMac ? 1000 : 500);

  // ✅ Location dropdown - wait longer as requested
  console.log(`[Ashby] Filling location: ${profile.location}`);
  await page.waitForTimeout(isMac ? 1500 : 1000); // Extra wait before location dropdown
  const locationFilled = await fillComboboxForQuestion(page, "Current Location", profile.location);
  console.log(`[Ashby] Location filled: ${locationFilled}`);
  
  // Try alternative location question formats if first didn't work
  if (!locationFilled && profile.location) {
    await page.waitForTimeout(isMac ? 1000 : 500);
    await fillComboboxForQuestion(page, "Location", profile.location);
    await page.waitForTimeout(isMac ? 1000 : 500);
    await fillComboboxForQuestion(page, "Where are you located", profile.location);
    await page.waitForTimeout(isMac ? 1000 : 500);
    await fillComboboxForQuestion(page, "City", profile.location);
  }

  // ✅ Work authorization dropdown - wait like location, try once with best match
  if (profile.workAuthorization?.currentStatus) {
    console.log(`[Ashby] Filling work authorization status: ${profile.workAuthorization.currentStatus}`);
    await page.waitForTimeout(isMac ? 1000 : 500); // Wait before work authorization dropdown
    
    // Try the most specific question first
    const authFilled = await fillComboboxForQuestion(
      page,
      "What is your current U.S. work authorization status",
      profile.workAuthorization.currentStatus
    );
    console.log(`[Ashby] Work authorization filled: ${authFilled}`);
    
    // Only try alternatives if first didn't work
    if (!authFilled) {
      await page.waitForTimeout(isMac ? 1000 : 500);
      await fillComboboxForQuestion(page, "current U.S. work authorization status", profile.workAuthorization.currentStatus);
    }
  }

  // 6) Yes/No questions
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

  // Willing to relocate/commute
  const pref = profile.preferences?.willingToRelocateOrCommute ?? "Yes";
  const prefAns: "Yes" | "No" = pref.toLowerCase().startsWith("y") ? "Yes" : "No";

  console.log(`[Ashby] Answering relocate/commute questions with: ${prefAns}`);
  
  // Try to find and answer relocate/commute questions - stop after first successful match
  // This prevents clicking the same question multiple times which could toggle it
  const relocateCommuteAnswered = 
    await answerYesNo(page, "Are you willing to relocate", prefAns) ||
    await answerYesNo(page, "Are you willing to commute", prefAns) ||
    await answerYesNo(page, "willing to relocate", prefAns) ||
    await answerYesNo(page, "willing to commute", prefAns);
  
  if (relocateCommuteAnswered) {
    console.log(`[Ashby] Relocate/commute question answered: ${prefAns}`);
  }

  // ✅ Office excited question - MUST be YES based on preferences.willingToRelocateOrCommute
  const willingToCommute = profile.preferences?.willingToRelocateOrCommute ?? "Yes";
  const excitedAnswer: "Yes" | "No" = willingToCommute.toLowerCase().startsWith("y") ? "Yes" : "No";
  
  console.log(`[Ashby] Answering office excited question with: ${excitedAnswer} (based on willingToRelocateOrCommute: ${willingToCommute})`);
  
  // Try multiple question formats to catch variations like "El Segundo, CA or San Francisco, CA office"
  // Order matters - try most specific first (the image shows "Mondays and Thursdays" question)
  let officeQuestionAnswered = false;
  const officeQuestionPatterns = [
    "Mondays and Thursdays", // For the specific question in the image
    "El Segundo", // For El Segundo/SF office question
    "San Francisco", // For SF office question
    "Are you excited to work from our", 
    "Are you excited to work in our office",
    "excited to work from our",
    "excited to work in our office"
  ];
  
  for (const pattern of officeQuestionPatterns) {
    if (await answerYesNo(page, pattern, excitedAnswer)) {
      officeQuestionAnswered = true;
      console.log(`[Ashby] Office excited question answered with pattern: "${pattern}"`);
      break; // Stop after first successful match
    }
  }
  
  if (!officeQuestionAnswered) {
    console.log(`[Ashby] Warning: Could not find office excited question`);
  }

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

  // Re-check name after resume upload/auto-population to undo ALL CAPS.
  const nameSelectors = [
    "input[autocomplete='name']",
    "input[name='name']",
    "input[placeholder*='Name' i]",
    "input[id*='name' i]"
  ];
  const existingName = await readFirstVisibleValue(page, nameSelectors);
  if (looksAllCapsName(existingName) && profile.fullName) {
    console.log(`[Ashby] fixing ALL CAPS name "${existingName}" -> "${profile.fullName}"`);
    await fillFirstVisible(page, nameSelectors, profile.fullName);
  }

  console.log("[Ashby] autofill completed (best-effort).");
  await page.waitForTimeout(400);
}
