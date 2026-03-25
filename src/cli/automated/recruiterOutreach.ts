import fs from "fs";
import path from "path";
import { chromium, Page } from "playwright";
import { getRecruiterOutreachPath, readRecruiterOutreach } from "../../utils/automated/recruiterOutreach";

function getLinkedInStoragePath() {
  return path.join(process.cwd(), "storage", "linkedin.json");
}

function buildNote(role: string, firstName: string | null) {
  const greeting = firstName ? `Hi ${firstName},` : "Hi ,";
  return [
    greeting,
    "",
    `I'm Sudharsan and I recently applied to ${role} role and sent a quick intro over email. Would love to connect here as well.`,
    "",
    "Thanks a lot☺"
  ].join("\n");
}

async function findFirstName(page: Page) {
  const first = await page.evaluate(() => {
    // document.title is always "First Last | LinkedIn" — most reliable source
    const titleMatch = document.title.match(/^([^|]+)/);
    if (titleMatch) {
      const firstName = titleMatch[1].trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
      if (firstName) return firstName;
    }
    // Fallback: h1 or h2 outside the dialog (LinkedIn uses h2 for profile names)
    for (const tag of ["h1", "h2"]) {
      const els = Array.from(document.querySelectorAll(tag));
      const el = els.find((e) => !e.closest("[role='dialog']") && !e.closest("[role='alertdialog']"));
      if (el) {
        const text = el.textContent?.trim() ?? "";
        const first = text.split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
        if (first) return first;
      }
    }
    return "";
  });
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

async function clickVisibleLocator(locator: ReturnType<Page["locator"]>) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.y > 900) continue;

    await candidate.click({ timeout: 5000, force: true });
    return true;
  }
  return false;
}

async function waitForInviteDialog(page: Page, timeoutMs = 6000) {
  const dialogSignals = [
    page.locator("[role='dialog'] button:has-text('Add a note')").first(),
    page.locator("[role='dialog'] textarea").first(),
    page.locator("[role='dialog'] button:has-text('Send without a note')").first(),
    page.locator("[role='dialog'] h2:has-text('Add a note')").first(),
    page.locator("[role='dialog'] h2:has-text('Add a note to your invitation')").first()
  ];

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const signal of dialogSignals) {
      const visible = await signal.isVisible().catch(() => false);
      if (visible) return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
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

async function clickDropdownConnect(page: Page) {
  await page.waitForTimeout(800);

  const candidates = [
    page.locator("div.artdeco-dropdown__content-inner a[href*='/preload/custom-invite/']").first(),
    page.locator("div.artdeco-dropdown__content-inner [role='menuitem']").filter({ hasText: /^Connect$/ }).first(),
    page.locator("div.artdeco-dropdown__content-inner li").filter({ hasText: /^Connect$/ }).first(),
    page.locator("div.artdeco-dropdown__content-inner").getByRole("button", { name: /connect/i }).first(),
    page.locator("div.artdeco-dropdown__content-inner").getByText("Connect", { exact: true }).first(),
    page.getByRole("menuitem", { name: /connect/i }).first(),
  ];

  for (const candidate of candidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (visible) {
      await candidate.click({ timeout: 5000 });
      return true;
    }
  }

  return false;
}

async function openConnectFlow(page: Page) {
  const directConnectSelectors = [
    "main section button[aria-label*='invite' i][aria-label*='connect' i]",
    "main section button:has-text('Connect')",
    "main section a[aria-label*='invite' i][aria-label*='connect' i]",
    "main section a[href*='/overlay/connect/']"
  ];

  let clickedDirect = false;
  for (const selector of directConnectSelectors) {
    clickedDirect = await clickVisibleLocator(page.locator(selector));
    if (clickedDirect) break;
  }

  if (!clickedDirect) {
    clickedDirect = await clickTopCardButton(page, ({ text, aria }) => {
      const combined = `${text} ${aria}`.toLowerCase();
      return combined.includes("connect") && !combined.includes("message") && !combined.includes("follow");
    });
  }

  if (clickedDirect) {
    const openedDialog = await waitForInviteDialog(page);
    return openedDialog ? "direct" : "none";
  }

  const clickedMore = await clickTopCardButton(page, ({ text, aria }) => {
    const combined = `${text} ${aria}`.toLowerCase();
    return combined.includes("more");
  });
  if (!clickedMore) return false;

  await page.waitForTimeout(500);
  const clickedDropdownConnect = await clickDropdownConnect(page);
  if (clickedDropdownConnect) {
    const openedDialog = await waitForInviteDialog(page, 10000);
    return openedDialog ? "more" : "none";
  }

  return "none";
}

async function addNoteAndFill(page: Page, role: string) {
  const dialogTextarea = page.locator("[role='dialog'] textarea").first();

  // Case 1: textarea already visible (dialog opened directly to note input)
  const textareaVisible = await dialogTextarea.isVisible().catch(() => false);

  if (!textareaVisible) {
    // Case 2: need to click "Add a note" button first
    const addNoteSelectors = [
      "[role='dialog'] button:has-text('Add a note')",
      "button:has-text('Add a note')",
      "button[aria-label*='Add a note' i]"
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

    // Poll for textarea rather than using waitFor (which throws on timeout)
    let appeared = false;
    for (let i = 0; i < 40; i += 1) {
      const visible = await dialogTextarea.isVisible().catch(() => false);
      if (visible) { appeared = true; break; }
      await page.waitForTimeout(200);
    }
    if (!appeared) {
      return { status: "no-add-note" as const };
    }
  }

  const firstName = await findFirstName(page);
  const note = buildNote(role, firstName);

  await dialogTextarea.click();
  await page.keyboard.insertText(note);

  return { status: "filled" as const, firstName, note };
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

  const browser = await chromium.launch({ headless: false, slowMo: 15 });
  const context = await browser.newContext({ storageState: storagePath });
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
        if (opened === "none" || opened === false) {
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

  console.log("\nAll recruiter tabs are left open for review. Press Ctrl+C when done.");
}

main().catch((error) => {
  console.error("recruiterOutreach failed:", error);
  process.exit(1);
});
