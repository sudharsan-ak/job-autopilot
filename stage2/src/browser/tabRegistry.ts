import type { BrowserContext, Page } from "playwright";
import type { StoredJob } from "../types.js";
import { canonicalizeUrl } from "../utils/identity.js";
import { pageTargetId } from "./cdp.js";

export async function findOrOpenJobPage(
  context: BrowserContext,
  job: StoredJob,
  recoveryUrls: string[] = [],
): Promise<{ page: Page; reused: boolean }> {
  const requested = canonicalizeUrl(job.applicationUrl ?? job.sourceUrl);
  if (!requested) throw new Error(`Queue row ${job.queueNumber} has no valid URL.`);
  const expected = new Set([requested, ...recoveryUrls.map(canonicalizeUrl).filter((value): value is string => Boolean(value))]);
  const existing = context.pages().find((page) => {
    const current = canonicalizeUrl(page.url());
    return current ? expected.has(current) : false;
  });
  if (existing) {
    await existing.bringToFront();
    return { page: existing, reused: true };
  }
  const page = await context.newPage();
  await page.goto(requested, { waitUntil: "domcontentloaded", timeout: 45_000 });
  return { page, reused: false };
}

export { pageTargetId };
