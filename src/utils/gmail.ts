import { google } from "googleapis";
import { authorizeGmail } from "./gmailAuth";

type CreateDraftInput = {
  to?: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
};

function toBase64Url(value: string) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function createGmailDraft(input: CreateDraftInput) {
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: "v1", auth: auth as any });
  const boundary = "job-autopilot-boundary";
  const message = [
    `To: ${input.to ?? ""}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.bodyText,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    input.bodyHtml,
    `--${boundary}--`
  ].join("\r\n");

  const response = await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: toBase64Url(message)
      }
    }
  });

  return response.data;
}
