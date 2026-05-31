# Job Autopilot

<img width="1912" height="992" alt="jobflow-automator" src="https://github.com/user-attachments/assets/f49adf92-c527-4158-9a63-111f7599013b" />

Automates the job search pipeline — collecting, analyzing, applying, and outreach — using Playwright and the LinkedIn/Greenhouse/Gmail APIs.

## Setup

```powershell
npm init -y
npm i playwright dotenv
npm i -D typescript ts-node @types/node
npx playwright install
```

Create your local profile config from the example:

```powershell
Copy-Item profile.example.json data/profile.json
```

`data/profile.json` is ignored by git. Fill in `fullName`, `linkedin`, `github`, `portfolio`, and the optional `outreach.*` fields.

## Docs

- [Auth](docs/auth.md)
- [Collecting & Analyzing Jobs](docs/collecting.md)
- [Applying to Jobs](docs/applying.md)
- [Outreach](docs/outreach.md)
