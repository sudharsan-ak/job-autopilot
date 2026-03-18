import { Page } from "playwright";

export type StructuredJobDetails = {
  title: string;
  company: string;
  location: string;
  descriptionText: string;
  requiredSkills: string[];
  preferredSkills: string[];
  coreResponsibilities: string[];
  seniority: string;
  domainKeywords: string[];
};

function normalizeWhitespace(value: string) {
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function dedupe(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function splitBulletLines(text: string) {
  return text
    .split(/\n/)
    .map((line) => line.replace(/^[\s\-*•]+/, "").trim())
    .filter((line) => line.length > 0);
}

function takeMatches(text: string, patterns: RegExp[], limit: number) {
  const lines = splitBulletLines(text);
  const matches: string[] = [];

  for (const line of lines) {
    if (patterns.some((pattern) => pattern.test(line))) {
      matches.push(line);
    }
    if (matches.length >= limit) {
      break;
    }
  }

  return dedupe(matches).slice(0, limit);
}

function detectSeniority(text: string) {
  const value = text.match(
    /\b(entry level|junior|mid[- ]level|mid level|senior|staff|lead|principal|manager|5\+ years|6\+ years|7\+ years|8\+ years)\b/i
  );
  return value?.[0] ?? "";
}

function extractSkills(text: string) {
  const knownSkills = [
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Node",
    "MongoDB",
    "PostgreSQL",
    "Postgres",
    "Supabase",
    "GraphQL",
    "REST",
    "REST APIs",
    "AWS",
    "Docker",
    "Kubernetes",
    "Python",
    "Java",
    "Go",
    "Next.js",
    "Redux",
    "HTML",
    "CSS",
    "SQL",
    "NoSQL",
    "CI/CD",
    "Tailwind",
    "Jest",
    "Playwright",
    "Redis",
    "Kafka",
    "Microservices"
  ];

  const found = knownSkills.filter((skill) => new RegExp(`\\b${skill.replace(/[.+]/g, "\\$&")}\\b`, "i").test(text));
  return dedupe(found);
}

function extractDomainKeywords(text: string) {
  const candidates = [
    "payments",
    "marketplace",
    "rideshare",
    "security",
    "enterprise",
    "consumer",
    "mobile",
    "platform",
    "search",
    "messaging",
    "analytics",
    "ai",
    "machine learning",
    "fintech",
    "healthcare",
    "developer tools",
    "infrastructure",
    "e-commerce",
    "logistics",
    "growth",
    "experimentation",
    "recommendations",
    "real-time"
  ];

  return dedupe(candidates.filter((value) => new RegExp(`\\b${value.replace(/[.+]/g, "\\$&")}\\b`, "i").test(text))).slice(0, 8);
}

export async function extractJobDescription(page: Page): Promise<StructuredJobDetails> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  const extracted = await page.evaluate(() => {
    const pickText = (selectors: string[]) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const value = (element?.textContent || "").trim();
        if (value) {
          return value;
        }
      }
      return "";
    };

    const clean = (value: string) => value.replace(/\s+/g, " ").trim();

    const title =
      pickText([
        "h1",
        "[data-testid='job-details-title']",
        ".job-details-jobs-unified-top-card__job-title",
        ".t-24.job-details-jobs-unified-top-card__job-title"
      ]) || "";

    const company =
      pickText([
        "[data-testid='company-name']",
        ".job-details-jobs-unified-top-card__company-name a",
        ".job-details-jobs-unified-top-card__company-name",
        ".job-details-jobs-unified-top-card__primary-description-container a"
      ]) || "";

    let location = "";
    const topMeta = document.querySelector(
      ".job-details-jobs-unified-top-card__primary-description-container"
    ) as HTMLElement | null;
    if (topMeta) {
      const parts = clean(topMeta.innerText)
        .split("·")
        .map((part) => clean(part))
        .filter(Boolean);
      location = parts.find((part) => /remote|hybrid|on-site|onsite|united states|, [A-Z]{2}\b/i.test(part)) || parts[0] || "";
    }

    const headings = Array.from(document.querySelectorAll("h2, h3"));
    const aboutHeading = headings.find((el) => clean(el.textContent || "").toLowerCase() === "about the job");

    let description = "";
    if (aboutHeading) {
      let container: Element | null = aboutHeading.parentElement;
      while (container) {
        const text = clean((container as HTMLElement).innerText || "");
        if (text.toLowerCase().includes("about the job") && text.length > 200) {
          description = text;
          break;
        }
        container = container.parentElement;
      }
    }

    if (!description) {
      const descriptionSelectors = [
        "[data-testid='job-details-description']",
        "[data-testid='job-description']",
        ".jobs-description",
        ".job-view-layout.jobs-details",
        "main"
      ];

      for (const selector of descriptionSelectors) {
        const element = document.querySelector(selector) as HTMLElement | null;
        const value = clean(element?.innerText || "");
        if (value.length > description.length) {
          description = value;
        }
      }
    }

    if (!description) {
      description = clean(document.body?.innerText || "");
    }

    return {
      title,
      company,
      location,
      description
    };
  });

  const text = normalizeWhitespace(extracted.description).slice(0, 15000);
  const requiredSkills = extractSkills(text).slice(0, 12);
  const preferredSkills = takeMatches(
    text,
    [/\bnice to have\b/i, /\bpreferred\b/i, /\bbonus\b/i, /\bplus\b/i],
    6
  );
  const coreResponsibilities = takeMatches(
    text,
    [/\bbuild\b/i, /\bdesign\b/i, /\bdevelop\b/i, /\bcollaborate\b/i, /\bown\b/i, /\blead\b/i, /\bship\b/i],
    6
  );
  const seniority = detectSeniority(text);
  const domainKeywords = extractDomainKeywords(text);

  return {
    title: normalizeWhitespace(extracted.title),
    company: normalizeWhitespace(extracted.company),
    location: normalizeWhitespace(extracted.location),
    descriptionText: text,
    requiredSkills,
    preferredSkills,
    coreResponsibilities,
    seniority,
    domainKeywords
  };
}
