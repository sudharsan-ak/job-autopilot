# Offline database access

The default database is `stage2/data/stage2.db`. It can be queried read-only while the MCP server is disconnected. Do not write to it while a Stage 2 worker is active.

Example with the SQLite CLI:

```powershell
sqlite3 -readonly .\data\stage2.db "SELECT batch_date, company, title, status FROM jobs JOIN batches ON batches.id = jobs.batch_id ORDER BY batch_date DESC, queue_number;"
```

Useful tables are `batches`, `jobs`, `waves`, `tabs`, `field_events`, `unresolved_fields`, `ai_resolutions`, `state_events`, `application_confirmations`, and `seen_jobs`.

Applicant answers are not copied into field-event or AI-resolution records. Audits retain profile keys, action results, and redacted value fingerprints.
