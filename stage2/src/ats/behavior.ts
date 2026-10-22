import type { AtsKind } from "../types.js";

export interface AtsBehavior {
  fieldContainerSelectors: string[];
  optionSelectors: string[];
  selectedValueSelectors: string[];
  uploadSuccessSelectors: string[];
  optionTimeoutMs: number;
  commitTimeoutMs: number;
  uploadTimeoutMs: number;
  maxVirtualScrolls: number;
}

const COMMON: AtsBehavior = {
  fieldContainerSelectors: [
    "fieldset",
    "[role='radiogroup']",
    "[role='group']",
    ".application-question",
    ".form-field",
    ".field",
    "[class*='form-group']",
    "[class*='formGroup']",
    "[class*='field-group']",
    "[class*='input-group']",
    "[class*='question']",
    "[data-testid*='field']",
    "[data-qa*='field']",
  ],
  optionSelectors: [
    "[role='option']",
    "option",
    "[class*='option']",
    "li[class*='item']",
  ],
  selectedValueSelectors: [
    "[aria-selected='true']",
    "[aria-checked='true']",
    "[class*='single-value']",
    "[class*='singleValue']",
    "[class*='multi-value__label']",
    "[class*='multiValue']",
    "[class*='selected-value']",
    "[class*='selectedValue']",
  ],
  uploadSuccessSelectors: [
    "[class*='file-name']",
    "[class*='fileName']",
    "[class*='uploaded']",
    "[class*='attachment']",
  ],
  optionTimeoutMs: 3_000,
  commitTimeoutMs: 2_500,
  uploadTimeoutMs: 10_000,
  maxVirtualScrolls: 16,
};

const ATS_BEHAVIORS: Partial<Record<AtsKind, Partial<AtsBehavior>>> = {
  GREENHOUSE: {
    fieldContainerSelectors: [
      "[class*='select__container']",
      "[class*='field']",
      ".application-question",
      "fieldset",
    ],
    optionSelectors: ["[role='option']", "[class*='select__option']", "option"],
    selectedValueSelectors: [
      "[class*='select__single-value']",
      "[class*='select__multi-value__label']",
      "[aria-selected='true']",
      "[aria-checked='true']",
    ],
    optionTimeoutMs: 4_000,
    commitTimeoutMs: 3_000,
  },
  ASHBY: {
    fieldContainerSelectors: ["[class*='fieldEntry']", "[class*='field']", "fieldset", "[role='group']"],
    optionSelectors: ["[role='option']", "[role='menuitem']", "option"],
    uploadSuccessSelectors: ["[data-testid*='file']", "[class*='file']"],
  },
  LEVER: {
    fieldContainerSelectors: [".application-question", "[class*='application-question']", "fieldset", ".field"],
    uploadSuccessSelectors: ["[class*='resume']", "[class*='file']"],
    optionTimeoutMs: 4_000,
  },
  WORKABLE: {
    fieldContainerSelectors: ["[data-ui]", "fieldset", "[role='radiogroup']", "[role='group']", ".form-field"],
    uploadSuccessSelectors: ["[data-ui*='resume']", "[data-ui*='file']", "[class*='file']"],
    optionTimeoutMs: 5_000,
    commitTimeoutMs: 3_000,
  },
  WORKDAY: {
    fieldContainerSelectors: [
      "[data-automation-id*='formField']",
      "[data-automation-id*='resumeUpload']",
      "[data-automation-id*='FormField']",
      "fieldset",
    ],
    optionSelectors: ["[role='option']", "[data-automation-label]", "option"],
    selectedValueSelectors: [
      "[data-automation-id*='selectedItem']",
      "[data-automation-id*='promptOption'][aria-checked='true']",
      "[aria-selected='true']",
      "[aria-checked='true']",
    ],
    uploadSuccessSelectors: [
      "[data-automation-id='file-upload-item']",
      "[data-automation-id='file-upload-successful']",
      "[data-automation-id='delete-file']",
    ],
    optionTimeoutMs: 5_000,
    commitTimeoutMs: 4_000,
    uploadTimeoutMs: 12_000,
  },
  RIPPLING: {
    fieldContainerSelectors: ["[data-testid*='field']", "[data-testid*='input']", "fieldset", "[role='group']"],
    optionSelectors: ["[role='option']", "[role='menuitem']", "option"],
    uploadSuccessSelectors: ["[data-testid*='upload']", "[data-testid*='file']", "[class*='file']"],
  },
};

export function getAtsBehavior(ats?: AtsKind): AtsBehavior {
  const override = ats ? ATS_BEHAVIORS[ats] : undefined;
  return {
    ...COMMON,
    ...override,
    fieldContainerSelectors: override?.fieldContainerSelectors ?? COMMON.fieldContainerSelectors,
    optionSelectors: override?.optionSelectors ?? COMMON.optionSelectors,
    selectedValueSelectors: override?.selectedValueSelectors ?? COMMON.selectedValueSelectors,
    uploadSuccessSelectors: override?.uploadSuccessSelectors ?? COMMON.uploadSuccessSelectors,
  };
}
