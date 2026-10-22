import type { FieldDescriptor, FieldMatch } from "../types.js";
import { TAXONOMY, normalizeFieldText } from "./taxonomy.js";

const DIAL_CODE_OPTION = /\+\d{1,4}\s*$/;

function looksLikePhoneCountryCode(field: FieldDescriptor): boolean {
  if (field.options.length === 0) return false;
  const withDialCode = field.options.filter((option) => DIAL_CODE_OPTION.test(option.trim()));
  return withDialCode.length / field.options.length >= 0.6;
}

export function matchField(field: FieldDescriptor): FieldMatch {
  const autocomplete = normalizeFieldText(field.autocomplete ?? "");
  const primary = [field.label, field.ariaLabel].map((value) => normalizeFieldText(value ?? "")).filter(Boolean);
  const identifiers = [field.name, field.id].map((value) => normalizeFieldText(value ?? "")).filter(Boolean);
  const context = normalizeFieldText(field.containerText ?? "");
  const sectionText = [field.section, field.containerText].filter(Boolean).join(" ");
  const phoneCountryCode = looksLikePhoneCountryCode(field);
  const matches: Array<{ key: string; score: number; evidence: string[]; threshold: number; sectionScope?: RegExp }> = [];

  for (const entry of TAXONOMY) {
    const evidence: string[] = [];
    let score = 0;
    if (autocomplete && entry.autocomplete?.includes(autocomplete)) {
      score = 1;
      evidence.push(`autocomplete=${autocomplete}`);
    }
    if (entry.key === "current_location_display" && /city[\s,]+region[\s,]+and country/.test(context)) {
      score = 1;
      evidence.push("location autocomplete helper text");
    }
    if (phoneCountryCode && entry.key === "phone_country_code") {
      score = 1;
      evidence.push("options are dial-code formatted");
    } else if (phoneCountryCode && entry.key === "physical_country") {
      continue;
    }
    if (primary.some((value) => entry.aliases.some((alias) => alias.test(value)))) {
      score = Math.max(score, 0.98);
      evidence.push(`label=${primary[0]}`);
    } else if (identifiers.some((value) => entry.aliases.some((alias) => alias.test(value)))) {
      score = Math.max(score, 0.96);
      evidence.push("name or id semantics");
    } else if (context && entry.aliases.some((alias) => alias.test(context))) {
      score = Math.max(score, 0.9);
      evidence.push("local DOM context");
    }
    if (score > 0) matches.push({ key: entry.key, score, evidence, threshold: entry.safeThreshold ?? 0.92, sectionScope: entry.sectionScope });
  }

  matches.sort((a, b) => b.score - a.score);
  let best = matches[0];
  let tied = matches.filter((candidate) => candidate.score === best?.score);

  if (tied.length > 1 && sectionText) {
    const inScope = tied.filter((candidate) => candidate.sectionScope?.test(sectionText));
    const resolved = inScope[0];
    if (inScope.length === 1 && resolved) {
      resolved.evidence.push(`section=${field.section ?? "context"}`);
      best = resolved;
      tied = [resolved];
    }
  }

  const conflicting = tied.length > 1 && tied.some((candidate) => candidate.key !== best?.key);
  if (!best || conflicting) {
    return {
      confidence: best?.score ?? 0,
      evidence: best?.evidence ?? [],
      reason: conflicting ? "Conflicting semantic matches." : "No deterministic taxonomy match.",
    };
  }
  return {
    profileKey: best.key,
    confidence: best.score,
    evidence: best.evidence,
    reason: best.score < best.threshold ? `Confidence is below ${best.threshold}.` : undefined,
  };
}

export function isSafeMatch(match: FieldMatch): boolean {
  if (!match.profileKey || match.reason) return false;
  const entry = TAXONOMY.find((candidate) => candidate.key === match.profileKey);
  return match.confidence >= (entry?.safeThreshold ?? 0.92);
}
