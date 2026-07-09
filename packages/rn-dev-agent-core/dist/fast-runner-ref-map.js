import { hashSnapshotNodes } from './lifecycle/settle-hash.js';
let refMap = new Map();
let metadataMap = new Map();
let screenRect = null;
let lastUpdated = 0;
let lastSnapshotHash = null;
export function updateRefMap(nodes) {
    refMap.clear();
    screenRect = null;
    // Screen rect = the union bounding box of all node rects. A (0,0)-anchored
    // heuristic is fragile: on some Android snapshots (#387 Phase B device-proven)
    // NO node spans the full window — the tallest (0,0) node is a ~128px top-chrome
    // strip, so a "largest (0,0) rect" pick yields a tiny viewport and direction
    // scrolls compute a ~50px drag in the status bar that never moves the list.
    // The max extent across all nodes recovers the true viewport on both platforms.
    let maxRight = 0;
    let maxBottom = 0;
    for (const node of nodes) {
        if (!node.ref || !node.rect)
            continue;
        refMap.set(node.ref, node.rect);
        const { x, y, width, height } = node.rect;
        if (width > 0 && height > 0) {
            maxRight = Math.max(maxRight, x + width);
            maxBottom = Math.max(maxBottom, y + height);
        }
    }
    // width > 300 keeps the same sanity floor the old heuristic used (ignore
    // degenerate all-tiny-node snapshots rather than emit a bogus rect).
    screenRect =
        maxRight > 300 && maxBottom > 0 ? { x: 0, y: 0, width: maxRight, height: maxBottom } : null;
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
    // refMap IS cleared (coordinates must never be served across generations —
    // only the CURRENT snapshot is tappable), but metadataMap is NOT: ref ids are
    // positional, so ids absent from this snapshot cannot collide with current
    // ones; retaining their signatures (with their ORIGIN generation's
    // flatIndex/nodeCount) lets a later stale tap heal by identity after a
    // re-render (Story 05 acceptance: dense→sparse→tap-original-ref, #386).
    // Colliding keys are overwritten by metadataMap.set below.
    refMap.clear();
    screenRect = null;
    const hashed = [];
    // Screen rect = union bounding box of all node rects (same rationale as
    // updateRefMap — a (0,0)-anchored pick is fragile when no node spans the
    // full window).
    let maxRight = 0;
    let maxBottom = 0;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node.ref || !node.rect)
            continue;
        const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
        refMap.set(key, node.rect);
        const meta = { type: node.type, flatIndex: i, nodeCount: nodes.length };
        if (node.label !== undefined)
            meta.label = node.label;
        if (node.identifier !== undefined)
            meta.identifier = node.identifier;
        metadataMap.set(key, meta);
        hashed.push(node);
        const { x, y, width, height } = node.rect;
        if (width > 0 && height > 0) {
            maxRight = Math.max(maxRight, x + width);
            maxBottom = Math.max(maxBottom, y + height);
        }
    }
    screenRect =
        maxRight > 300 && maxBottom > 0 ? { x: 0, y: 0, width: maxRight, height: maxBottom } : null;
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
        nodeCount: rec.nodeCount,
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
function identityMatches(sig, node) {
    return node.type === sig.type && node.label === sig.label && node.identifier === sig.identifier;
}
// Story 05 (#386): re-bind a stale ref to the live tree by identity attrs
// (type/label/identifier — bounds excluded; enabled/hittable are state, not
// identity). Maestro's rule: tap only on a UNIQUE match. The flat index is a
// tie-breaker only when the tree shape is unchanged — never a primary key.
export function refreshRef(sig, nodes) {
    const matches = [];
    for (let i = 0; i < nodes.length; i++) {
        if (identityMatches(sig, nodes[i]))
            matches.push({ node: nodes[i], index: i });
    }
    if (matches.length === 0)
        return { kind: 'absent' };
    if (matches.length === 1)
        return { kind: 'unique', node: matches[0].node };
    if (nodes.length === sig.nodeCount) {
        const atSameIndex = matches.filter((m) => m.index === sig.flatIndex);
        if (atSameIndex.length === 1)
            return { kind: 'unique', node: atSameIndex[0].node };
    }
    return { kind: 'ambiguous', candidates: matches.map((m) => m.node) };
}
