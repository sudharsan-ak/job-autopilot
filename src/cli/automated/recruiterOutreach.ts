import fs from "fs";
import path from "path";
import { chromium, Locator, Page } from "playwright";
import { getRecruiterOutreachPath, readRecruiterOutreach } from "../../utils/automated/recruiterOutreach";

const PROFILE_READY_TIMEOUT_MS = 20000;
const INVITE_DIALOG_TIMEOUT_MS = 10000;
const OVERFLOW_MENU_TIMEOUT_MS = 8000;
const SEND_DELAY_SECONDS = 5;

type AttemptStage =
  | "load-profile"
  | "locate-header-actions"
  | "open-direct-connect"
  | "open-more-menu"
  | "choose-connect-from-menu"
  | "open-note-editor"
  | "fill-note"
  | "ready-to-send";

type AttemptStatus = "prepared" | "skipped" | "failed";

type FailureReason =
  | "header-not-found"
  | "already-pending-or-following"
  | "direct-connect-clicked-no-dialog"
  | "more-button-not-found"
  | "more-menu-not-visible"
  | "overflow-menu-opened-no-connect"
  | "overflow-connect-clicked-no-dialog"
  | "invite-dialog-not-found"
  | "add-note-unavailable"
  | "add-note-clicked-textarea-missing"
  | "fill-note-failed"
  | "unexpected-error";

type ConnectBranch = "direct" | "more" | null;

type ActionSummary = {
  tag: string;
  text: string;
  aria: string;
  href: string;
  label: string;
};

type AttemptEvent = {
  stage: AttemptStage;
  message: string;
};

type AttemptDiagnostic = {
  index: number;
  total: number;
  role: string;
  url: string;
  stage: AttemptStage;
  status: AttemptStatus;
  branch: ConnectBranch;
  failureReason: FailureReason | null;
  errorMessage: string | null;
  headerFound: boolean;
  menuVisible: boolean;
  dialogVisible: boolean;
  textareaVisible: boolean;
  firstName: string | null;
  noteLength: number;
  headerActions: ActionSummary[];
  menuActions: ActionSummary[];
  events: AttemptEvent[];
  screenshotPath: string | null;
  snapshotPath: string | null;
};

type HeaderActionsResult =
  | {
      status: "opened";
      branch: "direct" | "more";
      headerRoot: Locator;
    }
  | {
      status: "skipped" | "failed";
      reason: FailureReason;
      headerRoot: Locator | null;
    };

type NoteFillResult =
  | {
      status: "filled";
      firstName: string | null;
      note: string;
    }
  | {
      status: "failed";
      reason: FailureReason;
    };

function getLinkedInStoragePath() {
  return path.join(process.cwd(), "storage", "linkedin.json");
}

