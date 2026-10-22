import type { Page } from "playwright";
import { getAtsBehavior } from "../ats/behavior.js";
import type { AtsKind, FieldDescriptor } from "../types.js";
import { fieldIsEmpty } from "./fieldDescriptor.js";
import { fieldsSemanticallyMatch, liveFieldLocator, waitForDomSettled } from "./fieldRuntime.js";
import { scanPage } from "./pageScanner.js";

export async function discoverInteractiveOptions(
  page: Page,
  fields: FieldDescriptor[],
  ats?: AtsKind,
): Promise<FieldDescriptor[]> {
  const behavior = getAtsBehavior(ats);
  const enriched: FieldDescriptor[] = [];
  for (const field of fields) {
    if (field.controlType !== "combobox" || field.options.length > 0 || !field.visible || field.disabled || !fieldIsEmpty(field)) {
      enriched.push(field);
      continue;
    }
    const live = await liveFieldLocator(page, field, ats);
    if (!live) {
      enriched.push(field);
      continue;
    }
    try {
      await live.locator.click({ timeout: 2_000 }).catch(async () => {
        await live.locator.focus({ timeout: 1_000 });
        await live.locator.press("ArrowDown", { timeout: 1_000 });
      });
      const deadline = Date.now() + behavior.optionTimeoutMs;
      let current = live.field;
      while (Date.now() < deadline) {
        const scanned = await scanPage(page, { ats });
        current = scanned.find((candidate) => fieldsSemanticallyMatch(candidate, field)) ?? current;
        if (current.options.length > 0) break;
        await page.waitForTimeout(50);
      }
      await live.locator.press("Escape", { timeout: 500 }).catch(() => undefined);
      await waitForDomSettled(page, 80, 500);
      enriched.push(current);
    } catch {
      enriched.push(field);
    }
  }
  return enriched;
}
