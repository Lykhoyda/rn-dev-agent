// Story 06 Phase B (#387): the screen rect that direction scroll/swipe compute
// their gesture from is the UNION BOUNDING BOX of all snapshot node rects. A
// (0,0)-anchored heuristic was fragile — device-proven on CI Android, where NO
// node spans the full window (the tallest (0,0) node is a ~128px top-chrome
// strip while the scrollable list sits at y=570,h=1590), so a "largest (0,0)
// rect" pick produced a 128px-tall viewport and every direction scroll dragged
// ~50px in the status bar, never moving the list.
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
