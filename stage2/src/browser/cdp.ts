import { chromium, type Browser, type BrowserContext } from "playwright";
import type { Stage2Config } from "../config.js";
import { ensureStage2Chrome } from "./chrome.js";

export interface Stage2Browser {
  browser: Browser;
  context: BrowserContext;
}

export async function connectStage2Browser(config: Stage2Config): Promise<Stage2Browser> {
  await ensureStage2Chrome(config);
  const browser = await chromium.connectOverCDP(config.cdpEndpoint);
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("Stage 2 Chrome exposed no browser context.");
  }
  return { browser, context };
}

export async function pageTargetId(page: import("playwright").Page): Promise<string | undefined> {
  try {
    const session = await page.context().newCDPSession(page);
    const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    await session.detach();
    return result.targetInfo?.targetId;
  } catch {
    return undefined;
  }
}
