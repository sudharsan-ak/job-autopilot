import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BatchRecord, StoredJob } from "../types.js";
import type { Stage2Repository } from "./repositories.js";

export interface ResultsFilter {
  batchId?: string;
  dateFrom?: string;
  dateTo?: string;
  company?: string;
  title?: string;
  status?: string[];
  ats?: string;
  groupBy?: "day" | "company" | "ats" | "status";
}

export function writeBatchResults(
  dataDir: string,
  batch: BatchRecord,
  jobs: StoredJob[],
  repository: Stage2Repository,
): { jsonPath: string; markdownPath: string; seenJobsPath: string } {
  const runDir = path.join(dataDir, "runs", batch.batchDate);
  mkdirSync(runDir, { recursive: true });
  const statusCounts = repository.statusCounts(batch.id);
  const payload = {
    batch,
    counts: statusCounts,
    jobs: jobs.map((job) => ({
      queue_number: job.queueNumber,
      title: job.title,
      company: job.company,
      classification: job.classification,
      application_url: job.applicationUrl,
      source_url: job.sourceUrl,
      status: job.status,
      status_detail: job.statusDetail,
      ats: job.ats,
    })),
    generated_at: new Date().toISOString(),
  };
  const jsonPath = path.join(runDir, "final_results.json");
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const lines = [
    `# Stage 2 Batch Summary - ${batch.batchDate}`,
    "",
    `Batch: \`${batch.id}\``,
    "",
    "## Status counts",
    "",
    "| Status | Count |",
    "| ------ | ----: |",
    ...Object.entries(statusCounts).map(([status, count]) => `| ${status} | ${count} |`),
    "",
  ];
  const markdownPath = path.join(runDir, "batch_summary.md");
  writeFileSync(markdownPath, lines.join("\n"), "utf8");

  const seenJobsPath = path.join(dataDir, "seen_jobs_export.json");
  writeFileSync(seenJobsPath, `${JSON.stringify(repository.exportSeenJobs(), null, 2)}\n`, "utf8");
  return { jsonPath, markdownPath, seenJobsPath };
}
