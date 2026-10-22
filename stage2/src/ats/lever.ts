import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const leverAdapter: AtsAdapter = {
  kind: "LEVER",
  score: (signals) => includesAny(signals.url, ["jobs.lever.co", "lever.co"]) ? 100 : includesAny(signals.bodyText, ["powered by lever"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit')", "input[type=submit][value*='Submit' i]"],
  },
};
