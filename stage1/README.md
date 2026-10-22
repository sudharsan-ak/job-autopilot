# Stage 1 output contract

Stage 1 discovers, evaluates, and optionally tailors resumes for a dated batch of jobs. Stage 2 consumes the Stage 1 JSON manifest and prepares eligible application forms for manual review.

The synthetic [`example`](example/) folder mirrors a normal dated Stage 1 output folder without containing personal data, real jobs, or resumes.

## Expected folder shape

```text
stage1/
  YYYY-MM-DD/
    jobs_manifest.json
    selected_jobs.md
    batch_summary.md
    suggest_changes_pending.md
    resumes/
      Company - Role.pdf
      Company - Role.tex
```

Only `jobs_manifest.json` is consumed by Stage 2. The Markdown files are human-readable Stage 1 artifacts. The `resumes` directory is optional when Stage 2 has a default resume configured.

## Manifest requirements

The recommended top-level structure is:

```json
{
  "batch_date": "YYYY-MM-DD",
  "jobs": []
}
```

For each job, Stage 2 uses:

| Field | Requirement | Purpose |
| --- | --- | --- |
| `classification` | Required | Only `APPLY` and `BORDERLINE` jobs enter the queue. `SKIP` jobs are ignored. |
| `title` | Recommended | Displayed in the queue. Defaults to `Unknown role`. |
| `company` | Recommended | Displayed in the queue. Defaults to `Unknown company`. |
| `job_key` | Recommended | Stable deduplication identity. |
| `employer_url` | Recommended | Direct employer/application URL. Preferred over the listing URL. |
| `hiringcafe_url` | Conditional | Source/listing URL used when no direct application URL is available. |
| `resume.pdf` | Optional | Job-specific PDF path relative to the manifest directory or an absolute path. |

Stage 2 also accepts compatible aliases documented by its loader, but producers should use the names above. Relative resume paths are resolved from the folder containing `jobs_manifest.json`.

If the job-specific PDF is missing, Stage 2 marks the row `PENDING_RESUME_REQUIRED` and may use `STAGE2_DEFAULT_RESUME_PATH`. It does not reject the entire manifest.

## Privacy

Real dated Stage 1 folders remain ignored by Git. Do not commit job history, tailored resumes, applicant details, or private source exports. Keep the tracked `example` folder synthetic.

## Stage 2 handoff

1. Validate the manifest with `batch_application_process_test`, mode `validate_manifest`.
2. Load it with `batch_application_process`, mode `load`. Loading creates the queue and does not open Chrome.
3. Prepare an explicit count or row list with mode `prepare`.
4. Review retained tabs and submit applications manually.

See [`../stage2/README.md`](../stage2/README.md) for setup and the complete operating sequence.
