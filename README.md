# Job Autopilot

## Setup

```powershell
npm init -y
npm i playwright dotenv
npm i -D typescript ts-node @types/node
npx playwright install
```

## Auth

LinkedIn session:

```powershell
npm run authLinkedIn
```

Greenhouse session:

```powershell
npm run authGreenhouse
```

Gmail session:

```powershell
npm run authGmail
```

Note: Gmail auth now requests both `gmail.compose` and `gmail.readonly` so draft creation and Sent-mail lookups can share the same token.

## Collect Jobs

Run LinkedIn collection with your own search URL:

```powershell
npm run collectLinkedIn -- --count=10 --url "https://www.linkedin.com/jobs/search/?currentJobId=4253101367&distance=25.0&f_E=3%2C4&f_F=it%2Ceng&f_JT=F&f_T=9%2C39%2C25201%2C3172%2C1176&f_TPR=r86400&geoId=103644278&keywords=Software%20Engineer%20JavaScript&origin=JOBS_HOME_KEYWORD_HISTORY"
```

Another example:

```powershell
npm run collectLinkedIn -- --count=20 --url "https://www.linkedin.com/jobs/search/?currentJobId=4364201648&distance=25.0&f_E=3%2C4&f_F=it%2Ceng&f_JT=F&f_T=9%2C39%2C25201%2C3172%2C1176&f_TPR=r86400&geoId=103644278&keywords=Frontend%20Engineer%20JavaScript%20NOT%20(%22Easy%20Apply%22%20OR%20%22Easy%20Apply%20only%22%20OR%20%22LinkedIn%20Easy%20Apply%22%20OR%20%226%2B%20years%22%20OR%20%227%2B%20years%22%20OR%20%228%2B%20years%22%20OR%20%2210%2B%20years%22)&origin=JOB_SEARCH_PAGE_JOB_FILTER&refresh=true&sortBy=DD"
```

Shortcut collectors:

```powershell
npm run frontendJobs
npm run softwareJobs
npm run fullstackJobs
```

## Analyze Jobs

After `data/jobs.csv` is populated, run:

```powershell
npm run analyzeJobs
```

What it does:

- reads `data/jobs.csv`
- opens each LinkedIn job link headlessly
- extracts title, company, location, and `About the job` text from the rendered DOM
- scores the job against your resume/profile
- writes buckets to:
  - `data/jobsStrong.csv`
  - `data/jobsMedium.csv`
  - `data/jobsSkip.csv`
- sorts each bucket from highest fit to lowest fit
- writes analyzed job text to:
  - `data/analyzed-jobs/JDInfo.txt`
- groups `JDInfo.txt` in this order:
  - `Strong fits`
  - `Partial fits`
  - `Skip fits`
- leaves the original `data/jobs.csv` unchanged

Notes about matching:

- strong matches are tuned around your JS/TS, React, Node, Meteor, and frontend/full-stack profile
- roles that are clearly too senior are penalized heavily and capped out of `strong`
- jobs with explicit clearance requirements are forced into `skip`

## Apply Jobs

Default run:

```powershell
npm run applyBatchWindows
npm run applyBatchMac
```

Run against a specific CSV bucket:

```powershell
npm run applyBatchWindows -- --csv=data/jobsStrong.csv
npm run applyBatchWindows -- --csv=data/jobsMedium.csv
npm run applyBatchWindows -- --csv=data/jobsSkip.csv
```

```powershell
npm run applyBatchMac -- --csv=data/jobsStrong.csv
npm run applyBatchMac -- --csv=data/jobsMedium.csv
npm run applyBatchMac -- --csv=data/jobsSkip.csv
```

Limit the Mac apply run to the first `N` approved jobs from the selected CSV:

```powershell
npm run applyBatchMac -- --count=5
npm run applyBatchMac -- --csv=data/jobsStrong.csv --count=5
```

Controls while apply automation is running:

- Pause: `p` or `Enter`
- Resume: `r` or `Enter`
- Stop after current step: `s` or `q`
- Hard stop: `Ctrl+C`

## Unknown Jobs

Open unknown jobs in the browser:

```powershell
npm run openUnknownJobs
```

Unknown jobs review UI:

```powershell
npm run unknownJobsUI
```

## Controller UI

```powershell
npm run controllerUI
```

This opens the controller UI and supports collecting, applying, clearing files, and pause/resume controls.

## Outreach

Automated outreach drafts:

```powershell
npm run createOutreachDrafts
```

Manual outreach workflow:

```powershell
npm run prepareManualOutreach
npm run draftEmails
```

Manual outreach watcher:

```powershell
npm run watchManualOutreach
npm run watchManualOutreach -- --intervalMinutes=3
```

This polls `data/manual-outreach/manualOutreach.txt`, keeps a local log at `data/manual-outreach/manualOutreachLog.json`, and only drafts blocks that are new or changed.

Recruiter outreach:

```powershell
npm run recruiterOutreach
```

This opens recruiter profile tabs, prepares the Connect flow, fills the note, and leaves the browser session open for manual review. Keep that first terminal and browser window open.

After you review the prepared tabs, open a second terminal and send the prepared invites from the same Playwright session:

```powershell
npm run sendRecruiterOutreach -- --delaySeconds=10
```

The send command:

- connects to the same existing recruiter-outreach browser session
- checks each recruiter tab for an open connect dialog
- skips tabs where the note is missing, empty, or the `Send` button is missing/disabled
- clicks `Send` only on valid prepared tabs
- waits the given number of seconds between successful sends

## Gmail CSV Enrichment

To enrich a recruiter CSV by looking through your Gmail Sent mail and finding likely recipient emails:

```powershell
npm run authGmail
npm run enrichLinkedInCsvEmails -- --csv "C:\Users\sudha\Downloads\LinkedIn Data - LKDN.csv"
```

Optional output path:

```powershell
npm run enrichLinkedInCsvEmails -- --csv "C:\Users\sudha\Downloads\LinkedIn Data - LKDN.csv" --out "C:\Users\sudha\Downloads\LinkedIn Data - LKDN.enriched.csv"
```

The script keeps the original CSV unchanged and writes a new file with:

- `Email`
- `MatchConfidence`
- `MatchNote`
