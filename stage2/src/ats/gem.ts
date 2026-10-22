import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const gemAdapter: AtsAdapter = {
  kind: "GEM",
  score: (signals) => includesAny(signals.url, ["gem.com/jobs", "jobs.gem.com"]) ? 100 : includesAny(signals.bodyText, ["powered by gem"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit')", "button:has-text('Submit Application')"],
  },
};
