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

let refMap = new Map<string, ElementRect>();
let metadataMap = new Map<string, RefMetadata>();
let screenRect: ElementRect | null = null;
let lastUpdated = 0;

export function updateRefMap(nodes: SnapshotNode[]): void {
  refMap.clear();
  screenRect = null;

  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    refMap.set(node.ref, node.rect);

    if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
      screenRect = node.rect;
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

export function clearRefMap(): void {
  refMap.clear();
  metadataMap.clear();
  screenRect = null;
  lastUpdated = 0;
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
  refMap.clear();
  metadataMap.clear();
  screenRect = null;

  for (const node of nodes) {
    if (!node.ref || !node.rect) continue;
    const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
    refMap.set(key, node.rect);

    const meta: RefMetadata = { type: node.type };
    if (node.label !== undefined) meta.label = node.label;
    if (node.identifier !== undefined) meta.identifier = node.identifier;
    metadataMap.set(key, meta);

    if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
      screenRect = node.rect;
    }
  }

  lastUpdated = Date.now();
}

export function getCachedMetadata(ref: string): RefMetadata | null {
  const key = ref.startsWith('@') ? ref.slice(1) : ref;
  return metadataMap.get(key) ?? null;
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
