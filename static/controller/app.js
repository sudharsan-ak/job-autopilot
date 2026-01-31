const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const collectBtn = document.getElementById("collectBtn");
const applyBtn = document.getElementById("applyBtn");
const clearJobsBtn = document.getElementById("clearJobs");
const clearUnknownBtn = document.getElementById("clearUnknown");
const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const stopBtn = document.getElementById("stopBtn");
const killBtn = document.getElementById("killBtn");
const clearLogBtn = document.getElementById("clearLog");

function appendLog(line) {
  const div = document.createElement("div");
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function fetchStatus() {
  const res = await fetch("/api/status");
  return res.json();
}

async function refreshStatus() {
  const s = await fetchStatus();
  statusEl.textContent = `Status: ${s.runKind}${s.running ? " (running)" : " (idle)"}`;
  if (!s.running && s.lastCollectCompleted) {
    applyBtn.style.display = "inline-block";
  }
  if (s.running) {
    collectBtn.disabled = true;
    applyBtn.disabled = true;
  } else {
    collectBtn.disabled = false;
    applyBtn.disabled = false;
  }
}

function connectLogs() {
  const es = new EventSource("/api/logs/stream");
  es.onmessage = (evt) => {
    try {
      const payload = JSON.parse(evt.data);
      if (payload.line) appendLog(payload.line);
    } catch {}
  };
}

collectBtn.addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim();
  const count = Number(document.getElementById("count").value || 10);
  if (!url) {
    appendLog("[ui] Please enter a LinkedIn URL.");
    return;
  }
  await fetch("/api/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, count })
  });
  await refreshStatus();
});

applyBtn.addEventListener("click", async () => {
  await fetch("/api/apply", { method: "POST" });
  await refreshStatus();
});

clearJobsBtn.addEventListener("click", async () => {
  if (!confirm("Clear jobs.csv? This will remove all jobs.")) return;
  await fetch("/api/clear/jobs", { method: "POST" });
});

clearUnknownBtn.addEventListener("click", async () => {
  if (!confirm("Clear unknownJobs.js? This will remove all unknown links.")) return;
  await fetch("/api/clear/unknown", { method: "POST" });
});

pauseBtn.addEventListener("click", async () => {
  if (!confirm("Pause after current job?")) return;
  await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause" })
  });
});

resumeBtn.addEventListener("click", async () => {
  if (!confirm("Resume processing?")) return;
  await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume" })
  });
});

stopBtn.addEventListener("click", async () => {
  if (!confirm("Stop after current job?")) return;
  await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "stop" })
  });
});

killBtn.addEventListener("click", async () => {
  if (!confirm("Kill will stop the run and close the Playwright browser. Continue?")) return;
  await fetch("/api/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "kill" })
  });
});

clearLogBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
});

connectLogs();
refreshStatus();
setInterval(refreshStatus, 3000);
