import type { Locator, Page } from "playwright";
import { getAtsBehavior } from "../ats/behavior.js";
import type { AtsKind, FieldDescriptor, FillAction, FillVerification } from "../types.js";
import { fieldsSemanticallyMatch, liveFieldLocator, refindField, waitForDomSettled } from "./fieldRuntime.js";
import { scanPage } from "./pageScanner.js";
import { frameForField, readFieldValue, valuesMatch } from "./verifier.js";

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function locationTokens(value: string): string[] {
  const aliases: Record<string, string> = { tx: "texas", ca: "california", usa: "unitedstates", us: "unitedstates" };
  return normalized(value).split(" ").filter(Boolean).map((token) => aliases[token] ?? token)
    .filter((token) => !["of", "america"].includes(token));
}

function compatibleLocation(expected: string, observed: string): boolean {
  const wanted = locationTokens(expected);
  const actual = new Set(locationTokens(observed));
  return wanted.length > 0 && wanted.filter((token) => actual.has(token)).length / wanted.length >= 0.75;
}

function locationLike(field: FieldDescriptor): boolean {
  return /address|location|city|state|province|country/i.test(
    [field.label, field.name, field.id, field.autocomplete, field.containerText].filter(Boolean).join(" "),
  );
}

function optionMatches(value: string, option: string, allowLocation: boolean): boolean {
  const wanted = normalized(value);
  const actual = normalized(option);
  if (wanted === actual) return true;
  if (allowLocation && compatibleLocation(value, option)) return true;
  return false;
}

async function openControl(locator: Locator): Promise<void> {
  await locator.click({ timeout: 2_000 }).catch(async () => {
    await locator.focus({ timeout: 1_000 });
    await locator.press("ArrowDown", { timeout: 1_000 });
  });
}

async function currentWithOptions(
  page: Page,
  original: FieldDescriptor,
  ats: AtsKind | undefined,
  timeoutMs = getAtsBehavior(ats).optionTimeoutMs,
): Promise<FieldDescriptor> {
  const behavior = getAtsBehavior(ats);
  const deadline = Date.now() + Math.min(timeoutMs, behavior.optionTimeoutMs);
  let current = (await refindField(page, original, ats)) ?? original;
  while (Date.now() < deadline) {
    const fields = await scanPage(page, { ats });
    current = fields.find((candidate) => fieldsSemanticallyMatch(candidate, original)) ?? current;
    if (current.options.length > 0 && current.optionContainerSelector) return current;
    await page.waitForTimeout(50);
  }
  return current;
}

async function chooseVisibleOption(
  page: Page,
  field: FieldDescriptor,
  value: string,
  ats?: AtsKind,
  initialTimeoutMs?: number,
): Promise<boolean> {
  const behavior = getAtsBehavior(ats);
  let current = await currentWithOptions(page, field, ats, initialTimeoutMs);
  for (let scroll = 0; scroll <= behavior.maxVirtualScrolls; scroll += 1) {
    if (!current.optionContainerSelector) return false;
    const root = frameForField(page, current).locator(current.optionContainerSelector).first();
    if (!await root.isVisible().catch(() => false)) return false;
    const options = root.locator(behavior.optionSelectors.join(","));
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!await option.isVisible().catch(() => false)) continue;
      const text = ((await option.getAttribute("aria-label")) ?? (await option.innerText().catch(() => ""))).replace(/\s+/g, " ").trim();
      if (text && optionMatches(value, text, locationLike(current))) {
        await option.click({ timeout: 2_000 });
        return true;
      }
    }
    if (scroll === behavior.maxVirtualScrolls || count === 0) break;
    await root.evaluate((element) => {
      element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(element.clientHeight * 0.8, 120));
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.waitForTimeout(50);
    current = await currentWithOptions(page, field, ats);
  }
  return false;
}

async function selectRadio(page: Page, field: FieldDescriptor, option: string, ats?: AtsKind): Promise<void> {
  const current = await refindField(page, field, ats);
  if (!current) throw new Error("Radio field is no longer available.");
  const radios = frameForField(page, current).locator(current.selector);
  const count = await radios.count();
  for (let index = 0; index < count; index += 1) {
    const radio = radios.nth(index);
    const label = await radio.evaluate((element: HTMLElement) => {
      const input = element as HTMLInputElement;
      return (input.labels?.[0]?.textContent
        ?? element.getAttribute("aria-label")
        ?? element.textContent
        ?? input.value
        ?? "").replace(/\s+/g, " ").trim();
    });
    if (normalized(label) !== normalized(option)) continue;
    if (current.widgetKind === "role-radio-group") await radio.click();
    else await radio.check();
    return;
  }
  throw new Error(`Radio option is no longer available: ${option}`);
}

