import type { Frame, Page } from "playwright";
import type { AtsKind, ControlType, WidgetKind } from "../types.js";
import { sha256 } from "../utils/identity.js";

export type FormGroupKind =
  | "personal"
  | "documents"
  | "employment"
  | "education"
  | "work_authorization"
  | "demographic"
  | "consent"
  | "custom";

export interface InspectedField {
  stableId: string;
  frameIndex: number;
  frameUrl: string;
  label: string;
  section?: string;
  groupKind: FormGroupKind;
  groupIndex: number;
  semanticRole: string;
  controlType: ControlType;
  widgetKind: WidgetKind;
  required: boolean;
  visible: boolean;
  currentValue?: string | boolean;
  options: string[];
  anchors: Record<string, string>;
  labelEvidence: string[];
  anchorStrength: "strong" | "medium" | "weak";
  semanticKey: string;
  warnings: string[];
}

export interface FormInspectionOptions {
  discoverOptions?: boolean;
  desiredEmploymentRecords?: number;
  desiredEducationRecords?: number;
}

interface RawInspectedField extends Omit<InspectedField, "stableId" | "semanticKey" | "warnings"> {
  interactionId: string;
  localOccurrence: number;
}

interface RepeaterDiagnostics {
  employmentBefore: number;
  employmentAfter: number;
  employmentAdded: number;
  educationBefore: number;
  educationAfter: number;
  educationAdded: number;
}

function normalize(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

function semanticKey(field: RawInspectedField): string {
  const strongestAnchor = field.anchors.id
    ?? field.anchors.name
    ?? field.anchors.dataAutomationId
    ?? field.anchors.dataUi
    ?? field.anchors.dataTestId
    ?? field.anchors.ariaLabelledby
    ?? field.anchors.ariaLabel
    ?? "";
  return [
    field.frameIndex,
    normalize(field.section),
    field.groupKind,
    field.groupIndex,
    field.semanticRole,
    field.controlType,
    normalize(field.label),
    normalize(strongestAnchor),
    field.localOccurrence,
  ].join("|");
}

async function countRepeaterRecords(page: Page, kind: "employment" | "education"): Promise<number> {
  return page.evaluate((recordKind) => {
    const controls = Array.from(document.querySelectorAll<HTMLElement>("input,textarea,select,[role='combobox']"));
    const pattern = recordKind === "employment"
      ? /(?:employment|experience|work(?:_|-)?history|jobs?)[_\[\]-]*(\d+)/i
      : /(?:education|schools?)[_\[\]-]*(\d+)/i;
    const indexes = new Set<string>();
    for (const control of controls) {
      const identity = `${control.id} ${(control as HTMLInputElement).name ?? ""}`;
      const match = identity.match(pattern);
      if (match?.[1]) indexes.add(match[1]);
    }
    if (indexes.size > 0) return indexes.size;

    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const labels = Array.from(document.querySelectorAll("label,legend"))
      .map((element) => clean(element.textContent).replace(/\*+$/, "").trim());
    const recordLabel = recordKind === "employment"
      ? /^(company name|company|employer)$/i
      : /^(school|school name|university|institution|institution name)$/i;
    return labels.filter((label) => recordLabel.test(label)).length;
  }, kind);
}

async function findRepeaterButton(page: Page, kind: "employment" | "education") {
  const buttons = page.locator("button");
  const count = await buttons.count();
  let best: { index: number; score: number } | undefined;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const score = await button.evaluate((element, recordKind) => {
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const text = clean([
        element.textContent,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
      ].filter(Boolean).join(" "));
      let ancestor: Element | null = element.parentElement;
      let context = "";
      for (let depth = 0; ancestor && depth < 8; depth += 1, ancestor = ancestor.parentElement) {
        context += ` ${clean(ancestor.querySelector("h1,h2,h3,h4,legend,[role='heading']")?.textContent)}`;
      }
      const buttonTop = element.getBoundingClientRect().top;
      const precedingLabels = Array.from(document.querySelectorAll("label,legend"))
        .map((label) => ({ text: clean(label.textContent), distance: buttonTop - label.getBoundingClientRect().top }))
        .filter((candidate) => candidate.distance >= 0)
        .sort((left, right) => left.distance - right.distance)
        .slice(0, 8)
        .map((candidate) => candidate.text)
        .join(" ");
      const kindWords = recordKind === "employment" ? /employment|work experience/ : /education|school/;
      const fieldWords = recordKind === "employment"
        ? /company name|job title|start date|end date|current role/
        : /school|university|degree|discipline|field of study/;
      let value = 0;
      if (/add|another/.test(text)) value += 2;
      if (kindWords.test(text)) value += 6;
      if (kindWords.test(context)) value += 4;
      if (fieldWords.test(precedingLabels)) value += 4;
      if (/submit|apply|delete|remove|clear/.test(text)) value = -100;
      return value;
    }, kind);
    if (score > (best?.score ?? 0)) best = { index, score };
  }
  return best && best.score >= 4 ? buttons.nth(best.index) : undefined;
}

