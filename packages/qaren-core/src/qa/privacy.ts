import type { Element, EvidenceStatus, NativeNode, Screen } from './screen.js';
import { elementFrame } from './screen.js';

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
  const privacy = new ObservedPrivacy(typed);
  privacy.observe(screen);
  return privacy.redact(text);
}

export type Provenance = 'typed' | 'observed' | 'concealed' | 'secret';

export interface PrivateValue {
  text: string;
  provenance: Provenance;
}

// Adjacent single-character boxes that render part of a protected value; the key is structural.
export interface FragmentContext {
  key: string;
  boxes: readonly string[];
  line: string;
}

export interface PrivateSet {
  values: readonly PrivateValue[];
  contexts?: readonly FragmentContext[];
  boxElements?: WeakSet<Element>;
}

// model: opaque tokens; durable: masked text; identifier: durable with typed values always masked;
// persisted: no rewrite, any hit withholds the whole artifact.
export type Policy = 'model' | 'durable' | 'identifier' | 'persisted';

const WORD = '\\p{L}\\p{M}\\p{N}_';
const TOKEN = /[\p{L}\p{M}\p{N}_.@-]+/gu;
const SHORT = 3;
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const coreOf = (token: string): string => token.replace(/^[_.@-]+|[_.@-]+$/g, '');
const chars = (text: string): number => [...text].length;
// A short non-secret value matches only between word boundaries.
const whole = (pattern: string): string => `(?<![${WORD}])${pattern}(?![${WORD}])`;

function forms(value: string): string[] {
  return [
    ...new Set(
      [value, value.trim()].flatMap((form) => [
        form,
        form.normalize('NFC'),
        form.normalize('NFD'),
      ]),
    ),
  ].filter(Boolean);
}

// Digits shown with or without grouping separators (`1234 5678 90` for `1234567890`).
const DIGIT_GAP = '[\\s.\\-\\u00a0\\u202f]';
function digitForm(value: string): string | undefined {
  const digits = value.replace(new RegExp(DIGIT_GAP, 'gu'), '');
  if (!/^\d{4,}$/.test(digits)) return undefined;
  return `(?<!\\p{N})${[...digits].join(`${DIGIT_GAP}?`)}(?!\\p{N})`;
}

interface Rule {
  pattern: string;
}

function rulesOf(value: PrivateValue, policy: Policy): Rule[] {
  return forms(value.text).map((form): Rule => {
    const escaped = escape(form);
    if (
      value.provenance === 'secret' ||
      value.provenance === 'concealed' ||
      (value.provenance === 'typed' && policy === 'identifier')
    )
      return { pattern: `[${WORD}.@-]*${escaped}[${WORD}.@-]*` };
    return { pattern: chars(form) < SHORT ? whole(escaped) : escaped };
  });
}

function rulesFor(set: PrivateSet, policy: Policy): Rule[] {
  return set.values
    .flatMap((value) => {
      const rules = rulesOf(value, policy);
      const digits = digitForm(value.text);
      return rules.length && digits ? [...rules, { pattern: digits }] : rules;
    })
    .sort((a, b) => b.pattern.length - a.pattern.length);
}

function maskFragments(text: string, set: PrivateSet): string {
  const lines = new Map<string, string>();
  for (const context of set.contexts ?? []) {
    if (!context.line) continue;
    const projected = lines.get(context.line) ?? context.line;
    lines.set(
      context.line,
      projected.replace(context.boxes.join(' | '), context.boxes.map(() => MASK).join(' | ')),
    );
  }
  let out = text;
  for (const [line, projected] of lines) out = out.split(line).join(projected);
  return out;
}

