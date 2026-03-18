import "dotenv/config";
import { chromium } from "playwright";
import { loadProfile } from "../../utils/config";
import { readOutReachJobs, getOutReachJobsPath } from "../../utils/outReachJobs";
import { extractJobDescription } from "../../utils/automated/extractJobDescription";
import { generateOutreachEmail } from "../../utils/automated/openai";
import { createGmailDraft } from "../../utils/gmail";
import { buildEmailBody, buildSubject } from "../../utils/outreachEmail";

async function main() {
  const urls = readOutReachJobs();
  if (urls.length === 0) {
    console.log(`No outreach URLs found in ${getOutReachJobsPath()}`);
    process.exit(0);
  }

  const profile = loadProfile();
  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const context = await browser.newContext();

  console.log(`Creating drafts for ${urls.length} outreach job(s)...`);

  for (const [index, url] of urls.entries()) {
    const page = await context.newPage();
    try {
      console.log(`\n[${index + 1}/${urls.length}] Opening ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      const job = await extractJobDescription(page);

      if (
        !job.title &&
        job.requiredSkills.length === 0 &&
        job.preferredSkills.length === 0 &&
        job.coreResponsibilities.length === 0 &&
        !job.seniority &&
        job.domainKeywords.length === 0
      ) {
        throw new Error("Structured JD extraction returned no usable content.");
      }

      const email = await generateOutreachEmail({
        profile,
        jobTitle: job.title || "Software Engineer",
        companyName: job.company || "the company",
        jobUrl: url,
        requiredSkills: job.requiredSkills,
        preferredSkills: job.preferredSkills,
        coreResponsibilities: job.coreResponsibilities,
        seniority: job.seniority,
        domainKeywords: job.domainKeywords,
        fixedIntro: "",
        fixedClosing: ""
      });

      const emailBody = buildEmailBody(job.title || "Software Engineer", email.middleParagraph);
      const subject = buildSubject(job.title || "Software Engineer");

      const draft = await createGmailDraft({
        subject,
        bodyText: emailBody.bodyText,
        bodyHtml: emailBody.bodyHtml
      });

      console.log(`Draft created: ${draft.id ?? "unknown-id"} | ${subject}`);
    } catch (error) {
      console.error(`Failed for ${url}:`, error);
    } finally {
      await page.close().catch(() => {});
    }
  }

  await browser.close();
}

main().catch((error) => {
  console.error("createOutreachDrafts failed:", error);
  process.exit(1);
});
