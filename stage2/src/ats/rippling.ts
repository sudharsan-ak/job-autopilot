import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const ripplingAdapter: AtsAdapter = {
  kind: "RIPPLING",
  score: (signals) => includesAny(signals.url, ["ats.rippling.com", "rippling.com/careers"]) ? 100 : includesAny(signals.scriptSources.join(" "), ["rippling"]) ? 75 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit')", "button:has-text('Submit Application')"],
  },
};
