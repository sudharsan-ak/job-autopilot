import type { AtsAdapter } from "./types.js";

export const genericAdapter: AtsAdapter = {
  kind: "GENERIC",
  score: () => 1,
  navigationHints: {
    safeNextSelectors: ["button:has-text('Next')", "button:has-text('Continue')", "button:has-text('Save and Continue')"],
    finalSelectors: [
      "button[type=submit]:has-text('Submit')",
      "input[type=submit][value*='Submit' i]",
      "button:has-text('Submit Application')",
    ],
  },
};
