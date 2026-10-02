import { isRecord } from './questions.js';
import type { NativeNode } from './screen.js';

export const NATIVE_PRESENCE_UNKNOWN_REASONS = [
  'empty-frame',
  'clipped',
  'ambiguous-descriptor',
  'not-hittable',
  'read-unavailable',
  'match-count-mismatch',
  'post-hit-mismatch',
] as const;

export interface NativePresenceNode {
  status: 'observed' | 'unknown';
  labelSource: 'direct' | 'value' | 'descendant' | 'none';
  unknownReason?: (typeof NATIVE_PRESENCE_UNKNOWN_REASONS)[number];
}

export interface NativePresence {
  source: 'xcui-live';
  nodes: NativePresenceNode[];
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateNativePresence(
  capture: unknown,
  nodes: NativeNode[],
  generation: unknown,
  expectedAppId: string | undefined,
  requestedBudgetMs: unknown,
): NativePresence | undefined {
  if (
    !Number.isSafeInteger(requestedBudgetMs) ||
    typeof requestedBudgetMs !== 'number' ||
    requestedBudgetMs <= 0 ||
    !isRecord(capture) ||
    capture.version !== 2 ||
    capture.appliedBudgetMs !== requestedBudgetMs ||
    capture.source !== 'xcui-live' ||
    capture.enumeration !== 'raw-unfiltered' ||
    capture.complete !== true ||
    !expectedAppId ||
    capture.appId !== expectedAppId ||
    typeof capture.captureId !== 'string' ||
    !capture.captureId ||
    capture.captureId.length > 128 ||
    !Number.isSafeInteger(generation) ||
    typeof generation !== 'number' ||
    generation < 1 ||
    capture.generation !== generation ||
    !finite(capture.startedUptimeMs) ||
    capture.startedUptimeMs < 0 ||
    !finite(capture.endedUptimeMs) ||
    capture.endedUptimeMs < capture.startedUptimeMs ||
    capture.endedUptimeMs - capture.startedUptimeMs >= requestedBudgetMs ||
    nodes.length === 0 ||
    nodes.length > 600 ||
    nodes[0].type !== 'Application' ||
    nodes[0].depth !== 0 ||
    nodes[0].parentIndex !== undefined ||
    new Set(nodes.map((node) => node.ref)).size !== nodes.length
  )
    return undefined;
  const observations: NativePresenceNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const p = node.presence;
    const parent = node.parentIndex;
    if (
      node.index !== index ||
      typeof node.type !== 'string' ||
      !node.type ||
      typeof node.enabled !== 'boolean' ||
      (index > 0 &&
        (parent === undefined ||
          !Number.isSafeInteger(parent) ||
          parent < 0 ||
          parent >= index ||
          node.depth !== nodes[parent].depth! + 1)) ||
      !node.rect ||
      !Object.values(node.rect).every(finite) ||
      !finite(node.rect.x) ||
      !finite(node.rect.y) ||
      !finite(node.rect.width) ||
      !finite(node.rect.height) ||
      node.rect.width < 0 ||
      node.rect.height < 0 ||
      !isRecord(p) ||
      p.captureId !== capture.captureId ||
      p.generation !== generation ||
      p.nodeIndex !== index ||
      (p.status !== 'observed' && p.status !== 'unknown') ||
      (p.labelSource !== 'direct' &&
        p.labelSource !== 'value' &&
        p.labelSource !== 'descendant' &&
        p.labelSource !== 'none') ||
      (p.status === 'observed' &&
        (!finite(p.observedUptimeMs) ||
          p.observedUptimeMs < capture.startedUptimeMs ||
          p.observedUptimeMs > capture.endedUptimeMs ||
          node.rect.width === 0 ||
          node.rect.height === 0)) ||
      (p.status === 'unknown' && p.observedUptimeMs !== undefined)
    )
      return undefined;
    const unknownReason =
      p.status === 'unknown'
        ? NATIVE_PRESENCE_UNKNOWN_REASONS.find((reason) => reason === p.unknownReason)
        : undefined;
    observations.push({
      status: p.status,
      labelSource: p.labelSource,
      ...(unknownReason ? { unknownReason } : {}),
    });
  }
  return { source: 'xcui-live', nodes: observations };
}

