import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

/**
 * One-time LinkedIn login helper.
 * - Opens a real browser (NOT headless)
 * - You login manually
 * - Saves cookies/session to storage/linkedin.json
 *
 * Run: npm run auth:linkedin
 */

async function main() {
  const storageDir = path.join(process.cwd(), "storage");
  const storagePath = path.join(storageDir, "linkedin.json");

  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50 // makes actions easier to see; tweak if you want faster
  });

  // Using a persistent context makes it feel like a normal Chrome profile
  const context = await browser.newContext();

  const page = await context.newPage();

  console.log("Opening LinkedIn...");
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });

  console.log("\n====================================================");
  console.log("ACTION NEEDED:");
  console.log("1) Login to LinkedIn in the opened browser window.");
  console.log("2) After login completes, go to the LinkedIn home feed.");
  console.log("3) Then come back here and press ENTER.");
  console.log("====================================================\n");

  // Wait for you to press Enter in terminal
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });

  // Basic check: we should NOT be on /login anymore
  const url = page.url();
  if (url.includes("/login")) {
    console.log("It still looks like you're on the login page.");
    console.log("Please login fully, then re-run: npm run auth:linkedin");
    await browser.close();
    process.exit(1);
  }

  await context.storageState({ path: storagePath });
  console.log(`✅ Saved LinkedIn session to: ${storagePath}`);

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ auth:linkedin failed:", err);
  process.exit(1);
});
