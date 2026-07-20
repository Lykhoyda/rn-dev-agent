import { hashSnapshotNodes } from './lifecycle/settle-hash.js';
let refMap = new Map();
let metadataMap = new Map();
let screenRect = null;
let lastUpdated = 0;
let lastSnapshotHash = null;
let snapshotGeneration = 0;
let keyboardStateAtSnapshot = null;
// #519 review: honest hittable (#395) guarantees only the CENTER is on-screen,
// so a straddling card (x=250..550 on a 402pt viewport) is legitimately
// hittable and would seed the union past the physical screen. iOS snapshots
// always carry Application/Window nodes whose extent is authoritative — their
// union caps the estimate. Android emits Java class names (never these types),
// so the CI-Android no-full-window constraint above is untouched: no cap.
const WINDOW_TYPES = new Set(['Application', 'Window']);
// width > 300 keeps the same sanity floor the old heuristic used (ignore
// degenerate all-tiny snapshots rather than emit a bogus rect).
function extentToRect(right, bottom) {
    return right > 300 && bottom > 0 ? { x: 0, y: 0, width: right, height: bottom } : null;
}
function windowCap(entries) {
    let right = 0;
    let bottom = 0;
    for (const e of entries) {
        if (e.type === undefined || !WINDOW_TYPES.has(e.type))
            continue;
        const { x, y, width, height } = e.rect;
        if (width <= 0 || height <= 0)
            continue;
        right = Math.max(right, x + width);
        bottom = Math.max(bottom, y + height);
    }
    return right > 300 && bottom > 0 ? { right, bottom } : null;
}
function resolveScreenRect(entries) {
    const cap = windowCap(entries);
    let allRight = 0;
    let allBottom = 0;
    let hitRight = 0;
    let hitBottom = 0;
    const usable = [];
    for (const e of entries) {
        const { x, y, width, height } = e.rect;
        if (width <= 0 || height <= 0)
            continue;
        usable.push(e);
        allRight = Math.max(allRight, x + width);
        allBottom = Math.max(allBottom, y + height);
        if (e.hittable === true) {
            hitRight = Math.max(hitRight, x + width);
            hitBottom = Math.max(hitBottom, y + height);
        }
    }
    if (cap !== null) {
        allRight = Math.min(allRight, cap.right);
        allBottom = Math.min(allBottom, cap.bottom);
        hitRight = Math.min(hitRight, cap.right);
        hitBottom = Math.min(hitBottom, cap.bottom);
    }
    if (hitRight <= 0 || hitBottom <= 0)
        return extentToRect(allRight, allBottom);
    // Grow the hittable seed by overlap until stable (bounded — each pass only
    // ever extends, and stops as soon as nothing new intersects).
    let right = hitRight;
    let bottom = hitBottom;
    for (let pass = 0; pass < 10; pass++) {
        let grew = false;
        for (const e of usable) {
            const { x, y, width, height } = e.rect;
            const intersects = x < right && y < bottom && x + width > 0 && y + height > 0;
            if (!intersects)
                continue;
            if (x + width > right) {
                right = x + width;
                grew = true;
            }
            if (y + height > bottom) {
                bottom = y + height;
                grew = true;
            }
        }
        if (!grew)
            break;
    }
    // Re-apply the window cap: growth extends by ANY intersecting rect, so a
    // straddling node re-inflates past the seed clamp without this.
    if (cap !== null) {
        right = Math.min(right, cap.right);
        bottom = Math.min(bottom, cap.bottom);
    }
    return extentToRect(right, bottom) ?? extentToRect(allRight, allBottom);
}
export function updateRefMap(nodes) {
    refMap.clear();
    screenRect = null;
    const entries = [];
    for (const node of nodes) {
        if (!node.ref || !node.rect)
            continue;
        refMap.set(node.ref, node.rect);
        entries.push({ rect: node.rect, hittable: node.hittable, type: node.type });
    }
    screenRect = resolveScreenRect(entries);
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
    snapshotGeneration = 0;
    keyboardStateAtSnapshot = null;
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
export function buildSnapshotVerdict(source, nodeCount, outcome) {
    const reasons = [];
    if (nodeCount === 0)
        reasons.push('empty-capture');
    return {
        state: reasons.length > 0 ? 'degraded' : 'ok',
        source,
        nodeCount,
        refMapUpdated: outcome.applied,
        reasons,
    };
}
export function updateRefMapFromFlat(nodes, freshness = {}) {
    // GH #409: a zero-node capture is indistinguishable from a degraded walk
    // (AX failure, wedged runner, mid-transition screen). It must never wipe the
    // last-known-good map — refs stay bound to the last verified capture, and a
    // genuinely emptied screen surfaces as STALE_REF on the next tap instead of
    // silently serving nothing.
    let validCount = 0;
    for (const node of nodes) {
        if (node.ref && node.rect)
            validCount++;
    }
    if (validCount === 0 && refMap.size > 0) {
        return { applied: false, reason: 'empty-capture' };
    }
    // refMap IS cleared (coordinates must never be served across generations —
    // only the CURRENT snapshot is tappable), but metadataMap is NOT: ref ids are
    // positional, so ids absent from this snapshot cannot collide with current
    // ones; retaining their signatures (with their ORIGIN generation's
    // flatIndex/nodeCount) lets a later stale tap heal by identity after a
    // re-render (Story 05 acceptance: dense→sparse→tap-original-ref, #386).
    // Colliding keys are overwritten by metadataMap.set below.
    refMap.clear();
    screenRect = null;
    snapshotGeneration = freshness.snapshotGeneration ?? snapshotGeneration + 1;
    keyboardStateAtSnapshot = freshness.keyboardVisible ?? null;
    const hashed = [];
    // Screen rect: hittable-first union with an all-nodes fallback — same
    // rationale as updateRefMap (off-screen mounted rows must not inflate the
    // viewport; a (0,0)-anchored pick is fragile when no node spans the window).
    const entries = [];
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (!node.ref || !node.rect)
            continue;
        const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
        refMap.set(key, node.rect);
        const meta = {
            type: node.type,
            flatIndex: i,
            nodeCount: nodes.length,
            snapshotGeneration,
            keyboardStateAtSnapshot,
        };
        if (node.label !== undefined)
            meta.label = node.label;
        if (node.identifier !== undefined)
            meta.identifier = node.identifier;
        metadataMap.set(key, meta);
        hashed.push(node);
        entries.push({ rect: node.rect, hittable: node.hittable, type: node.type });
    }
    screenRect = resolveScreenRect(entries);
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
    return { applied: true };
}
export function getFreshRefTarget(ref) {
    if (!isRefMapFresh())
        return null;
    const key = ref.startsWith('@') ? ref.slice(1) : ref;
    const rect = refMap.get(key);
    const record = metadataMap.get(key);
    if (!rect ||
        !record ||
        record.snapshotGeneration !== snapshotGeneration ||
        record.keyboardStateAtSnapshot === null)
        return null;
    return {
        rect,
        snapshotGeneration: record.snapshotGeneration,
        keyboardStateAtSnapshot: record.keyboardStateAtSnapshot,
    };
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
