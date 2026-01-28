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

function extractStateName(location: string | undefined): string {
  if (!location) return "";
  const parts = location.split(",").map((p) => p.trim());
  if (parts.length < 2) return "";
  return parts[1];
}

async function getQuestionBlockForInput(page: Page, questionText: string) {
  const text = new RegExp(escapeRegex(questionText), "i");
  const q = page.getByText(text).first();
  try {
    if (!(await q.isVisible({ timeout: 1200 }))) return null;
    await q.scrollIntoViewIfNeeded().catch(() => {});

    const label = page.locator("label", { hasText: text }).first();
    if (await label.isVisible({ timeout: 800 }).catch(() => false)) {
      const forId = await label.getAttribute("for");
      if (forId) {
        const input = page.locator(`#${forId}`).first();
        if (await input.isVisible({ timeout: 800 }).catch(() => false)) {
          return input.locator("xpath=ancestor::*[self::div or self::section or self::fieldset][1]");
        }
      }
    }

    for (let level = 1; level <= 10; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section or self::fieldset][${level}]`);
      const inputCount = await block.locator("input, textarea").count().catch(() => 999);
      const radioCount = await block.locator("input[type='radio']").count().catch(() => 0);
      if (inputCount > 0 && inputCount <= 8 && radioCount <= 2) return block;
    }
  } catch {}
  return null;
}

async function pickInputInBlock(block: ReturnType<Page["locator"]>, questionText: string) {
  const inputs = block.locator("input, textarea");
  const count = await inputs.count();
  if (count === 0) return null;
  if (count === 1) return inputs.first();

  const tokens = questionText
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 3);

  const attrs = await inputs.evaluateAll((els) =>
    els.map((el) => ({
      name: (el.getAttribute("name") || "").toLowerCase(),
      id: (el.getAttribute("id") || "").toLowerCase(),
      aria: (el.getAttribute("aria-label") || "").toLowerCase(),
      placeholder: (el.getAttribute("placeholder") || "").toLowerCase(),
      dataqa: (el.getAttribute("data-qa") || "").toLowerCase()
    }))
  );

  for (let i = 0; i < attrs.length; i++) {
    const combined = `${attrs[i].name} ${attrs[i].id} ${attrs[i].aria} ${attrs[i].placeholder} ${attrs[i].dataqa}`;
    if (tokens.some((t) => combined.includes(t))) {
      return inputs.nth(i);
    }
  }

  return inputs.first();
}

async function getInputNearQuestion(page: Page, questionText: string) {
  try {
    const block = await getQuestionBlockForInput(page, questionText);
    if (block) {
      const input = await pickInputInBlock(block, questionText);
      if (input && (await input.isVisible({ timeout: 1200 }).catch(() => false))) return input;
    }
  } catch {}
  return null;
}

async function getRadioQuestionContainer(page: Page, questionText: string) {
  const text = new RegExp(escapeRegex(questionText), "i");
  try {
    const fieldset = page.locator("fieldset", { hasText: text }).first();
    if (await fieldset.isVisible({ timeout: 1200 }).catch(() => false)) {
      const radios = await fieldset.locator("input[type='radio']").count().catch(() => 0);
      if (radios > 0) return fieldset;
    }

    const q = page.getByText(text).first();
    if (!(await q.isVisible({ timeout: 1200 }))) return null;
    await q.scrollIntoViewIfNeeded().catch(() => {});
    for (let level = 1; level <= 10; level++) {
      const block = q.locator(`xpath=ancestor::*[self::div or self::section or self::fieldset][${level}]`);
      const radios = await block.locator("input[type='radio']").count().catch(() => 0);
      if (radios > 0) return block;
    }
  } catch {}
  return null;
}

async function debugField(page: Page, labelText: string) {
  const label = page.getByText(new RegExp(escapeRegex(labelText), "i")).first();
  const labelVisible = await label.isVisible({ timeout: 800 }).catch(() => false);
  if (!labelVisible) {
    console.log(`[Lever][debug] Label not visible: "${labelText}"`);
    return;
  }

  const nearInput = await getInputNearQuestion(page, labelText);
  const radioContainer = await getRadioQuestionContainer(page, labelText);
  const inputVisible = nearInput ? await nearInput.isVisible({ timeout: 800 }).catch(() => false) : false;
  const textareaVisible = nearInput
    ? ((await nearInput.evaluate((el) => el.tagName.toLowerCase())) === "textarea")
    : false;
  const radioVisible = radioContainer
    ? await radioContainer.locator("input[type='radio']").first().isVisible({ timeout: 800 }).catch(() => false)
    : false;

  const inputValue = inputVisible ? await nearInput?.inputValue().catch(() => "") : "";
  const textareaValue = textareaVisible ? await nearInput?.inputValue().catch(() => "") : "";

  console.log(
    `[Lever][debug] "${labelText}" -> input:${inputVisible} value:"${inputValue}" textarea:${textareaVisible} value:"${textareaValue}" radio:${radioVisible}`
  );
}

async function debugLeverFields(page: Page) {
  const labels = [
    "Current location",
    "Portfolio URL",
    "What is your target cash compensation range",
    "Do you now, or will you in the future require visa support",
    "Do you require visa support",
    "State"
  ];
  for (const label of labels) {
    await debugField(page, label);
  }
}

async function answerRadioQuestion(page: Page, questionText: string, optionText: string) {
  try {
    const container = await getRadioQuestionContainer(page, questionText);
    if (!container) return false;
    const optionExact = new RegExp(`^${escapeRegex(optionText)}$`, "i");
    const option = container.locator("label").filter({ hasText: optionExact }).first();
    if (await option.isVisible({ timeout: 1200 }).catch(() => false)) {
      await option.scrollIntoViewIfNeeded().catch(() => {});
      await option.click();
      return true;
    }

    const fallback = container.getByText(optionExact).first();
    if (await fallback.isVisible({ timeout: 1200 }).catch(() => false)) {
      await fallback.scrollIntoViewIfNeeded().catch(() => {});
      await fallback.click();
      return true;
    }
  } catch {}
  return false;
}

async function fillTextAreaByQuestion(page: Page, questionText: string, value: string) {
  if (!value) return false;
  try {
    const block = await getQuestionBlockForInput(page, questionText);
    if (!block) return false;
    const textarea = block.locator("textarea").first();
    if (await textarea.isVisible({ timeout: 1200 }).catch(() => false)) {
      const existing = await textarea.inputValue().catch(() => "");
      if (existing && existing.trim().length > 0) return false;
      await textarea.fill(value);
      return true;
    }
  } catch {}
  return false;
}

async function fillInputIfEmpty(page: Page, selector: string, value: string) {
  if (!value) return false;
  const loc = page.locator(selector).first();
  try {
    if (!(await loc.isVisible({ timeout: 1200 }))) return false;
    const existing = await loc.inputValue().catch(() => "");
    if (existing && existing.trim().length > 0) return false;
    await loc.fill(value);
    return true;
  } catch {
    return false;
  }
}

async function fillLocationHard(page: Page, value: string) {
  if (!value) return false;
  const input = page.locator("input.location-input, input[name='location'], input[data-qa='location-input']").first();
  try {
    if (!(await input.isVisible({ timeout: 1200 }))) return false;
    const existing = await input.inputValue().catch(() => "");
    if (existing && existing.trim().length > 0) return false;
    await input.fill(value);
    await input.dispatchEvent("input").catch(() => {});
    await input.dispatchEvent("change").catch(() => {});
    await input.blur().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function fillLocationHardJs(page: Page, value: string) {
  if (!value) return false;
  try {
    const filled = await page.evaluate((val) => {
      const container = document.querySelector("li.application-question[data-qa='structured-contact-location-question']");
      const input = (container || document).querySelector(
        "input.location-input, input[name='location'], input[data-qa='location-input']"
      ) as HTMLInputElement | null;
      if (!input) return false;
      if (input.value && input.value.trim().length > 0) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const hidden = (container || document).querySelector("input[name='selectedLocation']") as HTMLInputElement | null;
      if (hidden) {
        const hiddenSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        hiddenSetter?.call(hidden, JSON.stringify({ name: val }));
        hidden.dispatchEvent(new Event("input", { bubbles: true }));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }, value);
    return Boolean(filled);
  } catch {
    return false;
  }
}

async function fillLocationHardType(page: Page, value: string) {
  if (!value) return false;
  const input = page.locator("input.location-input, input[name='location'], input[data-qa='location-input']").first();
  try {
    if (!(await input.isVisible({ timeout: 1200 }))) return false;
    await input.click({ timeout: 1200 });
    await input.press("Control+A").catch(() => {});
    await input.type(value, { delay: 20 });
    await input.blur().catch(() => {});
    const finalValue = await input.inputValue().catch(() => "");
    return finalValue.trim().length > 0;
  } catch {
    return false;
  }
}

async function enforceLocationValue(page: Page, value: string) {
  if (!value) return false;
  try {
    const enforced = await page.evaluate((val) => {
      const container = document.querySelector("li.application-question[data-qa='structured-contact-location-question']");
      const input = (container || document).querySelector(
        "input.location-input, input[name='location'], input[data-qa='location-input']"
      ) as HTMLInputElement | null;
      if (!input) return false;
      if (!input.value || input.value.trim().length === 0) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, val);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const hidden = (container || document).querySelector("input[name='selectedLocation']") as HTMLInputElement | null;
      if (hidden) {
        const hiddenSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        hiddenSetter?.call(hidden, JSON.stringify({ name: val }));
        hidden.dispatchEvent(new Event("input", { bubbles: true }));
        hidden.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }, value);
    return Boolean(enforced);
  } catch {
    return false;
  }
}

async function fillPortfolioHard(page: Page, value: string) {
  if (!value) return false;
  const input = page.locator("input[name='urls[Portfolio]']").first();
  try {
    if (!(await input.isVisible({ timeout: 1200 }))) return false;
    const existing = await input.inputValue().catch(() => "");
    if (existing && existing.trim().length > 0) return false;
    await input.fill(value);
    return true;
  } catch {
    return false;
  }
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

async function fillByQuestionText(page: Page, questionText: string, value: string) {
  if (!value) return false;
  try {
    const input = await getInputNearQuestion(page, questionText);
    if (!input) return false;
    const tag = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    if (tag === "input" || tag === "textarea") {
      await input.scrollIntoViewIfNeeded().catch(() => {});
      const existing = await input.inputValue().catch(() => "");
      if (existing && existing.trim().length > 0) return false;
      await input.fill(value);
      return true;
    }
  } catch {}
  return false;
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

function toLeverApplyUrl(currentUrl: string): string | null {
  try {
    const u = new URL(currentUrl);
    if (!u.hostname.includes("jobs.lever.co")) return null;
    if (u.pathname.includes("/apply")) return u.toString();
    u.pathname = u.pathname.replace(/\/+$/, "") + "/apply";
    return u.toString();
  } catch {
    return null;
  }
}

export async function autofillLever(page: Page, profile: Profile) {
  const applyUrl = toLeverApplyUrl(page.url());
  if (applyUrl && applyUrl !== page.url()) {
    await page.goto(applyUrl, { waitUntil: "domcontentloaded" });
  }

  await page.waitForTimeout(1200);
  if (process.env.LEVER_DEBUG === "1") {
    console.log("[Lever][debug] Before fill");
    await debugLeverFields(page);
  }

  const { first, last } = getFirstLastName(profile);

  await fillInputIfEmpty(page, "input[name='name']", profile.fullName);
  await fillInputIfEmpty(page, "input[name='email']", profile.email);
  await fillInputIfEmpty(page, "input[name='phone']", profile.phone);

  await fillByLabelText(page, "Full name", profile.fullName);
  await fillByLabelText(page, "First name", first);
  await fillByLabelText(page, "Last name", last);
  await fillByLabelText(page, "Email", profile.email);
  await fillByLabelText(page, "Phone", profile.phone);
  await fillByLabelText(page, "Location", profile.location);
  await fillByLabelText(page, "Current location", profile.location);
  await fillByLabelText(page, "Current Location", profile.location);
  await fillByQuestionText(page, "Current location", profile.location);
  await fillLocationHard(page, profile.location);
  await fillLocationHardJs(page, profile.location);
  await page.waitForTimeout(300);
  await fillLocationHardType(page, profile.location);
  await page.waitForTimeout(400);
  await enforceLocationValue(page, profile.location);

  await fillByLabelText(page, "LinkedIn", profile.linkedin);
  await fillByLabelText(page, "LinkedIn Profile", profile.linkedin);
  await fillByLabelText(page, "Website", profile.portfolio);
  await fillByLabelText(page, "Portfolio URL", profile.portfolio);
  await fillByLabelText(page, "Portfolio", profile.portfolio);
  await fillByQuestionText(page, "Portfolio URL", profile.portfolio);
  await fillPortfolioHard(page, profile.portfolio);
  await fillByLabelText(page, "GitHub", profile.github);

  await fillByLabelText(page, "target cash compensation range", profile.defaults?.salaryExpectation);
  await fillByLabelText(page, "target cash compensation", profile.defaults?.salaryExpectation);
  await fillByLabelText(page, "target compensation", profile.defaults?.salaryExpectation);
  await fillByLabelText(page, "target salary", profile.defaults?.salaryExpectation);
  await fillByQuestionText(page, "What is your target cash compensation range", profile.defaults?.salaryExpectation);

  await answerRadioQuestion(page, "Do you now, or will you in the future require visa support", "Yes");
  await answerRadioQuestion(page, "Do you require visa support", "Yes");
  await fillTextAreaByQuestion(page, "If yes, please describe", "Currently on H-1B visa and would require visa transfer");
  await fillTextAreaByQuestion(page, "If yes, please describe.", "Currently on H-1B visa and would require visa transfer");

  const stateName = extractStateName(profile.location);
  if (stateName) {
    await answerRadioQuestion(page, "State", stateName);
  }

  await uploadResumeIfPossible(page, profile.resumePdfPath);

  console.log("[Lever] autofill completed (best-effort).");
}
