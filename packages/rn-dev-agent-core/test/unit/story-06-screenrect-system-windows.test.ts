// Story 06 Phase B (#387): the screen rect that direction scroll/swipe compute
// their gesture from is a HITTABLE-FIRST union bounding box of snapshot node
// rects, with an all-nodes fallback. Two device-proven failure modes shaped it:
//  - A (0,0)-anchored heuristic broke on CI Android, where NO node spans the
//    full window (the tallest (0,0) node is a ~128px top-chrome strip while the
//    scrollable list sits at y=570,h=1590) — direction scrolls dragged ~50px in
//    the status bar and never moved the list.
//  - An ALL-nodes union is inflatable by off-screen mounted content (post-merge
//    review finding): both runners keep content-bearing nodes in the snapshot
//    with real out-of-viewport coords (RN FlatList windowing) marked
//    hittable:false — including them pushes gestures off the physical screen
//    and false-passes scrollintoview's isInViewport. Hittable-only excludes
//    them; the all-nodes fallback covers snapshots without hittable data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateRefMap, getScreenRect } from '../../dist/fast-runner-ref-map.js';

test('screen rect: CI-Android shape — no full-window (0,0) node, list below the chrome', () => {
  // Exactly the failing snapshot shape (app=0,0,1080,128; list at y=570,h=1590).
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 1080, height: 128 } },
    { ref: 'e1', rect: { x: 0, y: 570, width: 1080, height: 1590 } },
    { ref: 'e2', rect: { x: 16, y: 2170, width: 300, height: 60 } },
  ] as never);
  // Union bbox height reaches the bottom-most node (2170+60), NOT the 128 chrome.
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 1080, height: 2230 });
});

test('screen rect: iOS shape — full-window Application node sets the extent', () => {
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: 'e1', rect: { x: 0, y: 0, width: 402, height: 874 } },
    { ref: 'e2', rect: { x: 16, y: 134, width: 370, height: 34 } },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 402, height: 874 });
});

test('screen rect: a leading status-bar node does not cap the extent', () => {
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 1280, height: 156 } },
    { ref: 'e1', rect: { x: 0, y: 0, width: 1280, height: 156 } },
    { ref: 'e2', rect: { x: 0, y: 0, width: 1280, height: 2856 } },
    { ref: 'e3', rect: { x: 24, y: 24, width: 264, height: 144 } },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 1280, height: 2856 });
});

test('screen rect: degenerate all-tiny-node snapshot yields null (sanity floor)', () => {
  updateRefMap([{ ref: 'e0', rect: { x: 0, y: 0, width: 40, height: 40 } }] as never);
  assert.equal(getScreenRect(), null);
});

test('screen rect: off-screen non-hittable nodes do not inflate the viewport', () => {
  // RN FlatList windowing shape: rows mounted screens past the fold stay in the
  // tree with real coords but hittable:false. The viewport must come from the
  // hittable union (874), not the mounted-content extent (4060).
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 402, height: 874 }, hittable: true },
    { ref: 'e1', rect: { x: 16, y: 800, width: 370, height: 60 }, hittable: true },
    { ref: 'e2', rect: { x: 16, y: 1200, width: 370, height: 60 }, hittable: false },
    { ref: 'e3', rect: { x: 16, y: 4000, width: 370, height: 60 }, hittable: false },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 402, height: 874 });
});

test('screen rect: falls back to the all-nodes union when no node is hittable', () => {
  // Older runner artifacts / synthetic snapshots without usable hittable data
  // keep the pre-hittable behavior instead of yielding null.
  updateRefMap([
    { ref: 'e0', rect: { x: 0, y: 0, width: 1080, height: 128 }, hittable: false },
    { ref: 'e1', rect: { x: 0, y: 570, width: 1080, height: 1590 } },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 1080, height: 2160 });
});

test('screen rect: tiny hittable set falls back to the all-nodes union (sanity floor)', () => {
  // If the only hittable node is a small control, the hittable union fails the
  // width>300 floor — the all-nodes union is a safer estimate than a 40px rect.
  updateRefMap([
    { ref: 'e0', rect: { x: 10, y: 10, width: 40, height: 40 }, hittable: true },
    { ref: 'e1', rect: { x: 0, y: 0, width: 402, height: 874 }, hittable: false },
  ] as never);
  assert.deepEqual(getScreenRect(), { x: 0, y: 0, width: 402, height: 874 });
});
