import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredJob } from "../types.js";

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
}

export function renderQueueMarkdown(jobs: StoredJob[], batchDate: string): string {
  const headers = ["#", "Role", "Company", "Job URL", "Status"];
  const rows = jobs.map((job) => {
    const target = job.applicationUrl ?? job.sourceUrl;
    const link = target ? `[Open](${target.replace(/\|/g, "%7C").replace(/\)/g, "%29")})` : "Missing";
    const status = job.statusDetail ? `${job.status}: ${job.statusDetail}` : job.status;
    return [String(job.queueNumber), escapeCell(job.title), escapeCell(job.company), link, escapeCell(status)];
  });
  const widths = headers.map((header, index) =>
    Math.max(header.length, 3, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const formatRow = (row: string[]) =>
    `| ${row
      .map((cell, index) => (index === 0 ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!)))
      .join(" | ")} |`;
  const separator = widths.map((width, index) => (index === 0 ? `${"-".repeat(Math.max(2, width - 1))}:` : "-".repeat(width)));

  return [
    `# Stage 2 Application Queue - ${batchDate}`,
    "",
    formatRow(headers),
    formatRow(separator),
    ...rows.map(formatRow),
    "",
  ].join("\n");
}

export function writeQueueMarkdown(dataDir: string, batchDate: string, jobs: StoredJob[]): string {
  const runDir = path.join(dataDir, "runs", batchDate);
  mkdirSync(runDir, { recursive: true });
  const outputPath = path.join(runDir, "application_queue.md");
  writeFileSync(outputPath, renderQueueMarkdown(jobs, batchDate), "utf8");
  return outputPath;
}
