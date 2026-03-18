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
  const heading = page.locator("h1").first();
  const text = (await heading.textContent().catch(() => ""))?.trim() ?? "";
  if (!text) {
    return null;
  }

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
  if (!match) {
    return false;
  }

  await page.locator("main section button").nth(match.index).click({ timeout: 5000 });
  return true;
}

async function openConnectFlow(page: Page) {
  const clickedDirect = await clickTopCardButton(page, ({ text, aria }) => {
    const combined = `${text} ${aria}`.toLowerCase();
    return combined.includes("connect") && !combined.includes("message") && !combined.includes("follow");
  });
  if (clickedDirect) {
    return true;
  }

  const clickedMore = await clickTopCardButton(page, ({ text, aria }) => {
    const combined = `${text} ${aria}`.toLowerCase();
    return combined.includes("more");
  });
  if (!clickedMore) {
    return false;
  }

  await page.waitForTimeout(500);
  const dropdownItems = page.locator("div.artdeco-dropdown__content-inner *");
  const count = await dropdownItems.count();

  for (let i = 0; i < count; i += 1) {
    const item = dropdownItems.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    const text = ((await item.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const aria = ((await item.getAttribute("aria-label").catch(() => "")) ?? "").toLowerCase();
    const role = ((await item.getAttribute("role").catch(() => "")) ?? "").toLowerCase();
    const combined = `${text} ${aria} ${role}`;

    if (!combined.includes("connect")) {
      continue;
    }

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
    if (!visible) {
      continue;
    }
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
  const textbox = page
    .locator("[role='dialog'] textarea")
    .or(page.locator("textarea"))
    .or(page.locator("[aria-label*='Add a note' i]"))
    .first();

  await textbox.fill(note, { timeout: 5000 });
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

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
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

  console.log("\nAll recruiter tabs are left open for review. Press Ctrl+C when done.");
}

main().catch((error) => {
  console.error("recruiterOutreach failed:", error);
  process.exit(1);
});
