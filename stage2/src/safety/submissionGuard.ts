import type { Page } from "playwright";
import type { NavigationDecision } from "../types.js";
import { decideNavigation, type NavigationHints } from "../forms/navigationGuard.js";

export async function guardedNavigationDecision(page: Page, hints: NavigationHints = {}): Promise<NavigationDecision> {
  return decideNavigation(page, hints);
}

export function assertSafeToAdvance(decision: NavigationDecision): asserts decision is NavigationDecision & { kind: "ADVANCE"; selector: string } {
  if (decision.kind !== "ADVANCE" || !decision.selector) {
    throw new Error(`Navigation blocked: ${decision.reason}`);
  }
}
