import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const ashbyAdapter: AtsAdapter = {
  kind: "ASHBY",
  score: (signals) => includesAny(signals.url, ["ashbyhq.com"]) ? 100 : includesAny(signals.bodyText, ["powered by ashby"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit Application')", "button:has-text('Submit Application')"],
  },
};
