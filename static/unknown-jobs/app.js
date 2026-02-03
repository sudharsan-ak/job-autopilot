async function fetchJobs() {
  const res = await fetch("/api/jobs");
  const data = await res.json();
  return data.jobs || [];
}

async function rejectJob(job) {
  await fetch("/api/reject", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: job.id, link: job.link })
  });
}

async function approveJob(job) {
  await fetch("/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: job.id, link: job.link })
  });
}

function render(jobs) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const bulkBar = document.getElementById("bulkBar");
  const selectAll = document.getElementById("selectAll");
  const bulkApprove = document.getElementById("bulkApprove");
  const bulkReject = document.getElementById("bulkReject");

  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No unknown jobs found.";
    list.appendChild(empty);
    if (selectAll) selectAll.checked = false;
    if (bulkBar) bulkBar.classList.add("hidden");
    return;
  }

  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "job";

    const selector = document.createElement("input");
    selector.type = "checkbox";
    selector.className = "selector";
    selector.dataset.link = job.link;
    selector.addEventListener("change", () => {
      const selected = Array.from(document.querySelectorAll(".selector")).filter((el) => el.checked);
      if (bulkBar) {
        if (selected.length > 0) bulkBar.classList.remove("hidden");
        else bulkBar.classList.add("hidden");
      }
    });

    const info = document.createElement("div");
    info.className = "job-info";

    const id = document.createElement("span");
    id.className = "job-id";
    id.textContent = job.id ? `#${job.id}` : "#?";

    const role = document.createElement("span");
    role.textContent = job.role ? `${job.role} ` : "Unknown role ";

    const link = document.createElement("a");
    link.className = "job-link";
    link.href = job.link;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `(${job.link})`;

    info.appendChild(id);
    info.appendChild(role);
    info.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "actions";

    const approve = document.createElement("button");
    approve.className = "approve";
    approve.textContent = "Approve";
    approve.addEventListener("click", async () => {
      await approveJob(job);
      row.style.opacity = "0.6";
    });

    const reject = document.createElement("button");
    reject.className = "reject";
    reject.textContent = "Reject";
    reject.addEventListener("click", async () => {
      await rejectJob(job);
      row.remove();
    });

    actions.appendChild(approve);
    actions.appendChild(reject);

    row.appendChild(selector);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  }

  if (selectAll) {
    selectAll.onchange = () => {
      const checked = selectAll.checked;
      document.querySelectorAll(".selector").forEach((el) => {
        el.checked = checked;
      });
      if (bulkBar) {
        if (checked) bulkBar.classList.remove("hidden");
        else bulkBar.classList.add("hidden");
      }
    };
  }

  if (bulkApprove) {
    bulkApprove.onclick = async () => {
      const selected = Array.from(document.querySelectorAll(".selector")).filter((el) => el.checked);
      for (const el of selected) {
        const link = el.dataset.link;
        const job = jobs.find((j) => j.link === link);
        if (job) await approveJob(job);
        el.closest(".job").style.opacity = "0.6";
      }
      if (selectAll) selectAll.checked = false;
      if (bulkBar) bulkBar.classList.add("hidden");
    };
  }

  if (bulkReject) {
    bulkReject.onclick = async () => {
      const selected = Array.from(document.querySelectorAll(".selector")).filter((el) => el.checked);
      for (const el of selected) {
        const link = el.dataset.link;
        const job = jobs.find((j) => j.link === link);
        if (job) await rejectJob(job);
        el.closest(".job").remove();
      }
      if (selectAll) selectAll.checked = false;
      if (bulkBar) bulkBar.classList.add("hidden");
    };
  }
}

fetchJobs().then(render).catch(() => {
  const list = document.getElementById("list");
  list.textContent = "Failed to load unknown jobs.";
});
