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

export async function sendGmailDraft(draftId: string) {
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: "v1", auth: auth as any });

  const response = await gmail.users.drafts.send({
    userId: "me",
    requestBody: { id: draftId }
  });

  return response.data;
}

export type GmailDraftSummary = {
  id: string;
  to: string;
  subject: string;
};

function getHeader(headers: { name?: string | null; value?: string | null }[] | undefined, name: string) {
  const header = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? "";
}

export async function listGmailDrafts(): Promise<GmailDraftSummary[]> {
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: "v1", auth: auth as any });

  const listResponse = await gmail.users.drafts.list({ userId: "me", maxResults: 50 });
  const draftRefs = listResponse.data.drafts ?? [];

  const summaries: GmailDraftSummary[] = [];
  for (const ref of draftRefs) {
    if (!ref.id) continue;
    const detail = await gmail.users.drafts.get({ userId: "me", id: ref.id, format: "metadata" });
    const headers = detail.data.message?.payload?.headers ?? undefined;
    summaries.push({
      id: ref.id,
      to: getHeader(headers, "To"),
      subject: getHeader(headers, "Subject")
    });
  }

  return summaries;
}
