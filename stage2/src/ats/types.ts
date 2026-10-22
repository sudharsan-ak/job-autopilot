import type { AtsKind } from "../types.js";
import type { NavigationHints } from "../forms/navigationGuard.js";

export interface AtsSignals {
  url: string;
  title: string;
  bodyText: string;
  formActions: string[];
  scriptSources: string[];
}

export interface AtsAdapter {
  kind: AtsKind;
  score(signals: AtsSignals): number;
  navigationHints: NavigationHints;
}

export function includesAny(value: string, terms: string[]): boolean {
  const normalized = value.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}