async function selectNative(page: Page, field: FieldDescriptor, value: string, ats?: AtsKind): Promise<void> {
  const live = await liveFieldLocator(page, field, ats);
  if (!live) throw new Error("Select field is no longer available.");
  const options = await live.locator.locator("option").evaluateAll((nodes) => nodes.map((node) => ({
    label: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
    value: (node as HTMLOptionElement).value,
  })));
  const match = options.find((option) => optionMatches(value, option.label, locationLike(live.field)))
    ?? options.find((option) => normalized(option.value) === normalized(value));
  if (!match) throw new Error(`Select has no supported option: ${value}`);
  await live.locator.selectOption(match.value);
}

async function fillCombobox(page: Page, field: FieldDescriptor, value: string, ats?: AtsKind): Promise<void> {
  let live = await liveFieldLocator(page, field, ats);
  if (!live) throw new Error("Combobox is no longer available.");
  await openControl(live.locator);
  if (await chooseVisibleOption(page, live.field, value, ats, 300)) return;

  live = await liveFieldLocator(page, field, ats);
  if (!live) throw new Error("Combobox remounted before typing.");
  const editable = await live.locator.evaluate((element) =>
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.getAttribute("contenteditable") === "true",
  );
  if (!editable) throw new Error(`Combobox has no supported option: ${value}`);
  await live.locator.fill("").catch(async () => {
    await live!.locator.press("Control+A");
    await live!.locator.press("Backspace");
  });
  await live.locator.pressSequentially(value, { delay: 20 });
  if (!await chooseVisibleOption(page, live.field, value, ats)) {
    throw new Error(`Combobox exposed no supported option after interaction: ${value}`);
  }
}

async function nativeSetValue(page: Page, field: FieldDescriptor, value: string, ats?: AtsKind): Promise<void> {
  const live = await liveFieldLocator(page, field, ats);
  if (!live) throw new Error("Text field is no longer available.");
  await live.locator.evaluate((element, nextValue) => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    const prior = input.value;
    setter?.call(input, nextValue);
    const tracker = (input as HTMLInputElement & { _valueTracker?: { setValue(value: string): void } })._valueTracker;
    tracker?.setValue(prior);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: nextValue }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
  }, value);
}

type ExecutableAction = Exclude<FillAction, { kind: "skip" }>;

async function performAction(page: Page, field: FieldDescriptor, action: ExecutableAction, ats?: AtsKind): Promise<void> {
  if (action.kind === "select" && field.controlType === "radio") {
    await selectRadio(page, field, action.value, ats);
    return;
  }
  if (action.kind === "select" && field.controlType === "select") {
    await selectNative(page, field, action.value, ats);
    return;
  }
  if (field.controlType === "combobox" || field.widgetKind === "aria-combobox" || field.widgetKind === "react-select") {
    await fillCombobox(page, field, String(action.value), ats);
    return;
  }
  const live = await liveFieldLocator(page, field, ats);
  if (!live) throw new Error("Field is no longer available.");
  if (action.kind === "check") {
    if (live.field.widgetKind === "role-checkbox") {
      const checked = await live.locator.getAttribute("aria-checked").then((value) => value === "true");
      if (checked !== action.value) await live.locator.click();
    } else if (action.value) await live.locator.check();
    else await live.locator.uncheck();
    return;
  }
  await live.locator.click({ timeout: 1_500 }).catch(() => undefined);
  await live.locator.fill(String(action.value));
}

async function waitForCommittedValue(
  page: Page,
  field: FieldDescriptor,
  expected: string | boolean,
  ats?: AtsKind,
): Promise<string | boolean | undefined> {
  const deadline = Date.now() + getAtsBehavior(ats).commitTimeoutMs;
  let observed: string | boolean | undefined;
  while (Date.now() < deadline) {
    observed = await readFieldValue(page, field, ats);
    if (valuesMatch(expected, observed)
      || (typeof expected === "string" && typeof observed === "string" && locationLike(field) && compatibleLocation(expected, observed))) return observed;
    await page.waitForTimeout(50);
  }
  return observed;
}

export async function executeAction(
  page: Page,
  field: FieldDescriptor,
  action: FillAction,
  ats?: AtsKind,
): Promise<FillVerification> {
  if (action.kind === "skip") return { fieldId: field.fieldId, success: true, expected: "SKIP", observed: "SKIP" };
  const expected = action.value;
  try {
    await performAction(page, field, action, ats);
    let observed = await waitForCommittedValue(page, field, expected, ats);
    if (!valuesMatch(expected, observed) && action.kind === "fill") {
      await nativeSetValue(page, field, action.value, ats);
      observed = await waitForCommittedValue(page, field, expected, ats);
    }
    await waitForDomSettled(page);
    observed = await readFieldValue(page, field, ats);
    const success = valuesMatch(expected, observed)
      || (typeof expected === "string" && typeof observed === "string" && locationLike(field) && compatibleLocation(expected, observed));
    return {
      fieldId: field.fieldId,
      success,
      expected,
      observed,
      error: success ? undefined : "Post-fill committed-state read-back did not match.",
    };
  } catch (error) {
    return { fieldId: field.fieldId, success: false, expected, error: String(error) };
  }
}
