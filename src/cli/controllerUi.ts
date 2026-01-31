import http from "http";
import path from "path";
import fs from "fs";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import os from "os";
import { exec } from "child_process";

const PORT = 5050;
const publicDir = path.join(process.cwd(), "static", "controller");
const indexPath = path.join(publicDir, "index.html");
const appPath = path.join(publicDir, "app.js");
const jobsPath = path.join(process.cwd(), "data", "jobs.csv");
const unknownPath = path.join(process.cwd(), "unknownJobs.js");
const jobsHeader = "id,source,title,company,location,link,approved,notes";

type RunKind = "collect" | "apply" | "idle";

let child: ChildProcessWithoutNullStreams | null = null;
let running = false;
let runKind: RunKind = "idle";
let lastCollectCompleted = false;
const logLines: string[] = [];
const logClients: http.ServerResponse[] = [];
let keepAwakeProc: ChildProcessWithoutNullStreams | null = null;

function pushLog(line: string) {
  const text = line.replace(/\r?\n$/, "");
  if (!text) return;
  logLines.push(text);
  if (logLines.length > 2000) logLines.shift();
  console.log(text);
  for (const res of logClients) {
    res.write(`data: ${JSON.stringify({ line: text })}\n\n`);
  }
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

function killProcessTree(targetPid: number) {
  if (!Number.isFinite(targetPid)) return;
  if (process.platform === "win32") {
    exec(`taskkill /PID ${targetPid} /T /F`);
  } else {
    process.kill(-targetPid, "SIGKILL");
  }
}

function startKeepAwake() {
  if (process.platform !== "win32") return;
  if (keepAwakeProc) return;
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeMethods {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@;
while ($true) {
  [NativeMethods]::SetThreadExecutionState(0x80000002) | Out-Null
  Start-Sleep -Seconds 30
}
`;
  keepAwakeProc = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    shell: true,
    cwd: process.cwd()
  });
}

function stopKeepAwake() {
  if (!keepAwakeProc) return;
  keepAwakeProc.kill();
  keepAwakeProc = null;
}

function startProcess(command: string, args: string[], kind: RunKind) {
  if (running || child) {
    pushLog("A process is already running. Please wait.");
    return false;
  }

  const exe = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    child = spawn(exe, [command, ...args], { shell: false, cwd: process.cwd(), detached: true });
  } catch (err) {
    // Fallback: some Windows setups require shell execution to avoid EINVAL.
    child = spawn(exe, [command, ...args], { shell: true, cwd: process.cwd(), detached: true });
  }
  running = true;
  runKind = kind;

  child.stdout.on("data", (data) => {
    data
      .toString()
      .split(/\r?\n/)
      .forEach((line: string) => pushLog(line));
  });

  child.stderr.on("data", (data) => {
    data
      .toString()
      .split(/\r?\n/)
      .forEach((line: string) => pushLog(line));
  });

  child.on("close", (code) => {
    pushLog(`[controller] Process ended with code ${code ?? "unknown"}`);
    running = false;
    runKind = "idle";
    child = null;
    if (kind === "collect") lastCollectCompleted = true;
  });

  return true;
}

function ensureJobsHeader() {
  const dir = path.dirname(jobsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(jobsPath, jobsHeader + "\n", "utf8");
}

function clearUnknownJobs() {
  const body = "export const unknownJobs = [\n];\n";
  fs.writeFileSync(unknownPath, body, "utf8");
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/") {
    return serveFile(res, indexPath, "text/html");
  }

  if (req.method === "GET" && url === "/app.js") {
    return serveFile(res, appPath, "application/javascript");
  }

  if (req.method === "GET" && url === "/api/status") {
    return json(res, 200, {
      running,
      runKind,
      lastCollectCompleted
    });
  }

  if (req.method === "GET" && url === "/api/logs/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write("\n");
    logClients.push(res);
    req.on("close", () => {
      const idx = logClients.indexOf(res);
      if (idx >= 0) logClients.splice(idx, 1);
    });
    return;
  }

  if (req.method === "POST" && url === "/api/collect") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let payload: { url?: string; count?: number } = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      const count = Math.max(1, Number(payload.count) || 10);
      const targetUrl = (payload.url || "").trim();
      if (!targetUrl) {
        return json(res, 400, { ok: false, error: "URL is required." });
      }
      const ok = startProcess("run", ["collect:linkedin", "--", `--count=${count}`, `--url=${targetUrl}`], "collect");
      return json(res, 200, { ok });
    });
    return;
  }

  if (req.method === "POST" && url === "/api/apply") {
    const ok = startProcess("run", ["apply:batch:mac"], "apply");
    return json(res, 200, { ok });
  }

  if (req.method === "POST" && url === "/api/clear/jobs") {
    ensureJobsHeader();
    pushLog("[controller] Cleared jobs.csv");
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/api/clear/unknown") {
    clearUnknownJobs();
    pushLog("[controller] Cleared unknownJobs.js");
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/api/control") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let payload: { action?: "pause" | "resume" | "stop" | "kill" } = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}
      if (!child || !child.stdin) {
        pushLog("[controller] No active process to control.");
        return json(res, 200, { ok: false });
      }
      const action = payload.action;
      if (action === "pause") child.stdin.write("p\n");
      if (action === "resume") child.stdin.write("p\n");
      if (action === "stop") child.stdin.write("s\n");
      if (action === "kill") {
        child.kill("SIGINT");
        setTimeout(() => {
          if (child?.pid) {
            pushLog("[controller] Force-stopping process tree...");
            killProcessTree(child.pid);
          }
        }, 1500);
      }
      return json(res, 200, { ok: true });
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Controller UI running at http://localhost:${PORT}`);
  startKeepAwake();
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  if (ips.length > 0) {
    console.log("Open on phone:");
    ips.forEach((ip) => console.log(`http://${ip}:${PORT}`));
  } else {
    console.log("No LAN IP found. Ensure you're on Wi-Fi and try again.");
  }
});

process.on("SIGINT", () => {
  stopKeepAwake();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopKeepAwake();
  process.exit(0);
});
