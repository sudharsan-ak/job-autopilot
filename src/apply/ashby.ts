import { Page } from "playwright";
import { Profile } from "../utils/config";

function toAshbyApplicationUrl(currentUrl: string): string | null {
  try {
    const u = new URL(currentUrl);
    if (!u.hostname.includes("ashbyhq.com")) return null;

    // Already on application route
    if (u.pathname.endsWith("/application")) return u.toString();

    // Normalize route:
    // /company/jobId   OR /company/jobId/... -> /company/jobId/application
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;

    const company = parts[0];
    const jobId = parts[1];

    u.pathname = `/${company}/${jobId}/application`;
    return u.toString();
  } catch {
    return null;
  }
}

async function fillFirstVisible(page: Page, selectors: string[], value: string) {
  if (!value) return false;

  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1500 })) {
        await loc.fill(value);
        return true;
      }
    } catch {}
  }
  return false;
}

async function uploadResumeIfPossible(page: Page, resumePdfPath: string) {
  if (!resumePdfPath) return false;

  const inputs = page.locator("input[type='file']");
  const count = await inputs.count();

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    try {
      await input.setInputFiles(resumePdfPath, { timeout: 7000 });
      return true;
    } catch {}
  }
  return false;
}

export async function autofillAshby(page: Page, profile: Profile) {
  // 1) Force navigation to /application route (most reliable)
  const cur = page.url();
  const appUrl = toAshbyApplicationUrl(cur);

  console.log(`[Ashby] current url: ${cur}`);
  console.log(`[Ashby] app url: ${appUrl ?? "(could not compute)"}`);

  if (appUrl && appUrl !== cur) {
    console.log("[Ashby] navigating to /application...");
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
  }

  console.log(`[Ashby] url after route fix: ${page.url()}`);

  // 2) Wait for form-ish elements
  try {
    await Promise.race([
      page.waitForSelector("input[autocomplete='name']", { timeout: 12000 }),
      page.waitForSelector("input[type='email']", { timeout: 12000 }),
      page.waitForSelector("input[type='file']", { timeout: 12000 }),
      page.waitForSelector("textarea", { timeout: 12000 })
    ]);
  } catch {
    console.log("[Ashby] could not confirm form fields appeared (continuing anyway).");
  }

  // 3) Fill fields (best-effort selectors)
  await fillFirstVisible(
    page,
    ["input[autocomplete='name']", "input[name='name']", "input[placeholder*='Name' i]"],
    profile.fullName
  );

  await fillFirstVisible(
    page,
    ["input[type='email']", "input[autocomplete='email']", "input[name='email']"],
    profile.email
  );

  await fillFirstVisible(
    page,
    ["input[type='tel']", "input[autocomplete='tel']", "input[name='phone']"],
    profile.phone
  );

  await fillFirstVisible(
    page,
    ["input[name*='linkedin' i]", "input[placeholder*='LinkedIn' i]"],
    profile.linkedin
  );

  await fillFirstVisible(
    page,
    ["input[name*='github' i]", "input[placeholder*='GitHub' i]"],
    profile.github
  );

  await fillFirstVisible(
    page,
    [
      "input[name*='portfolio' i]",
      "input[name*='website' i]",
      "input[placeholder*='Portfolio' i]",
      "input[placeholder*='Website' i]"
    ],
    profile.portfolio
  );

  // 4) Upload resume
  const uploaded = await uploadResumeIfPossible(page, profile.resumePdfPath);
  console.log(`[Ashby] resume upload attempted: ${uploaded}`);

  await page.waitForTimeout(500);
  console.log("[Ashby] autofill done (best-effort).");
}
