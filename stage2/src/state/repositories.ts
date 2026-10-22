import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ManifestLoadResult } from "../application/manifestLoader.js";
import type { AtsKind, BatchRecord, FieldResolution, JobStatus, StoredJob, UncertainField } from "../types.js";
import { canonicalizeUrl, sha256 } from "../utils/identity.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function mapBatch(row: Row): BatchRecord {
  return {
    id: String(row.id),
    batchDate: String(row.batch_date),
    sourcePath: String(row.source_path),
    fingerprint: String(row.fingerprint),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapJob(row: Row): StoredJob {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    queueNumber: Number(row.queue_number),
    jobKey: String(row.job_key),
    title: String(row.title),
    company: String(row.company),
    classification: row.classification as StoredJob["classification"],
    sourceUrl: row.source_url ? String(row.source_url) : undefined,
    applicationUrl: row.application_url ? String(row.application_url) : undefined,
    resumePath: row.resume_path ? String(row.resume_path) : undefined,
    status: row.status as JobStatus,
    statusDetail: row.status_detail ? String(row.status_detail) : undefined,
    ats: row.ats ? (String(row.ats) as AtsKind) : undefined,
    rawIndex: Number(row.raw_index),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class Stage2Repository {
  constructor(private readonly db: DatabaseSync) {}

  importManifest(manifest: ManifestLoadResult): { batch: BatchRecord; jobs: StoredJob[]; reused: boolean } {
    const existing = this.db.prepare("SELECT * FROM batches WHERE fingerprint = ?").get(manifest.fingerprint) as Row | undefined;
    if (existing) {
      const batch = mapBatch(existing);
      return { batch, jobs: this.listJobs(batch.id), reused: true };
    }

    const timestamp = now();
    const batchId = `${manifest.batchDate}-${manifest.fingerprint.slice(0, 10)}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO batches(id,batch_date,source_path,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(batchId, manifest.batchDate, manifest.sourcePath, manifest.fingerprint, "LOADED", timestamp, timestamp);

      const insertJob = this.db.prepare(`
        INSERT INTO jobs(
          id,batch_id,queue_number,job_key,title,company,classification,source_url,application_url,
          resume_path,status,status_detail,raw_index,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const getSeen = this.db.prepare("SELECT * FROM seen_jobs WHERE job_key = ?");
      const insertSeen = this.db.prepare(`
        INSERT INTO seen_jobs(job_key,company,title,canonical_url,aliases_json,first_seen_at,last_seen_at,times_seen)
        VALUES(?,?,?,?,?,?,?,?)
      `);
      const updateSeen = this.db.prepare(
        "UPDATE seen_jobs SET aliases_json=?, last_seen_at=?, times_seen=times_seen+1 WHERE job_key=?",
      );

      for (const job of manifest.jobs) {
        const jobId = `${batchId}-${String(job.queueNumber).padStart(4, "0")}`;
        insertJob.run(
          jobId,
          batchId,
          job.queueNumber,
          job.jobKey,
          job.title,
          job.company,
          job.classification,
          job.sourceUrl ?? null,
          job.applicationUrl ?? null,
          job.resumePath ?? null,
          job.status,
          job.statusDetail ?? null,
          job.rawIndex,
          timestamp,
          timestamp,
        );

        const aliases = [...new Set([job.sourceUrl, job.applicationUrl].filter((value): value is string => Boolean(value)))];
        const prior = getSeen.get(job.jobKey) as Row | undefined;
        if (prior) {
          const priorAliases = JSON.parse(String(prior.aliases_json)) as string[];
          updateSeen.run(JSON.stringify([...new Set([...priorAliases, ...aliases])]), timestamp, job.jobKey);
        } else {
          insertSeen.run(
            job.jobKey,
            job.company,
            job.title,
            canonicalizeUrl(job.applicationUrl ?? job.sourceUrl) ?? null,
            JSON.stringify(aliases),
            timestamp,
            timestamp,
            1,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      batch: this.getBatch(batchId)!,
      jobs: this.listJobs(batchId),
      reused: false,
    };
  }

  getBatch(batchId: string): BatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(batchId) as Row | undefined;
    return row ? mapBatch(row) : undefined;
  }

  getBatchByDate(batchDate: string): BatchRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM batches WHERE batch_date = ? ORDER BY created_at DESC LIMIT 1")
      .get(batchDate) as Row | undefined;
    return row ? mapBatch(row) : undefined;
  }

  latestBatch(): BatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
    return row ? mapBatch(row) : undefined;
  }

  listJobs(batchId: string): StoredJob[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE batch_id = ? ORDER BY queue_number").all(batchId) as Row[]).map(mapJob);
  }

  getJob(jobId: string): StoredJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  selectJobs(batchId: string, rows?: number[], count?: number): StoredJob[] {
    const jobs = this.listJobs(batchId);
    const eligibleStates = new Set<JobStatus>([
      "PENDING",
      "PENDING_RESUME_REQUIRED",
      "OPENING",
      "FILLING",
      "PAUSED",
      "STOPPED",
      "PARTIAL_READY_FOR_REVIEW",
    ]);
    if (rows?.length) {
      const requested = new Set(rows);
      const explicitRetryStates = new Set<JobStatus>([...eligibleStates, "NEEDS_AI_REVIEW", "BLOCKED"]);
      return jobs.filter((job) => requested.has(job.queueNumber) && explicitRetryStates.has(job.status));
    }
    const eligible = jobs.filter((job) => eligibleStates.has(job.status));
    return eligible.slice(0, count ?? 10);
  }

  updateJob(jobId: string, status: JobStatus, detail?: string, ats?: AtsKind): void {
    this.db
      .prepare("UPDATE jobs SET status=?, status_detail=?, ats=COALESCE(?,ats), updated_at=? WHERE id=?")
      .run(status, detail ?? null, ats ?? null, now(), jobId);
  }

  createWave(batchId: string, rows: number[]): { id: string; sequence: number } {
    const sequenceRow = this.db
      .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM waves WHERE batch_id=?")
      .get(batchId) as { sequence: number };
    const sequence = Number(sequenceRow.sequence);
    const id = `${batchId}-W${String(sequence).padStart(3, "0")}`;
    const timestamp = now();
    this.db
      .prepare(
        "INSERT INTO waves(id,batch_id,sequence,requested_rows_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(id, batchId, sequence, JSON.stringify(rows), "QUEUED", timestamp, timestamp);
    return { id, sequence };
  }

  getWave(waveId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM waves WHERE id=?").get(waveId) as Row | undefined;
  }

  latestWave(batchId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM waves WHERE batch_id=? ORDER BY sequence DESC LIMIT 1").get(batchId) as Row | undefined;
  }

  setWaveState(waveId: string, state: string, controlRequest?: string | null): void {
    const timestamp = now();
    const started = state === "RUNNING" ? timestamp : null;
    const completed = ["COMPLETED", "STOPPED", "FAILED"].includes(state) ? timestamp : null;
    this.db
      .prepare(
        `UPDATE waves SET state=?, control_request=?, started_at=COALESCE(started_at,?),
         completed_at=COALESCE(?,completed_at), updated_at=? WHERE id=?`,
      )
      .run(state, controlRequest ?? null, started, completed, timestamp, waveId);
  }

  setWaveWorker(waveId: string, workerPid: number): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE waves SET worker_pid=?,heartbeat_at=?,updated_at=? WHERE id=?")
      .run(workerPid, timestamp, timestamp, waveId);
  }

  heartbeat(waveId: string): void {
    const timestamp = now();
    this.db.prepare("UPDATE waves SET heartbeat_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, waveId);
  }

  requestedControl(waveId: string): string | undefined {
    const row = this.db.prepare("SELECT control_request FROM waves WHERE id=?").get(waveId) as Row | undefined;
    return row?.control_request ? String(row.control_request) : undefined;
  }

  upsertTab(input: {
    jobId: string;
    waveId: string;
    originalUrl: string;
    currentUrl: string;
    recoveryUrl: string;
    targetId?: string;
    ats?: AtsKind;
    formStep?: string;
    checkpoint: string;
    tabState: string;
    lastAction?: string;
  }): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO tabs(id,job_id,wave_id,original_url,current_url,recovery_url,target_id,ats,form_step,
        checkpoint,tab_state,last_action,last_seen_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        wave_id=excluded.wave_id,current_url=excluded.current_url,recovery_url=excluded.recovery_url,
        target_id=excluded.target_id,ats=excluded.ats,form_step=excluded.form_step,
        checkpoint=excluded.checkpoint,tab_state=excluded.tab_state,last_action=excluded.last_action,
        last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at
    `).run(
      `tab-${input.jobId}`,
      input.jobId,
      input.waveId,
      input.originalUrl,
      input.currentUrl,
      input.recoveryUrl,
      input.targetId ?? null,
      input.ats ?? null,
      input.formStep ?? null,
      input.checkpoint,
      input.tabState,
      input.lastAction ?? null,
      timestamp,
      timestamp,
      timestamp,
    );
  }

  listTabs(batchId: string): Row[] {
    return this.db.prepare(`
      SELECT tabs.*, jobs.queue_number, jobs.title, jobs.company
      FROM tabs JOIN jobs ON jobs.id=tabs.job_id
      WHERE jobs.batch_id=? ORDER BY jobs.queue_number
    `).all(batchId) as Row[];
  }

  getTab(jobId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM tabs WHERE job_id=?").get(jobId) as Row | undefined;
  }

  addFieldEvent(input: {
    jobId: string;
    waveId: string;
    fieldId: string;
    profileKey?: string;
    controlType: string;
    question: string;
    action: string;
    expected?: string;
    observed?: string;
    confidence?: number;
    evidence?: string[];
    success: boolean;
    error?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO field_events(job_id,wave_id,field_id,profile_key,control_type,question,action,
        expected_value_redacted,observed_value_redacted,confidence,evidence_json,success,error,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.jobId,input.waveId,input.fieldId,input.profileKey ?? null,input.controlType,input.question,input.action,
      input.expected ?? null,input.observed ?? null,input.confidence ?? null,JSON.stringify(input.evidence ?? []),
      input.success ? 1 : 0,input.error ?? null,now(),
    );
  }

  saveUnresolved(field: UncertainField, fingerprint: string): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO unresolved_fields(wave_id,job_id,field_id,payload_json,field_fingerprint,state,created_at,updated_at)
      VALUES(?,?,?,?,?,'OPEN',?,?)
      ON CONFLICT(wave_id,job_id,field_id) DO UPDATE SET
        payload_json=excluded.payload_json,field_fingerprint=excluded.field_fingerprint,state='OPEN',updated_at=excluded.updated_at
    `).run(field.waveId, field.jobId, field.fieldId, JSON.stringify(field), fingerprint, timestamp, timestamp);
  }

  listUnresolved(waveId: string, state = "OPEN"): Array<UncertainField & { fieldFingerprint: string }> {
    const rows = this.db
      .prepare("SELECT payload_json,field_fingerprint FROM unresolved_fields WHERE wave_id=? AND state=? ORDER BY job_id,field_id")
      .all(waveId, state) as Row[];
    return rows.map((row) => ({
      ...(JSON.parse(String(row.payload_json)) as UncertainField),
      fieldFingerprint: String(row.field_fingerprint),
    }));
  }

  listUserQuestions(waveId: string): Array<UncertainField & { fieldFingerprint: string }> {
    return this.listUnresolved(waveId, "ASK_USER");
  }

  listPendingResolutions(waveId: string): Array<UncertainField & { fieldFingerprint: string }> {
    return [...this.listUnresolved(waveId), ...this.listUserQuestions(waveId)];
  }

  closeUnresolved(waveId: string, jobId: string, fieldId: string, state: string): void {
    this.db
      .prepare("UPDATE unresolved_fields SET state=?,updated_at=? WHERE wave_id=? AND job_id=? AND field_id=?")
      .run(state, now(), waveId, jobId, fieldId);
  }

  unresolvedState(waveId: string, jobId: string, fieldId: string): string | undefined {
    const row = this.db
      .prepare("SELECT state FROM unresolved_fields WHERE wave_id=? AND job_id=? AND field_id=?")
      .get(waveId, jobId, fieldId) as Row | undefined;
    return row?.state ? String(row.state) : undefined;
  }

  jobHasPendingReview(waveId: string, jobId: string): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM unresolved_fields WHERE wave_id=? AND job_id=? AND state IN ('OPEN','ASK_USER')")
      .get(waveId, jobId) as { count: number };
    return Number(row.count) > 0;
  }

  addResolution(input: {
    requestId: string;
    waveId: string;
    jobId: string;
    resolution: FieldResolution;
    result: string;
    error?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO ai_resolutions(request_id,wave_id,job_id,field_id,action,profile_key,answer_redacted,
        confidence,result,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      input.requestId,input.waveId,input.jobId,input.resolution.fieldId,input.resolution.action,
      input.resolution.profileField ?? null,input.resolution.answer === undefined ? null : "[REDACTED]",
      input.resolution.confidence ?? null,input.result,input.error ?? null,now(),
    );
  }

  addStateEvent(eventType: string, input: { batchId?: string; waveId?: string; jobId?: string; details?: unknown }): void {
    this.db
      .prepare("INSERT INTO state_events(batch_id,wave_id,job_id,event_type,details_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(input.batchId ?? null,input.waveId ?? null,input.jobId ?? null,eventType,input.details ? JSON.stringify(input.details) : null,now());
  }

  markApplied(batchId: string, rows: number[], note?: string): StoredJob[] {
    const timestamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const find = this.db.prepare("SELECT * FROM jobs WHERE batch_id=? AND queue_number=?");
      const confirm = this.db.prepare(`
        INSERT INTO application_confirmations(batch_id,job_id,confirmed_at,note) VALUES(?,?,?,?)
        ON CONFLICT(batch_id,job_id) DO UPDATE SET confirmed_at=excluded.confirmed_at,note=excluded.note
      `);
      const update = this.db.prepare("UPDATE jobs SET status='APPLIED',status_detail=?,updated_at=? WHERE id=?");
      for (const row of rows) {
        const job = find.get(batchId, row) as Row | undefined;
        if (!job) throw new Error(`Queue row ${row} does not exist in batch ${batchId}.`);
        confirm.run(batchId, String(job.id), timestamp, note ?? null);
        update.run("User confirmed manual submission.", timestamp, String(job.id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listJobs(batchId);
  }

  statusCounts(batchId: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status,COUNT(*) AS count FROM jobs WHERE batch_id=? GROUP BY status ORDER BY status")
      .all(batchId) as Row[];
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.count)]));
  }

  historicalResults(filters: {
    dateFrom?: string;
    dateTo?: string;
    company?: string;
    title?: string;
    status?: string[];
    ats?: string;
  }): Row[] {
    const conditions: string[] = [];
    const values: string[] = [];
    if (filters.dateFrom) {
      conditions.push("b.batch_date >= ?");
      values.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push("b.batch_date <= ?");
      values.push(filters.dateTo);
    }
    if (filters.company) {
      conditions.push("LOWER(j.company) LIKE ?");
      values.push(`%${filters.company.toLowerCase()}%`);
    }
    if (filters.title) {
      conditions.push("LOWER(j.title) LIKE ?");
      values.push(`%${filters.title.toLowerCase()}%`);
    }
    if (filters.status?.length) {
      conditions.push(`j.status IN (${filters.status.map(() => "?").join(",")})`);
      values.push(...filters.status);
    }
    if (filters.ats) {
      conditions.push("j.ats = ?");
      values.push(filters.ats);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT b.batch_date,j.id,j.batch_id,j.queue_number,j.title,j.company,j.classification,
        j.source_url,j.application_url,j.status,j.status_detail,j.ats,j.updated_at
      FROM jobs j JOIN batches b ON b.id=j.batch_id
      ${where}
      ORDER BY b.batch_date DESC,j.queue_number
    `).all(...values) as Row[];
  }

  exportSeenJobs(): Row[] {
    return this.db.prepare("SELECT * FROM seen_jobs ORDER BY last_seen_at DESC").all() as Row[];
  }

  createResolutionRequestId(waveId: string, resolutions: FieldResolution[]): string {
    return `${waveId}-${sha256(JSON.stringify(resolutions)).slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  }
}
