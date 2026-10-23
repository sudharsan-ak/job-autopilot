# MCP tools

## `batch_application_process`

Supported modes:

- `load`: import a Stage 1 JSON manifest or compatible Markdown selected-jobs table without opening Chrome.
- `prepare`: start a detached worker for explicit rows or a bounded count.
- `resolve_fields`: validate and apply one bundled set of AI resolutions.
- `status`: return batch, wave, job, tab, worker, and unresolved-field state.
- `pause`: request a safe-checkpoint pause.
- `resume`: restart an interrupted or paused detached worker.
- `stop`: request a safe-checkpoint stop while preserving tabs.
- `mark_applied`: record only rows explicitly confirmed as manually submitted.
- `results`: query current or historical results and optionally write final reports.

`prepare` and `resume` accept `wait_ms`. A short wait returns current worker state; the detached worker continues independently.

## End-to-end example

Validate the synthetic Stage 1 manifest without changing production state:

```json
{
  "mode": "validate_manifest",
  "batch_path": "../stage1/example/jobs_manifest.json"
}
```

The same mode accepts a Markdown table:

```json
{
  "mode": "validate_manifest",
  "batch_path": "../stage1/YYYY-MM-DD/selected_jobs.md"
}
```

Load a real private dated manifest and create its queue without opening Chrome:

```json
{
  "mode": "load",
  "batch_path": "../stage1/YYYY-MM-DD/jobs_manifest.json"
}
```

To build the same queue from a Markdown shortlist, pass that file as `batch_path` instead. The table must contain Role, Company, Job URL, and Classification columns. Application URL, Resume Path, Job Key, and ATS columns are optional.

Prepare the next three eligible jobs sequentially:

```json
{
  "mode": "prepare",
  "batch_date": "YYYY-MM-DD",
  "count": 3,
  "wait_ms": 30000
}
```

If the worker is still running, call status with the returned `wave_id`. Do not start another wave:

```json
{
  "mode": "status",
  "wave_id": "<returned-wave-id>"
}
```

After reviewing and manually submitting specific retained tabs, record only those rows:

```json
{
  "mode": "mark_applied",
  "batch_date": "YYYY-MM-DD",
  "rows": [1, 2]
}
```

Stage 2 may navigate through safe `Next` or `Continue` steps, but it never clicks final `Submit`, `Apply`, `Finish`, `Complete`, or `Send` actions.

## `batch_application_process_test`

This tool never fills or submits a form and does not write production application state.

- `health`: configuration and CDP reachability.
- `validate_manifest`: parse a manifest without importing it.
- `dry_run_fixture`: exercise matcher behavior on synthetic fields.
- `database_check`: migrate and inspect an isolated temporary database.
- `inspect_url`: inspect ATS, fields, and navigation boundary without filling; the test tab is closed unless `retain_tab` is true.
- `simplify_autofill`: reuse or open the requested URL, wait for Simplify's injected `#fill-button` inside its open shadow root, click it once, remove Simplify's tracking parameters and reload the clean URL once when necessary, then report completion without invoking the Stage 2 field filler or submitting.
