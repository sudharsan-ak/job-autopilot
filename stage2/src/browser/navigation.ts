import type { Page } from "playwright";

function isHiringCafe(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "hiring.cafe" || host.endsWith(".hiring.cafe") || host === "hiringcafe.com" || host.endsWith(".hiringcafe.com");
  } catch {
    return false;
  }
}

async function applicationFormPresent(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const present = await frame.evaluate(() => {
      const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        "input:not([type=hidden]):not([type=search]):not([type=submit]):not([type=button]), textarea, select",
      )).filter((field) => {
        const element = field as HTMLElement;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return field instanceof HTMLInputElement && field.type === "file"
          ? style.display !== "none" && style.visibility !== "hidden"
          : style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const text = (document.body?.innerText ?? "").toLowerCase();
      const required = fields.filter((field) => field.required || field.getAttribute("aria-required") === "true").length;
      const hasUpload = fields.some((field) => field instanceof HTMLInputElement && field.type === "file");
      const applicationSignals = ["first name", "last name", "email", "phone", "resume", "cover letter", "work authorization"]
        .filter((signal) => text.includes(signal)).length;
      return hasUpload || applicationSignals >= 2 || (fields.length >= 3 && required >= 2 && applicationSignals >= 1);
    }).catch(() => false);
    if (present) return true;
  }
  return false;
}

const ENTRY_ACTION = /^(apply|apply now|apply for this job|apply to this job|apply directly(?: on (?:the )?employer(?:'s|’s) site)?|start application|continue|continue application|continue to application)$/i;

export async function enterApplicationForm(initialPage: Page): Promise<Page> {
  let page = initialPage;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    const hasApplicationForm = await applicationFormPresent(page);
    if (hasApplicationForm && !isHiringCafe(page.url())) return page;
    const candidates = page.locator("a, button, [role=button]").filter({ hasText: ENTRY_ACTION });
    const count = await candidates.count();
    if (count === 0) return page;

    let selected: ReturnType<Page["locator"]> | undefined;
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = await candidate.evaluate((element) => ({
        insideForm: Boolean(element.closest("form")),
        type: element.getAttribute("type")?.toLowerCase(),
      }));
      const safeListingAction = !hasApplicationForm || isHiringCafe(page.url());
      if (safeListingAction) {
        selected = candidate;
        const priorUrl = page.url();
        const popupPromise = page.context().waitForEvent("page", { timeout: 5_000 }).catch(() => undefined);
        await candidate.click();
        const popup = await popupPromise;
        if (popup) {
          await popup.waitForURL((url) => /^https?:$/i.test(url.protocol), { timeout: 15_000 }).catch(() => undefined);
          await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
          if (/^https?:\/\//i.test(popup.url())) {
            await page.close().catch(() => undefined);
            page = popup;
          } else {
            await popup.close().catch(() => undefined);
          }
        } else {
          await page.waitForURL((url) => url.toString() !== priorUrl, { timeout: 15_000 }).catch(() => undefined);
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        }
        break;
      }
    }
    if (!selected) return page;
  }
  return page;
}
