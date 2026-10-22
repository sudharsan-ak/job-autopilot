import type { Frame, Page } from "playwright";
import { getAtsBehavior, type AtsBehavior } from "../ats/behavior.js";
import type { AtsKind, ControlType, FieldDescriptor, WidgetKind } from "../types.js";
import { buildFormModel } from "./formModel.js";

interface BrowserField extends Omit<FieldDescriptor, "frameUrl"> {
  frameUrl: string;
}

async function scanFrame(frame: Frame, frameIndex: number, behavior: AtsBehavior, ats?: AtsKind): Promise<BrowserField[]> {
  return frame.evaluate(({ index, atsBehavior, atsKind }) => {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const cleanText = (value: string | null | undefined) => normalize(value)
      .replace(/SVGs not supported by this browser\.?/gi, "")
      .trim();
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
    const visible = (element: Element | null | undefined): boolean => {
      if (!element) return false;
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const referencedText = (element: Element, attribute: string) => normalize(element.getAttribute(attribute))
      .split(" ")
      .filter(Boolean)
      .map((id) => cleanText(rootById(element, id)?.textContent))
      .filter(Boolean)
      .join(" ");
    const closestContainer = (element: Element): HTMLElement => {
      for (const selector of atsBehavior.fieldContainerSelectors) {
        const found = element.closest(selector);
        if (found instanceof HTMLElement && found !== element) return found;
      }
      return (element.closest("fieldset,[role='group'],[role='radiogroup']") as HTMLElement | null)
        ?? element.parentElement
        ?? element as HTMLElement;
    };
    const labelFor = (element: HTMLElement, container = closestContainer(element)): string => {
      const input = element as HTMLInputElement;
      const explicit = input.labels ? Array.from(input.labels).map((label) => cleanText(label.textContent)).find(Boolean) : undefined;
      const labelled = referencedText(element, "aria-labelledby");
      const direct = cleanText(element.getAttribute("aria-label"));
      const legend = cleanText(container.querySelector("legend")?.textContent);
      const localLabel = cleanText(container.querySelector("label")?.textContent);
      const wrappingLabel = cleanText(element.closest("label")?.textContent);
      const placeholder = cleanText(element.getAttribute("placeholder"));
      return cleanText(explicit || labelled || direct || legend || localLabel || wrappingLabel || placeholder || input.name || input.id);
    };
    const optionLabel = (element: HTMLElement): string => {
      const input = element as HTMLInputElement;
      return cleanText(input.labels?.[0]?.textContent)
        || referencedText(element, "aria-labelledby")
        || cleanText(element.getAttribute("aria-label"))
        || cleanText(element.textContent)
        || cleanText(input.value);
    };
    const sectionFor = (element: Element): string | undefined => {
      const section = element.closest("section,fieldset,[data-automation-id*='section'],[class*='section']");
      return cleanText(section?.querySelector("h1,h2,h3,h4,legend,[role='heading']")?.textContent) || undefined;
    };
    const elementMetadata = (element: Element): string => cleanText([
      element.id,
      element.getAttribute("class"),
      element.getAttribute("name"),
      element.getAttribute("data-automation-id"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-qa"),
      element.getAttribute("data-question-id"),
      element.getAttribute("data-field-id"),
    ].filter(Boolean).join(" ")).toLowerCase();
    const domPathFor = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        const parent: Element | null = current.parentElement;
        const siblings: Element[] = parent
          ? Array.from(parent.children).filter((candidate: Element) => candidate.tagName === current!.tagName)
          : [];
        const position = siblings.indexOf(current) + 1;
        parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${Math.max(position, 1)})`);
        current = parent;
      }
      return parts.join(">");
    };
    const atsQuestionIdFor = (element: Element): string | undefined => {
      let current: Element | null = element;
      while (current && current !== document.body) {
        for (const attribute of ["data-question-id", "data-field-id", "data-automation-id", "data-testid", "data-qa"]) {
          const value = cleanText(current.getAttribute(attribute));
          if (value) return `${attribute}:${value}`;
        }
        current = current.parentElement;
      }
      return undefined;
    };
    const greenhouseRepeatHintFor = (element: HTMLElement): { kind: "EMPLOYMENT" | "EDUCATION"; index: number } | undefined => {
      if (atsKind !== "GREENHOUSE") return undefined;
      for (const candidate of [element.id, (element as HTMLInputElement).name].filter(Boolean)) {
        const employment = candidate.match(/^(?:company-name|title|start-date-month|start-date-year|end-date-month|end-date-year|current-role)-(\d+)(?:_|$)/i);
        if (employment) return { kind: "EMPLOYMENT", index: Number(employment[1]) };
        const education = candidate.match(/^(?:school|degree|discipline)--?(\d+)(?:_|$)/i);
        if (education) return { kind: "EDUCATION", index: Number(education[1]) };
      }
      return undefined;
    };
    const repeatKindFor = (element: HTMLElement): "EMPLOYMENT" | "EDUCATION" | undefined => {
      const greenhouseHint = greenhouseRepeatHintFor(element);
      if (greenhouseHint) return greenhouseHint.kind;
      let current: Element | null = element;
      const evidence: string[] = [];
      while (current && current !== document.body) {
        evidence.push(elementMetadata(current));
        const heading = current.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend,:scope > [role='heading']");
        evidence.push(cleanText(heading?.textContent).toLowerCase());
        current = current.parentElement;
      }
      const text = evidence.join(" ");
      if (/\b(education|school|university|college|academic)\b/.test(text)) return "EDUCATION";
      if (/\b(employment|work experience|professional experience|job history)\b/.test(text)) return "EMPLOYMENT";
      return undefined;
    };
    const explicitRecordIndex = (element: HTMLElement, kind: "EMPLOYMENT" | "EDUCATION"): number | undefined => {
      const greenhouseHint = greenhouseRepeatHintFor(element);
      if (greenhouseHint?.kind === kind) return greenhouseHint.index;
      const text = [element.getAttribute("name"), element.id, atsQuestionIdFor(element)].filter(Boolean).join(" ");
      const prefix = kind === "EMPLOYMENT" ? "(?:employment|work(?:_|-)?experience|job)" : "(?:education|school|academic)";
      const patterns = [
        new RegExp(`${prefix}(?:_history)?\\[(\\d+)\\]`, "i"),
        new RegExp(`${prefix}(?:_|-)(\\d+)(?:_|-|\\b)`, "i"),
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1] !== undefined) return Number(match[1]);
      }
      return undefined;
    };
    const repeatBindingFor = (element: HTMLElement) => {
      const greenhouseHint = greenhouseRepeatHintFor(element);
      if (greenhouseHint) {
        const groupKey = `${greenhouseHint.kind.toLowerCase()}:greenhouse`;
        return {
          kind: greenhouseHint.kind,
          groupKey,
          recordKey: `${groupKey}:record:${greenhouseHint.index}`,
          recordIndex: greenhouseHint.index,
        };
      }
      const kind = repeatKindFor(element);
      if (!kind) return undefined;
      const groupPattern = kind === "EMPLOYMENT"
        ? /employment|work(?:-|_)?experience|job(?:-|_)?history/i
        : /education|school|academic/i;
      const recordPattern = /record|entry|item|card|panel|block|experience|education|school|\bjob\b/i;
      let groupRoot: Element | undefined;
      let recordRoot: Element | undefined;
      let current: Element | null = element.parentElement;
      while (current && current !== document.body) {
        const metadata = elementMetadata(current);
        if (!recordRoot && groupPattern.test(metadata) && recordPattern.test(metadata)) recordRoot = current;
        if (groupPattern.test(metadata) || groupPattern.test(cleanText(current.querySelector(":scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend")?.textContent))) {
          groupRoot = current;
        }
        current = current.parentElement;
      }
      groupRoot ??= element.closest("section,fieldset,[role='group']") ?? undefined;
      if (!groupRoot) return undefined;

      if (!recordRoot || recordRoot === groupRoot) {
        let candidate: Element | null = element.parentElement;
        while (candidate && candidate.parentElement && candidate !== groupRoot) {
          const siblings = Array.from(candidate.parentElement.children).filter((sibling) =>
            sibling.querySelector("input,textarea,select,[role='combobox'],[role='checkbox'],[role='radio']"),
          );
          const signature = `${candidate.tagName}|${cleanText(candidate.getAttribute("class"))}`;
          const comparable = siblings.filter((sibling) => `${sibling.tagName}|${cleanText(sibling.getAttribute("class"))}` === signature);
          if (comparable.length > 1) {
            recordRoot = candidate;
            break;
          }
          candidate = candidate.parentElement;
        }
      }

      const explicit = explicitRecordIndex(element, kind);
      let recordIndex = explicit;
      if (recordIndex === undefined && recordRoot?.parentElement) {
        const siblings = Array.from(recordRoot.parentElement.children).filter((sibling) =>
          sibling.querySelector("input,textarea,select,[role='combobox'],[role='checkbox'],[role='radio']"),
        );
        const signature = `${recordRoot.tagName}|${cleanText(recordRoot.getAttribute("class"))}`;
        const comparable = siblings.filter((sibling) => `${sibling.tagName}|${cleanText(sibling.getAttribute("class"))}` === signature);
        const indexInComparable = comparable.indexOf(recordRoot);
        if (indexInComparable >= 0) recordIndex = indexInComparable;
      }
      recordIndex ??= 0;
      const groupKey = `${kind.toLowerCase()}:${atsQuestionIdFor(groupRoot as HTMLElement) ?? domPathFor(groupRoot)}`;
      const recordKey = `${groupKey}:record:${recordIndex}`;
      return { kind, groupKey, recordKey, recordIndex };
    };
    const controlType = (element: HTMLElement): ControlType => {
      const tag = element.tagName.toLowerCase();
      const role = cleanText(element.getAttribute("role")).toLowerCase();
      if (role === "combobox" || element.getAttribute("aria-haspopup") === "listbox") return "combobox";
      if (role === "checkbox" || role === "switch") return "checkbox";
      if (tag === "textarea") return "textarea";
      if (tag === "select") return "select";
      const type = cleanText(element.getAttribute("type") || "text").toLowerCase();
      if (["email", "tel", "url", "date", "file", "radio", "checkbox"].includes(type)) return type as ControlType;
      if (["text", "number", "search", "password"].includes(type)) return "text";
      return "unknown";
    };
    const widgetKind = (element: HTMLElement, type: ControlType): WidgetKind => {
      if (type === "file") return "file-upload";
      if (element.getAttribute("role") === "checkbox" || element.getAttribute("role") === "switch") return "role-checkbox";
      const interactiveText = element.getAttribute("aria-autocomplete")
        || element.getAttribute("aria-controls")
        || element.getAttribute("aria-owns")
        || /address|location/i.test(element.getAttribute("data-ui") ?? "");
      if (type === "combobox" || interactiveText) {
        const classes = `${element.className || ""} ${closestContainer(element).className || ""}`;
        return /react-select|select__/i.test(classes) ? "react-select" : "aria-combobox";
      }
      return "native";
    };
    const linkedOptionRoot = (element: HTMLElement, container: HTMLElement): HTMLElement | undefined => {
      const ids = `${element.getAttribute("aria-controls") ?? ""} ${element.getAttribute("aria-owns") ?? ""}`.trim().split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const candidate = rootById(element, id);
        if (candidate instanceof HTMLElement) return candidate;
      }
      const local = container.querySelector<HTMLElement>("[role='listbox'],[role='menu'],[class*='menu']");
      return local ?? undefined;
    };
    const optionTexts = (element: HTMLElement, container: HTMLElement): { options: string[]; optionRoot?: HTMLElement } => {
      const optionRoot = linkedOptionRoot(element, container);
      if (!optionRoot) return { options: [] };
      const selectors = atsBehavior.optionSelectors.join(",");
      const options = Array.from(optionRoot.querySelectorAll<HTMLElement>(selectors))
        .filter((option) => visible(option))
        .map((option) => optionLabel(option))
        .filter(Boolean);
      return { options: [...new Set(options)], optionRoot };
    };
    const selectedText = (element: HTMLElement, container: HTMLElement): string | undefined => {
      const input = element as HTMLInputElement;
      const nativeValue = cleanText(input.value || element.getAttribute("aria-valuetext"));
      if (nativeValue) return nativeValue;
      for (const selector of atsBehavior.selectedValueSelectors) {
        const selected = container.querySelector<HTMLElement>(selector);
        const value = cleanText(selected?.textContent ?? selected?.getAttribute("aria-label"));
        if (value && !/^(select|choose)(\.{3})?$/i.test(value)) return value;
      }
      return undefined;
    };

    const native = deepQueryAll<HTMLElement>(document,
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='image']):not([type='reset']), textarea, select, [role='combobox'], [aria-haspopup='listbox'], [role='checkbox'], [role='switch']",
    );
    const controls = native.filter((element, position) => {
      if (native.indexOf(element) !== position) return false;
      if ((element.getAttribute("role") === "combobox" || element.getAttribute("aria-haspopup") === "listbox")
        && element.querySelector("input,textarea,select")) return false;
      return true;
    });
    const roleRadioGroups = deepQueryAll<HTMLElement>(document, "[role='radiogroup']")
      .filter((group) => visible(group) && group.querySelector("[role='radio']"));
    const ungroupedRoleRadios = deepQueryAll<HTMLElement>(document, "[role='radio']")
      .filter((radio) => visible(radio) && !radio.closest("[role='radiogroup']"));
    const fields: BrowserField[] = [];
    const handledRadios = new WeakSet<HTMLInputElement>();
    const usedIds = new Set(deepQueryAll<HTMLElement>(document, "[data-job-autopilot-field-id]")
      .map((element) => element.getAttribute("data-job-autopilot-field-id"))
      .filter((value): value is string => Boolean(value)));
    const claimedIds = new Set<string>();
    const elementIds = new WeakMap<HTMLElement, string>();
    const runtime = window as typeof window & { __jobAutopilotNextFieldId?: number };
    let nextFieldId = runtime.__jobAutopilotNextFieldId ?? 0;
    const fieldIdFor = (element: HTMLElement): string => {
      const assigned = elementIds.get(element);
      if (assigned) return assigned;
      const existing = element.getAttribute("data-job-autopilot-field-id");
      if (existing && !claimedIds.has(existing)) {
        claimedIds.add(existing);
        elementIds.set(element, existing);
        return existing;
      }
      let candidate = `s2-${index}-${nextFieldId++}`;
      while (usedIds.has(candidate)) candidate = `s2-${index}-${nextFieldId++}`;
      runtime.__jobAutopilotNextFieldId = nextFieldId;
      usedIds.add(candidate);
      claimedIds.add(candidate);
      elementIds.set(element, candidate);
      return candidate;
    };
    const markRoot = (container: HTMLElement, fieldId: string): string | undefined => {
      if (container === document.body || container === document.documentElement) return undefined;
      const ids = new Set(normalize(container.getAttribute("data-job-autopilot-field-root")).split(" ").filter(Boolean));
      ids.add(fieldId);
      container.setAttribute("data-job-autopilot-field-root", [...ids].join(" "));
      return `[data-job-autopilot-field-root~="${fieldId}"]`;
    };
    const markOptionRoot = (optionRoot: HTMLElement | undefined, fieldId: string): string | undefined => {
      if (!optionRoot) return undefined;
      const ids = new Set(normalize(optionRoot.getAttribute("data-job-autopilot-options-for")).split(" ").filter(Boolean));
      ids.add(fieldId);
      optionRoot.setAttribute("data-job-autopilot-options-for", [...ids].join(" "));
      return `[data-job-autopilot-options-for~="${fieldId}"]`;
    };
    const contextFor = (element: HTMLElement, container: HTMLElement): string => cleanText([
      container.textContent,
      referencedText(element, "aria-describedby"),
    ].filter(Boolean).join(" ")).slice(0, 700);

    for (const element of controls) {
      const type = controlType(element);
      const input = element as HTMLInputElement;
      const labelsVisible = Boolean(input.labels && Array.from(input.labels).some(visible));
      const isVisible = visible(element) || (["radio", "checkbox"].includes(type) && labelsVisible);
      if (!isVisible && type !== "file") continue;
      if (type === "radio" && input.name) {
        if (handledRadios.has(input)) continue;
        const radios = controls.filter((candidate) => {
          const radio = candidate as HTMLInputElement;
          return radio.type === "radio" && radio.name === input.name && radio.getRootNode() === input.getRootNode();
        }) as HTMLInputElement[];
        radios.forEach((radio) => handledRadios.add(radio));
        const container = closestContainer(input);
        const fieldId = radios.map((radio) => radio.getAttribute("data-job-autopilot-field-id")).find(Boolean) ?? fieldIdFor(input);
        radios.forEach((radio) => radio.setAttribute("data-job-autopilot-field-id", fieldId));
        const checked = radios.find((radio) => radio.checked);
        fields.push({
          fieldId,
          frameUrl: location.href,
          frameIndex: index,
          selector: `[data-job-autopilot-field-id="${fieldId}"]`,
          fieldRootSelector: markRoot(container, fieldId),
          controlType: "radio",
          inputType: "radio",
          widgetKind: "native-radio-group",
          label: labelFor(input, container),
          name: input.name,
          id: input.id || undefined,
          required: radios.some((radio) => radio.required || radio.getAttribute("aria-required") === "true"),
          disabled: radios.every((radio) => radio.disabled || radio.getAttribute("aria-disabled") === "true"),
          readOnly: false,
          visible: radios.some((radio) => visible(radio) || Boolean(radio.labels && Array.from(radio.labels).some(visible))),
          options: radios.map(optionLabel).filter(Boolean),
          currentValue: checked ? optionLabel(checked) : undefined,
          containerText: contextFor(input, container),
          section: sectionFor(input),
          domPath: domPathFor(input),
          atsQuestionId: atsQuestionIdFor(input),
          repeatGroup: repeatBindingFor(input),
        });
        continue;
      }

      const container = closestContainer(element);
      const fieldId = fieldIdFor(element);
      element.setAttribute("data-job-autopilot-field-id", fieldId);
      const select = element as HTMLSelectElement;
      const detectedWidget = widgetKind(element, type);
      const optionData = type === "combobox" || detectedWidget === "aria-combobox" || detectedWidget === "react-select"
        ? optionTexts(element, container)
        : { options: [] as string[], optionRoot: undefined };
      fields.push({
        fieldId,
        frameUrl: location.href,
        frameIndex: index,
        selector: `[data-job-autopilot-field-id="${fieldId}"]`,
        fieldRootSelector: markRoot(container, fieldId),
        optionContainerSelector: markOptionRoot(optionData.optionRoot, fieldId),
        selectedValueSelectors: atsBehavior.selectedValueSelectors,
        controlType: type,
        inputType: input.type || undefined,
        widgetKind: detectedWidget,
        label: labelFor(element, container),
        name: input.name || undefined,
        id: input.id || undefined,
        autocomplete: input.autocomplete || undefined,
        ariaLabel: element.getAttribute("aria-label") || undefined,
        required: input.required || element.getAttribute("aria-required") === "true",
        disabled: input.disabled || element.getAttribute("aria-disabled") === "true",
        readOnly: input.readOnly || element.getAttribute("aria-readonly") === "true",
        visible: isVisible,
        options: type === "select"
          ? Array.from(select.options).map((option) => cleanText(option.textContent || option.value)).filter(Boolean)
          : optionData.options,
        currentValue: type === "checkbox"
          ? (element.getAttribute("role") ? element.getAttribute("aria-checked") === "true" : input.checked)
          : type === "select"
            ? cleanText(select.selectedOptions[0]?.textContent ?? select.value)
            : type === "combobox"
              ? selectedText(element, container)
              : type === "file"
                ? input.files?.[0]?.name
                : cleanText(input.value),
        containerText: contextFor(element, container),
        section: sectionFor(element),
        domPath: domPathFor(element),
        atsQuestionId: atsQuestionIdFor(element),
        repeatGroup: repeatBindingFor(element),
      });
    }

    const addRoleRadioGroup = (group: HTMLElement, radios: HTMLElement[]) => {
      const fieldId = fieldIdFor(group);
      group.setAttribute("data-job-autopilot-field-root", fieldId);
      radios.forEach((radio) => radio.setAttribute("data-job-autopilot-field-id", fieldId));
      const checked = radios.find((radio) => radio.getAttribute("aria-checked") === "true" || radio.getAttribute("data-state") === "checked");
      fields.push({
        fieldId,
        frameUrl: location.href,
        frameIndex: index,
        selector: `[data-job-autopilot-field-id="${fieldId}"]`,
        fieldRootSelector: `[data-job-autopilot-field-root="${fieldId}"]`,
        controlType: "radio",
        inputType: "radio",
        widgetKind: "role-radio-group",
        label: labelFor(group, group),
        name: group.getAttribute("name") || undefined,
        id: group.id || undefined,
        ariaLabel: group.getAttribute("aria-label") || undefined,
        required: group.getAttribute("aria-required") === "true" || Boolean(group.querySelector("[aria-required='true']")),
        disabled: radios.every((radio) => radio.getAttribute("aria-disabled") === "true"),
        readOnly: false,
        visible: radios.some(visible),
        options: radios.map(optionLabel).filter(Boolean),
        currentValue: checked ? optionLabel(checked) : undefined,
        containerText: contextFor(group, group),
        section: sectionFor(group),
        domPath: domPathFor(group),
        atsQuestionId: atsQuestionIdFor(group),
        repeatGroup: repeatBindingFor(group),
      });
    };
    for (const group of roleRadioGroups) addRoleRadioGroup(group, Array.from(group.querySelectorAll<HTMLElement>("[role='radio']")));
    for (const radio of ungroupedRoleRadios) addRoleRadioGroup(closestContainer(radio), [radio]);
    return fields;
  }, { index: frameIndex, atsBehavior: behavior, atsKind: ats });
}

export async function scanPage(page: Page, options: { ats?: AtsKind } = {}): Promise<FieldDescriptor[]> {
  const behavior = getAtsBehavior(options.ats);
  const results: FieldDescriptor[] = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      results.push(...await scanFrame(frame, index, behavior, options.ats));
    } catch (error) {
      if (frame === page.mainFrame()) throw error;
      // Detached or restricted child frames are retried on the next scan.
    }
  }
  return buildFormModel(results).fields;
}
