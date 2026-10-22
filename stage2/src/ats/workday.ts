import type { AtsAdapter } from "./types.js";
import { includesAny } from "./types.js";

export const workdayAdapter: AtsAdapter = {
  kind: "WORKDAY",
  score: (signals) => includesAny(signals.url, ["myworkdayjobs.com", "workday.com"]) ? 100 : includesAny(signals.scriptSources.join(" "), ["workday"]) ? 80 : 0,
  navigationHints: {
    safeNextSelectors: [
      "button[data-automation-id='bottom-navigation-next-button']",
      "button[data-automation-id='pageFooterNextButton']",
      "button:has-text('Save and Continue')",
      "button:has-text('Next')",
    ],
    finalSelectors: [
      "button[data-automation-id='bottom-navigation-submit-button']",
      "button[data-automation-id='pageFooterSubmitButton']",
      "button:has-text('Submit')",
    ],
  },
};