async function expandRepeaters(
  page: Page,
  ats: AtsKind,
  desiredEmployment: number,
  desiredEducation: number,
): Promise<RepeaterDiagnostics> {
  const employmentBefore = await countRepeaterRecords(page, "employment");
  const educationBefore = await countRepeaterRecords(page, "education");
  let employmentAdded = 0;
  let educationAdded = 0;

  if (ats === "GREENHOUSE") {
    for (const [kind, desired] of [["employment", desiredEmployment], ["education", desiredEducation]] as const) {
      let existing = kind === "employment" ? employmentBefore : educationBefore;
      while (existing > 0 && existing < desired) {
        const button = await findRepeaterButton(page, kind);
        if (!button) break;
        await button.click({ timeout: 2_000 });
        await page.waitForTimeout(120);
        const updated = await countRepeaterRecords(page, kind);
        if (updated <= existing) break;
        if (kind === "employment") employmentAdded += updated - existing;
        else educationAdded += updated - existing;
        existing = updated;
      }
    }
  }

  return {
    employmentBefore,
    employmentAfter: await countRepeaterRecords(page, "employment"),
    employmentAdded,
    educationBefore,
    educationAfter: await countRepeaterRecords(page, "education"),
    educationAdded,
  };
}

async function inspectFrame(frame: Frame, frameIndex: number, ats: AtsKind): Promise<RawInspectedField[]> {
  return frame.evaluate(({ index, atsKind }) => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const normalized = (value: string | null | undefined) => clean(value).normalize("NFKC").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
    const visible = (element: Element | null | undefined) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const deepQueryAll = <T extends Element>(root: Document | ShadowRoot, selector: string): T[] => {
      const result = Array.from(root.querySelectorAll<T>(selector));
      for (const host of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
        if (host.shadowRoot) result.push(...deepQueryAll<T>(host.shadowRoot, selector));
      }
      return result;
    };
    const rootById = (element: Element, id: string): Element | null => {
      const root = element.getRootNode() as Document | ShadowRoot;
      return root.querySelector(`#${CSS.escape(id)}`) ?? document.getElementById(id);
    };
    const byIds = (element: Element, attribute: string) => clean(element.getAttribute(attribute)).split(/\s+/).filter(Boolean)
      .map((id) => clean(rootById(element, id)?.textContent)).filter(Boolean).join(" ");
    const fieldContainer = (element: Element) => element.closest(
      "fieldset,[role='group'],[role='radiogroup'],.application-question,.form-field,.field,[data-automation-id*='formField'],[data-testid*='field'],[data-ui*='field'],[class*='field']",
    ) ?? element.parentElement ?? element;
    const labelEvidenceFor = (element: HTMLElement, container = fieldContainer(element)) => {
      const input = element as HTMLInputElement;
      return [...new Set([
        ...(input.labels ? Array.from(input.labels).map((label) => clean(label.textContent)) : []),
        byIds(element, "aria-labelledby"),
        clean(element.getAttribute("aria-label")),
        clean(container.querySelector(":scope > legend")?.textContent),
        clean(container.querySelector(":scope > label")?.textContent),
        clean(element.closest("label")?.textContent),
        clean(element.getAttribute("placeholder")),
        clean(element.getAttribute("data-automation-id")),
        clean(element.getAttribute("data-testid")),
        clean(input.autocomplete),
        clean(input.name),
        clean(input.id),
      ].filter(Boolean))];
    };
    const sectionFor = (element: Element) => {
      let current: Element | null = element;
      while (current && current !== document.body) {
        const heading = current.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend,:scope > [role='heading']");
        const text = clean(heading?.textContent);
        if (text) return text;
        current = current.parentElement;
      }
      return undefined;
    };
    const anchorsFor = (element: HTMLElement): Record<string, string> => Object.fromEntries(Object.entries({
      id: element.id,
      name: (element as HTMLInputElement).name,
      dataAutomationId: element.getAttribute("data-automation-id"),
      dataUi: element.getAttribute("data-ui"),
      dataTestId: element.getAttribute("data-testid"),
      ariaLabelledby: element.getAttribute("aria-labelledby"),
      ariaDescribedby: element.getAttribute("aria-describedby"),
      ariaLabel: element.getAttribute("aria-label"),
      autocomplete: (element as HTMLInputElement).autocomplete,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])));
    const repeatHintFor = (anchors: Record<string, string>): { kind: "employment" | "education"; index: number; role: string } | undefined => {
      if (atsKind !== "GREENHOUSE") return undefined;
      const candidates = [anchors.id, anchors.name];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const employment = candidate.match(/^(company-name|title|start-date-month|start-date-year|end-date-month|end-date-year|current-role)-(\d+)(?:_|$)/i);
        if (employment) {
          const roles: Record<string, string> = {
            "company-name": "employment.company",
            title: "employment.title",
            "start-date-month": "employment.start_month",
            "start-date-year": "employment.start_year",
            "end-date-month": "employment.end_month",
            "end-date-year": "employment.end_year",
            "current-role": "employment.current",
          };
          return { kind: "employment", index: Number(employment[2]), role: roles[employment[1]!.toLowerCase()]! };
        }
        const education = candidate.match(/^(school|degree|discipline)--?(\d+)(?:_|$)/i);
        if (education) {
          const roles: Record<string, string> = {
            school: "education.school",
            degree: "education.degree",
            discipline: "education.discipline",
          };
          return { kind: "education", index: Number(education[2]), role: roles[education[1]!.toLowerCase()]! };
        }
      }
      return undefined;
    };
    const semanticRoleFor = (label: string, section: string | undefined, anchors: Record<string, string>): string => {
      const labelText = normalized(label);
      const anchorText = normalized(Object.values(anchors).join(" "));
      const all = normalized(`${section ?? ""} ${label} ${Object.values(anchors).join(" ")}`);
      if (/preferred.*(?:first )?name/.test(all)) return "preferred_name";
      if (/first name|given name|fname/.test(anchorText) || /^(first name|given name)$/.test(labelText)) return "first_name";
      if (/last name|family name|surname|lname/.test(anchorText) || /^(last name|family name|surname)$/.test(labelText)) return "last_name";
      if (/linkedin/.test(all)) return "linkedin_url";
      if (/e mail|email/.test(labelText) || /e mail|email/.test(anchorText)) return "email";
      if (/sponsor|visa status|immigration support/.test(all)) return "work_authorization.sponsorship";
      if (/authorized to work|legally authorized|work authorization/.test(all)) return "work_authorization.authorized";
      if (/at least 18|18 years of age/.test(all)) return "age_requirement";
      if (/hispanic|latino/.test(all)) return "demographic.hispanic_latino";
      if (/(^| )race( |$)|ethnic/.test(all)) return "demographic.race";
      if (/(^| )gender( |$)/.test(all)) return "demographic.gender";
      if (/veteran/.test(all)) return "demographic.veteran";
      if (/disability/.test(all)) return "demographic.disability";
      if (/(^| )country( |$)/.test(labelText) || /(^| )country( |$)/.test(anchorText)) return "country";
      if (/(^| )(phone|telephone|mobile)( |$)/.test(labelText) || /(^| )(phone|telephone|mobile)( |$)/.test(anchorText)) return "phone";
      if (/(^| )(location|city|address)( |$)/.test(labelText) || /(^| )(location|city|address)( |$)/.test(anchorText)) return "location";
      if (/cover letter/.test(all)) return "cover_letter";
      if (/resume|curriculum vitae|\bcv\b/.test(all)) return "resume";
      const employmentContext = /employment/.test(anchorText) || /employment|work experience/.test(normalized(section));
      if ((employmentContext && /company|employer/.test(all)) || /^(company name|company|employer)$/.test(labelText) || /^company name \d+$/.test(anchorText)) return "employment.company";
      if ((employmentContext && /job title|position title|\btitle\b/.test(all)) || /^title$/.test(labelText) && /^title \d+$/.test(anchorText)) return "employment.title";
      if ((employmentContext || /^start date month \d+$/.test(anchorText)) && /start.*month|month.*start/.test(all)) return "employment.start_month";
      if ((employmentContext || /^start date year \d+$/.test(anchorText)) && /start.*year|year.*start/.test(all)) return "employment.start_year";
      if ((employmentContext || /^end date month \d+$/.test(anchorText)) && /end.*month|month.*end/.test(all)) return "employment.end_month";
      if ((employmentContext || /^end date year \d+$/.test(anchorText)) && /end.*year|year.*end/.test(all)) return "employment.end_year";
      if ((employmentContext || /^current role \d+/.test(anchorText)) && /current role/.test(all)) return "employment.current";
      const educationContext = /education|school/.test(anchorText) || /education/.test(normalized(section));
      if ((educationContext && /school|university|institution/.test(all)) || /^(school|school name|university|institution|institution name)$/.test(labelText)) return "education.school";
      if ((educationContext && /degree/.test(all)) || /^degree$/.test(labelText) && /^degree \d+$/.test(anchorText)) return "education.degree";
      if ((educationContext && /discipline|field of study|major/.test(all)) || /^(discipline|field of study|major)$/.test(labelText) && /^(discipline|field of study|major) \d+$/.test(anchorText)) return "education.discipline";
      if (educationContext) {
        if (/start.*month|month.*start/.test(all)) return "education.start_month";
        if (/start.*year|year.*start/.test(all)) return "education.start_year";
        if (/end.*month|month.*end|graduation.*month/.test(all)) return "education.end_month";
        if (/end.*year|year.*end|graduation.*year/.test(all)) return "education.end_year";
      }
      if (/privacy|arbitration|acknowledge|receipt of/.test(all)) return "consent.privacy";
      if (/artificial intelligence|ai tools|use ai/.test(all)) return "consent.ai";
      if (/how did you hear|source/.test(all)) return "source";
      return "custom";
    };
    const groupKindFor = (role: string): FormGroupKind => {
      if (role.startsWith("employment.")) return "employment";
      if (role.startsWith("education.")) return "education";
      if (role.startsWith("demographic.")) return "demographic";
      if (role.startsWith("work_authorization.")) return "work_authorization";
      if (role.startsWith("consent.")) return "consent";
      if (["resume", "cover_letter"].includes(role)) return "documents";
      if (["first_name", "last_name", "preferred_name", "email", "phone", "country", "location", "linkedin_url"].includes(role)) return "personal";
      return "custom";
    };
    const controlTypeFor = (element: HTMLElement): ControlType => {
      const role = normalized(element.getAttribute("role"));
      if (role === "combobox" || element.getAttribute("aria-haspopup") === "listbox") return "combobox";
      if (["checkbox", "switch"].includes(role)) return "checkbox";
      if (role === "radio") return "radio";
      if (element.tagName === "TEXTAREA") return "textarea";
      if (element.tagName === "SELECT") return "select";
      const type = normalized(element.getAttribute("type") || "text");
      if (["email", "tel", "url", "date", "file", "radio", "checkbox"].includes(type)) return type as ControlType;
      if (["text", "number", "search", "password"].includes(type)) return "text";
      return "unknown";
    };
    const widgetKindFor = (element: HTMLElement, controlType: ControlType): WidgetKind => {
      const role = normalized(element.getAttribute("role"));
      if (controlType === "file") return "file-upload";
      if (["checkbox", "switch"].includes(role)) return "role-checkbox";
      if (role === "radio") return "role-radio-group";
      if (controlType === "radio") return "native-radio-group";
      if (controlType === "combobox") {
        const context = `${element.className || ""} ${fieldContainer(element).className || ""}`;
        return /react-select|select__/i.test(context) ? "react-select" : "aria-combobox";
      }
      return "native";
    };
    const anchorStrengthFor = (anchors: Record<string, string>): RawInspectedField["anchorStrength"] => {
      if (anchors.id || anchors.name || anchors.dataAutomationId || anchors.dataTestId) return "strong";
      if (anchors.dataUi || anchors.ariaLabelledby || anchors.ariaLabel || anchors.autocomplete) return "medium";
      return "weak";
    };
    const optionText = (element: HTMLElement) => clean(
      (element as HTMLInputElement).labels?.[0]?.textContent
      || byIds(element, "aria-labelledby")
      || element.getAttribute("aria-label")
      || element.textContent
      || (element as HTMLInputElement).value,
    );
    const nativeControls = deepQueryAll<HTMLElement>(document,
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='image']):not([type='reset']),textarea,select,[role='combobox'],[aria-haspopup='listbox'],[role='checkbox'],[role='switch']",
    ).filter((element, position, all) => all.indexOf(element) === position)
      .filter((element) => !((element.getAttribute("role") === "combobox" || element.getAttribute("aria-haspopup") === "listbox") && element.querySelector("input,textarea,select")));
    const groupRoots = new Map<Element, number>();
    const groupCounters = new Map<FormGroupKind, number>();
    const occurrences = new Map<string, number>();
    const handledRadios = new Set<HTMLInputElement>();
    const result: RawInspectedField[] = [];
    let interactionCounter = 0;
    const add = (element: HTMLElement, overrides: Partial<RawInspectedField> = {}) => {
      const container = fieldContainer(element);
      const controlType = overrides.controlType ?? controlTypeFor(element);
      const anchors = overrides.anchors ?? anchorsFor(element);
      const evidence = overrides.labelEvidence ?? labelEvidenceFor(element, container);
      let label = overrides.label ?? evidence[0] ?? "Unlabelled field";
      const section = overrides.section ?? sectionFor(element);
      const repeatHint = repeatHintFor(anchors);
      const semanticRole = overrides.semanticRole ?? repeatHint?.role ?? semanticRoleFor(label, section, anchors);
      if (controlType === "file" && ["resume", "cover_letter"].includes(semanticRole)) {
        label = semanticRole === "resume" ? "Resume/CV" : "Cover Letter";
      }
      const groupKind = overrides.groupKind ?? repeatHint?.kind ?? groupKindFor(semanticRole);
      const identity = `${anchors.id ?? ""} ${anchors.name ?? ""} ${anchors.dataAutomationId ?? ""}`;
      const indexed = groupKind === "employment"
        ? identity.match(/(?:employment|experience|work(?:_|-)?history|jobs?)[_\[\]-]*(\d+)/i)
        : groupKind === "education"
          ? identity.match(/(?:education|schools?)[_\[\]-]*(\d+)/i)
          : undefined;
      const numbered = ["employment", "education"].includes(groupKind)
        ? identity.match(/(?:^|[-_\[])(\d+)(?:[-_\]]|$)/)
        : undefined;
      const groupRoot = groupKind === "employment"
        ? element.closest("[data-testid*='employment'],[class*='employment'],[class*='experience'],section,fieldset") ?? container
        : groupKind === "education"
          ? element.closest("[data-testid*='education'],[class*='education'],section,fieldset") ?? container
          : container;
      if (!groupRoots.has(groupRoot)) {
        groupRoots.set(groupRoot, groupCounters.get(groupKind) ?? 0);
        groupCounters.set(groupKind, (groupCounters.get(groupKind) ?? 0) + 1);
      }
      const groupIndex = overrides.groupIndex ?? (repeatHint
        ? repeatHint.index
        : indexed?.[1]
        ? Number(indexed[1])
        : numbered?.[1]
          ? Number(numbered[1])
          : groupRoots.get(groupRoot) ?? 0);
      const occurrenceKey = `${normalized(section)}|${groupKind}|${groupIndex}|${semanticRole}|${controlType}|${normalized(label)}|${normalized(anchors.name || anchors.id)}`;
      const localOccurrence = occurrences.get(occurrenceKey) ?? 0;
      occurrences.set(occurrenceKey, localOccurrence + 1);
      const interactionId = `s2-inspect-${index}-${interactionCounter++}`;
      element.setAttribute("data-stage2-inspection-id", interactionId);
      result.push({
        frameIndex: index,
        frameUrl: location.href,
        label,
        section,
        groupKind,
        groupIndex,
        semanticRole,
        controlType,
        widgetKind: overrides.widgetKind ?? widgetKindFor(element, controlType),
        required: overrides.required ?? ((element as HTMLInputElement).required || element.getAttribute("aria-required") === "true"),
        visible: overrides.visible ?? visible(element),
        currentValue: overrides.currentValue,
        options: overrides.options ?? [],
        anchors,
        labelEvidence: evidence,
        anchorStrength: overrides.anchorStrength ?? anchorStrengthFor(anchors),
        interactionId,
        localOccurrence,
      });
    };

    for (const element of nativeControls) {
      const type = controlTypeFor(element);
      const input = element as HTMLInputElement;
      const labelVisible = Boolean(input.labels && Array.from(input.labels).some((label) => visible(label)));
      if (!visible(element) && type !== "file" && !(["radio", "checkbox"].includes(type) && labelVisible)) continue;
      if (type === "radio" && input.name) {
        if (handledRadios.has(input)) continue;
        const radios = nativeControls.filter((candidate) => {
          const radio = candidate as HTMLInputElement;
          return radio.type === "radio" && radio.name === input.name;
        }) as HTMLInputElement[];
        radios.forEach((radio) => handledRadios.add(radio));
        const container = fieldContainer(input);
        const checked = radios.find((radio) => radio.checked);
        add(input, {
          label: labelEvidenceFor(input, container)[0] ?? "Unlabelled field",
          widgetKind: "native-radio-group",
          required: radios.some((radio) => radio.required || radio.getAttribute("aria-required") === "true"),
          visible: radios.some((radio) => visible(radio) || Boolean(radio.labels && Array.from(radio.labels).some((label) => visible(label)))),
          currentValue: checked ? optionText(checked) : undefined,
          options: radios.map(optionText).filter(Boolean),
        });
        continue;
      }
      const select = element as HTMLSelectElement;
      const roleChecked = element.getAttribute("aria-checked");
      const currentValue = type === "checkbox"
        ? (roleChecked === null ? input.checked : roleChecked === "true")
        : type === "select"
          ? clean(select.selectedOptions[0]?.textContent || select.value)
          : type === "file"
            ? input.files?.[0]?.name
            : clean(input.value || element.getAttribute("aria-valuetext"));
      add(element, {
        currentValue,
        options: type === "select"
          ? Array.from(select.options).map((option) => clean(option.textContent || option.value)).filter(Boolean)
          : [],
      });
    }

    for (const group of deepQueryAll<HTMLElement>(document, "[role='radiogroup']")) {
      if (!visible(group)) continue;
      const radios = Array.from(group.querySelectorAll<HTMLElement>("[role='radio']"));
      if (!radios.length) continue;
      const checked = radios.find((radio) => radio.getAttribute("aria-checked") === "true");
      add(group, {
        controlType: "radio",
        widgetKind: "role-radio-group",
        label: labelEvidenceFor(group, group)[0] ?? "Unlabelled field",
        required: group.getAttribute("aria-required") === "true",
        currentValue: checked ? optionText(checked) : undefined,
        options: radios.map(optionText).filter(Boolean),
      });
    }
    void atsKind;
    return result;
  }, { index: frameIndex, atsKind: ats });
}

