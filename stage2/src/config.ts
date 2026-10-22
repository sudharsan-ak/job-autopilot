import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Stage2Config {
  rootDir: string;
  dataDir: string;
  profilePath?: string;
  defaultResumePath: string;
  cdpEndpoint: string;
  chromeProfile: string;
  chromeExecutable: string;
  chromeLaunchTimeoutMs: number;
  simplifyDetectionTimeoutMs: number;
  simplifyAutofillTimeoutMs: number;
}

function loadLocalEnv(rootDir: string): void {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (error) {
    throw new Error(`Unable to load ${envPath}: ${String(error)}`);
  }
}

export function getConfig(overrides: Partial<Stage2Config> = {}): Stage2Config {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const inferredRoot = path.basename(path.dirname(moduleDirectory)) === "dist"
    ? path.resolve(moduleDirectory, "..", "..")
    : path.resolve(moduleDirectory, "..");
  const rootDir = path.resolve(overrides.rootDir ?? process.env.STAGE2_ROOT ?? inferredRoot);
  loadLocalEnv(rootDir);

  const cdpEndpoint = overrides.cdpEndpoint ?? process.env.STAGE2_CDP_ENDPOINT ?? "http://127.0.0.1:9224";
  const parsed = new URL(cdpEndpoint);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "9224") {
    throw new Error("Stage 2 refuses CDP endpoints other than http://127.0.0.1:9224.");
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const defaultResumeName = "default-resume.pdf";
  const defaultResumePath = path.resolve(
    overrides.defaultResumePath
      ?? process.env.STAGE2_DEFAULT_RESUME_PATH
      ?? [path.join(rootDir, "..", defaultResumeName), path.join(rootDir, defaultResumeName)].find(existsSync)
      ?? path.join(rootDir, "..", defaultResumeName),
  );
  return {
    rootDir,
    dataDir: path.resolve(overrides.dataDir ?? process.env.STAGE2_DATA_DIR ?? path.join(rootDir, "data")),
    profilePath: overrides.profilePath ?? process.env.STAGE2_PROFILE_PATH,
    defaultResumePath,
    cdpEndpoint,
    chromeProfile: path.resolve(
      overrides.chromeProfile ??
        process.env.STAGE2_CHROME_PROFILE ??
        path.join(homedir(), "ChromeStage2Applications"),
    ),
    chromeExecutable: path.resolve(
      overrides.chromeExecutable ??
        process.env.STAGE2_CHROME_EXECUTABLE ??
        path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    ),
    chromeLaunchTimeoutMs: overrides.chromeLaunchTimeoutMs ?? 15_000,
    simplifyDetectionTimeoutMs: overrides.simplifyDetectionTimeoutMs
      ?? Number(process.env.STAGE2_SIMPLIFY_DETECTION_TIMEOUT_MS ?? 10_000),
    simplifyAutofillTimeoutMs: overrides.simplifyAutofillTimeoutMs
      ?? Number(process.env.STAGE2_SIMPLIFY_AUTOFILL_TIMEOUT_MS ?? 120_000),
  };
}
