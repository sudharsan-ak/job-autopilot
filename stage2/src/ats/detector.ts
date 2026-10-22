import type { Page } from "playwright";
import { ATS_ADAPTERS } from "./registry.js";
import type { AtsAdapter, AtsSignals } from "./types.js";

export async function collectAtsSignals(page: Page): Promise<AtsSignals> {
  const documentSignals = await page.evaluate(() => ({
    bodyText: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 12_000),
    formActions: Array.from(document.forms).map((form) => form.action).filter(Boolean),
    scriptSources: Array.from(document.scripts).map((script) => script.src).filter(Boolean),
  }));
  return { url: page.url(), title: await page.title(), ...documentSignals };
}

export async function detectAts(page: Page): Promise<AtsAdapter> {
  const signals = await collectAtsSignals(page);
  return ATS_ADAPTERS
    .map((adapter) => ({ adapter, score: adapter.score(signals) }))
    .sort((a, b) => b.score - a.score)[0]!.adapter;
}
