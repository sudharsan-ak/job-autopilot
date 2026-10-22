import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const greenhouseAdapter: AtsAdapter = {
  kind: "GREENHOUSE",
  score: (signals) =>
    includesAny(signals.url, ["greenhouse.io", "greenhouse.com"]) ? 100 : includesAny([...signals.formActions, ...signals.scriptSources].join(" "), ["greenhouse"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')"],
    finalSelectors: ["button[type=submit]:has-text('Submit')", "input[type=submit][value*='Submit' i]"],
  },
};
