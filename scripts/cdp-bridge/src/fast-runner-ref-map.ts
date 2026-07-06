import { hashSnapshotNodes } from './lifecycle/settle-hash.js';

interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SnapshotNode {
  ref: string;
  rect: ElementRect;
  label?: string;
  identifier?: string;
  type?: string;
  enabled?: boolean;
  hittable?: boolean;
}

export interface FlatNode {
  ref: string;
  type: string;
  label?: string;
  identifier?: string;
  rect: ElementRect;
  enabled?: boolean;
  hittable?: boolean;
}

interface XCUITreeNode {
  type?: string;
  identifier?: string;
  label?: string;
  frame?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
  children?: XCUITreeNode[];
}

interface RefMetadata {
  type: string;
  label?: string;
  identifier?: string;
}

export interface RefSignature {
  type: string;
  label?: string;
  identifier?: string;
  flatIndex: number;
  nodeCount: number;
}

interface StoredRefRecord extends RefMetadata {
  flatIndex: number;
  nodeCount: number;
}

let refMap = new Map<string, ElementRect>();
let metadataMap = new Map<string, StoredRefRecord>();
let screenRect: ElementRect | null = null;
let lastUpdated = 0;
let lastSnapshotHash: string | null = null;

export function updateRefMap(nodes: SnapshotNode[]): void {
  refMap.clear();
  screenRect = null;

  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    refMap.set(node.ref, node.rect);

    // Largest (0,0)-anchored rect wins: with interactive windows in the
    // Android snapshot (#370), the status bar (0,0,w,~156) precedes the app
    // window, and first-match sent direction gestures into the status bar
    // (#387 Phase B device-proven).
    if (node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
      if (
        !screenRect ||
        node.rect.width * node.rect.height > screenRect.width * screenRect.height
      ) {
        screenRect = node.rect;
      }
    }
  }

  lastUpdated = Date.now();
}

export function lookupRef(ref: string): ElementRect | null {
  const clean = ref.startsWith('@') ? ref.slice(1) : ref;
  return refMap.get(clean) ?? null;
}

export function refCenter(ref: string): { x: number; y: number } | null {
  const rect = lookupRef(ref);
  if (!rect) return null;
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

export function getScreenRect(): ElementRect | null {
  return screenRect;
}

export function getRefMapAge(): number {
  return lastUpdated ? Date.now() - lastUpdated : Infinity;
}

// A @ref resolves to fixed coordinates captured at snapshot time. If the
// snapshot is old, the UI may have scrolled/re-rendered and those coordinates
// now point at a different element — a wrong-element tap that STALE_REF (which
// only fires on absent refs) would not catch. Callers gate coordinate
// resolution on this so an over-age map is treated like a stale ref.
export const MAX_REF_MAP_AGE_MS = 60_000;

export function isRefMapFresh(maxAgeMs: number = MAX_REF_MAP_AGE_MS): boolean {
  return getRefMapAge() <= maxAgeMs;
}

export function clearRefMap(): void {
  refMap.clear();
  metadataMap.clear();
  screenRect = null;
  lastUpdated = 0;
  lastSnapshotHash = null;
}

export function hasRefMap(): boolean {
  return refMap.size > 0;
}

export function flattenXCUITree(tree: XCUITreeNode): {
  nodes: FlatNode[];
  refMap: Map<string, ElementRect>;
} {
  const nodes: FlatNode[] = [];
  const localRefMap = new Map<string, ElementRect>();
  let counter = 0;

  const walk = (node: XCUITreeNode | undefined | null): void => {
    if (!node || typeof node !== 'object') return;
    if (node.frame) {
      const id = `e${counter}`;
      counter++;
      const rect: ElementRect = {
        x: node.frame.x,
        y: node.frame.y,
        width: node.frame.width,
        height: node.frame.height,
      };
      const flat: FlatNode = {
        ref: `@${id}`,
        type: node.type ?? '',
        rect,
      };
      if (node.label !== undefined) flat.label = node.label;
      if (node.identifier !== undefined) flat.identifier = node.identifier;
      if (node.enabled !== undefined) flat.enabled = node.enabled;
      if (node.hittable !== undefined) flat.hittable = node.hittable;
      nodes.push(flat);
      localRefMap.set(id, rect);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  };

  walk(tree);
  return { nodes, refMap: localRefMap };
}

export function updateRefMapFromFlat(nodes: FlatNode[]): void {
  // refMap IS cleared (coordinates must never be served across generations —
  // only the CURRENT snapshot is tappable), but metadataMap is NOT: ref ids are
  // positional, so ids absent from this snapshot cannot collide with current
  // ones; retaining their signatures (with their ORIGIN generation's
  // flatIndex/nodeCount) lets a later stale tap heal by identity after a
  // re-render (Story 05 acceptance: dense→sparse→tap-original-ref, #386).
  // Colliding keys are overwritten by metadataMap.set below.
  refMap.clear();
  screenRect = null;

  const hashed: FlatNode[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    refMap.set(key, node.rect);

    const meta: StoredRefRecord = { type: node.type, flatIndex: i, nodeCount: nodes.length };
    if (node.label !== undefined) meta.label = node.label;
    if (node.identifier !== undefined) meta.identifier = node.identifier;
    metadataMap.set(key, meta);
    hashed.push(node);

    if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
      screenRect = node.rect;
    }
  }

  // Hash only the nodes that passed the ref/rect filter: hashSnapshotNodes
  // dereferences node.rect.* unconditionally, and a malformed entry must not
  // throw mid-update. For real runner data the filtered subset equals the full
  // array (both mappers pre-filter !rect), so comparability with the settle
  // probes is preserved. Fail-open on hash error (matches settle.ts).
  try {
    lastSnapshotHash = hashSnapshotNodes(hashed);
  } catch {
    lastSnapshotHash = null;
  }
  lastUpdated = Date.now();
}

export function getCachedMetadata(ref: string): RefMetadata | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const meta: RefMetadata = { type: rec.type };
  if (rec.label !== undefined) meta.label = rec.label;
  if (rec.identifier !== undefined) meta.identifier = rec.identifier;
  return meta;
}

