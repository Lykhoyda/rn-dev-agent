import type { Element, EvidenceStatus, Screen } from './screen.js';

export const MASK = '•••';

const BULLETS = /^[\s•●∙*]+$/u;

// A placeholder or a run of bullets is not private content.
// A secure value equal to its placeholder may be a real secret, so only open fields drop it.
function readable(element: Element, value: string | undefined): value is string {
  return !!value && !BULLETS.test(value) && (element.secure || value !== element.placeholder);
}

export function readableValue(element: Element): string | undefined {
  return readable(element, element.value) ? element.value : undefined;
}

interface InputPrivacy {
  values: string[];
  nativeLabelMayBeValue: boolean;
  checkSubject: EvidenceStatus;
}

const inputPrivacy = new WeakMap<Element, InputPrivacy>();
interface PrivateSubject {
  names: string[];
  uncertain: boolean;
  unassociated: boolean;
}

const privateScreens = new WeakMap<
  Screen,
  {
    values: string[];
    subjects: PrivateSubject[];
    sensitivePixels: boolean;
  }
>();
const uncertainPrivateInputs = new WeakSet<Element>();

export function capturePrivateScreen(
  screen: Screen,
  facts: {
    values: readonly string[];
    secure: boolean;
    testID?: string;
    elements: Element[];
    associationUnique: boolean;
    labelMayBeValue?: boolean;
  }[],
): void {
  const values = new Set<string>();
  const add = (value: string): void => {
    if (value) values.add(value);
    if (value.trim()) values.add(value.trim());
  };
  const subjects: PrivateSubject[] = [];
  let unassociatedSecure = false;
  for (const fact of facts) {
    fact.values.forEach(add);
    const uncertain =
      fact.secure || !fact.associationUnique || inputCheckSubject(fact.elements[0]) !== 'supported';
    subjects.push({
      names: [
        ...new Set(
          [fact.testID, ...fact.elements.flatMap((e) => [e.label, e.placeholder, e.testID])].filter(
            (name): name is string => !!name,
          ),
        ),
      ],
      uncertain,
      unassociated:
        fact.elements.length === 0 ||
        (!fact.associationUnique && !fact.elements.some((e) => e.label || e.placeholder)),
    });
    if (fact.secure && !fact.associationUnique) unassociatedSecure = true;
    for (const element of fact.elements) {
      if (uncertain) uncertainPrivateInputs.add(element);
      for (const value of inputPrivacy.get(element)?.values ?? [])
        if (readable(element, value)) add(value);
      const shown = readableValue(element);
      if (shown) add(shown);
      if (
        ((fact.labelMayBeValue ?? fact.secure) || nativeLabelMayBeValue(element)) &&
        element.label
      )
        add(element.label);
    }
  }
  if (unassociatedSecure) {
    for (const element of screen.elements) {
      if (isPossibleInput(element) || element.kind === 'other' || element.value !== undefined) {
        uncertainPrivateInputs.add(element);
        for (const value of inputPrivacy.get(element)?.values ?? [])
          if (readable(element, value)) add(value);
        const shown = readableValue(element);
        if (shown) add(shown);
        if (element.label) add(element.label);
      }
    }
  }
  privateScreens.set(screen, {
    values: [...values],
    subjects,
    sensitivePixels:
      values.size > 0 ||
      facts.some((fact) => fact.secure) ||
      inputValues(screen).length > 0 ||
      screen.elements.some((element) => element.secure),
  });
}

export function privateCheckSubjects(screen: Screen): readonly PrivateSubject[] {
  return privateScreens.get(screen)?.subjects ?? [];
}

export function mentionsPrivateValue(screen: Screen, text: string): boolean {
  return privateScreens.get(screen)?.values.some((value) => text.includes(value)) ?? false;
}

export function captureInputPrivacy(element: Element, data: InputPrivacy): void {
  inputPrivacy.set(element, data);
}

export function isPossibleInput(element: Element): boolean {
  return element.kind === 'input' || inputPrivacy.has(element);
}

export function inputCheckSubject(element: Element): EvidenceStatus {
  if (element.secure || uncertainPrivateInputs.has(element)) return 'unknown';
  return (
    inputPrivacy.get(element)?.checkSubject ??
    (element.kind === 'input' ? 'supported' : 'unsupported')
  );
}

export function nativeLabelMayBeValue(element: Element): boolean {
  return inputPrivacy.get(element)?.nativeLabelMayBeValue ?? false;
}

