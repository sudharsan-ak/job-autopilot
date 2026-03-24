import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";
import { chromium, Page } from "playwright";
import {
  clearRecruiterOutreachSession,
  getRecruiterOutreachPath,
  getRecruiterOutreachSessionPath,
  readRecruiterOutreach,
  saveRecruiterOutreachSession
} from "../../utils/automated/recruiterOutreach";

function getLinkedInStoragePath() {
  return path.join(process.cwd(), "storage", "linkedin.json");
}

function getRecruiterBrowserProfileDir() {
  return path.join(process.cwd(), "storage", "recruiter-outreach-browser");
}

function getDebugPort() {
  return 9223;
}

function getCdpEndpoint() {
  return `http://127.0.0.1:${getDebugPort()}`;
}

function buildNote(role: string, firstName: string | null) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  return [
    greeting,
    "",
    `I'm Sudharsan and I recently applied to ${role} role and sent a quick intro over email. Would love to connect here as well.`,
    "",
    "Thanks a lot☺"
  ].join("\n");
}

function readStorageState(storagePath: string) {
  const raw = fs.readFileSync(storagePath, "utf8");
  return JSON.parse(raw) as {
    cookies?: Array<Record<string, any>>;
  };
}

async function waitForCdpEndpoint(timeoutMs = 15000) {
  const endpoint = `${getCdpEndpoint()}/json/version`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for Chromium CDP endpoint at ${endpoint}`);
}

function launchSharedChromiumProcess() {
  const userDataDir = getRecruiterBrowserProfileDir();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    chromium.executablePath(),
    [
      `--remote-debugging-port=${getDebugPort()}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-session-crashed-bubble",
      "about:blank"
    ],
    {
      detached: false,
      stdio: "ignore"
    }
  );

  return child;
}

async function ensureLinkedInAuth(page: Page, storagePath: string) {
  const storage = readStorageState(storagePath);
  const cookies = (storage.cookies ?? []).filter((cookie) => /linkedin\.com$/i.test(cookie.domain ?? ""));
  if (cookies.length > 0) {
    await page.context().addCookies(cookies as any);
  }
}

async function findFirstName(page: Page) {
  const heading = page.locator("h1").first();
  const text = (await heading.textContent().catch(() => ""))?.trim() ?? "";
  if (!text) return null;
  const first = text.split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
  return first || null;
}

async function getTopCardButtonHandles(page: Page) {
  const buttons = page.locator("main section button");
  const count = await buttons.count();
  const results: Array<{ index: number; text: string; aria: string }> = [];

  for (let i = 0; i < Math.min(count, 12); i += 1) {
    const button = buttons.nth(i);
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await button.boundingBox().catch(() => null);
    if (!box || box.y > 900) continue;

    const text = ((await button.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    const aria = (await button.getAttribute("aria-label").catch(() => "")) ?? "";
    results.push({ index: i, text, aria });
  }

  return results;
}

async function clickTopCardButton(page: Page, matcher: (button: { text: string; aria: string }) => boolean) {
  const buttons = await getTopCardButtonHandles(page);
  const match = buttons.find(matcher);
  if (!match) return false;
  const target = page.locator("main section button").nth(match.index);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 5000, force: true });
  return true;
}

