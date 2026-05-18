let refMap = new Map();
let metadataMap = new Map();
let screenRect = null;
let lastUpdated = 0;
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
export function clearRefMap() {
    refMap.clear();
    metadataMap.clear();
    screenRect = null;
    lastUpdated = 0;
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
    for (const node of nodes) {
        if (!node.ref || !node.rect)
            continue;
        const key = node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
        refMap.set(key, node.rect);
        const meta = { type: node.type };
        if (node.label !== undefined)
            meta.label = node.label;
        if (node.identifier !== undefined)
            meta.identifier = node.identifier;
        metadataMap.set(key, meta);
        if (!screenRect && node.rect.x === 0 && node.rect.y === 0 && node.rect.width > 300) {
            screenRect = node.rect;
        }
    }
    lastUpdated = Date.now();
}
export function getCachedMetadata(ref) {
    const key = ref.startsWith('@') ? ref.slice(1) : ref;
    return metadataMap.get(key) ?? null;
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
