import { Profile } from "./config";
import { StructuredJobDetails } from "./automated/extractJobDescription";

export type JobFitBucket = "strong" | "partial" | "skip";

export type JobFitResult = {
  score: number;
  bucket: JobFitBucket;
  matchedSkills: string[];
  missingSignals: string[];
  reasons: string[];
};

const PRIMARY_SKILLS = [
  "javascript",
  "typescript",
  "react",
  "meteor",
  "node.js",
  "node",
  "mongodb",
  "postgresql",
  "postgres",
  "rest",
  "graphql",
  "html",
  "css"
];

const SECONDARY_SKILLS = [
  "aws",
  "docker",
  "playwright",
  "cypress",
  "testing",
  "ci/cd",
  "microservices",
  "tailwind",
  "next.js",
  "redux",
  "agile",
  "scrum"
];

const TARGET_TITLE_SIGNALS = [
  "frontend",
  "front end",
  "full stack",
  "fullstack",
  "software engineer",
  "web",
  "product engineer",
  "growth",
  "ui"
];

const NEGATIVE_TITLE_SIGNALS = [
  "principal",
  "director",
  "manager",
  "android",
  "ios",
  "mobile",
  "machine learning",
  "ml engineer",
  "data scientist",
  "data engineer",
  "devops",
  "site reliability",
  "sre",
  "embedded",
  "firmware",
  "salesforce",
  "sap",
  "qa engineer",
  "test automation"
];

const BACKEND_HEAVY_NON_JS = ["go", "golang", "ruby", "scala", "rust", "c#", ".net", "spring", "java"];

const HARD_BLOCKERS = [
  "no sponsorship",
  "cannot sponsor",
  "we do not sponsor",
  "without sponsorship",
  "security clearance",
  "active clearance",
  "clearance required",
  "must be eligible for clearance",
  "eligible for security clearance",
  "us citizen",
  "citizens only",
  "must be a u.s. citizen",
  "must be us citizen"
];

function normalize(value: string) {
  return value.toLowerCase();
}

function includesAny(text: string, values: string[]) {
  return values.some((value) => text.includes(value));
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function parseRequiredYears(text: string) {
  const patterns = [
    /(\d+)\s*\+\s*(?:years|yrs)/gi,
    /(\d+)\s*(?:-|to)\s*\d+\s*(?:years|yrs)/gi,
    /(?:at least|minimum of|min\.?)\s*(\d+)\s*(?:years|yrs)/gi,
    /(\d+)\s*(?:or more)\s*(?:years|yrs)/gi,
    /(\d+)\s*(?:years|yrs)(?:\s+of\s+experience)?/gi
  ];
  const hits = patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => Number.parseInt(match[1] ?? "", 10))
  );
  if (hits.length === 0) {
    return null;
  }
  return Math.max(...hits.filter((value) => !Number.isNaN(value)));
}

function buildSkillUniverse(profile: Profile) {
  const fromProfile = (profile.keywords ?? []).map((keyword) => normalize(keyword));
  return dedupe([...PRIMARY_SKILLS, ...SECONDARY_SKILLS, ...fromProfile]);
}

export function summarizeFit(result: JobFitResult) {
  const reasons = [...result.reasons];
  if (result.matchedSkills.length > 0) {
    reasons.push(`matched ${result.matchedSkills.slice(0, 5).join("/")}`);
  }
  if (result.missingSignals.length > 0) {
    reasons.push(`gaps ${result.missingSignals.slice(0, 3).join("/")}`);
  }
  return `fit=${result.score} ${result.bucket} | ${reasons.join(" | ")}`;
}

