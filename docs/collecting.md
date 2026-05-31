# Collecting Jobs

Run LinkedIn collection with your own search URL:

```powershell
npm run collectLinkedIn -- --count=10 --url "YOUR_LINKEDIN_SEARCH_URL"
```

Shortcut collectors:

```powershell
npm run frontendJobs
npm run softwareJobs
npm run fullstackJobs
```

# Analyzing Jobs

After `data/jobs.csv` is populated:

```powershell
npm run analyzeJobs
```

Outputs buckets to `data/jobsStrong.csv`, `data/jobsMedium.csv`, `data/jobsSkip.csv` and job text to `data/analyzed-jobs/JDInfo.txt`.
