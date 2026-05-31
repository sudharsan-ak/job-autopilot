# Applying to Jobs

```powershell
npm run applyBatchWindows
npm run applyBatchMac
```

Run against a specific CSV bucket:

```powershell
npm run applyBatchWindows -- --csv=data/jobsStrong.csv
npm run applyBatchMac -- --csv=data/jobsStrong.csv --count=5
```

Controls while running:

- Pause: `p` or `Enter`
- Resume: `r` or `Enter`
- Stop after current step: `s` or `q`
- Hard stop: `Ctrl+C`

# Unknown Jobs

```powershell
npm run openUnknownJobs
npm run unknownJobsUI
```

# Controller UI

```powershell
npm run controllerUI
```