export function scoreJobFit(
  profile: Profile,
  input: StructuredJobDetails & { descriptionText?: string; fallbackTitle?: string; fallbackLocation?: string }
): JobFitResult {
  const title = normalize(input.title || input.fallbackTitle || "");
  const description = normalize(input.descriptionText || "");
  const location = normalize(input.fallbackLocation || "");
  const combined = `${title}\n${description}\n${location}`;
  const reasons: string[] = [];
  const matchedSkills: string[] = [];
  const missingSignals: string[] = [];
  let maxBucket: JobFitBucket = "strong";

  if (includesAny(combined, HARD_BLOCKERS)) {
    return {
      score: 0,
      bucket: "skip",
      matchedSkills: [],
      missingSignals: ["hard requirement mismatch"],
      reasons: ["blocked by sponsorship/citizenship/clearance requirement"]
    };
  }

  let score = 0;

  if (includesAny(title, TARGET_TITLE_SIGNALS)) {
    score += 18;
    reasons.push("title aligns with frontend/full-stack target");
  }

  const negativeTitleHit = NEGATIVE_TITLE_SIGNALS.find((signal) => title.includes(signal));
  if (negativeTitleHit) {
    score -= 35;
    missingSignals.push(negativeTitleHit);
    reasons.push(`title tilts away from target stack (${negativeTitleHit})`);
  }

  if (title.includes("lead")) {
    score -= 6;
    missingSignals.push("lead scope");
  }

  const skillUniverse = buildSkillUniverse(profile);
  const primaryMatched = PRIMARY_SKILLS.filter((skill) => combined.includes(skill));
  const secondaryMatched = SECONDARY_SKILLS.filter((skill) => combined.includes(skill));

  if (combined.includes("javascript")) {
    score += 12;
    matchedSkills.push("javascript");
    reasons.push("javascript baseline match");
  }

  score += Math.min(
    primaryMatched
      .filter((skill) => skill !== "javascript")
      .reduce((sum, skill) => {
        if (skill === "react" || skill === "typescript") return sum + 10;
        if (skill === "node.js" || skill === "node" || skill === "meteor") return sum + 8;
        if (skill === "mongodb" || skill === "postgresql" || skill === "postgres") return sum + 5;
        if (skill === "graphql" || skill === "rest") return sum + 4;
        return sum + 3;
      }, 0),
    44
  );
  score += Math.min(secondaryMatched.length * 3, 15);
  matchedSkills.push(...primaryMatched, ...secondaryMatched);

  if (combined.includes("react") && combined.includes("typescript")) {
    score += 14;
    reasons.push("react/typescript combination strongly matches profile");
  } else if (combined.includes("react") || combined.includes("typescript")) {
    score += 7;
  }

  if ((title.includes("frontend") || title.includes("front end")) && combined.includes("javascript")) {
    score += 10;
    reasons.push("frontend title plus javascript overlap");
  }

  if ((title.includes("full stack") || title.includes("fullstack")) && (combined.includes("react") || combined.includes("node"))) {
    score += 10;
    reasons.push("full-stack title plus web stack overlap");
  }

  const requiredSkillsText = normalize(input.requiredSkills.join(" "));
  if (requiredSkillsText.includes("react")) score += 12;
  if (requiredSkillsText.includes("typescript")) score += 12;
  if (requiredSkillsText.includes("javascript")) score += 10;
  if (requiredSkillsText.includes("node") || requiredSkillsText.includes("node.js")) score += 8;
  if (requiredSkillsText.includes("meteor")) score += 8;

  if (
    (title.includes("backend") || requiredSkillsText.includes("go") || requiredSkillsText.includes("golang")) &&
    !combined.includes("javascript") &&
    !combined.includes("typescript") &&
    !combined.includes("node")
  ) {
    score -= 22;
    missingSignals.push("backend-heavy non-JS stack");
  }

  const backendHeavyNonJsHit = BACKEND_HEAVY_NON_JS.filter((skill) => combined.includes(skill));
  if (backendHeavyNonJsHit.length >= 2 && primaryMatched.length <= 2 && !title.includes("full")) {
    score -= 24;
    missingSignals.push("non-JS backend emphasis");
  }

  const yearsRequired = parseRequiredYears(combined);
  const threshold = profile.experienceThreshold ?? 5;
  if (yearsRequired !== null) {
    if (yearsRequired <= threshold) {
      score += 6;
    } else if (yearsRequired === threshold + 1) {
      score -= 12;
      maxBucket = "partial";
      missingSignals.push(`${yearsRequired}+ years`);
      reasons.push("role seniority is slightly above target range");
    } else if (yearsRequired === threshold + 2) {
      score -= 26;
      maxBucket = "partial";
      missingSignals.push(`${yearsRequired}+ years`);
      reasons.push("role seniority is above target range");
    } else if (yearsRequired >= threshold + 3) {
      score -= 45;
      maxBucket = "skip";
      missingSignals.push(`${yearsRequired}+ years`);
      reasons.push("role seniority is far above target range");
    }
  }

  if (input.coreResponsibilities.some((line) => /\b(build|design|develop|ship|own|collaborate)\b/i.test(line))) {
    score += 8;
    reasons.push("responsibilities match end-to-end product work");
  }

  if (/\breact\b|\btypescript\b|\bjavascript\b|\bnode\b|\bgraphql\b|\brest\b/i.test(description)) {
    score += 6;
  }

  if (input.domainKeywords.some((keyword) => ["platform", "growth", "search", "enterprise"].includes(keyword.toLowerCase()))) {
    score += 4;
  }

  const topMissing = skillUniverse.filter((skill) => !combined.includes(skill)).slice(0, 5);
  if (primaryMatched.length === 0) {
    missingSignals.push("weak JS/TS overlap");
  }
  if (!title.includes("frontend") && !title.includes("full") && !title.includes("software engineer")) {
    missingSignals.push("title mismatch");
  }

  let bucket: JobFitBucket = score >= 65 ? "strong" : score >= 35 ? "partial" : "skip";
  if (maxBucket === "partial" && bucket === "strong") {
    bucket = "partial";
  }
  if (maxBucket === "skip") {
    bucket = "skip";
  }

  if (bucket !== "strong" && topMissing.length > 0) {
    missingSignals.push(...topMissing.slice(0, 2));
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    bucket,
    matchedSkills: dedupe(matchedSkills).slice(0, 8),
    missingSignals: dedupe(missingSignals).slice(0, 6),
    reasons: dedupe(reasons).slice(0, 5)
  };
}