async function discoverOptions(page: Page, raw: RawInspectedField[]): Promise<{ attempted: number; populated: number; failed: string[] }> {
  let attempted = 0;
  let populated = 0;
  const failed: string[] = [];
  for (const field of raw) {
    if (field.controlType !== "combobox" || field.options.length > 0 || !field.visible) continue;
    const frame = page.frames()[field.frameIndex];
    if (!frame) continue;
    const locator = frame.locator(`[data-stage2-inspection-id="${field.interactionId}"]`).first();
    if (!await locator.isVisible().catch(() => false)) continue;
    attempted += 1;
    try {
      await locator.click({ timeout: 2_000 }).catch(async () => {
        await locator.focus({ timeout: 1_000 });
        await locator.press("ArrowDown", { timeout: 1_000 });
      });
      const deadline = Date.now() + 4_000;
      let options: string[] = [];
      while (Date.now() < deadline && options.length === 0) {
        options = await frame.evaluate((interactionId) => {
          const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
          const visible = (element: Element) => {
            const html = element as HTMLElement;
            const style = getComputedStyle(html);
            const rect = html.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
              && rect.width > 0 && rect.height > 0;
          };
          const control = document.querySelector(`[data-stage2-inspection-id="${CSS.escape(interactionId)}"]`);
          if (!control) return [];
          const ids = `${control.getAttribute("aria-controls") ?? ""} ${control.getAttribute("aria-owns") ?? ""}`.trim().split(/\s+/).filter(Boolean);
          const roots = ids.map((id) => document.getElementById(id)).filter((root): root is HTMLElement => Boolean(root));
          if (roots.length === 0) {
            roots.push(...Array.from(document.querySelectorAll<HTMLElement>("[role='listbox'],[role='menu'],[class*='select__menu']")).filter(visible));
          }
          const optionElements = roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLElement>("[role='option'],[role='menuitem'],[class*='select__option'],option")));
          return [...new Set(optionElements.filter(visible).map((option) => clean(option.textContent || option.getAttribute("aria-label"))).filter(Boolean))];
        }, field.interactionId);
        if (options.length === 0) await page.waitForTimeout(75);
      }
      field.options = options;
      if (options.length > 0) populated += 1;
      else failed.push(field.interactionId);
      await locator.press("Escape", { timeout: 750 }).catch(() => undefined);
      await page.waitForTimeout(50);
    } catch {
      failed.push(field.interactionId);
      await locator.press("Escape", { timeout: 500 }).catch(() => undefined);
    }
  }
  return { attempted, populated, failed };
}

