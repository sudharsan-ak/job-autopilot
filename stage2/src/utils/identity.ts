import { createHash } from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalizeUrl(raw?: string): string | undefined {
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return undefined;
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    const removable = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "ref",
      "source",
    ];
    for (const key of removable) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeNavigableUrl(raw?: string): string | undefined {
  if (!raw || !/^https?:\/\//i.test(raw.trim())) return undefined;
  try {
    const url = new URL(raw.trim());
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function createJobKey(company: string, title: string, url?: string): string {
  return sha256(
    [normalizeText(company).toLowerCase(), normalizeText(title).toLowerCase(), canonicalizeUrl(url) ?? ""]
      .join("|")
      .normalize("NFKC"),
  );
}
