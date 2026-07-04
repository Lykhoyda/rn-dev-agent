// Story 05 (#386) final-review fix (regression from 4ff56662): before ref
// signature retention, updateRefMapFromFlat cleared metadataMap wholesale each
// generation, so getCachedMetadata(ref) returned null for a ref absent from the
// current snapshot — the multi-review "H3" guard on device_fill's JS-first path
// (src/tools/device-interact.ts) relied on THAT to stop a stale-generation @ref
// from resolving to a reused testID (e.g. 'input-email' on both Login and
// Signup) and filling the wrong screen's field with a passing verify.
//
// After retention, getCachedMetadata keeps returning the OLD identifier for a
// retained-but-absent ref, so `isRefMapFresh()` (an AGE gate only) no longer
// protects H3. The fix gates cachedIdentifier resolution on CURRENT-GENERATION
// presence via lookupRef (which reads refMap — cleared every generation).
//
// resolveCachedIdentifier is the extracted pure helper under test.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCachedIdentifier } from '../../dist/tools/device-interact.js';
import {
  updateRefMapFromFlat,
  clearRefMap,
  getCachedMetadata,
  lookupRef,
} from '../../dist/fast-runner-ref-map.js';

const rect = (x = 0, y = 0) => ({ x, y, width: 100, height: 40 });

beforeEach(() => clearRefMap());

test('resolveCachedIdentifier returns the identifier for a ref present in the CURRENT generation', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'TextField', identifier: 'input-email', rect: rect(0, 0) },
  ]);
  assert.equal(resolveCachedIdentifier('@e0'), 'input-email');
});

test('regression (4ff56662): a ref retained-but-absent from the newest generation resolves to undefined', () => {
  // gen 1: @e0 is a TextField named 'input-email' (e.g. the Login screen).
  updateRefMapFromFlat([
    { ref: '@e0', type: 'TextField', identifier: 'input-email', rect: rect(0, 0) },
  ]);
  // gen 2: navigation happened — @e0 no longer appears (a different screen).
  updateRefMapFromFlat([{ ref: '@e9', type: 'Other', identifier: 'x', rect: rect(0, 50) }]);

  // Proves retention is what makes the naive (age-only) gate unsafe: the
  // signature is still there for identity-healing purposes...
  assert.equal(getCachedMetadata('@e0')?.identifier, 'input-email');
  // ...but @e0 is absent from the current generation's coordinate map...
  assert.equal(lookupRef('@e0'), null);
  // ...so the H3 gate must refuse to hand back the retained identifier.
  assert.equal(resolveCachedIdentifier('@e0'), undefined);
});

test('resolveCachedIdentifier returns undefined when the ref map is stale (age gate still applies)', (t) => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'TextField', identifier: 'input-email', rect: rect(0, 0) },
  ]);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.mock.timers.tick(61_000); // exceeds MAX_REF_MAP_AGE_MS (60s)
  assert.equal(resolveCachedIdentifier('@e0'), undefined);
});

test('resolveCachedIdentifier returns undefined for an unknown ref', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'TextField', identifier: 'input-email', rect: rect(0, 0) },
  ]);
  assert.equal(resolveCachedIdentifier('@e99'), undefined);
});

test('resolveCachedIdentifier accepts both @-prefixed and bare refs', () => {
  updateRefMapFromFlat([
    { ref: '@e0', type: 'TextField', identifier: 'input-email', rect: rect(0, 0) },
  ]);
  assert.equal(resolveCachedIdentifier('e0'), 'input-email');
});
