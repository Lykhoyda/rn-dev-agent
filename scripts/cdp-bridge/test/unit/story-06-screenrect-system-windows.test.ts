// Story 06 Phase B (#387): with FLAG_RETRIEVE_INTERACTIVE_WINDOWS (#370),
// Android snapshots include SYSTEM windows, and the status bar
// (0,0,1280,156) precedes the app window in node order. updateRefMap's
// screen-rect heuristic took the FIRST (0,0)-anchored wide node, so
// direction-based device_scroll/device_swipe computed gestures inside the
// status bar (device-proven: a 62px drag at y 47-109 opened the shade and
// knocked the fixture out of the foreground). The heuristic must pick the
// LARGEST full-bleed rect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateRefMap, getScreenRect } from '../../dist/fast-runner-ref-map.js';

test('screen rect: largest (0,0)-anchored rect wins over a leading status-bar window', () => {
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 1280, height: 156 } },
    { ref: 'e1', rect: { x: 0, y: 0, width: 1280, height: 156 } },
    { ref: 'e2', rect: { x: 0, y: 0, width: 1280, height: 2856 } },
    { ref: 'e3', rect: { x: 24, y: 24, width: 264, height: 144 } },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 1280, height: 2856 });
});

test('screen rect: unchanged behavior when the app window comes first (iOS shape)', () => {
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: 'e1', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: 'e2', rect: { x: 16, y: 134, width: 370, height: 34 } },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 402, height: 874 });
});
