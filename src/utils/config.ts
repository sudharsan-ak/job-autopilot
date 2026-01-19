import * as fs from "fs";
import * as path from "path";

export type Profile = {
  fullName: string;
  email: string;
  phone: string;
  location: string;

  linkedin: string;
  github: string;
  portfolio: string;

  resumePdfPath: string;

  keywords: string[];
  avoidPhrases: string[];

  defaults: {
    authorizedToWork: string;
    needsSponsorship: string;
    startDate: string;
    salaryExpectation: string;
  };
};

export function loadProfile(): Profile {
  const profilePath = path.join(process.cwd(), "data", "profile.json");

  if (!fs.existsSync(profilePath)) {
    throw new Error(`profile.json not found at: ${profilePath}`);
  }

  const raw = fs.readFileSync(profilePath, "utf-8");
  const profile = JSON.parse(raw) as Profile;

  if (!profile.fullName || !profile.email || !profile.phone) {
    throw new Error("profile.json missing required fields: fullName/email/phone");
  }

  return profile;
}
