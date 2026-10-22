# Job Autopilot Stage 2

Stage 2 is an isolated local MCP server that prepares selected job application forms in a dedicated Chrome profile. It may upload a recognized resume/CV file when an application requires it, but it never clicks a final submission action.

## Local setup

1. Copy `.env.example` to `.env` and point it to your own applicant profile, default resume, and private data directory. `config/applicant-profile.example.json` shows the supported shape. A job-specific resume from the Stage 1 manifest takes precedence over the default resume.
2. Run `npm install` and `npm run build` inside this folder.
3. Start the dedicated Chrome profile with `scripts/launch-stage2-chrome.ps1` or allow the server to start it when port 9224 is unavailable.
4. Register `mcp.json` with the MCP host.

Source code, adapters, fixtures, and tests are reusable. Applicant profiles, SQLite state, browser profiles, evidence, logs, resumes, credentials, and screenshots are intentionally excluded from Git.

See `docs/ARCHITECTURE.md`, `docs/MCP_USAGE.md`, `docs/OFFLINE_DATABASE.md`, and `docs/IMPLEMENTATION_STATUS.md` for operating details.
