import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

/**
 * One-time MyGreenhouse login helper.
 * - Opens a real browser (NOT headless)
 * - You login manually
 * - Saves cookies/session to storage/combined.json
 *
 * Run: npm run auth:greenhouse
 */

async function main() {
  const storageDir = path.join(process.cwd(), "storage");
  const combinedPath = path.join(storageDir, "combined.json");
  const linkedinPath = path.join(storageDir, "linkedin.json");

  if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(linkedinPath) ? linkedinPath : undefined
  });

  const page = await context.newPage();

  console.log("Opening MyGreenhouse...");
  await page.goto("https://my.greenhouse.io/", { waitUntil: "domcontentloaded" });

  console.log("\n====================================================");
  console.log("ACTION NEEDED:");
  console.log("1) Login to MyGreenhouse in the opened browser window.");
  console.log("2) After login completes, stay on MyGreenhouse.");
  console.log("3) Then come back here and press ENTER.");
  console.log("====================================================\n");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });

  await context.storageState({ path: combinedPath });
  console.log(`Saved combined session to: ${combinedPath}`);

  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("auth:greenhouse failed:", err);
  process.exit(1);
});
