import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Stage2Config } from "../config.js";
import type { FieldResolution } from "../types.js";

function daemonPath(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDirectory, "daemon.js");
}

function launch(config: Stage2Config, args: string[]): number {
  const executable = daemonPath();
  if (!existsSync(executable)) throw new Error(`Built Stage 2 worker is missing: ${executable}`);
  const logDir = path.join(config.dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(path.join(logDir, "worker.log"), "a");
  try {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd: config.rootDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        STAGE2_ROOT: config.rootDir,
        STAGE2_DATA_DIR: config.dataDir,
        STAGE2_PROFILE_PATH: config.profilePath,
        STAGE2_CDP_ENDPOINT: config.cdpEndpoint,
        STAGE2_CHROME_PROFILE: config.chromeProfile,
        STAGE2_CHROME_EXECUTABLE: config.chromeExecutable,
        STAGE2_SIMPLIFY_DETECTION_TIMEOUT_MS: String(config.simplifyDetectionTimeoutMs),
        STAGE2_SIMPLIFY_AUTOFILL_TIMEOUT_MS: String(config.simplifyAutofillTimeoutMs),
      },
    });
    child.unref();
    if (!child.pid) throw new Error("Detached Stage 2 worker did not return a process ID.");
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

export function launchPrepareWorker(config: Stage2Config, waveId: string): number {
  return launch(config, ["prepare", "--wave", waveId]);
}

export function launchWorkerSelfTest(config: Stage2Config, waveId: string): number {
  return launch(config, ["selftest", "--wave", waveId]);
}

export function launchResolutionWorker(
  config: Stage2Config,
  waveId: string,
  resolutions: Array<FieldResolution & { jobId?: string }>,
): { pid: number; resultPath: string } {
  const commandDir = path.join(config.dataDir, "commands");
  mkdirSync(commandDir, { recursive: true });
  const requestId = randomUUID();
  const commandPath = path.join(commandDir, `${requestId}.request.json`);
  const resultPath = path.join(commandDir, `${requestId}.result.json`);
  writeFileSync(commandPath, `${JSON.stringify({ waveId, resolutions })}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    const pid = launch(config, ["resolve", "--wave", waveId, "--command", commandPath, "--result", resultPath]);
    return { pid, resultPath };
  } catch (error) {
    if (existsSync(commandPath)) unlinkSync(commandPath);
    throw error;
  }
}

export async function waitForResultFile<T>(resultPath: string, waitMs: number): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as T;
      unlinkSync(resultPath);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}

export function processExists(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
