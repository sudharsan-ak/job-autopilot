import "dotenv/config";
import readline from "readline";
import { listGmailDrafts, sendGmailDraft, type GmailDraftSummary } from "../utils/gmail";

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSelection(input: string, count: number): number[] {
  if (input.toLowerCase() === "all") {
    return Array.from({ length: count }, (_, i) => i);
  }
  return input
    .split(",")
    .map((part) => parseInt(part.trim(), 10) - 1)
    .filter((index) => Number.isInteger(index) && index >= 0 && index < count);
}

async function main() {
  const drafts = await listGmailDrafts();

  if (drafts.length === 0) {
    console.log("No drafts found.");
    return;
  }

  console.log(`\nFound ${drafts.length} draft(s):\n`);
  drafts.forEach((draft: GmailDraftSummary, index: number) => {
    console.log(`${index + 1}. To: ${draft.to || "(no recipient)"} | Subject: ${draft.subject || "(no subject)"}`);
  });

  const selectionInput = await prompt("\nSend which? (comma-separated numbers, or \"all\", blank to cancel): ");
  if (!selectionInput) {
    console.log("Cancelled.");
    return;
  }

  const selectedIndexes = parseSelection(selectionInput, drafts.length);
  if (selectedIndexes.length === 0) {
    console.log("No valid selection made. Cancelled.");
    return;
  }

  const selectedDrafts = selectedIndexes.map((i) => drafts[i]);
  console.log("\nAbout to send:");
  selectedDrafts.forEach((draft) => console.log(`- To: ${draft.to || "(no recipient)"} | Subject: ${draft.subject || "(no subject)"}`));

  const confirmation = await prompt("\nConfirm send? (y/n): ");
  if (confirmation.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  for (const [index, draft] of selectedDrafts.entries()) {
    try {
      await sendGmailDraft(draft.id);
      console.log(`Sent: ${draft.to || "(no recipient)"} -> ${draft.subject || "(no subject)"}`);
    } catch (error) {
      console.error(`Failed to send draft ${draft.id}:`, error);
    }

    if (index < selectedDrafts.length - 1) {
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  console.error("sendDrafts failed:", error);
  process.exit(1);
});