async function openConnectFlow(page: Page) {
  const clickedDirect = await clickTopCardButton(page, ({ text, aria }) => {
    const combined = `${text} ${aria}`.toLowerCase();
    return combined.includes("connect") && !combined.includes("message") && !combined.includes("follow");
  });
  if (clickedDirect) return true;

  const clickedMore = await clickTopCardButton(page, ({ text, aria }) => {
    const combined = `${text} ${aria}`.toLowerCase();
    return combined.includes("more");
  });
  if (!clickedMore) return false;

  await page.waitForTimeout(500);
  const dropdownItems = page.locator("div.artdeco-dropdown__content-inner *");
  const count = await dropdownItems.count();

  for (let i = 0; i < count; i += 1) {
    const item = dropdownItems.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;

    const text = ((await item.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const aria = ((await item.getAttribute("aria-label").catch(() => "")) ?? "").toLowerCase();
    const role = ((await item.getAttribute("role").catch(() => "")) ?? "").toLowerCase();
    const combined = `${text} ${aria} ${role}`;
    if (!combined.includes("connect")) continue;

    await item.click({ timeout: 5000, force: true });
    await page.waitForTimeout(600);
    return true;
  }

  return false;
}

async function addNoteAndFill(page: Page, role: string) {
  const addNoteSelectors = [
    "button:has-text('Add a note')",
    "button[aria-label*='Add a note' i]",
    "[role='dialog'] button:has-text('Add a note')"
  ];

  let addNoteButton = null as ReturnType<Page["locator"]> | null;
  for (const selector of addNoteSelectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    addNoteButton = locator;
    break;
  }

  if (!addNoteButton) {
    return { status: "no-add-note" as const };
  }

  await addNoteButton.click({ timeout: 5000 });
  await page.waitForTimeout(500);

  const firstName = await findFirstName(page);
  const note = buildNote(role, firstName);
  const textbox = page.locator("[role='dialog'] textarea").first();
  await textbox.fill(note, { timeout: 5000 });
  return { status: "filled" as const, firstName };
}

async function main() {
  const groups = readRecruiterOutreach();
  if (groups.length === 0) {
    console.log(`No recruiter outreach entries found in ${getRecruiterOutreachPath()}`);
    process.exit(0);
  }

  const storagePath = getLinkedInStoragePath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(`LinkedIn session not found. Run: npm run authLinkedIn`);
  }

  const browserProcess = launchSharedChromiumProcess();
  await waitForCdpEndpoint();

  saveRecruiterOutreachSession({
    cdpEndpoint: getCdpEndpoint(),
    browserPid: browserProcess.pid,
    createdAt: new Date().toISOString()
  });

  const browser = await chromium.connectOverCDP(getCdpEndpoint(), { slowMo: 60 });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Could not access the shared recruiter outreach browser context.");
  }

  const seedPage = context.pages()[0] ?? (await context.newPage());
  await ensureLinkedInAuth(seedPage, storagePath);
  await seedPage.close().catch(() => {});

  const total = groups.reduce((sum, group) => sum + group.links.length, 0);
  console.log(`Preparing LinkedIn recruiter outreach for ${total} profile(s)...`);

  let current = 0;
  for (const group of groups) {
    console.log(`\nRole: ${group.role}`);
    for (const link of group.links) {
      current += 1;
      const page = await context.newPage();
      try {
        console.log(`[${current}/${total}] Opening ${link}`);
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForTimeout(1800);
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

        const topButtons = await getTopCardButtonHandles(page);
        const connectedState = topButtons.some(({ text, aria }) => {
          const combined = `${text} ${aria}`.toLowerCase();
          return combined.includes("pending") || combined.includes("following");
        });

        if (connectedState) {
          console.log("Connect not needed or already pending/connected. Leaving tab open.");
          continue;
        }

        const opened = await openConnectFlow(page);
        if (!opened) {
          console.log("Connect button not found directly or under More. Leaving tab open.");
          continue;
        }

        const result = await addNoteAndFill(page, group.role);
        if (result.status !== "filled") {
          console.log("Connect opened, but Add a note was unavailable. Leaving tab open.");
          continue;
        }

        console.log(`Note prepared${result.firstName ? ` for ${result.firstName}` : ""}. Review and send manually.`);
      } catch (error) {
        console.error(`Failed for ${link}:`, error);
      }
    }
  }

  console.log(`\nAll recruiter tabs are left open for review.`);
  console.log(`Session saved to ${getRecruiterOutreachSessionPath()}`);
  console.log("Keep this terminal and browser window open while you review tabs.");
  console.log("When ready, run the separate send command from another terminal.");
  console.log("Press Ctrl+C in this terminal only after you are completely done.");

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearRecruiterOutreachSession();
    await browser.close().catch(() => {});
    if (browserProcess.pid) {
      try {
        process.kill(browserProcess.pid);
      } catch {}
    }
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>(() => {});
}

main().catch((error) => {
  console.error("recruiterOutreach failed:", error);
  process.exit(1);
});
