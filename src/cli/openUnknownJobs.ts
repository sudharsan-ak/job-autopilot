import fs from "fs";
import path from "path";
import { exec } from "child_process";

type UnknownJob = { id?: string | number; role?: string; link: string };

const args = process.argv.slice(2);
const countArg = args.find((arg) => arg.startsWith("--count="));
const count = countArg ? Number(countArg.split("=")[1]) : 10;

if (Number.isNaN(count) || count <= 0) {
  console.error("Invalid --count value. Example: --count=10");
  process.exit(1);
}

const unknownPath = path.join(process.cwd(), "unknownJobs.js");
if (!fs.existsSync(unknownPath) || fs.statSync(unknownPath).size === 0) {
  console.log("unknownJobs.js is missing or empty. Nothing to open.");
  process.exit(0);
}

function parseUnknownJobs(contents: string): UnknownJob[] {
  const lines = contents.split(/\r?\n/);
  const jobs: UnknownJob[] = [];

  for (const line of lines) {
    const idMatch = line.match(/"id"\s*:\s*"([^"]+)"/);
    const roleMatch = line.match(/"role"\s*:\s*"([^"]+)"/);
    const linkMatch = line.match(/"link"\s*:\s*"([^"]+)"/);
    if (linkMatch) {
      jobs.push({ id: idMatch?.[1], role: roleMatch?.[1], link: linkMatch[1] });
    }
  }

  if (jobs.length > 0) return jobs;

  const fallback: UnknownJob[] = [];
  const linkRegex = /https?:\/\/[^\s"'<>]+/g;
  const matches = contents.match(linkRegex) || [];
  for (const link of matches) {
    fallback.push({ link });
  }
  return fallback;
}

async function main() {
  const contents = fs.readFileSync(unknownPath, "utf8");
  const unknownJobs = parseUnknownJobs(contents);

  if (unknownJobs.length === 0) {
    console.log("unknownJobs.js has no links to open.");
    return;
  }

  const slice = unknownJobs.slice(0, count);
  slice.forEach((job) => {
    if (!job?.link) return;
    exec(`start "" "${job.link}"`);
  });

  console.log(`Opened ${slice.length} link(s) in your default browser.`);
}

main().catch((err) => {
  console.error("Failed to open unknown job links:", err);
  process.exit(1);
});
