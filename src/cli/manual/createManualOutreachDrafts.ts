import { createGmailDraft } from "../../utils/gmail";
import {
  getManualOutreachInputPath,
  parseManualOutreachInput,
  readManualOutreachInput
} from "../../utils/manual/manualOutreach";
import { buildEmailBody, buildSubject, inferGreetingNameFromEmail } from "../../utils/outreachEmail";

const BATCH_SIZE = 3;

async function main() {
  const raw = readManualOutreachInput();
  const jobs = parseManualOutreachInput(raw);

  if (jobs.length === 0) {
    console.log(`No manual outreach entries found in ${getManualOutreachInputPath()}`);
    process.exit(0);
  }

  console.log(`Creating manual outreach drafts for ${jobs.length} role block(s)...`);

  const tasks = jobs.flatMap((job, jobIndex) =>
    job.versions.map((version, versionIndex) => ({
      job,
      jobIndex,
      version,
      versionIndex,
      to: job.emails?.[versionIndex]
    }))
  );

  console.log(`Creating ${tasks.length} draft(s) with batch size ${BATCH_SIZE}...`);

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ job, jobIndex, version, versionIndex, to }) => {
        try {
          const subject = buildSubject(job.role);
          const emailBody = buildEmailBody(job.role, version, inferGreetingNameFromEmail(to));
          const draft = await createGmailDraft({
            to,
            subject,
            bodyText: emailBody.bodyText,
            bodyHtml: emailBody.bodyHtml
          });

          console.log(
            `Draft created: ${draft.id ?? "unknown-id"} | block ${jobIndex + 1} version ${versionIndex + 1}${to ? ` | to ${to}` : ""} | ${subject}`
          );
        } catch (error) {
          console.error(`Failed for block ${jobIndex + 1} version ${versionIndex + 1}:`, error);
        }
      })
    );
  }
}

main().catch((error) => {
  console.error("createManualOutreachDrafts failed:", error);
  process.exit(1);
});
