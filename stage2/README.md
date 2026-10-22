# Job Autopilot Stage 2

Stage 2 is an isolated local MCP server that prepares selected job application forms in a dedicated Chrome profile. It may upload a recognized resume/CV file when an application requires it, but it never clicks a final submission action.

## Local setup

1. Copy `.env.example` to `.env` and point it to your own applicant profile, default resume, and private data directory. `config/applicant-profile.example.json` shows the supported shape. A job-specific resume from the Stage 1 manifest takes precedence over the default resume.
2. Run `npm install` and `npm run build` inside this folder.
3. Start the dedicated Chrome profile with `scripts/launch-stage2-chrome.ps1` or allow the server to start it when port 9224 is unavailable.
4. Register `mcp.json` with the MCP host.

Source code, adapters, fixtures, and tests are reusable. Applicant profiles, SQLite state, browser profiles, evidence, logs, resumes, credentials, and screenshots are intentionally excluded from Git.

See `docs/ARCHITECTURE.md`, `docs/MCP_USAGE.md`, `docs/OFFLINE_DATABASE.md`, and `docs/IMPLEMENTATION_STATUS.md` for operating details.

## Stage 1 to Stage 2 workflow

The tracked [`../stage1/example`](../stage1/example/) folder demonstrates the Stage 1 handoff without personal data. A real private batch normally lives at `stage1/YYYY-MM-DD/jobs_manifest.json` with optional job-specific resumes in the same dated folder.

1. Configure `.env`, install dependencies, and run `npm test`.
2. Launch the dedicated port-9224 Chrome profile and install/sign in to Simplify in that profile if Simplify-first autofill is desired.
3. Validate the Stage 1 manifest with `batch_application_process_test`, mode `validate_manifest`.
4. Load the manifest with `batch_application_process`, mode `load`. This creates `application_queue.md` and does not open Chrome.
5. Prepare an explicit queue count or row list with mode `prepare`. Jobs run sequentially.
6. Poll mode `status` until the detached wave completes. Workday destinations are skipped. Other application tabs remain open for review.
7. Review every retained tab and submit manually. Stage 2 never clicks the final submission action.
8. After manual submission, use mode `mark_applied` for only the confirmed queue rows. Use mode `results` to inspect or finalize reports.

See [`docs/MCP_USAGE.md`](docs/MCP_USAGE.md) for request examples and [`../stage1/README.md`](../stage1/README.md) for the manifest contract.
