import type { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    batch_date TEXT NOT NULL,
    source_path TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batches_date ON batches(batch_date);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    queue_number INTEGER NOT NULL,
    job_key TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    classification TEXT NOT NULL,
    source_url TEXT,
    application_url TEXT,
    resume_path TEXT,
    status TEXT NOT NULL,
    status_detail TEXT,
    ats TEXT,
    raw_index INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(batch_id, queue_number)
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_batch_status ON jobs(batch_id, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_key ON jobs(job_key);

  CREATE TABLE IF NOT EXISTS waves (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    sequence INTEGER NOT NULL,
    requested_rows_json TEXT NOT NULL,
    state TEXT NOT NULL,
    control_request TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(batch_id, sequence)
  );

  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    wave_id TEXT REFERENCES waves(id),
    original_url TEXT NOT NULL,
    current_url TEXT NOT NULL,
    recovery_url TEXT NOT NULL,
    target_id TEXT,
    ats TEXT,
    form_step TEXT,
    checkpoint TEXT NOT NULL,
    tab_state TEXT NOT NULL,
    last_action TEXT,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id)
  );

  CREATE TABLE IF NOT EXISTS field_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    wave_id TEXT REFERENCES waves(id),
    field_id TEXT NOT NULL,
    profile_key TEXT,
    control_type TEXT NOT NULL,
    question TEXT NOT NULL,
    action TEXT NOT NULL,
    expected_value_redacted TEXT,
    observed_value_redacted TEXT,
    confidence REAL,
    evidence_json TEXT,
    success INTEGER NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS unresolved_fields (
    wave_id TEXT NOT NULL REFERENCES waves(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    field_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    field_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(wave_id, job_id, field_id)
  );

  CREATE TABLE IF NOT EXISTS ai_resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    wave_id TEXT NOT NULL REFERENCES waves(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    field_id TEXT NOT NULL,
    action TEXT NOT NULL,
    profile_key TEXT,
    answer_redacted TEXT,
    confidence REAL,
    result TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS state_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT,
    wave_id TEXT,
    job_id TEXT,
    event_type TEXT NOT NULL,
    details_json TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS application_confirmations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    confirmed_at TEXT NOT NULL,
    note TEXT,
    UNIQUE(batch_id, job_id)
  );

  CREATE TABLE IF NOT EXISTS seen_jobs (
    job_key TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    canonical_url TEXT,
    aliases_json TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    times_seen INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE waves ADD COLUMN worker_pid INTEGER;
  ALTER TABLE waves ADD COLUMN heartbeat_at TEXT;
  `,
];

export function runMigrations(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[index]!);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
