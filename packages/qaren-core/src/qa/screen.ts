import { isRecord } from './questions.js';
import { createHash } from 'node:crypto';
import { captureInputPrivacy, nativeLabelMayBeValue } from './privacy.js';
import { PRIVATE_INPUT_LIMITS } from './private-input-limits.js';
import type { NativePresence, NativePresenceNode } from './native-presence.js';
import { associateHeadings, validateHostTypography } from './host-typography.js';
import type { HeadingEvidence, HostTypography } from './host-typography.js';
import { associateHosts } from './host-association.js';

export type Kind = 'button' | 'input' | 'switch' | 'link' | 'cell' | 'text' | 'image' | 'other';
export type EvidenceStatus = 'supported' | 'unsupported' | 'unknown';
export type Visibility = 'visible' | 'offscreen' | 'hidden' | 'unknown';

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
  semantic?: {
    press: EvidenceStatus;
    fill: EvidenceStatus;
    visibility: Visibility;
    disabled?: boolean;
    heading?: HeadingEvidence;
    nativePresence?: {
      kind: Kind;
      labelSource: NativePresenceNode['labelSource'];
      structural: boolean;
    };
  };
}

export type Front = 'app' | 'dev-menu' | 'picker' | 'dialog';

export interface Screen {
  elements: Element[];
  visibleText: string[];
  front: Front;
  semanticUnassociatedReact?: number;
  coverage?: {
    native: 'complete' | 'incomplete' | 'unknown';
    react: 'complete' | 'incomplete' | 'unknown';
  };
  captureCoverage?: Screen['coverage'];
  reactHostEvidence?: ReactHostEvidence;
}

export interface NativeNode {
  ref: string;
  index?: number;
  parentIndex?: number;
  depth?: number;
  presence?: unknown;
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
  capabilities?: { press: boolean; fill: boolean };
}

export interface ReactHostObservation {
  testID?: string;
  nativeID?: string;
  role: string | null;
  roleSource: 'role' | 'accessibilityRole' | 'none';
  capabilities: { press?: true; fill?: true };
  disabled?: true;
  readOnly?: true;
}

export interface ReactHostEvidence {
  hosts: ReactHostObservation[];
  complete: boolean;
  typography?: HostTypography;
}

export function validateReactHostEvidence(value: unknown): ReactHostEvidence | undefined {
  if (
    !isRecord(value) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.hosts) ||
    value.hosts.length > PRIVATE_INPUT_LIMITS.maxHosts ||
    (value.complete && value.hosts.length === PRIVATE_INPUT_LIMITS.maxHosts)
  )
    return undefined;
  const hosts: ReactHostObservation[] = [];
  for (const host of value.hosts) {
    if (
      !isRecord(host) ||
      (host.roleSource !== 'role' &&
        host.roleSource !== 'accessibilityRole' &&
        host.roleSource !== 'none') ||
      (host.role !== null &&
        (typeof host.role !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(host.role))) ||
      (host.roleSource === 'none' && host.role !== null) ||
      (value.complete && host.roleSource !== 'none' && host.role === null) ||
      !isRecord(host.capabilities) ||
      Object.entries(host.capabilities).some(
        ([key, fact]) => !['press', 'fill'].includes(key) || fact !== true,
      ) ||
      ['testID', 'nativeID'].some(
        (key) => host[key] !== undefined && typeof host[key] !== 'string',
      ) ||
      ['disabled', 'readOnly'].some((key) => host[key] !== undefined && host[key] !== true)
    )
      return undefined;
    hosts.push({
      role: host.role as string | null,
      roleSource: host.roleSource as ReactHostObservation['roleSource'],
      capabilities: { ...host.capabilities },
      ...(host.testID !== undefined ? { testID: host.testID as string } : {}),
      ...(host.nativeID !== undefined ? { nativeID: host.nativeID as string } : {}),
      ...(host.disabled === true ? { disabled: true } : {}),
      ...(host.readOnly === true ? { readOnly: true } : {}),
    });
  }
  const typography =
    value.typography === undefined
      ? undefined
      : validateHostTypography(value.typography, hosts.length);
  if (value.typography !== undefined && !typography) return undefined;
  return { hosts, complete: value.complete, ...(typography ? { typography } : {}) };
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

function nativeCapabilities(kind: Kind): Pick<NonNullable<Element['semantic']>, 'press' | 'fill'> {
  return {
    press: kind === 'button' || kind === 'switch' || kind === 'link' ? 'supported' : 'unknown',
    fill: kind === 'input' ? 'supported' : kind === 'other' ? 'unknown' : 'unsupported',
  };
}

