import type { Element, Screen } from './screen.js';

export const MASK = '•••';

interface InputPrivacy {
  values: string[];
  nativeLabelMayBeValue: boolean;
}

const inputPrivacy = new WeakMap<Element, InputPrivacy>();

export function captureInputPrivacy(element: Element, data: InputPrivacy): void {
  inputPrivacy.set(element, data);
}

export function nativeLabelMayBeValue(element: Element): boolean {
  return inputPrivacy.get(element)?.nativeLabelMayBeValue ?? false;
}

export function inputValues(screen: Screen, evidenceOnly = false): string[] {
  return screen.elements.flatMap((e) => {
    if (e.kind !== 'input') return [];
    const data = inputPrivacy.get(e);
    return [
      ...(!evidenceOnly || e.secure
        ? [...(data?.values ?? []), ...(e.value ? [e.value] : [])]
        : []),
      ...(data?.nativeLabelMayBeValue && e.label ? [e.label] : []),
    ];
  });
}

export function redactEvidence(
  screen: Screen,
  text: string,
  typed: readonly string[] = [],
): string {
  return maskEvidence(text, inputValues(screen, true), typed);
}

function maskEvidence(
  text: string,
  privateValues: readonly string[],
  typed: readonly string[],
): string {
  const values = [...new Set([...privateValues, ...typed].filter(Boolean))];
  const mask = modelMask(values, [text]);
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

  constructor(private readonly typed: readonly string[] = []) {}

  observe(screen: Screen): void {
    for (const value of inputValues(screen)) this.observed.add(value);
    for (const value of inputValues(screen, true)) this.concealed.add(value);
  }

  modelValues(): string[] {
    return [...this.typed, ...this.observed];
  }

  redact(text: string): string {
    return maskEvidence(text, [...this.concealed], this.typed);
  }
}

export interface ModelMask {
  tokens: string[];
  apply(text: string): string;
}

export function modelMask(values: readonly string[], source: readonly string[]): ModelMask {
  const unique = [...new Set(values.filter(Boolean))];
  let prefix = 'QAREN_VALUE';
  while (source.some((text) => text.includes(`[${prefix}_`))) prefix += '_';
  const tokens = unique.map((_, i) => `[${prefix}_${i + 1}]`);
  const replacements = new Map(unique.map((value, i) => [value, tokens[i]]));
  const alternatives = unique
    .sort((a, b) => b.length - a.length)
    .map((value) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return value.length < 3
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
    if (el.kind !== 'input' || !el.value || (values && !el.secure && !values.includes(el.value)))
      return masked;
    const name = el.label ?? el.placeholder ?? el.testID ?? 'input';
    return masked.split(`${name}: ${el.value}`).join(`${name}: ${MASK}`);
  }, text);
}