export function inputValues(screen: Screen, evidenceOnly = false): string[] {
  return [
    ...new Set([
      ...(privateScreens.get(screen)?.values ?? []),
      ...screen.elements.flatMap((e) => {
        if (!isPossibleInput(e)) return [];
        const data = inputPrivacy.get(e);
        return [
          ...(!evidenceOnly || e.secure
            ? [
                ...(data?.values ?? []).filter((value) => readable(e, value)),
                ...(readableValue(e) ? [readableValue(e)!] : []),
              ]
            : []),
          ...(data?.nativeLabelMayBeValue && e.label ? [e.label] : []),
        ];
      }),
    ]),
  ];
}

export function redactEvidence(
  screen: Screen,
  text: string,
  typed: readonly string[] = [],
): string {
  return maskEvidence(
    text,
    inputValues(screen, true),
    typed,
    new Set(privateScreens.get(screen)?.values),
  );
}

function maskEvidence(
  text: string,
  privateValues: readonly string[],
  typed: readonly string[],
  substringValues: ReadonlySet<string> = new Set(),
): string {
  const values = [...new Set([...privateValues, ...typed].filter(Boolean))];
  const mask = modelMask(values, [text], substringValues);
  const projected = mask.tokens.reduce(
    (out, token, i) =>
      out
        .split(token)
        .join(privateValues.includes(values[i]) || values[i].length >= 3 ? MASK : values[i]),
    mask.apply(text),
  );
  return maskValues(projected, typed);
}

export class ObservedPrivacy {
  private readonly observed = new Set<string>();
  private readonly concealed = new Set<string>();
  private readonly substringValues = new Set<string>();
  private sensitivePixels = false;

  constructor(private readonly typed: readonly string[] = []) {}

  observe(screen: Screen): void {
    this.sensitivePixels ||= privateScreens.get(screen)?.sensitivePixels === true;
    for (const value of privateScreens.get(screen)?.values ?? []) this.substringValues.add(value);
    for (const value of inputValues(screen)) this.observed.add(value);
    for (const value of inputValues(screen, true)) this.concealed.add(value);
  }

  canScreenshot(): boolean {
    return !this.sensitivePixels;
  }

  modelValues(): string[] {
    return [...this.typed, ...this.observed];
  }

  maskForModel(values: readonly string[], source: readonly string[]): ModelMask {
    return modelMask(values, source, this.substringValues);
  }

  redact(text: string): string {
    return maskEvidence(text, [...this.concealed], this.typed, this.substringValues);
  }
}

export interface ModelMask {
  tokens: string[];
  apply(text: string): string;
}

export function modelMask(
  values: readonly string[],
  source: readonly string[],
  substringValues: ReadonlySet<string> = new Set(),
): ModelMask {
  const unique = [...new Set(values.filter(Boolean))];
  let prefix = 'QAREN_VALUE';
  while (source.some((text) => text.includes(`[${prefix}_`))) prefix += '_';
  const tokens = unique.map((_, i) => `[${prefix}_${i + 1}]`);
  const replacements = new Map(unique.map((value, i) => [value, tokens[i]]));
  const alternatives = unique
    .sort((a, b) => b.length - a.length)
    .map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return value.length < 3 && !substringValues.has(value)
        ? `(?<![\\p{L}\\p{M}\\p{N}_])${escaped}(?![\\p{L}\\p{M}\\p{N}_])`
        : escaped;
    });
  const pattern = alternatives.length ? new RegExp(alternatives.join('|'), 'gu') : undefined;
  return {
    tokens,
    apply: (text) => (pattern ? text.replace(pattern, (value) => replacements.get(value)!) : text),
  };
}

export function maskValues(text: string, values: readonly string[]): string {
  return [...values]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((masked, value) => {
      for (const [open, close] of [
        ['"', '"'],
        ['“', '”'],
      ]) {
        masked = masked.split(`${open}${value}${close}`).join(`${open}${MASK}${close}`);
      }
      return value.length >= 3 ? masked.split(value).join(MASK) : masked;
    }, text);
}

export function maskInputs(screen: Screen, text: string, values?: readonly string[]): string {
  return screen.elements.reduce((masked, el) => {
    if (!isPossibleInput(el) || !el.value || (values && !el.secure && !values.includes(el.value)))
      return masked;
    const name = el.label ?? el.placeholder ?? el.testID ?? 'input';
    return masked.split(`${name}: ${el.value}`).join(`${name}: ${MASK}`);
  }, text);
}
