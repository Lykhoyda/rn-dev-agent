import { createHash } from 'node:crypto';
// 4px quantization absorbs sub-pixel animation jitter that strict equality
// (Maestro's hierarchy compare) would treat as motion. The synthetic @eN ref
// is excluded — it is an enumeration index, not identity. hittable is also
// excluded (#519 review): it is derived from enabled + rect + viewport, and
// its center-vs-viewport-edge comparison is unquantized — hashing it lets
// sub-bucket jitter at the screen edge flip the hash every poll, defeating
// the quantization. `checked` is included because Android Switch state can
// change without moving or relabeling the node; omitting it made a proven
// toggle look like a swallowed tap. Value/focus remain unavailable on every
// runner, so the snapshot-eq fallback can still miss changes limited to those
// fields; primary pixel/window probes cover current runner artifacts.
const BOUNDS_QUANTUM_PX = 4;
export function normalizeNodeForHash(node) {
    const q = (v) => Math.round(v / BOUNDS_QUANTUM_PX);
    // JSON-encoded tuple: labels/identifiers are app-controlled strings that may
    // contain any bytes — JSON escaping makes the per-node encoding unambiguous,
    // and the newline separator below cannot collide with escaped content.
    return JSON.stringify([
        node.identifier ?? '',
        node.type,
        node.label ?? '',
        q(node.rect.x),
        q(node.rect.y),
        q(node.rect.width),
        q(node.rect.height),
        node.enabled ?? null,
        node.checked ?? null,
    ]);
}
export function hashSnapshotNodes(nodes) {
    const h = createHash('sha256');
    for (const node of nodes) {
        h.update(normalizeNodeForHash(node));
        h.update('\n');
    }
    return h.digest('hex');
}
