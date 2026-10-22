import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const workableAdapter: AtsAdapter = {
  kind: "WORKABLE",
  score: (signals) => includesAny(signals.url, ["workable.com"]) ? 100 : includesAny(signals.bodyText, ["powered by workable"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit')", "button:has-text('Submit application')"],
  },
};
