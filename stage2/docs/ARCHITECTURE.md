# Stage 2 architecture

Stage 2 is isolated from the repository's original `src/` implementation.

```text
MCP dispatcher
  -> SQLite queue and checkpoints
  -> detached wave worker
  -> dedicated Chrome CDP endpoint on 127.0.0.1:9224
  -> ATS detector and shared form engine
  -> retained tabs for manual review and submission
```

The detached worker continues after the MCP client disconnects. SQLite is authoritative; Markdown and JSON files are projections. A restarted MCP process can inspect the worker PID and heartbeat, reconcile retained tabs by stored URLs, and resume an interrupted wave.

The shared form engine performs DOM scanning, semantic matching, profile resolution, browser actions, read-back verification, unresolved-field collection, and guarded navigation. Greenhouse, Ashby, Lever, Workable, Rippling, Gem, Workday, and generic employer forms supply small detection and navigation hints.

Hard boundaries:

- resume/CV upload is allowed, preferring the job-specific tailored file and falling back to the configured default; all other document uploads remain manual;
- no CAPTCHA, MFA, password, signature, identity document, payment, consent, or attestation filling;
- no final Submit, Apply, Finish, Complete, Send, or final-review action;
- no access to CDP ports 9222 or 9223;
- no applicant values in logs, SQLite field events, or source-controlled files.
