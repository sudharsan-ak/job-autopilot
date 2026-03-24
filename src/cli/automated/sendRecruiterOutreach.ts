import { chromium, Page } from "playwright";
import {
  getRecruiterOutreachSessionPath,
  readRecruiterOutreachSession
} from "../../utils/automated/recruiterOutreach";

function getArg(name: string) {
  const hit = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return null;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? null;
}

function getDelaySeconds() {
  const raw = getArg("delaySeconds");
  if (!raw) return 10;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --delaySeconds value: ${raw}`);
  }
  return parsed;
}

async function getPreparedDialog(page: Page) {
  const dialog = page.locator("[role='dialog']").last();
  const visible = await dialog.isVisible().catch(() => false);
  if (!visible) {
    return null;
  }
  return dialog;
}

async function getDialogTextarea(page: Page) {
  const dialog = await getPreparedDialog(page);
  if (!dialog) return null;
  const textarea = dialog.locator("textarea").first();
  const visible = await textarea.isVisible().catch(() => false);
  if (!visible) return null;
  return textarea;
}

async function getSendButton(page: Page) {
  const dialog = await getPreparedDialog(page);
  if (!dialog) return null;

  const selectors = [
    "button:has-text('Send')",
    "button[aria-label*='Send' i]",
    "button.artdeco-button--primary"
  ];

  for (const selector of selectors) {
    const button = dialog.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    const text = ((await button.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const aria = ((await button.getAttribute("aria-label").catch(() => "")) ?? "").toLowerCase();
    const combined = `${text} ${aria}`;
    if (!combined.includes("send")) continue;
    return button;
  }

  return null;
}

async function sendPreparedInvite(page: Page) {
  const url = page.url();
  await page.bringToFront();
  await page.waitForTimeout(500);

  const textarea = await getDialogTextarea(page);
  if (!textarea) {
    return { sent: false, reason: "no open connect dialog with note textarea", url };
  }

  const note = ((await textarea.inputValue().catch(() => "")) ?? "").trim();
  if (!note) {
    return { sent: false, reason: "note textarea is empty", url };
  }

  const sendButton = await getSendButton(page);
  if (!sendButton) {
    return { sent: false, reason: "send button not found", url };
  }

  const enabled = await sendButton.isEnabled().catch(() => false);
  if (!enabled) {
    return { sent: false, reason: "send button is disabled", url };
  }

  await sendButton.click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  return { sent: true, reason: "sent", url };
}

async function main() {
  const delaySeconds = getDelaySeconds();
  const session = readRecruiterOutreachSession();
  if (!session) {
    throw new Error(
      `Recruiter outreach session not found. Run npm run recruiterOutreach first and keep that terminal open. Expected session file at ${getRecruiterOutreachSessionPath()}`
    );
  }

  const browser = await chromium.connectOverCDP(session.cdpEndpoint);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Recruiter outreach browser session was found, but no browser context is available.");
  }

  const pages = context
    .pages()
    .filter((page) => /linkedin\.com\/in\//i.test(page.url()));

  if (pages.length === 0) {
    throw new Error("No LinkedIn recruiter profile tabs found in the active outreach session.");
  }

  console.log(`Connected to existing recruiter outreach session with ${pages.length} recruiter tab(s).`);
  console.log(`Delay between successful sends: ${delaySeconds} second(s).`);

  let sentCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    console.log(`[${i + 1}/${pages.length}] ${page.url()}`);

    try {
      const result = await sendPreparedInvite(page);
      if (!result.sent) {
        skippedCount += 1;
        console.log(` -> skipped | ${result.reason}`);
        continue;
      }

      sentCount += 1;
      console.log(" -> sent");

      if (i < pages.length - 1 && delaySeconds > 0) {
        console.log(` -> waiting ${delaySeconds} second(s) before next tab`);
        await page.waitForTimeout(delaySeconds * 1000);
      }
    } catch (error) {
      skippedCount += 1;
      console.log(` -> skipped | ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`Send run complete. Sent: ${sentCount} | Skipped: ${skippedCount}`);
}

main().catch((error) => {
  console.error("sendRecruiterOutreach failed:", error);
  process.exit(1);
});