type Rect = NonNullable<NativeNode['rect']>;

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function clip(a: Rect, b: Rect | undefined): Rect {
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

// Texts of a verified capture indistinguishable from their parent text, as XCUI reports React Native text.
export function duplicateNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  const duplicates = new Set<number>();
  if (!presence) return duplicates;
  const key = (i: number) => {
    const n = nodes[i];
    return JSON.stringify([
      n.type,
      n.identifier ?? '',
      n.label ?? '',
      n.value ?? null,
      n.rect ? [n.rect.x, n.rect.y, n.rect.width, n.rect.height] : null,
      n.enabled,
      n.hittable,
      n.secure,
      presence.nodes[i]?.status,
      presence.nodes[i]?.labelSource,
    ]);
  };
  nodes.forEach((n, i) => {
    const parent = n.parentIndex;
    if (n.type === 'StaticText' && parent !== undefined && parent < i && key(parent) === key(i))
      duplicates.add(i);
  });
  return duplicates;
}

// An observed title of a verified capture that a navigation bar is named after; iOS exposes it as the bar's header.
export function navigationTitles(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Map<number, { kind: 'navigation-title'; barRef: string }> {
  const titles = new Map<number, { kind: 'navigation-title'; barRef: string }>();
  if (!presence) return titles;
  nodes.forEach((bar, b) => {
    const name = bar.identifier?.trim();
    if (bar.type !== 'NavigationBar' || !name) return;
    // A bar may hold a hidden twin of its title, as iOS large titles do; exactly one may be observed.
    const observed = nodes.flatMap((n, i) =>
      n.parentIndex === b &&
      n.type === 'StaticText' &&
      n.label === bar.identifier &&
      presence.nodes[i]?.status === 'observed' &&
      presence.nodes[i].labelSource === 'direct'
        ? [i]
        : [],
    );
    if (observed.length === 1)
      titles.set(observed[0], { kind: 'navigation-title', barRef: bar.ref });
  });
  return titles;
}

// Unidentified views of a verified capture repeated identically beside each other directly under a
// scroll view, as XCUI reports the platform's scroll indicators.
export function scrollChromeNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  const chrome = new Set<number>();
  if (!presence) return chrome;
  const key = (n: NativeNode) =>
    JSON.stringify([
      n.parentIndex,
      n.label ?? '',
      n.value ?? null,
      n.rect ? [n.rect.x, n.rect.y, n.rect.width, n.rect.height] : null,
      n.enabled,
    ]);
  const counts = new Map<string, number>();
  const candidate = (n: NativeNode) =>
    n.type === 'Other' &&
    !n.identifier &&
    n.parentIndex !== undefined &&
    nodes[n.parentIndex]?.type === 'ScrollView';
  for (const n of nodes) if (candidate(n)) counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  nodes.forEach((n, i) => {
    if (candidate(n) && counts.get(key(n))! > 1) chrome.add(i);
  });
  return chrome;
}

// Unobserved nodes of a verified capture lying wholly outside the window or a scroll view ancestor.
export function offscreenNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  if (!presence) return new Set();
  return new Set(
    [...outsideViewport(nodes)].filter((i) => presence.nodes[i]?.status === 'unknown'),
  );
}

// Only a single sized Window proves the viewport; without one nothing is claimed off screen.
export function outsideViewport(nodes: NativeNode[]): Set<number> {
  const offscreen = new Set<number>();
  const windows = nodes.flatMap((node, i) => (node.type === 'Window' ? [i] : []));
  const window = windows.length === 1 ? nodes[windows[0]].rect : undefined;
  if (!window || window.width <= 0 || window.height <= 0) return offscreen;
  nodes.forEach((node, i) => {
    if (!node.rect || node.rect.width <= 0 || node.rect.height <= 0) return;
    let visible = window;
    let parent = node.parentIndex;
    for (
      let hops = 0;
      parent !== undefined && parent !== windows[0] && hops < nodes.length;
      hops++
    ) {
      if (nodes[parent]?.type === 'ScrollView') visible = clip(visible, nodes[parent].rect);
      parent = nodes[parent]?.parentIndex;
    }
    if (parent === windows[0] && !overlaps(node.rect, visible)) offscreen.add(i);
  });
  return offscreen;
}
