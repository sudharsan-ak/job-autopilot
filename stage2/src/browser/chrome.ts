import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import type { Stage2Config } from "../config.js";

async function endpointAvailable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
    return Boolean(payload.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

function assertExpectedWindowsOwner(config: Stage2Config): void {
  if (process.platform !== "win32") return;
  const script = [
    "$c=Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 9224 -State Listen -ErrorAction Stop | Select-Object -First 1",
    "$p=Get-CimInstance Win32_Process -Filter \"ProcessId = $($c.OwningProcess)\"",
    "$p.CommandLine",
  ].join("; ");
  const commandLine = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  const profile = config.chromeProfile.toLowerCase().replace(/\\/g, "/");
  if (!normalized.includes("--remote-debugging-port=9224") || !normalized.includes(profile)) {
    throw new Error("Port 9224 is active but is not owned by the configured Stage 2 Chrome profile.");
  }
}

export async function ensureStage2Chrome(config: Stage2Config): Promise<void> {
  if (await endpointAvailable(config.cdpEndpoint)) {
    assertExpectedWindowsOwner(config);
    return;
  }
  if (!existsSync(config.chromeExecutable)) throw new Error(`Chrome executable not found: ${config.chromeExecutable}`);
  mkdirSync(config.chromeProfile, { recursive: true });
  const child = spawn(
    config.chromeExecutable,
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9224",
      `--user-data-dir=${config.chromeProfile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + config.chromeLaunchTimeoutMs;
  while (Date.now() < deadline) {
    if (await endpointAvailable(config.cdpEndpoint)) {
      assertExpectedWindowsOwner(config);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome did not expose ${config.cdpEndpoint} within ${config.chromeLaunchTimeoutMs} ms.`);
}
