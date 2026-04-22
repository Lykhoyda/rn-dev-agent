// M6 / Phase 112: Maestro YAML + Detox JS generator tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMaestro,
  generateDetox,
  maestroSelector,
  detoxSelector,
  nextSelector,
} from '../../dist/tools/test-recorder-generators.js';

test('M6 Maestro: tap with testID emits tapOn id selector', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'login-btn', t: 1 }]);
  assert.match(out, /- tapOn:\s+id: "login-btn"/);
});

test('M6 Maestro: type emits tapOn + inputText pair', () => {
  const out = generateMaestro([
    { type: 'type', testID: 'email-input', value: 'a@b.c', t: 1 },
  ]);
  assert.match(out, /- tapOn:\s+id: "email-input"/);
  assert.match(out, /- inputText: "a@b\.c"/);
});

test('M6 Maestro: swipeUp uses finger-direction (dy>0 → up)', () => {
  const out = generateMaestro([{ type: 'swipe', direction: 'up', t: 1 }]);
  assert.match(out, /- swipeUp/);
});

test('M6 Maestro: swipeDown / swipeLeft / swipeRight all render', () => {
  const out = generateMaestro([
    { type: 'swipe', direction: 'down',  t: 1 },
    { type: 'swipe', direction: 'left',  t: 2 },
    { type: 'swipe', direction: 'right', t: 3 },
  ]);
  assert.match(out, /- swipeDown/);
  assert.match(out, /- swipeLeft/);
  assert.match(out, /- swipeRight/);
});

test('M6 Maestro: navigate emits assertVisible on next selector', () => {
  const out = generateMaestro([
    { type: 'navigate', from: 'Login', to: 'Home', t: 1 },
    { type: 'tap', testID: 'home-greeting', t: 2 },
  ]);
  assert.match(out, /# navigated: Login -> Home/);
  assert.match(out, /- assertVisible:\s+id: "home-greeting"/);
});

test('M6 Maestro: annotation becomes YAML comment', () => {
  const out = generateMaestro([{ type: 'annotation', note: 'reached checkout', t: 1 }]);
  assert.match(out, /# NOTE: reached checkout/);
});

test('M6 Maestro: long_press emits longPressOn', () => {
  const out = generateMaestro([{ type: 'long_press', testID: 'avatar', t: 1 }]);
  assert.match(out, /- longPressOn:\s+id: "avatar"/);
});

test('M6 Detox: tap uses by.id selector', () => {
  const out = generateDetox([{ type: 'tap', testID: 'login-btn', t: 1 }]);
  assert.match(out, /await element\(by\.id\("login-btn"\)\)\.tap\(\)/);
});

test('M6 Detox: type uses typeText with JSON-stringified value', () => {
  const out = generateDetox([
    { type: 'type', testID: 'email', value: 'with "quotes"', t: 1 },
  ]);
  assert.match(out, /await element\(by\.id\("email"\)\)\.typeText\("with \\"quotes\\""\)/);
});

test('M6 Detox: swipe passes direction verbatim (finger-direction matches Detox)', () => {
  const out = generateDetox([
    { type: 'swipe', testID: 'list', direction: 'up', t: 1 },
  ]);
  assert.match(out, /await element\(by\.id\("list"\)\)\.swipe\("up"\)/);
});

test('M6 selectors: maestroSelector falls back to label when no testID', () => {
  assert.equal(maestroSelector({ type: 'tap', label: 'Submit', t: 1 }), 'id: "Submit"');
});

test('M6 selectors: detoxSelector returns null when nothing identifies the event', () => {
  assert.equal(detoxSelector({ type: 'tap', t: 1 }), null);
});

test('M6 nextSelector: stops at next navigate boundary', () => {
  const events = [
    { type: 'navigate', from: 'A', to: 'B', t: 1 },
    { type: 'navigate', from: 'B', to: 'C', t: 2 },
    { type: 'tap', testID: 'after-nav', t: 3 },
  ];
  const sel = nextSelector(events, 0, maestroSelector);
  assert.equal(sel, null);
});

// Review fixes (Gemini conf 90 + Codex conf 95): newline injection in
// generators. Annotations and other user-controlled strings must not break
// out of comment context.
test('M6 Maestro: annotation newlines are stripped (no YAML escape)', () => {
  const out = generateMaestro([
    { type: 'annotation', note: 'reached checkout\nstep:malicious', t: 1 },
  ]);
  assert.match(out, /# NOTE: reached checkout step:malicious/);
  assert.doesNotMatch(out, /^step:malicious/m);
});

test('M6 Detox: annotation newlines are stripped (no JS escape)', () => {
  const out = generateDetox([
    { type: 'annotation', note: 'line1\nawait device.uninstallApp();', t: 1 },
  ]);
  assert.match(out, /\/\/ NOTE: line1 await device\.uninstallApp\(\);/);
  // The escaped line MUST appear inside a comment, never as standalone code.
  assert.doesNotMatch(out, /^\s*await device\.uninstallApp\(\);/m);
});

test('M6 Maestro: testName / bundleId newlines are stripped', () => {
  const out = generateMaestro([{ type: 'tap', testID: 'x', t: 1 }], {
    testName: 'flow\nrm -rf',
    bundleId: 'com.x\nstep: bad',
  });
  assert.match(out, /# flow rm -rf/);
  assert.match(out, /appId: com\.x step: bad/);
});

test('M6 Detox: submit fallback is a manual-replay comment, not pressBack()', () => {
  // No testID/label → fallback path. Old behavior was `device.pressBack()`
  // which is Android-only and semantically wrong (back-button vs return-key).
  const out = generateDetox([{ type: 'submit', t: 1 }]);
  assert.doesNotMatch(out, /device\.pressBack/);
  assert.match(out, /\/\/ submit: missing testID\/label/);
});
