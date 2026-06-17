// Live-sim speedup (quick win #2): device_find should reuse the snapshot it
// already captured instead of re-snapshotting on every call — but ONLY while
// that snapshot is still a faithful picture of the screen. A tap/navigation
// changes the screen, so the cache must be invalidated by mutating verbs, not
// just by a time-to-live (a fresh-by-time but stale-by-content cache would
// drive a wrong-element tap — worse than a slow-but-correct snapshot).
//
// These tests pin the cache-validity STATE MACHINE:
//   cacheSnapshot()      -> present + clean
//   markSnapshotDirty()  -> invalid (a mutating verb happened)
//   TTL                  -> invalid once too old
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheSnapshot,
  getCachedSnapshot,
  markSnapshotDirty,
  isSnapshotCacheValid,
} from '../../dist/agent-device-wrapper.js';

const NODES = [{ ref: '@e0', label: 'Continue', type: 'Button', hittable: true }];

test('snapshot cache: a freshly cached snapshot is valid', () => {
  cacheSnapshot('ios', NODES);
  assert.equal(isSnapshotCacheValid('ios'), true);
  assert.deepEqual(getCachedSnapshot('ios')?.nodes, NODES);
});

test('snapshot cache: a mutating verb invalidates the cache (content staleness)', () => {
  cacheSnapshot('ios', NODES);
  assert.equal(isSnapshotCacheValid('ios'), true);
  markSnapshotDirty();
  assert.equal(isSnapshotCacheValid('ios'), false, 'a tap/press must invalidate the cache');
});

test('snapshot cache: re-caching after a mutation makes it valid (clean) again', () => {
  cacheSnapshot('ios', NODES);
  markSnapshotDirty();
  assert.equal(isSnapshotCacheValid('ios'), false);
  cacheSnapshot('ios', NODES); // a fresh snapshot taken after the screen settled
  assert.equal(isSnapshotCacheValid('ios'), true);
});

test('snapshot cache: an unknown platform is never valid', () => {
  cacheSnapshot('ios', NODES);
  assert.equal(isSnapshotCacheValid('android'), false);
});

test('snapshot cache: an over-age cache is invalid even when clean (TTL)', () => {
  cacheSnapshot('ios', NODES);
  // Force-expire with a negative age budget: any real age (>= 0) exceeds it,
  // so this deterministically exercises the TTL branch without sleeping.
  assert.equal(isSnapshotCacheValid('ios', -1), false);
});

test('snapshot cache: dirty flag is global but validity is keyed per platform read', () => {
  // markSnapshotDirty invalidates the active device's cache; a subsequent fresh
  // cache for that platform clears it. (The bridge drives one device at a time.)
  cacheSnapshot('android', NODES);
  assert.equal(isSnapshotCacheValid('android'), true);
  markSnapshotDirty();
  assert.equal(isSnapshotCacheValid('android'), false);
});

// Source guard: the invalidation MUST be wired at the runNative dispatch choke
// point, otherwise the cache silently goes stale after taps in production.
test('source guard: markSnapshotDirty is invoked inside runNative for mutating verbs', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/agent-device-wrapper.js'), 'utf-8');
  // The wiring (not just the definition) must be present: the mutating-verb set
  // is consulted at the dispatch choke point and triggers the invalidation.
  assert.match(src, /SNAPSHOT_MUTATING_VERBS\.has\(/, 'runNative must gate invalidation on the mutating-verb set');
  assert.match(src, /markSnapshotDirty\(\)/, 'runNative must call markSnapshotDirty() on mutating verbs');
});