async function cleanupInspectionMarkers(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      document.querySelectorAll("[data-stage2-inspection-id]").forEach((element) => element.removeAttribute("data-stage2-inspection-id"));
    }).catch(() => undefined);
  }
}

export async function inspectForm(page: Page, ats: AtsKind, options: FormInspectionOptions = {}): Promise<{
  fields: InspectedField[];
  diagnostics: {
    total: number;
    duplicateStableIds: string[];
    weakAnchors: number;
    unlabelled: number;
    repeaters: RepeaterDiagnostics;
    optionDiscovery: { attempted: number; populated: number; failed: string[] };
  };
}> {
  const repeaters = await expandRepeaters(
    page,
    ats,
    Math.max(0, options.desiredEmploymentRecords ?? 0),
    Math.max(0, options.desiredEducationRecords ?? 0),
  );
  const raw: RawInspectedField[] = [];
  try {
    for (const [frameIndex, frame] of page.frames().entries()) {
      try {
        raw.push(...await inspectFrame(frame, frameIndex, ats));
      } catch (error) {
        if (frame === page.mainFrame()) throw error;
      }
    }
    const optionDiscovery = options.discoverOptions === false
      ? { attempted: 0, populated: 0, failed: [] }
      : await discoverOptions(page, raw);
    const fields: InspectedField[] = raw.map((field) => {
      const key = semanticKey(field);
      return {
        ...field,
        semanticKey: key,
        stableId: `field-${sha256(key).slice(0, 16)}`,
        warnings: [
          ...(field.anchorStrength === "weak" ? ["weak_anchor"] : []),
          ...(field.label === "Unlabelled field" ? ["missing_label"] : []),
          ...(field.controlType === "combobox" && field.options.length === 0 ? ["options_unavailable"] : []),
        ],
      };
    }).map(({ interactionId: _interactionId, localOccurrence: _localOccurrence, ...field }) => field);
    const counts = new Map<string, number>();
    for (const field of fields) counts.set(field.stableId, (counts.get(field.stableId) ?? 0) + 1);
    const duplicateStableIds = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    for (const field of fields) {
      if (duplicateStableIds.includes(field.stableId)) field.warnings.push("duplicate_stable_id");
    }
    return {
      fields,
      diagnostics: {
        total: fields.length,
        duplicateStableIds,
        weakAnchors: fields.filter((field) => field.anchorStrength === "weak").length,
        unlabelled: fields.filter((field) => field.label === "Unlabelled field").length,
        repeaters,
        optionDiscovery,
      },
    };
  } finally {
    await cleanupInspectionMarkers(page);
  }
}
