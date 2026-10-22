import type { Frame, Page } from "playwright";
import type { NavigationDecision } from "../types.js";

export interface NavigationHints {
  safeNextSelectors?: string[];
  finalSelectors?: string[];
}

const FINAL_TEXT = /^(submit\b.*|apply( now)?|finish\b.*|complete\b.*|send\b.*|final review|review( application)?|review.*submit.*)$/i;
const NEXT_TEXT = /^(next|continue|save and continue|continue application|next step)$/i;

interface Candidate {
  selector: string;
  frameUrl: string;
  frameIndex: number;
  text: string;
  type: string;
  insideForm: boolean;
  disabled: boolean;
}

async function validationBlocker(frame: Frame): Promise<string | undefined> {
  return frame.evaluate(() => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const captcha = document.querySelector(
      "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, .h-captcha, [data-sitekey], [class*='captcha']",
    );
    if (captcha && visible(captcha)) return "A visible CAPTCHA requires human completion.";
    const required = Array.from(document.querySelectorAll<HTMLElement>("[required], [aria-required='true']"));
    for (const element of required) {
      if (!visible(element) && !element.matches("input[type='radio'],input[type='checkbox']")) continue;
      if (element.getAttribute("aria-disabled") === "true" || (element as HTMLInputElement).disabled) continue;
      if (element.matches("input[type='radio']")) {
        const input = element as HTMLInputElement;
        const radios = input.name
          ? Array.from(document.querySelectorAll<HTMLInputElement>(`input[type='radio'][name="${CSS.escape(input.name)}"]`))
          : [input];
        if (!radios.some((radio) => radio.checked)) return "A required radio group is unanswered.";
        continue;
      }
      if (element.getAttribute("role") === "radiogroup") {
        if (!element.querySelector("[role='radio'][aria-checked='true']")) return "A required radio group is unanswered.";
        continue;
      }
      if (element.matches("input[type='checkbox']") || ["checkbox", "switch"].includes(element.getAttribute("role") ?? "")) {
        const checked = element instanceof HTMLInputElement ? element.checked : element.getAttribute("aria-checked") === "true";
        if (!checked) return "A required checkbox is unanswered.";
        continue;
      }
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const value = "value" in input ? String(input.value ?? "").trim() : "";
      const selected = element.getAttribute("aria-valuetext")
        || element.querySelector("[aria-selected='true'],[class*='single-value'],[class*='singleValue']")?.textContent?.trim();
      if (!value && !selected) return "A required field is empty.";
    }
    return undefined;
  }).catch(() => undefined);
}

async function visibleCandidates(frame: Frame, frameIndex: number): Promise<Candidate[]> {
  const candidates = await frame.evaluate(() => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const deepQueryAll = <T extends Element>(root: Document | ShadowRoot, selector: string): T[] => {
      const found: T[] = [];
      for (const element of Array.from(root.querySelectorAll<T>(selector))) found.push(element);
      for (const host of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (host.shadowRoot) found.push(...deepQueryAll<T>(host.shadowRoot, selector));
      }
      return found;
    };
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    return deepQueryAll<HTMLElement>(document, "button, input[type=submit], input[type=button], a[role=button]")
      .filter(visible)
      .map((element, index) => {
        const marker = `nav-${index}`;
        element.setAttribute("data-job-autopilot-nav", marker);
        const input = element as HTMLInputElement;
        return {
          selector: `[data-job-autopilot-nav="${marker}"]`,
          text: normalize(element.getAttribute("aria-label") || input.value || element.textContent),
          type: normalize(element.getAttribute("type")).toLowerCase(),
          insideForm: Boolean(element.closest("form")),
          disabled: input.disabled || element.getAttribute("aria-disabled") === "true",
        };
      });
  });
  return candidates.map((candidate) => ({ ...candidate, frameUrl: frame.url(), frameIndex }));
}

export async function decideNavigation(page: Page, hints: NavigationHints = {}): Promise<NavigationDecision> {
  for (const [frameIndex, frame] of page.frames().entries()) {
    for (const selector of hints.finalSelectors ?? []) {
      if (await frame.locator(selector).first().isVisible().catch(() => false)) {
        return { kind: "FINAL_BOUNDARY", selector, frameUrl: frame.url(), frameIndex, reason: "ATS adapter identified a final action." };
      }
    }
  }

  const candidates = (await Promise.all(page.frames().map((frame, index) => visibleCandidates(frame, index)))).flat().filter((candidate) => !candidate.disabled);
  const final = candidates.find((candidate) => FINAL_TEXT.test(candidate.text) || (candidate.type === "submit" && !NEXT_TEXT.test(candidate.text)));
  if (final) return { kind: "FINAL_BOUNDARY", selector: final.selector, frameUrl: final.frameUrl, frameIndex: final.frameIndex, reason: `Final action detected: ${final.text || final.type}.` };

  for (const frame of page.frames()) {
    const blocker = await validationBlocker(frame);
    if (blocker) return { kind: "BLOCKED", frameUrl: frame.url(), reason: blocker };
  }

  for (const [frameIndex, frame] of page.frames().entries()) {
    for (const selector of hints.safeNextSelectors ?? []) {
      if (await frame.locator(selector).first().isVisible().catch(() => false)) {
        return { kind: "ADVANCE", selector, frameUrl: frame.url(), frameIndex, reason: "ATS adapter identified a safe step transition." };
      }
    }
  }
  const next = candidates.find((candidate) => NEXT_TEXT.test(candidate.text));
  if (next) return { kind: "ADVANCE", selector: next.selector, frameUrl: next.frameUrl, frameIndex: next.frameIndex, reason: `Safe transition detected: ${next.text}.` };
  return { kind: "WAIT", reason: "Neither a final boundary nor a provably safe transition was found." };
}
