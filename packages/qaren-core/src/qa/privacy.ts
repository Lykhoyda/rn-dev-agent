import type { Element, EvidenceStatus, NativeNode, Screen } from './screen.js';

export const MASK = '•••';

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
      for (const value of inputPrivacy.get(element)?.values ?? []) add(value);
      if (element.value) add(element.value);
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
        for (const value of inputPrivacy.get(element)?.values ?? []) add(value);
        if (element.value) add(element.value);
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

// A field whose value is private evidence: native secure, or an input the screen model cannot read safely.
export function isPrivateInput(element: Element): boolean {
  return (
    element.secure || inputCheckSubject(element) === 'unknown' || nativeLabelMayBeValue(element)
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
            ? [...(data?.values ?? []).filter(Boolean), ...(e.value ? [e.value] : [])]
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
  return maskProtectedFragments(maskValues(projected, typed), [
    ...privateValues,
    ...substringValues,
  ]);
}

// A protected value can be shown split across boxes, so any token that is part of one is masked.
function maskProtectedFragments(text: string, protectedValues: readonly string[]): string {
  const values = protectedValues.filter(Boolean);
  if (!values.length) return text;
  return text.replace(/[\p{L}\p{M}\p{N}_.@-]+/gu, (token) => {
    const core = token.replace(/^[_.@-]+|[_.@-]+$/g, '');
    return core && values.some((value) => value.includes(core)) ? MASK : token;
  });
}

const NATIVE_TYPES = new Set([
  'Application',
  'Window',
  'Other',
  'Group',
  'StaticText',
  'Button',
  'Link',
  'Image',
  'Icon',
  'Cell',
  'Table',
  'CollectionView',
  'ScrollView',
  'TextField',
  'SecureTextField',
  'SearchField',
  'TextView',
  'Switch',
  'Toggle',
  'Slider',
  'Stepper',
  'Picker',
  'PickerWheel',
  'DatePicker',
  'SegmentedControl',
  'PageIndicator',
  'ProgressIndicator',
  'ActivityIndicator',
  'NavigationBar',
  'TabBar',
  'Toolbar',
  'Keyboard',
  'Key',
  'WebView',
  'Map',
  'Alert',
  'Sheet',
]);
export const SYSTEM_SCROLL_BAR_LABEL =
  /^(vertical|horizontal)\s+scroll\s+bar(?:,?\s*\d+\s+pages?)?$/i;
const BARE_PERCENT = /^\d{1,3}%$/;
// iOS may add one decimal digit and a (narrow) no-break space before %.
export const SCROLL_BAR_PERCENT = /^\d{1,3}(?:[.,]\d)?\s?%$/;
// The sink adds the 12-byte `qaren-core: ` prefix and a newline, keeping each line within 512 bytes.
const SENSITIVE_PIXELS_LIMIT = 499;
const SHAPE_LIMIT = 4;

const shapeType = (type: string | undefined): string =>
  type !== undefined && (NATIVE_TYPES.has(type) || /^Element\(\d{1,3}\)$/.test(type))
    ? type
    : 'unlisted';

function labelClass(label: string | undefined): string {
  const text = label?.trim();
  if (!text) return 'none';
  if (SYSTEM_SCROLL_BAR_LABEL.test(text)) return 'sb-exact';
  return /scroll\s*bar/i.test(text) ? 'sb-loose' : 'other';
}

function valueClass(value: string | undefined): string {
  if (value === undefined) return 'none';
  if (BARE_PERCENT.test(value)) return 'pct';
  if (/^\d{1,3}(?:[.,]\d+)?\s*%$/.test(value)) return 'pct-loose';
  if (/^[-+]?\d+$/.test(value)) return 'int';
  return /^[-+]?\d*[.,]\d+$/.test(value) ? 'dec' : 'text';
}

function lengthBucket(length: number): string {
  if (length <= 1) return String(length);
  return length <= 3 ? '2-3' : length <= 8 ? '4-8' : '9+';
}

// Value-free counts and shapes observe the stored verdict without changing privacy decisions.
export function sensitivePixelsReasons(
  screen: Screen,
  nodes: readonly NativeNode[],
): string | undefined {
  const stored = privateScreens.get(screen);
  if (stored?.sensitivePixels !== true) return undefined;
  const values = new Set(stored.values);
  const nodeOf = new Map(nodes.map((node) => [node.ref, node]));
  const nodeAt = new Map(nodes.map((node) => [node.index, node]));
  const carriers = new Map<string | undefined, number>();
  const shapes: unknown[][] = [];
  for (const element of screen.elements) {
    const carrier =
      (element.value !== undefined && values.has(element.value)) ||
      ((element.secure || nativeLabelMayBeValue(element)) &&
        element.label !== undefined &&
        values.has(element.label));
    if (!carrier) continue;
    const node = nodeOf.get(element.ref);
    carriers.set(node?.type, (carriers.get(node?.type) ?? 0) + 1);
    const parent = node?.parentIndex === undefined ? undefined : nodeAt.get(node.parentIndex);
    shapes.push([
      shapeType(node?.type),
      labelClass(node?.label),
      valueClass(element.value),
      lengthBucket(element.value?.length ?? 0),
      node?.rect ? Math.round(node.rect.width) : null,
      node?.rect ? Math.round(node.rect.height) : null,
      parent ? shapeType(parent.type) : 'none',
      element.testID ? 1 : 0,
      element.value === undefined
        ? 'label'
        : element.value === node?.value?.trim()
          ? 'native'
          : 'react',
    ]);
  }
  return formatSensitivePixels(
    stored.values.length,
    screen.elements.filter((element) => element.secure).length,
    inputValues(screen).length,
    carriers,
    shapes,
  );
}

export function formatSensitivePixels(
  r1: number,
  secure: number,
  r3: number,
  carriers: Iterable<readonly [string | undefined, number]>,
  allShapes: readonly (readonly unknown[])[] = [],
): string {
  const counts = new Map<string, number>();
  for (const [raw, count] of carriers) {
    const type = raw !== undefined && NATIVE_TYPES.has(raw) ? raw : 'Other';
    counts.set(type, (counts.get(type) ?? 0) + count);
  }
  const types = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
  let omittedTypes = 0;
  const shapes = allShapes.slice(0, SHAPE_LIMIT);
  const line = () =>
    `sensitive-pixels ${JSON.stringify({
      v: 1,
      r1,
      secure,
      r3,
      types,
      omittedTypes,
      shapes,
      omittedShapes: allShapes.length - shapes.length,
    })}`;
  let text = line();
  while (
    Buffer.byteLength(text, 'utf8') > SENSITIVE_PIXELS_LIMIT &&
    (shapes.length || types.length)
  ) {
    if (shapes.length) shapes.pop();
    else {
      types.pop();
      omittedTypes++;
    }
    text = line();
  }
  return text;
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
    const text = [
      ...screen.visibleText,
      ...screen.elements
        .filter((element) => !element.offscreen && !element.ref.startsWith('react:'))
        .flatMap((element) => [element.label ?? '', element.value ?? '']),
    ];
    this.sensitivePixels ||= this.modelValues().some(
      (value) => !!value && text.some((line) => line.includes(value)),
    );
  }

  // A value typed where the screen cannot show us the field: mask it everywhere, even as a substring.
  concealFallback(value: string): void {
    this.concealed.add(value);
    this.substringValues.add(value);
    this.sensitivePixels = true;
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
