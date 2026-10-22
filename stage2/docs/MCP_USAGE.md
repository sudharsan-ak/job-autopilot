# MCP tools

## `batch_application_process`

Supported modes:

- `load`: import a Stage 1 JSON manifest without opening Chrome.
- `prepare`: start a detached worker for explicit rows or a bounded count.
- `resolve_fields`: validate and apply one bundled set of AI resolutions.
- `status`: return batch, wave, job, tab, worker, and unresolved-field state.
- `pause`: request a safe-checkpoint pause.
- `resume`: restart an interrupted or paused detached worker.
- `stop`: request a safe-checkpoint stop while preserving tabs.
- `mark_applied`: record only rows explicitly confirmed as manually submitted.
- `results`: query current or historical results and optionally write final reports.

`prepare` and `resume` accept `wait_ms`. A short wait returns current worker state; the detached worker continues independently.

## `batch_application_process_test`

This tool never fills or submits a form and does not write production application state.

- `health`: configuration and CDP reachability.
- `validate_manifest`: parse a manifest without importing it.
- `dry_run_fixture`: exercise matcher behavior on synthetic fields.
- `database_check`: migrate and inspect an isolated temporary database.
- `inspect_url`: inspect ATS, fields, and navigation boundary without filling; the test tab is closed unless `retain_tab` is true.
- `simplify_autofill`: reuse or open the requested URL, wait for Simplify's injected `#fill-button` inside its open shadow root, click it once, remove Simplify's tracking parameters and reload the clean URL once when necessary, then report completion without invoking the Stage 2 field filler or submitting.
