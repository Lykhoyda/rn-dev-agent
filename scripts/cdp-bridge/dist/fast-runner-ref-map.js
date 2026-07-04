import { hashSnapshotNodes } from './lifecycle/settle-hash.js';
let refMap = new Map();
let metadataMap = new Map();
let screenRect = null;
let lastUpdated = 0;
let lastSnapshotNodeCount = 0;
let lastSnapshotHash = null;
export function updateRefMap(nodes) {
    refMap.clear();
    screenRect = null;
    for (const node of nodes) {
        if (!node.ref || !node.rect)
            continue;
        refMap.set(node.ref, node.rect);
        if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
            screenRect = node.rect;
        }
    }
    lastUpdated = Date.now();
}
export function lookupRef(ref) {
    const clean = ref.startsWith('@') ? ref.slice(1) : ref;
    return refMap.get(clean) ?? null;
}
export function refCenter(ref) {
    const rect = lookupRef(ref);
    if (!rect)
        return null;
    return {
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
    };
}
export function getScreenRect() {
    return screenRect;
}
export function getRefMapAge() {
    return lastUpdated ? Date.now() - lastUpdated : Infinity;
}
// A @ref resolves to fixed coordinates captured at snapshot time. If the
// snapshot is old, the UI may have scrolled/re-rendered and those coordinates
// now point at a different element — a wrong-element tap that STALE_REF (which
// only fires on absent refs) would not catch. Callers gate coordinate
// resolution on this so an over-age map is treated like a stale ref.
export const MAX_REF_MAP_AGE_MS = 60_000;
export function isRefMapFresh(maxAgeMs = MAX_REF_MAP_AGE_MS) {
    return getRefMapAge() <= maxAgeMs;
}
export function clearRefMap() {
    refMap.clear();
    metadataMap.clear();
    screenRect = null;
    lastUpdated = 0;
    lastSnapshotNodeCount = 0;
    lastSnapshotHash = null;
}
export function hasRefMap() {
    return refMap.size > 0;
}
export function flattenXCUITree(tree) {
    const nodes = [];
    const localRefMap = new Map();
    let counter = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object')
            return;
        if (node.frame) {
            const id = `e${counter}`;
            counter++;
            const rect = {
                x: node.frame.x,
                y: node.frame.y,
                width: node.frame.width,
                height: node.frame.height,
            };
            const flat = {
                ref: `@${id}`,
                type: node.type ?? '',
                rect,
            };
            if (node.label !== undefined)
                flat.label = node.label;
            if (node.identifier !== undefined)
                flat.identifier = node.identifier;
            if (node.enabled !== undefined)
                flat.enabled = node.enabled;
            if (node.hittable !== undefined)
                flat.hittable = node.hittable;
            nodes.push(flat);
            localRefMap.set(id, rect);
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children)
                walk(child);
        }
    };
    walk(tree);
    return { nodes, refMap: localRefMap };
}
export function updateRefMapFromFlat(nodes) {
    refMap.clear();
    metadataMap.clear();
    screenRect = null;
    const hashed = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node.ref || !node.rect)
            continue;
        const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
        refMap.set(key, node.rect);
        const meta = { type: node.type, flatIndex: i };
        if (node.label !== undefined)
            meta.label = node.label;
        if (node.identifier !== undefined)
            meta.identifier = node.identifier;
        metadataMap.set(key, meta);
        hashed.push(node);
        if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
            screenRect = node.rect;
        }
    }
    lastSnapshotNodeCount = nodes.length;
    // Hash only the nodes that passed the ref/rect filter: hashSnapshotNodes
    // dereferences node.rect.* unconditionally, and a malformed entry must not
    // throw mid-update. For real runner data the filtered subset equals the full
    // array (both mappers pre-filter !rect), so comparability with the settle
    // probes is preserved. Fail-open on hash error (matches settle.ts).
    try {
        lastSnapshotHash = hashSnapshotNodes(hashed);
    }
    catch {
        lastSnapshotHash = null;
    }
    lastUpdated = Date.now();
}
export function getCachedMetadata(ref) {
    const key = ref.startsWith('@') ? ref.slice(1) : ref;
    const rec = metadataMap.get(key);
    if (!rec)
        return null;
    const meta = { type: rec.type };
    if (rec.label !== undefined)
        meta.label = rec.label;
    if (rec.identifier !== undefined)
        meta.identifier = rec.identifier;
    return meta;
}
export function getCachedSignature(ref) {
    const key = ref.startsWith('@') ? ref.slice(1) : ref;
    const rec = metadataMap.get(key);
    if (!rec)
        return null;
    const sig = {
        type: rec.type,
        flatIndex: rec.flatIndex,
        nodeCount: lastSnapshotNodeCount,
    };
    if (rec.label !== undefined)
        sig.label = rec.label;
    if (rec.identifier !== undefined)
        sig.identifier = rec.identifier;
    return sig;
}
export function getLastSnapshotHash() {
    return lastSnapshotHash;
}
// Story 05 (#386): called when a mutating verb settles without any hash
// observation — the screen may have changed unobserved, so the baseline must
// not be compared against. Fail-open beats fail-wrong.
export function invalidateLastSnapshotHash() {
    lastSnapshotHash = null;
}
function metadataMatches(a, b) {
    return a.type === b.type && a.label === b.label && a.identifier === b.identifier;
}
function flatNodeMetadata(node) {
    const meta = { type: node.type };
    if (node.label !== undefined)
        meta.label = node.label;
    if (node.identifier !== undefined)
        meta.identifier = node.identifier;
    return meta;
}
export function isRefStale(ref, newNodes) {
    const cached = getCachedMetadata(ref);
    if (!cached)
        return true;
    const target = ref.startsWith('@') ? ref : `@${ref}`;
    const fresh = newNodes.find((n) => n.ref === target);
    if (!fresh)
        return true;
    return !metadataMatches(cached, flatNodeMetadata(fresh));
}
export function findNewRefByMetadata(oldRef, newNodes) {
    const cached = getCachedMetadata(oldRef);
    if (!cached)
        return null;
    for (const node of newNodes) {
        if (metadataMatches(cached, flatNodeMetadata(node))) {
            return node.ref;
        }
    }
    return null;
}
export function flattenAndroidAccessibilityTree(nodes) {
    const localRefMap = new Map();
    for (const node of nodes) {
        if (!node.ref || !node.rect)
            continue;
        const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
        localRefMap.set(key, node.rect);
    }
    return { nodes, refMap: localRefMap };
}