function getRecruiterOutreachDiagnosticsRootPath() {
  return path.join(process.cwd(), "data", "recruiter-outreach");
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

async function findFirstName(page: Page) {
  const first = await page.evaluate(() => {
    // document.title is always "First Last | LinkedIn" - most reliable source
    const titleMatch = document.title.match(/^([^|]+)/);
    if (titleMatch) {
      const firstName = titleMatch[1].trim().split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
      if (firstName) return firstName;
    }

    for (const tag of ["h1", "h2"]) {
      const els = Array.from(document.querySelectorAll(tag));
      const el = els.find((e) => !e.closest("[role='dialog']") && !e.closest("[role='alertdialog']"));
      if (el) {
        const text = el.textContent?.trim() ?? "";
        const firstName = text.split(/\s+/)[0]?.replace(/[^A-Za-z'-]/g, "") ?? "";
        if (firstName) return firstName;
      }
    }

    return "";
  });

  return first || null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createRunTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDirectory(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFileSegment(value: string) {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return sanitized || "profile";
}

function getProfileSlug(url: string) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop() ?? "profile";
    return sanitizeFileSegment(last);
  } catch {
    return sanitizeFileSegment(url);
  }
}

function createAttemptDiagnostic(index: number, total: number, role: string, url: string): AttemptDiagnostic {
  return {
    index,
    total,
    role,
    url,
    stage: "load-profile",
    status: "failed",
    branch: null,
    failureReason: null,
    errorMessage: null,
    headerFound: false,
    menuVisible: false,
    dialogVisible: false,
    textareaVisible: false,
    firstName: null,
    noteLength: 0,
    headerActions: [],
    menuActions: [],
    events: [],
    screenshotPath: null,
    snapshotPath: null
  };
}

function pushAttemptEvent(attempt: AttemptDiagnostic, message: string) {
  attempt.events.push({ stage: attempt.stage, message });
  console.log(message);
}

function actionSummaryLabel(summary: ActionSummary) {
  if (summary.label) return summary.label;
  if (summary.href) return summary.href;
  return summary.tag;
}

function formatActionList(actions: ActionSummary[]) {
  if (actions.length === 0) return "none";
  return actions.map((action) => actionSummaryLabel(action)).join(" | ");
}

function collapseWhitespace(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

async function readActionSummary(locator: Locator): Promise<ActionSummary> {
  const text = collapseWhitespace(await locator.textContent().catch(() => ""));
  const aria = collapseWhitespace(await locator.getAttribute("aria-label").catch(() => ""));
  const href = collapseWhitespace(await locator.getAttribute("href").catch(() => ""));
  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "unknown");
  const label = collapseWhitespace([text, aria].filter(Boolean).join(" | "));

  return { tag, text, aria, href, label };
}

async function collectVisibleActions(scope: Locator, selector: string, limit = 30) {
  const locators = scope.locator(selector);
  const count = await locators.count().catch(() => 0);
  const results: ActionSummary[] = [];

  for (let i = 0; i < Math.min(count, limit); i += 1) {
    const candidate = locators.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width < 4 || box.height < 4) continue;

    results.push(await readActionSummary(candidate));
  }

  return results;
}

async function findVisibleAction(
  scope: Locator,
  selector: string,
  matcher: (summary: ActionSummary) => boolean,
  limit = 30
) {
  const locators = scope.locator(selector);
  const count = await locators.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, limit); i += 1) {
    const candidate = locators.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width < 4 || box.height < 4) continue;

    const summary = await readActionSummary(candidate);
    if (matcher(summary)) {
      return { locator: candidate, summary };
    }
  }

  return null;
}

function isPendingOrFollowingAction(summary: ActionSummary) {
  const combined = `${summary.text} ${summary.aria}`.toLowerCase();
  return combined.includes("pending") || combined.includes("following") || combined.includes("invitation sent");
}

function isConnectAction(summary: ActionSummary) {
  const combined = `${summary.text} ${summary.aria}`.toLowerCase();
  if (!combined.includes("connect")) return false;
  return !combined.includes("message") && !combined.includes("follow") && !combined.includes("contact");
}

function isMoreAction(summary: ActionSummary) {
  const combined = `${summary.text} ${summary.aria}`.toLowerCase();
  return combined.includes("more");
}

async function clickLocator(locator: Locator, label: string) {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.waitFor({ state: "visible", timeout: 5000 });
      await locator.click({ timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await delay(250);
      }
    }
  }

  throw new Error(`Failed to click ${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function activateLocatorByDom(locator: Locator, label: string) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.waitFor({ state: "visible", timeout: 5000 });
  await locator.evaluate((el) => {
    if (el instanceof HTMLElement) {
      el.click();
      return;
    }

    (el as { click?: () => void }).click?.();
  }).catch((error) => {
    throw new Error(`Failed to activate ${label} via DOM click: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function findVisibleProfileHeading(page: Page) {
  const headingGroups = [
    page.locator("main h1"),
    page.locator("main h2")
  ];

  const deadline = Date.now() + PROFILE_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    for (const group of headingGroups) {
      const count = await group.count().catch(() => 0);

      for (let i = 0; i < Math.min(count, 12); i += 1) {
        const heading = group.nth(i);
        const visible = await heading.isVisible().catch(() => false);
        if (!visible) continue;

        const text = collapseWhitespace(await heading.textContent().catch(() => ""));
        if (!text) continue;

        const box = await heading.boundingBox().catch(() => null);
        if (!box || box.width < 40 || box.height < 10) continue;
        if (box.y > 900) continue;

        return heading;
      }
    }

    await delay(150);
  }

  return null;
}