// The one matcher every sink calls; `token` names the opaque replacement of an exact model value.
export function matchPrivate(
  text: string,
  set: PrivateSet,
  policy: Policy,
  token?: (value: string) => string | undefined,
): { text: string; hit: boolean } {
  const rules = rulesFor(set, policy);
  let out = maskFragments(text, set);
  if (rules.length) {
    const pattern = new RegExp(rules.map((rule) => `(${rule.pattern})`).join('|'), 'gu');
    out = out.replace(pattern, (match) => token?.(match) ?? MASK);
  }
  return { text: out, hit: out !== text };
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
  private readonly secret = new Set<string>();
  private readonly preclassified: string[] = [];
  private readonly contexts = new Map<string, FragmentContext>();
  private readonly boxElements = new WeakSet<Element>();
  private sensitivePixels = false;

  constructor(private readonly typed: readonly string[] = []) {}

  // Plan values known before the walk (fills, a configured login block) are typed before anything streams.
  classify(values: readonly string[]): void {
    this.preclassified.push(...values.filter(Boolean));
  }

  observe(screen: Screen): void {
    this.sensitivePixels ||= privateScreens.get(screen)?.sensitivePixels === true;
    for (const value of privateScreens.get(screen)?.values ?? []) this.secret.add(value);
    for (const value of inputValues(screen)) this.observed.add(value);
    for (const value of inputValues(screen, true)) this.concealed.add(value);
    this.retainFragments(screen);
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

  // Contexts accumulate across observations: a later screen never releases an earlier box.
  private retainFragments(screen: Screen): void {
    const values = [...this.concealed, ...this.secret].flatMap(forms);
    if (!values.length) return;
    let run: Element[] = [];
    const flush = (): void => {
      for (let a = 0; a < run.length; a++)
        for (let b = run.length - 1; b > a; b--) {
          const window = run.slice(a, b + 1);
          const boxes = window.map((element) => element.label!.trim());
          if (!values.some((value) => value.includes(boxes.join('')))) continue;
          const key = window.map((element) => element.ref).join(',');
          const line = screen.visibleText.slice(0, 40).join(' | ');
          this.contexts.set(`${key}\u0000${line}`, { key, boxes, line });
          for (const element of window) this.boxElements.add(element);
          break;
        }
      run = [];
    };
    for (const element of screen.elements) {
      const box = !element.offscreen && chars(element.label?.trim() ?? '') === 1;
      const previous = run[run.length - 1];
      if (box && previous && !sameRow(previous, element)) flush();
      if (box) run.push(element);
      else flush();
    }
    flush();
  }

  // A value typed where the screen cannot show us the field: mask it everywhere, even as a substring.
  concealFallback(value: string): void {
    this.concealed.add(value);
    this.secret.add(value);
    this.sensitivePixels = true;
  }

  canScreenshot(): boolean {
    return !this.sensitivePixels;
  }

  privateSet(): PrivateSet {
    const tagged = (values: Iterable<string>, provenance: Provenance): PrivateValue[] =>
      [...new Set(values)].filter(Boolean).map((text) => ({ text, provenance }));
    return {
      values: [
        ...tagged(this.secret, 'secret'),
        ...tagged(this.concealed, 'concealed'),
        ...tagged([...this.typed, ...this.preclassified], 'typed'),
        ...tagged(this.observed, 'observed'),
      ],
      contexts: [...this.contexts.values()],
      boxElements: this.boxElements,
    };
  }

  modelValues(): string[] {
    return [...this.typed, ...this.preclassified, ...this.observed];
  }

  maskForModel(values: readonly string[], source: readonly string[]): ModelMask {
    return modelMask(values, source, this.privateSet());
  }

  redactIdentifier(text: string): string {
    return matchPrivate(text, this.privateSet(), 'identifier').text;
  }

  redact(text: string): string {
    return matchPrivate(text, this.privateSet(), 'durable').text;
  }

  // A check whose only on-screen evidence for a named character is a protected box cannot be judged.
  namesProtectedBox(text: string, screen: Screen): boolean {
    const boxes = screen.elements.filter((element) => this.boxElements.has(element));
    if (!boxes.length) return false;
    const named = new Set((text.match(TOKEN) ?? []).map(coreOf));
    const elsewhere = new Set(
      screen.elements
        .filter((element) => !this.boxElements.has(element))
        .flatMap((element) => (element.label?.match(TOKEN) ?? []).map(coreOf)),
    );
    return boxes.some((box) => {
      const char = box.label!.trim();
      return named.has(char) && !elsewhere.has(char);
    });
  }
}

function sameRow(a: Element, b: Element): boolean {
  const x = elementFrame(a);
  const y = elementFrame(b);
  if (!x || !y) return true;
  return Math.abs(x.y + x.height / 2 - (y.y + y.height / 2)) <= Math.max(x.height, y.height) / 2;
}

export interface ModelMask {
  tokens: string[];
  apply(text: string): string;
  describeElement(element: Element, render: (element: Element) => string): string;
}

export function modelMask(
  values: readonly string[],
  source: readonly string[],
  set: PrivateSet = { values: [] },
): ModelMask {
  const unique = [...new Set(values.filter(Boolean))];
  let prefix = 'QAREN_VALUE';
  while (source.some((text) => text.includes(`[${prefix}_`))) prefix += '_';
  const tokens = unique.map((_, i) => `[${prefix}_${i + 1}]`);
  const replacements = new Map(
    unique.flatMap((value, i) => forms(value).map((form) => [form, tokens[i]])),
  );
  const listed = new Set(set.values.map((value) => value.text));
  const all: PrivateSet = {
    ...set,
    values: [
      ...set.values,
      ...unique
        .filter((value) => !listed.has(value))
        .map((text) => ({ text, provenance: 'observed' as const })),
    ],
  };
  const tokenized = new Set(unique);
  const longValues = all.values
    .filter(
      (value) =>
        value.provenance === 'secret' ||
        value.provenance === 'concealed' ||
        tokenized.has(value.text),
    )
    .flatMap((value) => forms(value.text))
    .filter((value) => chars(value) >= SHORT);
  // Tokens already in the text are shielded by digit-free placeholders so no value rule rewrites them.
  const guard = (i: number): string => String.fromCharCode(0xe001, 0xe100 + i, 0xe001);
  const maskText = (text: string): string => {
    const opaque = tokens.filter((token) => text.includes(token));
    let guarded = text;
    opaque.forEach((token, i) => (guarded = guarded.split(token).join(guard(i))));
    const masked = matchPrivate(
      guarded,
      all,
      'model',
      (match) => replacements.get(match) ?? replacements.get(match.trim()),
    ).text;
    return opaque.reduce((out, token, i) => out.split(guard(i)).join(token), masked);
  };
  return {
    tokens,
    apply: maskText,
    describeElement: (element, render) => {
      if (set.boxElements?.has(element))
        return maskText(render({ ...element, label: MASK, value: undefined }));
      const testID = element.testID;
      if (!testID) return maskText(render(element));
      const placeholder = '';
      const rendered = render({ ...element, testID: placeholder });
      const masked = maskText(rendered);
      if (rendered.split(placeholder).length !== 2 || masked.split(placeholder).length !== 2)
        return maskText(render(element));
      const identifier = longValues.some((value) => testID.includes(value)) ? MASK : testID;
      return masked.replace(placeholder, () => identifier);
    },
  };
}

export function maskValues(text: string, values: readonly string[]): string {
  return matchPrivate(
    text,
    { values: values.filter(Boolean).map((value) => ({ text: value, provenance: 'typed' })) },
    'durable',
  ).text;
}

// An input shown as `name: value` whose value was typed or is secure.
export function maskInputs(screen: Screen, text: string, values?: readonly string[]): string {
  const shown = screen.elements.flatMap((el) =>
    isPossibleInput(el) && el.value && (!values || el.secure || values.includes(el.value))
      ? [{ text: el.value, provenance: 'concealed' as const }]
      : [],
  );
  return matchPrivate(text, { values: shown }, 'durable').text;
}
