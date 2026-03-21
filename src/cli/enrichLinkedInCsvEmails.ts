import path from "path";
import fs from "fs";
import { google, gmail_v1 } from "googleapis";
import { authorizeGmail } from "../utils/gmailAuth";
import { CsvRow } from "../utils/csv";
import { readTabular, writeTabular } from "../utils/tabular";

type MatchResult = {
  email: string;
  confidence: "exact" | "likely" | "maybe" | "none";
  note: string;
  score: number;
};

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function getArg(name: string): string | null {
  const hit = process.argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!hit) return null;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function getPositiveIntArg(name: string): number | null {
  const raw = getArg(name);
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --${name} value: ${raw}. Expected a positive integer.`);
  }
  return value;
}

function normalize(value: string) {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanRecruiterName(value: string) {
  return (value ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(she\/her|he\/him|they\/them|she her|he him|they them)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string) {
  return normalize(cleanRecruiterName(value))
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function compact(value: string) {
  return normalize(value).replace(/\s+/g, "");
}

function localPart(email: string) {
  return email.split("@")[0]?.toLowerCase() ?? "";
}

function domain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function localPartSegments(email: string) {
  return localPart(email)
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length >= 1);
}

function parseToHeader(value: string) {
  const parts = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const emailMatch = part.match(/<([^>]+)>/);
      const email = (emailMatch?.[1] ?? part).trim().toLowerCase();
      const displayName = part.replace(/<[^>]+>/, "").replace(/^"|"$/g, "").trim();
      return { email, displayName };
    })
    .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item.email));
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function extractPlainText(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text.trim()) return text;
  }

  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}

function greetingMatchesFirstName(bodyText: string, firstName: string) {
  if (!firstName || firstName.length < 3) return false;
  const normalizedBody = normalize(bodyText);
  if (!normalizedBody) return false;

  const firstNamePattern = firstName.replace(/[^a-z0-9]/g, "");
  const greetingPatterns = [
    `hi ${firstNamePattern}`,
    `hello ${firstNamePattern}`,
    `hey ${firstNamePattern}`,
    `dear ${firstNamePattern}`
  ];

  return greetingPatterns.some((pattern) => normalizedBody.includes(pattern));
}

function getCompanySignals(company: string, companyLinkedInPage: string) {
  const baseTokens = tokens(company);
  const signals = new Set<string>(baseTokens);
  const compactCompany = compact(company);
  if (compactCompany) {
    signals.add(compactCompany);
  }

  const slugMatch = companyLinkedInPage.match(/linkedin\.com\/company\/([^/]+)/i);
  if (slugMatch?.[1]) {
    const slug = slugMatch[1].toLowerCase();
    signals.add(slug);
    slug
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length >= 2)
      .forEach((part) => signals.add(part));
    signals.add(slug.replace(/[^a-z0-9]+/g, ""));
  }

  return Array.from(signals).filter(Boolean);
}

function getMeaningfulCompanySignals(company: string, companyLinkedInPage: string) {
  return getCompanySignals(company, companyLinkedInPage).filter((signal) => signal.replace(/[^a-z0-9]/g, "").length >= 4);
}

function getCompanyAcronyms(company: string, companyLinkedInPage: string) {
  const sourceTokens = tokens(company);
  const acronyms = new Set<string>();

  if (sourceTokens.length >= 2) {
    const acronym = sourceTokens.map((token) => token[0]).join("");
    if (acronym.length >= 2) acronyms.add(acronym);
  }

  const slugMatch = companyLinkedInPage.match(/linkedin\.com\/company\/([^/]+)/i);
  if (slugMatch?.[1]) {
    const slugTokens = slugMatch[1]
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2);
    if (slugTokens.length >= 2) {
      const slugAcronym = slugTokens.map((token) => token[0]).join("");
      if (slugAcronym.length >= 2) acronyms.add(slugAcronym);
    }
  }

  return Array.from(acronyms);
}

function getCompanyDomainCandidates(company: string, companyLinkedInPage: string) {
  const signals = getCompanySignals(company, companyLinkedInPage);
  const domains = new Set<string>();

  for (const signal of signals) {
    const cleaned = signal.replace(/[^a-z0-9]/g, "");
    if (cleaned.length < 3) continue;
    domains.add(`${cleaned}.com`);
    domains.add(`${cleaned}.io`);
    domains.add(`${cleaned}.ai`);
    domains.add(`${cleaned}.co`);

    if (!cleaned.endsWith("app")) {
      domains.add(`${cleaned}app.com`);
    }
    if (!cleaned.endsWith("group")) {
      domains.add(`${cleaned}group.com`);
    }
  }

  return Array.from(domains);
}

function getAcronymDomainCandidates(company: string, companyLinkedInPage: string) {
  const acronyms = getCompanyAcronyms(company, companyLinkedInPage);
  const domains = new Set<string>();

  for (const acronym of acronyms) {
    const cleaned = acronym.replace(/[^a-z0-9]/g, "");
    if (cleaned.length < 2) continue;
    domains.add(`${cleaned}.com`);
    domains.add(`${cleaned}.io`);
    domains.add(`${cleaned}.ai`);
    domains.add(`${cleaned}.co`);
  }

  return Array.from(domains);
}

function getNamePatterns(name: string) {
  const nameTokens = tokens(name);
  const first = nameTokens[0] ?? "";
  const last = nameTokens[nameTokens.length - 1] ?? "";
  const patterns = new Set<string>();

  if (first && last) {
    patterns.add(`${first}${last}`);
    patterns.add(`${last}${first}`);
    patterns.add(`${first}.${last}`);
    patterns.add(`${last}.${first}`);
    patterns.add(`${first}_${last}`);
    patterns.add(`${last}_${first}`);
    patterns.add(`${first[0]}${last}`);
    patterns.add(`${last}${first[0]}`);
    patterns.add(`${first}${last[0]}`);
    patterns.add(`${last[0]}${first}`);
  }

  return {
    nameTokens,
    first,
    last,
    patterns: Array.from(patterns).filter(Boolean)
  };
}

function scoreRecipient(
  name: string,
  company: string,
  companyLinkedInPage: string,
  candidateEmail: string,
  displayName: string,
  subject: string,
  bodyText: string
) {
  const nameTokens = tokens(name);
  const companySignals = getMeaningfulCompanySignals(company, companyLinkedInPage);
  const companyAcronyms = getCompanyAcronyms(company, companyLinkedInPage);
  const lp = localPart(candidateEmail);
  const emailDomain = domain(candidateEmail);
  const lpSegments = localPartSegments(candidateEmail);
  const { patterns, first, last } = getNamePatterns(name);
  const displayNameTokens = tokens(displayName);

  const subjectNormalized = normalize(subject);
  const companyMatchesDomain = companySignals.some((token) => emailDomain.includes(token));
  const companyMatchesSubject = companySignals.some((token) => subjectNormalized.includes(token));
  const companyMatchesAcronymDomain =
    !companyMatchesDomain && companyAcronyms.some((token) => emailDomain.includes(token));

  const compactLocalPart = lp.replace(/[^a-z0-9]/g, "");
  const localPartPatternHits = patterns.filter((pattern) => {
    const compactPattern = pattern.replace(/[^a-z0-9]/g, "");
    return compactPattern && compactLocalPart.includes(compactPattern);
  });
  const firstInLocalPart =
    first.length >= 3 &&
    lpSegments.some((segment) => segment === first || segment.startsWith(first) || first.startsWith(segment));
  const lastInLocalPart =
    last.length >= 3 &&
    lpSegments.some((segment) => segment === last || segment.startsWith(last) || last.startsWith(segment));
  const displayHasFirst = first.length >= 3 && displayNameTokens.includes(first);
  const displayHasLast = last.length >= 3 && displayNameTokens.includes(last);
  const lastNameRequiredEvidence = lastInLocalPart || displayHasLast;
  const firstNameEvidence = firstInLocalPart || displayHasFirst;
  const strongNameOnlyMatch =
    localPartPatternHits.length > 0 && lastNameRequiredEvidence && firstNameEvidence;

  if (!companyMatchesDomain && !companyMatchesSubject && !companyMatchesAcronymDomain && !strongNameOnlyMatch) {
    return { score: 0, note: "candidate does not align with company domain/subject" };
  }

  if (!lastNameRequiredEvidence && localPartPatternHits.length === 0) {
    return { score: 0, note: "candidate does not contain last-name/full-pattern evidence" };
  }

  let score = 0;
  const reasons: string[] = [];

  if (localPartPatternHits.length > 0) {
    score += 60;
    reasons.push("common full-name email pattern matched");
  }

  if (lastNameRequiredEvidence) {
    score += 30;
    reasons.push("last name matched");
  }

  if (firstNameEvidence) {
    score += 18;
    reasons.push("first name matched");
  }

  const matchedDisplayNameTokens = nameTokens.filter((token) => token.length >= 3 && displayNameTokens.includes(token));
  if (matchedDisplayNameTokens.length >= 2) {
    score += 18;
    reasons.push("display name matched");
  } else if (matchedDisplayNameTokens.length === 1) {
    score += 8;
    reasons.push("display name partially matched");
  }

  const initials = nameTokens.map((token) => token[0]).join("");
  if (initials && compactLocalPart.includes(initials)) {
    score += 10;
    reasons.push("initials matched local part");
  }

  if (companyMatchesDomain) {
    score += 18;
    reasons.push("company matched domain");
  }

  if (companyMatchesSubject) {
    score += 6;
    reasons.push("company matched subject");
  }

  if (companyMatchesAcronymDomain) {
    score += 9;
    reasons.push("company acronym matched domain");
  }

  if (!companyMatchesDomain && !companyMatchesSubject && !companyMatchesAcronymDomain && strongNameOnlyMatch) {
    score += 10;
    reasons.push("strong name-only fallback matched");
  }

  if (greetingMatchesFirstName(bodyText, first)) {
    score += 14;
    reasons.push("greeting matched first name");
  }

  return { score, note: reasons.join("; ") || "weak match" };
}

async function listCompanySentMessages(
  gmail: gmail_v1.Gmail,
  company: string,
  companyLinkedInPage: string,
  recruiterName: string
) {
  const companySignals = getMeaningfulCompanySignals(company, companyLinkedInPage);
  const companyDomains = getCompanyDomainCandidates(company, companyLinkedInPage);
  const acronymDomains = getAcronymDomainCandidates(company, companyLinkedInPage);
  const { nameTokens } = getNamePatterns(recruiterName);
  const queries = Array.from(
    new Set(
      [
        `in:sent "${company}"`,
        ...companySignals.slice(0, 6).flatMap((signal) => [`in:sent "${signal}"`, `in:sent ${signal}`]),
        ...companyDomains.slice(0, 8).flatMap((domain) => [`in:sent to:${domain}`, `in:sent "${domain}"`]),
        ...acronymDomains.slice(0, 4).flatMap((domain) => [`in:sent to:${domain}`, `in:sent "${domain}"`]),
        ...nameTokens.slice(0, 2).map((token) => `in:sent "${company}" "${token}"`),
        ...companyDomains.slice(0, 4).flatMap((domain) =>
          nameTokens.slice(0, 2).map((token) => `in:sent to:${domain} "${token}"`)
        ),
        ...acronymDomains.slice(0, 2).flatMap((domain) =>
          nameTokens.slice(0, 2).map((token) => `in:sent to:${domain} "${token}"`)
        )
      ]
    )
  );

  const seen = new Set<string>();
  const messages: gmail_v1.Schema$Message[] = [];

  for (const query of queries) {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 25
    });

    for (const message of response.data.messages ?? []) {
      if (!message.id || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }

  return messages;
}

async function findEmailForRow(gmail: gmail_v1.Gmail, row: CsvRow): Promise<MatchResult> {
  const name = row["Name"] ?? "";
  const company = row["Company"] ?? "";
  const companyLinkedInPage = row["Company LinkedIn Page"] ?? "";

  if (!name || !company) {
    return { email: "", confidence: "none", note: "missing name/company", score: 0 };
  }

  const messageRefs = await listCompanySentMessages(gmail, company, companyLinkedInPage, name);
  if (messageRefs.length === 0) {
    return { email: "", confidence: "none", note: "no sent messages found for company", score: 0 };
  }

  const candidates: Array<MatchResult> = [];

  for (const ref of messageRefs) {
    const message = await gmail.users.messages.get({
      userId: "me",
      id: ref.id ?? "",
      format: "full",
      metadataHeaders: ["To", "Subject"]
    });

    const headers = message.data.payload?.headers;
    const toHeader = getHeader(headers, "To");
    const subject = getHeader(headers, "Subject");
    const bodyText = extractPlainText(message.data.payload) || message.data.snippet || "";
    const recipients = parseToHeader(toHeader);

    for (const recipient of recipients) {
      const scored = scoreRecipient(
        name,
        company,
        companyLinkedInPage,
        recipient.email,
        recipient.displayName,
        subject,
        bodyText
      );
      candidates.push({
        email: recipient.email,
        score: scored.score,
        note: scored.note,
        confidence: "none"
      });
    }
  }

  if (candidates.length === 0) {
    return { email: "", confidence: "none", note: "no recipient emails found in sent messages", score: 0 };
  }

  candidates.sort((left, right) => right.score - left.score);
  const best = candidates[0];

  if (best.score >= 70) {
    return { ...best, confidence: "exact", note: `exact match | ${best.note}` };
  }
  if (best.score >= 45) {
    return { ...best, confidence: "likely", note: `likely match | ${best.note}` };
  }
  if (best.score >= 20) {
    return { ...best, confidence: "maybe", note: `maybe closest match | ${best.note}` };
  }

  return { email: "", confidence: "none", note: "no confident match found", score: best.score };
}

async function main() {
  const csvArg = getArg("csv");
  if (!csvArg) {
    throw new Error("Missing --csv=<path> argument.");
  }
  const force = hasFlag("force");
  const fromRange = getPositiveIntArg("fromRange");
  const toRange = getPositiveIntArg("toRange");
  if ((fromRange && !toRange) || (!fromRange && toRange)) {
    throw new Error("Provide both --fromRange and --toRange together.");
  }
  if (fromRange && toRange && fromRange > toRange) {
    throw new Error(`Invalid range: fromRange (${fromRange}) cannot be greater than toRange (${toRange}).`);
  }

  const inputPath = path.resolve(csvArg);
  const outputArg = getArg("out");
  const outputPath =
    outputArg ? path.resolve(outputArg) : inputPath.replace(/\.csv$/i, ".enriched.csv");

  const rows = readTabular(inputPath);
  if (rows.length === 0) {
    throw new Error(`No rows found in ${inputPath}`);
  }

  const rangeStart = fromRange ? fromRange - 1 : 0;
  const rangeEnd = toRange ? Math.min(toRange - 1, rows.length - 1) : rows.length - 1;
  if (rangeStart >= rows.length) {
    throw new Error(`fromRange ${fromRange} is beyond the number of rows in the CSV (${rows.length}).`);
  }

  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: "v1", auth: auth as any });

  const enrichedRows: CsvRow[] = rows.map((row) => ({ ...row }));
  for (let index = rangeStart; index <= rangeEnd; index += 1) {
    const row = rows[index];
    const existingEmail = (row["Email"] ?? "").trim();
    if (existingEmail && !force) {
      enrichedRows[index] = {
        ...row,
        MatchConfidence: "existing",
        MatchNote: "email already present"
      };
      continue;
    }

    console.log(`[${index + 1}/${rows.length}] ${row["Name"] ?? ""} @ ${row["Company"] ?? ""}`);
    const match = await findEmailForRow(gmail, row);
    enrichedRows[index] = {
      ...row,
      Email: match.email,
      MatchConfidence: match.confidence,
      MatchNote: match.note
    };
    console.log(` -> ${match.confidence}${match.email ? ` | ${match.email}` : ""}`);
  }

  const headers = Array.from(
    new Set([
      ...Object.keys(rows[0] ?? {}),
      "Email",
      "MatchConfidence",
      "MatchNote"
    ])
  );

  if (/\.xlsx$/i.test(inputPath) && /\.xlsx$/i.test(outputPath) && inputPath !== outputPath && !fs.existsSync(outputPath)) {
    fs.copyFileSync(inputPath, outputPath);
  }

  writeTabular(outputPath, enrichedRows, headers);
  console.log(`Wrote enriched file to ${outputPath}`);
}

main().catch((error) => {
  console.error("enrichLinkedInCsvEmails failed:", error);
  process.exit(1);
});