async function locateProfileHeaderRoot(page: Page) {
  const heading = await findVisibleProfileHeading(page);
  if (!heading) {
    return null;
  }

  const candidates = [
    heading.locator("xpath=ancestor::*[contains(@class, 'pv-top-card')][1]"),
    heading.locator("xpath=ancestor::*[self::section or self::div][.//button or .//a][1]"),
    heading.locator("xpath=ancestor::section[1]"),
    page.locator("main section").filter({ has: heading }).first()
  ];

  for (const candidate of candidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width < 100 || box.height < 100) continue;

    return candidate;
  }

  return null;
}

async function waitForHeaderButtons(headerRoot: Locator, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const visibleButtons = await collectVisibleActions(headerRoot, "button", 20);
    if (visibleButtons.length > 0) {
      return;
    }

    await delay(150);
  }
}

async function findHeaderDirectConnect(headerRoot: Locator) {
  const selectors = [
    "a[href*='/preload/custom-invite/'][aria-label*='connect' i]",
    "a[aria-label*='invite' i][aria-label*='connect' i]",
    "button[aria-label*='invite' i][aria-label*='connect' i]",
    "a[href*='/overlay/connect/'][aria-label*='connect' i]"
  ];

  for (const selector of selectors) {
    const match = await findVisibleAction(headerRoot, selector, () => true, 12);
    if (match) {
      return match;
    }
  }

  return null;
}

async function findHeaderMoreButton(headerRoot: Locator) {
  const selectors = [
    "button[aria-label='More']",
    "button[aria-label*='More' i][aria-expanded]",
    "button[aria-label*='More' i]"
  ];

  for (const selector of selectors) {
    const match = await findVisibleAction(headerRoot, selector, isMoreAction, 12);
    if (match) {
      return match;
    }
  }

  return null;
}

async function findInviteSendButton(dialog: Locator) {
  const sendCandidates = [
    dialog.locator("button[aria-label*='Send invitation' i]").first(),
    dialog.locator("button[aria-label*='Send' i]").first(),
    dialog.getByRole("button", { name: /send invitation/i }).first(),
    dialog.getByRole("button", { name: /^send$/i }).first(),
    dialog.locator("button:has-text('Send')").first()
  ];

  for (const candidate of sendCandidates) {
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width < 4 || box.height < 4) continue;

    return candidate;
  }

  return null;
}

async function isInviteDialog(dialog: Locator) {
  const text = ((await dialog.textContent().catch(() => "")) ?? "").toLowerCase();
  const textareaVisible = await dialog.locator("textarea").first().isVisible().catch(() => false);
  const addNoteVisible = await dialog.locator("button:has-text('Add a note')").first().isVisible().catch(() => false);
  const sendWithoutNoteVisible = await dialog.locator("button:has-text('Send without a note')").first().isVisible().catch(() => false);
  const emailInputVisible = await dialog.locator("input[type='email'], input[inputmode='email']").first().isVisible().catch(() => false);
  const cancelVisible = await dialog.getByRole("button", { name: /cancel/i }).first().isVisible().catch(() => false);
  const sendButton = await findInviteSendButton(dialog);

  const looksLikeInviteByText =
    text.includes("add a note to your invitation") ||
    text.includes("send without a note") ||
    text.includes("personalize your invitation") ||
    text.includes("enter their email to connect") ||
    text.includes("include a personal note") ||
    text.includes("to connect");

  const hasInviteControls =
    textareaVisible ||
    addNoteVisible ||
    sendWithoutNoteVisible ||
    emailInputVisible ||
    (cancelVisible && sendButton !== null);

  return looksLikeInviteByText || (sendButton !== null && hasInviteControls);
}

