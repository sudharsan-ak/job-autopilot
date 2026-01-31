import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

type UnknownJob = { id?: string; link: string };

const PORT = 4545;
const unknownPath = path.join(process.cwd(), "unknownJobs.js");
const publicDir = path.join(process.cwd(), "static", "unknown-jobs");
const indexPath = path.join(publicDir, "index.html");
const appPath = path.join(publicDir, "app.js");

function parseUnknownJobs(contents: string): UnknownJob[] {
  const lines = contents.split(/\r?\n/);
  const jobs: UnknownJob[] = [];

  for (const line of lines) {
    const idMatch = line.match(/"id"\s*:\s*"([^"]+)"/);
    const linkMatch = line.match(/"link"\s*:\s*"([^"]+)"/);
    if (linkMatch) {
      jobs.push({ id: idMatch?.[1], link: linkMatch[1] });
    }
  }

  if (jobs.length > 0) return jobs;

  const linkRegex = /https?:\/\/[^\s"'<>]+/g;
  const matches = contents.match(linkRegex) || [];
  return matches.map((link) => ({ link }));
}

function loadUnknownJobs(): UnknownJob[] {
  if (!fs.existsSync(unknownPath)) return [];
  const contents = fs.readFileSync(unknownPath, "utf8");
  if (!contents.trim()) return [];
  return parseUnknownJobs(contents);
}

function writeUnknownJobs(jobs: UnknownJob[]) {
  const lines = jobs.map((j) => `{ "id": "${j.id ?? ""}", "link": "${j.link}" },`);
  const body = ["export const unknownJobs = [", ...lines, "];"].join("\n");
  fs.writeFileSync(unknownPath, body, "utf8");
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function notFound(res: http.ServerResponse) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
  if (!fs.existsSync(filePath)) {
    notFound(res);
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/") {
    return serveFile(res, indexPath, "text/html");
  }

  if (req.method === "GET" && url === "/app.js") {
    return serveFile(res, appPath, "application/javascript");
  }

  if (req.method === "GET" && url === "/api/jobs") {
    const jobs = loadUnknownJobs();
    return json(res, 200, { jobs });
  }

  if (req.method === "POST" && url === "/api/reject") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let payload: { id?: string; link?: string } = {};
      try {
        payload = JSON.parse(body || "{}");
      } catch {}

      const jobs = loadUnknownJobs();
      const filtered = jobs.filter((j) => (payload.link ? j.link !== payload.link : j.id !== payload.id));
      writeUnknownJobs(filtered);
      return json(res, 200, { ok: true, remaining: filtered.length });
    });
    return;
  }

  if (req.method === "POST" && url === "/api/approve") {
    // Approve keeps it in the file; we just acknowledge.
    res.writeHead(204);
    res.end();
    return;
  }

  return notFound(res);
});

server.listen(PORT, () => {
  console.log(`Unknown Jobs UI running at http://localhost:${PORT}`);
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
  console.log(`Loaded from: ${unknownPath}`);
});