export function getCachedSignature(ref: string): RefSignature | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  const rec = metadataMap.get(key);
  if (!rec) return null;
  const sig: RefSignature = {
    type: rec.type,
    flatIndex: rec.flatIndex,
    nodeCount: rec.nodeCount,
  };
  if (rec.label !== undefined) sig.label = rec.label;
  if (rec.identifier !== undefined) sig.identifier = rec.identifier;
  return sig;
}

export function getLastSnapshotHash(): string | null {
  return lastSnapshotHash;
}

// Story 05 (#386): called when a mutating verb settles without any hash
// observation — the screen may have changed unobserved, so the baseline must
// not be compared against. Fail-open beats fail-wrong.
export function invalidateLastSnapshotHash(): void {
  lastSnapshotHash = null;
}

function metadataMatches(a: RefMetadata, b: RefMetadata): boolean {
  return a.type === b.type && a.label === b.label && a.identifier === b.identifier;
}

function flatNodeMetadata(node: FlatNode): RefMetadata {
  const meta: RefMetadata = { type: node.type };
  if (node.label !== undefined) meta.label = node.label;
  if (node.identifier !== undefined) meta.identifier = node.identifier;
  return meta;
}

export function isRefStale(ref: string, newNodes: FlatNode[]): boolean {
  const cached = getCachedMetadata(ref);
  if (!cached) return true;
  const target = ref.startsWith('@') ? ref : `@${ref}`;
  const fresh = newNodes.find((n) => n.ref === target);
  if (!fresh) return true;
  return !metadataMatches(cached, flatNodeMetadata(fresh));
}

export function findNewRefByMetadata(oldRef: string, newNodes: FlatNode[]): string | null {
  const cached = getCachedMetadata(oldRef);
  if (!cached) return null;
  for (const node of newNodes) {
    if (metadataMatches(cached, flatNodeMetadata(node))) {
      return node.ref;
    }
  }
  return null;
}

export function flattenAndroidAccessibilityTree(nodes: FlatNode[]): {
  nodes: FlatNode[];
  refMap: Map<string, { x: number; y: number; width: number; height: number }>;
} {
  const localRefMap = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    localRefMap.set(key, node.rect);
  }
  return { nodes, refMap: localRefMap };
}

export type RefreshOutcome =
  | { kind: 'unique'; node: FlatNode }
  | { kind: 'ambiguous'; candidates: FlatNode[] }
  | { kind: 'absent' };

function identityMatches(sig: RefSignature, node: FlatNode): boolean {
  return node.type === sig.type && node.label === sig.label && node.identifier === sig.identifier;
}

// Story 05 (#386): re-bind a stale ref to the live tree by identity attrs
// (type/label/identifier — bounds excluded; enabled/hittable are state, not
// identity). Maestro's rule: tap only on a UNIQUE match. The flat index is a
// tie-breaker only when the tree shape is unchanged — never a primary key.
export function refreshRef(sig: RefSignature, nodes: FlatNode[]): RefreshOutcome {
  const matches: { node: FlatNode; index: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (identityMatches(sig, nodes[i])) matches.push({ node: nodes[i], index: i });
  }
  if (matches.length === 0) return { kind: 'absent' };
  if (matches.length === 1) return { kind: 'unique', node: matches[0].node };
  if (nodes.length === sig.nodeCount) {
    const atSameIndex = matches.filter((m) => m.index === sig.flatIndex);
    if (atSameIndex.length === 1) return { kind: 'unique', node: atSameIndex[0].node };
  }
  return { kind: 'ambiguous', candidates: matches.map((m) => m.node) };
}