async function findInviteDialog(page: Page) {
  const dialogs = page.locator("[role='dialog']");
  const count = await dialogs.count().catch(() => 0);

  for (let i = 0; i < Math.min(count, 6); i += 1) {
    const dialog = dialogs.nth(i);
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) continue;

    const inviteDialog = await isInviteDialog(dialog);
    if (inviteDialog) {
      return dialog;
    }
  }

  return null;
}

async function waitForInviteDialog(page: Page, timeoutMs = INVITE_DIALOG_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const dialog = await findInviteDialog(page);
    if (dialog) return dialog;
    await delay(150);
  }

  return null;
}

async function waitForVisibleOverflowMenu(page: Page, timeoutMs = OVERFLOW_MENU_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const menus = page.locator("div.artdeco-dropdown__content-inner, div[role='menu']");
    const count = await menus.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 6); i += 1) {
      const menu = menus.nth(i);
      const visible = await menu.isVisible().catch(() => false);
      if (!visible) continue;

      const menuActions = await collectVisibleActions(menu, "a, button, [role='menuitem']", 20);
      if (menuActions.length > 0) {
        return { menu, menuActions };
      }
    }

    await delay(150);
  }

  return null;
}

async function openHeaderConnectFlow(page: Page, attempt: AttemptDiagnostic): Promise<HeaderActionsResult> {
  attempt.stage = "locate-header-actions";
  const headerRoot = await locateProfileHeaderRoot(page);
  if (!headerRoot) {
    attempt.failureReason = "header-not-found";
    pushAttemptEvent(attempt, "Header top card not found.");
    return { status: "failed", reason: "header-not-found", headerRoot: null };
  }

  attempt.headerFound = true;
  await waitForHeaderButtons(headerRoot);
  attempt.headerActions = await collectVisibleActions(headerRoot, "button, a", 30);
  pushAttemptEvent(attempt, `Header actions detected: ${formatActionList(attempt.headerActions)}`);

  if (attempt.headerActions.some(isPendingOrFollowingAction)) {
    attempt.failureReason = "already-pending-or-following";
    pushAttemptEvent(attempt, "Connect not needed or already pending/following. Leaving tab open.");
    return { status: "skipped", reason: "already-pending-or-following", headerRoot };
  }

  attempt.stage = "open-direct-connect";
  const directConnect = await findHeaderDirectConnect(headerRoot);
  if (directConnect) {
    pushAttemptEvent(attempt, `Trying direct Connect from header: ${actionSummaryLabel(directConnect.summary)}`);
    try {
      await activateLocatorByDom(directConnect.locator, "direct Connect button");
      const dialog = await waitForInviteDialog(page, INVITE_DIALOG_TIMEOUT_MS);
      if (dialog) {
        attempt.dialogVisible = true;
        attempt.branch = "direct";
        pushAttemptEvent(attempt, "Invite dialog opened from direct Connect.");
        return { status: "opened", branch: "direct", headerRoot };
      }

      pushAttemptEvent(attempt, "Direct Connect was clicked, but no invite dialog appeared. Falling back to More.");
    } catch (error) {
      pushAttemptEvent(
        attempt,
        `Direct Connect click failed: ${error instanceof Error ? error.message : String(error)}. Falling back to More.`
      );
    }
  } else {
    pushAttemptEvent(attempt, "No direct Connect action found in the header.");
  }

  attempt.stage = "open-more-menu";
  const moreButton = await findHeaderMoreButton(headerRoot);
  if (!moreButton) {
    attempt.failureReason = directConnect ? "direct-connect-clicked-no-dialog" : "more-button-not-found";
    pushAttemptEvent(attempt, "Header More action not found after direct Connect path failed.");
    return {
      status: "failed",
      reason: directConnect ? "direct-connect-clicked-no-dialog" : "more-button-not-found",
      headerRoot
    };
  }

  pushAttemptEvent(attempt, `Opening More menu from header: ${actionSummaryLabel(moreButton.summary)}`);

  try {
    await activateLocatorByDom(moreButton.locator, "More menu button");
  } catch (error) {
    attempt.failureReason = "more-menu-not-visible";
    pushAttemptEvent(attempt, `More button click failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "failed", reason: "more-menu-not-visible", headerRoot };
  }

  const menuResult = await waitForVisibleOverflowMenu(page, OVERFLOW_MENU_TIMEOUT_MS);
  if (!menuResult) {
    attempt.failureReason = "more-menu-not-visible";
    pushAttemptEvent(attempt, "More menu did not become visible.");
    return { status: "failed", reason: "more-menu-not-visible", headerRoot };
  }

  attempt.menuVisible = true;
  attempt.menuActions = menuResult.menuActions;
  pushAttemptEvent(attempt, `Visible More menu actions: ${formatActionList(attempt.menuActions)}`);

  attempt.stage = "choose-connect-from-menu";
  const menuConnect = await findVisibleAction(menuResult.menu, "a, button, [role='menuitem'], li", isConnectAction, 30);
  if (!menuConnect) {
    attempt.failureReason = "overflow-menu-opened-no-connect";
    pushAttemptEvent(attempt, "More menu opened, but no Connect action was found inside it.");
    return { status: "failed", reason: "overflow-menu-opened-no-connect", headerRoot };
  }

  pushAttemptEvent(attempt, `Trying Connect from More menu: ${actionSummaryLabel(menuConnect.summary)}`);

  try {
    await activateLocatorByDom(menuConnect.locator, "Connect option inside More menu");
  } catch (error) {
    attempt.failureReason = "overflow-connect-clicked-no-dialog";
    pushAttemptEvent(
      attempt,
      `Connect click inside More menu failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return { status: "failed", reason: "overflow-connect-clicked-no-dialog", headerRoot };
  }

  const dialog = await waitForInviteDialog(page, INVITE_DIALOG_TIMEOUT_MS);
  if (!dialog) {
    attempt.failureReason = "overflow-connect-clicked-no-dialog";
    pushAttemptEvent(attempt, "Connect inside More menu was clicked, but no invite dialog appeared.");
    return { status: "failed", reason: "overflow-connect-clicked-no-dialog", headerRoot };
  }

  attempt.dialogVisible = true;
  attempt.branch = "more";
  pushAttemptEvent(attempt, "Invite dialog opened from the More menu Connect path.");
  return { status: "opened", branch: "more", headerRoot };
}

async function fillPreparedNote(page: Page, role: string, attempt: AttemptDiagnostic): Promise<NoteFillResult> {
  attempt.stage = "open-note-editor";
  const dialog = await waitForInviteDialog(page, INVITE_DIALOG_TIMEOUT_MS);
  if (!dialog) {
    attempt.failureReason = "invite-dialog-not-found";
    pushAttemptEvent(attempt, "Invite dialog could not be confirmed before note entry.");
    return { status: "failed", reason: "invite-dialog-not-found" };
  }

  attempt.dialogVisible = true;
  await delay(250);

  let textarea = dialog.locator("textarea").first();
  let textareaVisible = await textarea.isVisible().catch(() => false);

  if (!textareaVisible) {
    pushAttemptEvent(attempt, "Invite dialog opened without textarea. Trying Add a note.");

    for (let noteAttempt = 1; noteAttempt <= 2; noteAttempt += 1) {
      const addNoteButton = await findVisibleAction(dialog, "button", (summary) => {
        const combined = `${summary.text} ${summary.aria}`.toLowerCase();
        return combined.includes("add a note");
      });

      if (!addNoteButton) {
        attempt.failureReason = "add-note-unavailable";
        pushAttemptEvent(attempt, "Add a note button was not available in the invite dialog.");
        return { status: "failed", reason: "add-note-unavailable" };
      }

      pushAttemptEvent(attempt, `Clicking Add a note (attempt ${noteAttempt}/2).`);

      try {
        await clickLocator(addNoteButton.locator, "Add a note button");
      } catch (error) {
        pushAttemptEvent(
          attempt,
          `Add a note click failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const visibleTextarea = await dialog.locator("textarea").first().waitFor({ state: "visible", timeout: 5000 })
        .then(() => dialog.locator("textarea").first())
        .catch(() => null);

      if (visibleTextarea) {
        textarea = visibleTextarea;
        textareaVisible = true;
        break;
      }

      if (noteAttempt < 2) {
        await delay(350);
      }
    }

    if (!textareaVisible) {
      attempt.failureReason = "add-note-clicked-textarea-missing";
      pushAttemptEvent(attempt, "Add a note was clicked, but the note textarea never appeared.");
      return { status: "failed", reason: "add-note-clicked-textarea-missing" };
    }
  } else {
    pushAttemptEvent(attempt, "Invite dialog already contained the note textarea.");
  }

  attempt.textareaVisible = true;
  attempt.stage = "fill-note";

  const firstName = await findFirstName(page);
  const note = buildNote(role, firstName);

  try {
    await textarea.fill("");
    await textarea.fill(note);
    const currentValue = await textarea.inputValue().catch(() => "");

    if (!currentValue.trim()) {
      throw new Error("textarea value remained empty after fill");
    }
  } catch (error) {
    attempt.failureReason = "fill-note-failed";
    pushAttemptEvent(attempt, `Failed to fill note text: ${error instanceof Error ? error.message : String(error)}`);
    return { status: "failed", reason: "fill-note-failed" };
  }

  attempt.firstName = firstName;
  attempt.noteLength = note.length;
  pushAttemptEvent(attempt, `Prepared note${firstName ? ` for ${firstName}` : ""}.`);

  return { status: "filled", firstName, note };
}

function shouldCaptureArtifacts(attempt: AttemptDiagnostic) {
  return attempt.failureReason !== null && attempt.failureReason !== "already-pending-or-following";
}

async function writeFailureArtifacts(runDir: string, attempt: AttemptDiagnostic, page: Page) {
  const slug = getProfileSlug(attempt.url);
  const baseName = `${String(attempt.index).padStart(3, "0")}-${slug}`;
  const screenshotPath = path.join(runDir, `${baseName}.png`);
  const snapshotPath = path.join(runDir, `${baseName}.json`);

  attempt.screenshotPath = screenshotPath;
  attempt.snapshotPath = snapshotPath;
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
  fs.writeFileSync(snapshotPath, JSON.stringify(attempt, null, 2), "utf8");
}

function appendAttemptRecord(runDir: string, attempt: AttemptDiagnostic) {
  const attemptsLogPath = path.join(runDir, "attempts.jsonl");
  fs.appendFileSync(attemptsLogPath, `${JSON.stringify(attempt)}\n`, "utf8");
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }

    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (chunk: string) => {
      if (chunk.includes("\n") || chunk.includes("\r")) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve();
      }
    };

    process.stdin.on("data", onData);
  });
}

async function sendPreparedNotes(pages: Page[], delaySeconds: number) {
  console.log(`\nStarting send - ${delaySeconds}s delay between each...\n`);
  let sent = 0;

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];

    try {
      await page.bringToFront();
      const dialog = await waitForInviteDialog(page, 2500);
      if (!dialog) {
        console.log(`[${i + 1}/${pages.length}] Invite dialog not found - skipping.`);
        continue;
      }

      const sendBtn = await findInviteSendButton(dialog);
      if (!sendBtn) {
        console.log(`[${i + 1}/${pages.length}] Send button not found - skipping.`);
        continue;
      }

      await activateLocatorByDom(sendBtn, "Send invitation button");
      sent += 1;
      console.log(`[${i + 1}/${pages.length}] Sent.`);
    } catch (error) {
      console.error(`[${i + 1}/${pages.length}] Failed to send:`, error);
    }

    if (i < pages.length - 1) {
      await delay(delaySeconds * 1000);
    }
  }

  console.log(`\nDone. ${sent}/${pages.length} invites sent.`);
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

  const diagnosticsRoot = getRecruiterOutreachDiagnosticsRootPath();
  ensureDirectory(diagnosticsRoot);
  const runDir = path.join(diagnosticsRoot, createRunTimestamp());
  ensureDirectory(runDir);

  const browser = await chromium.launch({ headless: false, slowMo: 15 });
  const context = await browser.newContext({ storageState: storagePath });
  const total = groups.reduce((sum, group) => sum + group.links.length, 0);

  console.log(`Preparing LinkedIn recruiter outreach for ${total} profile(s)...`);
  console.log(`Diagnostics directory: ${runDir}`);

  let current = 0;
  const preparedPages: Page[] = [];

  for (const group of groups) {
    console.log(`\nRole: ${group.role}`);

    for (const link of group.links) {
      current += 1;
      const page = await context.newPage();
      const attempt = createAttemptDiagnostic(current, total, group.role, link);

      try {
        console.log(`[${current}/${total}] Opening ${link}`);
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

        const headerResult = await openHeaderConnectFlow(page, attempt);
        if (headerResult.status === "skipped") {
          attempt.status = "skipped";
          appendAttemptRecord(runDir, attempt);
          continue;
        }

        if (headerResult.status === "failed") {
          attempt.status = "failed";
          attempt.failureReason = headerResult.reason;

          if (shouldCaptureArtifacts(attempt)) {
            await writeFailureArtifacts(runDir, attempt, page);
          }

          appendAttemptRecord(runDir, attempt);
          console.log("Connect flow was not completed. Leaving tab open for manual review.");
          continue;
        }

        const noteResult = await fillPreparedNote(page, group.role, attempt);
        if (noteResult.status === "failed") {
          attempt.status = "failed";
          attempt.failureReason = noteResult.reason;

          if (shouldCaptureArtifacts(attempt)) {
            await writeFailureArtifacts(runDir, attempt, page);
          }

          appendAttemptRecord(runDir, attempt);
          console.log("Connect opened, but note preparation was not completed. Leaving tab open for manual review.");
          continue;
        }

        attempt.stage = "ready-to-send";
        attempt.status = "prepared";
        attempt.failureReason = null;
        appendAttemptRecord(runDir, attempt);

        console.log(`Note prepared${noteResult.firstName ? ` for ${noteResult.firstName}` : ""}. Review and send manually.`);
        preparedPages.push(page);
      } catch (error) {
        attempt.status = "failed";
        attempt.failureReason = "unexpected-error";
        attempt.errorMessage = error instanceof Error ? error.message : String(error);
        pushAttemptEvent(attempt, `Unexpected error: ${attempt.errorMessage}`);

        if (shouldCaptureArtifacts(attempt)) {
          await writeFailureArtifacts(runDir, attempt, page);
        }

        appendAttemptRecord(runDir, attempt);
        console.error(`Failed for ${link}:`, error);
      }
    }
  }

  if (preparedPages.length === 0) {
    console.log("\nNo notes were prepared. Nothing to send.");
    return;
  }

  console.log(`\n${preparedPages.length} note(s) prepared and ready.`);
  console.log("Review the open tabs, then come back here.");
  await waitForEnter(`Press ENTER when ready to send (${SEND_DELAY_SECONDS}s between each), or Ctrl+C to cancel: `);
  await sendPreparedNotes(preparedPages, SEND_DELAY_SECONDS);
}

main().catch((error) => {
  console.error("recruiterOutreach failed:", error);
  process.exit(1);
});
