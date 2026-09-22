import { createHash } from 'node:crypto';
import { captureInputPrivacy, nativeLabelMayBeValue } from './privacy.js';

export type Kind = 'button' | 'input' | 'switch' | 'link' | 'cell' | 'text' | 'image' | 'other';

export interface Element {
  ref: string;
  kind: Kind;
  label?: string;
  testID?: string;
  value?: string;
  placeholder?: string;
  hittable: boolean;
  disabled: boolean;
  secure: boolean;
  offscreen: boolean;
  where?: 'top' | 'middle' | 'bottom';
  side?: 'left' | 'center' | 'right';
}

export type Front = 'app' | 'dev-menu' | 'picker' | 'dialog';

export interface Screen {
  elements: Element[];
  visibleText: string[];
  front: Front;
}

export interface NativeNode {
  ref: string;
  label?: string;
  identifier?: string;
  type?: string;
  hittable?: boolean;
  enabled?: boolean;
  secure?: boolean;
  value?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface DigestEntry {
  role: string;
  testID?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  value?: string | boolean;
  disabled?: boolean;
}

const IOS_KINDS: Record<string, Kind> = {
  Button: 'button',
  TextField: 'input',
  SecureTextField: 'input',
  SearchField: 'input',
  TextView: 'input',
  Switch: 'switch',
  Toggle: 'switch',
  Link: 'link',
  Cell: 'cell',
  StaticText: 'text',
  Image: 'image',
};

// Most specific suffix first: ToggleButton and RadioButton must not read as Button.
const ANDROID_KINDS: Array<[string, Kind]> = [
  ['ToggleButton', 'switch'],
  ['RadioButton', 'switch'],
  ['ImageButton', 'button'],
  ['Button', 'button'],
  ['AutoCompleteTextView', 'input'],
  ['EditText', 'input'],
  ['Switch', 'switch'],
  ['CheckBox', 'switch'],
  ['TextView', 'text'],
  ['ImageView', 'image'],
];

export function kindOf(type: string | undefined): Kind {
  if (!type) return 'other';
  if (IOS_KINDS[type]) return IOS_KINDS[type];
  const leaf = type.slice(type.lastIndexOf('.') + 1);
  for (const [suffix, kind] of ANDROID_KINDS) {
    if (leaf.endsWith(suffix)) return kind;
  }
  return 'other';
}

function kindOfRole(role: string): Kind {
  switch (role.toLowerCase()) {
    case 'textinput':
    case 'search':
      return 'input';
    case 'switch':
    case 'checkbox':
    case 'radio':
    case 'togglebutton':
      return 'switch';
    case 'link':
      return 'link';
    case 'image':
    case 'imagebutton':
      return 'image';
    case 'text':
    case 'header':
      return 'text';
    default:
      return 'button';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function norm(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function digestValue(value: string | boolean | undefined): string | undefined {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return nonEmpty(value);
}

function thirds(center: number, extent: number, names: readonly [string, string, string]): string {
  if (extent <= 0) return names[1];
  const ratio = center / extent;
  return ratio < 1 / 3 ? names[0] : ratio < 2 / 3 ? names[1] : names[2];
}

// Native nodes own visibility; unmatched React entries supply off-screen candidates.
export function join(nodes: NativeNode[], digest: DigestEntry[], front: Front = 'app'): Screen {
  let width = 0;
  let height = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    width = Math.max(width, n.rect.x + n.rect.width);
    height = Math.max(height, n.rect.y + n.rect.height);
  }
  const used = new Set<number>();
  const elements: Element[] = nodes.map((n) => {
    const testID = nonEmpty(n.identifier);
    const label = nonEmpty(n.label);
    let match: DigestEntry | undefined;
    for (let i = 0; i < digest.length; i += 1) {
      if (used.has(i)) continue;
      const d = digest[i];
      const byId = testID !== undefined && d.testID === testID;
      const byLabel =
        !byId &&
        label !== undefined &&
        d.testID === undefined &&
        norm(d.text ?? d.label) === norm(label);
      if (byId || byLabel) {
        used.add(i);
        match = d;
        break;
      }
    }
    let kind = kindOf(n.type);
    if (kind === 'other' && match) kind = kindOfRole(match.role);
    const element: Element = {
      ref: n.ref,
      kind,
      hittable: n.hittable === true,
      disabled: n.enabled === false || match?.disabled === true,
      secure: n.secure === true || n.type === 'SecureTextField',
      offscreen: false,
    };
    if (label) element.label = label;
    if (testID) element.testID = testID;
    if (kind === 'input')
      captureInputPrivacy(element, {
        values: [nonEmpty(n.value), digestValue(match?.value)].filter(
          (value): value is string => !!value,
        ),
        nativeLabelMayBeValue: ANDROID_KINDS.some(
          ([suffix, kind]) => kind === 'input' && n.type?.endsWith(suffix),
        ),
      });
    // Secure values stay in private boundary data, never in the public value property.
    const value = element.secure ? undefined : (digestValue(match?.value) ?? nonEmpty(n.value));
    if (value !== undefined) element.value = value;
    const placeholder = nonEmpty(match?.placeholder);
    if (placeholder) element.placeholder = placeholder;
    if (n.rect) {
      element.where = thirds(n.rect.y + n.rect.height / 2, height, [
        'top',
        'middle',
        'bottom',
      ]) as Element['where'];
      element.side = thirds(n.rect.x + n.rect.width / 2, width, [
        'left',
        'center',
        'right',
      ]) as Element['side'];
    }
    return element;
  });
  digest.forEach((d, i) => {
    if (used.has(i) || !d.testID) return;
    const element: Element = {
      ref: `react:${d.testID}`,
      kind: kindOfRole(d.role),
      testID: d.testID,
      hittable: false,
      disabled: d.disabled === true,
      secure: false,
      offscreen: true,
    };
    const label = nonEmpty(d.text ?? d.label);
    if (label) element.label = label;
    const placeholder = nonEmpty(d.placeholder);
    if (placeholder) element.placeholder = placeholder;
    const value = digestValue(d.value);
    if (value !== undefined) element.value = value;
    elements.push(element);
  });

  const ordered = nodes
    .map((n, i) => ({ n, i, e: elements[i] }))
    .sort((a, b) => {
      const ay = a.n.rect?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.n.rect?.y ?? Number.MAX_SAFE_INTEGER;
      if (ay !== by) return ay - by;
      const ax = a.n.rect?.x ?? 0;
      const bx = b.n.rect?.x ?? 0;
      return ax !== bx ? ax - bx : a.i - b.i;
    });
  // Image and container labels are accessibility-only, not assertion evidence.
  const visibleText: string[] = [];
  for (const { e } of ordered) {
    if (e.kind === 'image' || e.kind === 'other') continue;
    const line =
      e.kind === 'input'
        ? e.value !== undefined
          ? `${e.label ?? e.placeholder ?? e.testID ?? 'input'}: ${e.value}`
          : e.label
        : e.label;
    if (line && visibleText[visibleText.length - 1] !== line) visibleText.push(line);
  }
  return { elements, visibleText, front };
}

export function actionView(screen: Screen): Element[] {
  return screen.elements.filter((e) => !e.disabled && (e.offscreen || e.hittable));
}

export function assertionView(screen: Screen): string[] {
  return screen.visibleText;
}

export function describe(e: Element): string {
  const parts = [e.kind.charAt(0).toUpperCase() + e.kind.slice(1)];
  if (e.label) parts.push(`"${e.label}"`);
  if (e.testID) parts.push(`[testID ${e.testID}]`);
  if (e.placeholder) parts.push(`placeholder "${e.placeholder}"`);
  if (!e.secure && e.value !== undefined) parts.push(`value "${e.value}"`);
  if (e.offscreen) parts.push('off screen');
  else if (e.where && e.side) parts.push(e.side === 'center' ? e.where : `${e.where}-${e.side}`);
  if (e.disabled) parts.push('disabled');
  return parts.join(' ');
}

// Compare content and layout, excluding secure input text and snapshot refs.
export function screenSignature(screen: Screen): string {
  const secureLines = new Set(
    screen.elements
      .filter((e) => e.secure)
      .flatMap((e) => [
        e.label,
        `${e.label ?? e.placeholder ?? e.testID ?? 'input'}: ${e.value ?? ''}`,
      ]),
  );
  const signature = JSON.stringify({
    front: screen.front,
    text: screen.visibleText.filter((text) => !secureLines.has(text)),
    elements: screen.elements
      .filter((e) => e.label !== undefined || e.testID !== undefined || e.value !== undefined)
      .map((e) => [
        e.kind,
        e.secure && nativeLabelMayBeValue(e) ? null : (e.label ?? null),
        e.testID ?? null,
        e.secure ? null : (e.value ?? null),
        e.hittable,
        e.disabled,
        e.offscreen,
        e.where ?? null,
        e.side ?? null,
      ]),
  });
  return createHash('sha256').update(signature).digest('hex');
}

export function frontFromSurface(surface: string | undefined, nodes: NativeNode[]): Front {
  if (nodes[0]?.type === 'Alert') return 'dialog';
  switch (surface) {
    case 'expo_dev_menu':
    case 'react_native_dev_menu':
      return 'dev-menu';
    case 'dev_client_picker':
    case 'first_run_tutorial':
      return 'picker';
    default:
      return 'app';
  }
}