function idCounts(ids: Array<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// Legacy offscreen flags are compatibility data, not semantic visibility evidence.
export function join(
  nodes: NativeNode[],
  digest: DigestEntry[],
  front: Front = 'app',
  coverage?: Screen['coverage'],
  reactHostEvidence?: ReactHostEvidence,
  nativePresence?: NativePresence | 'unknown',
): Screen {
  const presenceMode =
    nativePresence !== undefined || nodes.some((node) => Object.hasOwn(node, 'presence'));
  const nativeIds = idCounts(nodes.map((n) => nonEmpty(n.identifier)));
  const reactIds = idCounts(digest.map((d) => d.testID));
  const hasPositiveHostFill = (id: string | undefined): boolean =>
    id !== undefined &&
    (reactHostEvidence?.hosts.some(
      (host) => host.capabilities.fill === true && (host.testID === id || host.nativeID === id),
    ) ??
      false);
  const presence = nativePresence === 'unknown' ? undefined : nativePresence;
  const associations = associateHosts(nodes, reactHostEvidence, presence);
  const associatedHosts = new Map(
    [...associations].map(([hostIndex, { nativeIndex }]) => [
      nativeIndex,
      reactHostEvidence!.hosts[hostIndex],
    ]),
  );
  const headings = associateHeadings(nodes, reactHostEvidence, presence, associations);
  let width = 0;
  let height = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    width = Math.max(width, n.rect.x + n.rect.width);
    height = Math.max(height, n.rect.y + n.rect.height);
  }
  const used = new Set<number>();
  let semanticUnassociatedReact = digest.length;
  const elements: Element[] = nodes.map((n, nodeIndex) => {
    const observed = nativePresence === 'unknown' ? undefined : nativePresence?.nodes[nodeIndex];
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
    const nativeKind = kind;
    const capabilities = nativeCapabilities(kind);
    const host = associatedHosts.get(nodeIndex);
    if (host?.capabilities.press === true) capabilities.press = 'supported';
    if (host?.capabilities.fill === true) capabilities.fill = 'supported';
    const uniqueIdentity =
      testID !== undefined &&
      n.identifier === testID &&
      nativeIds.get(testID) === 1 &&
      reactIds.get(testID) === 1;
    const uniqueMatch = uniqueIdentity && match?.testID === testID;
    if (uniqueMatch || (uniqueIdentity && host?.testID === testID)) semanticUnassociatedReact -= 1;
    if (uniqueMatch) {
      if (!presenceMode && match?.capabilities?.press === true) capabilities.press = 'supported';
      if (!presenceMode && match?.capabilities?.fill === true) capabilities.fill = 'supported';
    }
    if (!presenceMode && kind === 'other' && match) kind = kindOfRole(match.role);
    const element: Element = {
      ref: n.ref,
      kind,
      hittable: n.hittable === true,
      disabled: n.enabled === false || match?.disabled === true,
      secure: n.secure === true || n.type === 'SecureTextField',
      offscreen: false,
      semantic: {
        ...capabilities,
        ...(headings.has(nodeIndex) ? { heading: headings.get(nodeIndex)! } : {}),
        visibility: observed?.status === 'observed' ? 'visible' : 'unknown',
        disabled:
          n.enabled === false ||
          host?.disabled === true ||
          host?.readOnly === true ||
          (!presenceMode && uniqueMatch && match?.disabled === true),
        ...(observed
          ? {
              nativePresence: {
                kind: nativeKind,
                labelSource: observed.labelSource,
                structural: n.type === 'Application' || n.type === 'Window',
              },
            }
          : {}),
      },
    };
    if (label) element.label = label;
    if (testID) element.testID = testID;
    const privateNativeLabel = presenceMode && observed?.labelSource !== 'direct';
    // Privacy may over-associate input observations without granting semantic capabilities.
    const privacyCandidates = digest.filter(
      (d) =>
        (testID !== undefined && d.testID === testID) ||
        (d.testID === undefined && label !== undefined && norm(d.text ?? d.label) === norm(label)),
    );
    const possibleDigestInput = privacyCandidates.some(
      (d) => kindOfRole(d.role) === 'input' || d.capabilities?.fill === true,
    );
    if (
      nativeKind === 'input' ||
      kind === 'input' ||
      element.secure ||
      possibleDigestInput ||
      hasPositiveHostFill(testID)
    )
      captureInputPrivacy(element, {
        checkSubject:
          nativeKind === 'input' ||
          host?.capabilities.fill === true ||
          (!presenceMode && uniqueMatch && match?.capabilities?.fill === true)
            ? 'supported'
            : nativeKind === 'text' &&
                n.value === undefined &&
                !hasPositiveHostFill(testID) &&
                !uniqueMatch
              ? 'unsupported'
              : 'unknown',
        values: [
          nonEmpty(n.value),
          digestValue(match?.value),
          ...privacyCandidates.map((d) => digestValue(d.value)),
          ...(privateNativeLabel ? [label] : []),
        ].filter((value): value is string => !!value),
        nativeLabelMayBeValue:
          privateNativeLabel ||
          ANDROID_KINDS.some(([suffix, kind]) => kind === 'input' && n.type?.endsWith(suffix)),
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
    if (
      nativeIds.get(d.testID) === 1 &&
      reactIds.get(d.testID) === 1 &&
      [...associatedHosts.values()].some((host) => host.testID === d.testID)
    )
      return;
    const element: Element = {
      ref: `react:${d.testID}`,
      kind: kindOfRole(d.role),
      testID: d.testID,
      hittable: false,
      disabled: d.disabled === true,
      secure: false,
      offscreen: true,
      semantic: {
        press: !presenceMode && d.capabilities?.press === true ? 'supported' : 'unknown',
        fill: !presenceMode && d.capabilities?.fill === true ? 'supported' : 'unknown',
        visibility: 'unknown',
        disabled: !presenceMode && d.disabled === true,
      },
    };
    const label = nonEmpty(d.text ?? d.label);
    if (label) element.label = label;
    const placeholder = nonEmpty(d.placeholder);
    if (placeholder) element.placeholder = placeholder;
    const value = digestValue(d.value);
    if (value !== undefined) element.value = value;
    if (element.kind === 'input' || d.capabilities?.fill === true || hasPositiveHostFill(d.testID))
      captureInputPrivacy(element, {
        checkSubject: 'unknown',
        values: value ? [value] : [],
        nativeLabelMayBeValue: false,
      });
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
  return {
    elements,
    visibleText,
    front,
    semanticUnassociatedReact,
    ...(coverage ? { coverage } : {}),
    ...(reactHostEvidence ? { reactHostEvidence } : {}),
  };
}

export function actionView(screen: Screen): Element[] {
  return screen.elements.filter((e) => !e.disabled && (e.offscreen || e.hittable));
}

export function assertionView(screen: Screen): string[] {
  return screen.visibleText;
}

type Projection = { elements: Element[] } | { refuse: string; reason: string };

function incomplete(reason: string): { refuse: string; reason: string } {
  return { refuse: 'SCREEN_EVIDENCE_INCOMPLETE', reason };
}

function projectionRefusal(screen: Screen): { refuse: string; reason: string } | undefined {
  if (new Set(screen.elements.map((e) => e.ref)).size !== screen.elements.length)
    return { refuse: 'AMBIGUOUS_REFS', reason: 'screen references are not unique' };
  if (screen.coverage?.native !== 'complete' || screen.coverage.react !== 'complete')
    return incomplete('semantic projection requires complete native and React coverage');
  if ((screen.semanticUnassociatedReact ?? 0) > 0)
    return incomplete('React observations lack a proven unique native association');
  return undefined;
}

export function semanticDisabled(element: Element): boolean {
  return element.semantic?.disabled ?? element.disabled;
}

export function semanticActionView(screen: Screen, kind: 'press' | 'fill'): Projection {
  const refusal = projectionRefusal(screen);
  if (refusal) return refusal;
  const elements: Element[] = [];
  for (const e of screen.elements) {
    if (e.semantic?.nativePresence?.structural) continue;
    if (semanticDisabled(e)) continue;
    if (!e.semantic) return incomplete('an observation has no semantic facts');
    if (e.semantic.visibility === 'hidden' || e.semantic[kind] === 'unsupported') continue;
    if (e.semantic[kind] !== 'supported')
      return incomplete('an observation has unknown operation capability');
    if (e.semantic.nativePresence && e.semantic.visibility !== 'visible')
      return incomplete('a native control lacks positive platform presence');
    if (e.semantic.visibility !== 'offscreen' && !e.hittable)
      return incomplete('a supported control has neither a hit hint nor offscreen evidence');
    elements.push(e);
  }
  return { elements };
}

export function visibilityView(screen: Screen): Projection {
  const refusal = projectionRefusal(screen);
  if (refusal) return refusal;
  const elements: Element[] = [];
  for (const e of screen.elements) {
    if (!e.semantic) return incomplete('an observation has no semantic facts');
    const native = e.semantic.nativePresence;
    if (native?.structural) continue;
    if (e.semantic.visibility === 'hidden' || e.semantic.visibility === 'offscreen') continue;
    const control =
      ['button', 'input', 'switch', 'link', 'cell'].includes(native?.kind ?? e.kind) ||
      e.semantic.press === 'supported' ||
      e.semantic.fill === 'supported';
    const content = [e.label, e.value, e.placeholder].some(
      (value) => nonEmpty(value) !== undefined,
    );
    if (
      !control &&
      !content &&
      !nonEmpty(e.testID) &&
      e.semantic.press === 'unsupported' &&
      e.semantic.fill === 'unsupported'
    )
      continue;
    if (e.semantic.visibility !== 'visible')
      return incomplete('a possible assertion contribution has unknown visibility');
    if (native && native.labelSource !== 'direct' && native.labelSource !== 'none')
      return incomplete(
        'a native label is derived from a value or descendant, not an independent name',
      );
    const kind = native?.kind ?? e.kind;
    if (!control && !((kind === 'text' || kind === 'input') && content))
      return incomplete('an observation is not proven readable content or an identified control');
    elements.push(e);
  }
  return { elements };
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
