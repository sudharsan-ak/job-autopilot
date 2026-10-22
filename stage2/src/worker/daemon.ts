import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { getConfig } from "../config.js";
import { loadApplicantProfile } from "../profile/loader.js";
import { Stage2Database } from "../state/database.js";
import { Stage2Repository } from "../state/repositories.js";
import type { FieldResolution } from "../types.js";
import { WaveProcessor } from "./waveProcessor.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const waveId = argument("--wave");
  if (!waveId) throw new Error("Worker requires --wave.");
  const config = getConfig();
  const database = new Stage2Database(config.dataDir);
  const repository = new Stage2Repository(database.connection);
  const wave = repository.getWave(waveId);
  if (!wave) throw new Error(`Unknown wave: ${waveId}`);
  repository.setWaveWorker(waveId, process.pid);
  const heartbeat = setInterval(() => repository.heartbeat(waveId), 2_000);
  heartbeat.unref();
  const commandPath = argument("--command");

  try {
    if (command === "selftest") {
      repository.setWaveState(waveId, "RUNNING", null);
      await new Promise((resolve) => setTimeout(resolve, 150));
      repository.setWaveState(waveId, "COMPLETED", null);
    } else if (command === "prepare") {
      if (!config.profilePath) throw new Error("STAGE2_PROFILE_PATH is required.");
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath));
      const batchId = String(wave.batch_id);
      const rows = JSON.parse(String(wave.requested_rows_json)) as number[];
      const jobs = repository.selectJobs(batchId, rows);
      await processor.start(waveId, jobs);
    } else if (command === "resolve") {
      const resultPath = argument("--result");
      if (!commandPath || !resultPath || !existsSync(commandPath)) throw new Error("Resolution worker requires valid command and result paths.");
      if (!config.profilePath) throw new Error("STAGE2_PROFILE_PATH is required.");
      const processor = new WaveProcessor(config, repository, loadApplicantProfile(config.profilePath));
      const payload = JSON.parse(readFileSync(commandPath, "utf8")) as {
        resolutions: Array<FieldResolution & { jobId?: string }>;
      };
      unlinkSync(commandPath);
      const result = await processor.applyResolutions(waveId, payload.resolutions);
      writeFileSync(resultPath, `${JSON.stringify({ ok: true, ...result })}\n`, { encoding: "utf8", mode: 0o600 });
    } else {
      throw new Error(`Unknown worker command: ${command}`);
    }
    clearInterval(heartbeat);
    database.close();
    process.exit(0);
  } catch (error) {
    clearInterval(heartbeat);
    if (commandPath && existsSync(commandPath)) unlinkSync(commandPath);
    repository.setWaveState(waveId, "FAILED", null);
    repository.addStateEvent("WORKER_PROCESS_FAILED", {
      batchId: String(wave.batch_id),
      waveId,
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    database.close();
    throw error;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
