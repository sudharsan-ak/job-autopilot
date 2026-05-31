# Outreach

Automated outreach drafts:

```powershell
npm run createOutreachDrafts
```

Manual outreach:

```powershell
npm run prepareManualOutreach
npm run draftEmails
```

Manual outreach watcher:

```powershell
npm run watchManualOutreach
npm run watchManualOutreach -- --intervalMinutes=3
```

Recruiter outreach:

```powershell
npm run recruiterOutreach
```

# Gmail CSV Enrichment

Enrich a recruiter CSV by finding recipient emails from your Gmail Sent mail:

```powershell
npm run authGmail
npm run enrichLinkedInCsvEmails -- --csv "path/to/your.csv"
npm run enrichLinkedInCsvEmails -- --csv "path/to/your.csv" --out "path/to/output.csv"
```
