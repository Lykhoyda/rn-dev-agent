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
  setSnapshotAuthorityProvider,
} from '../../dist/agent-device-wrapper.js';
import { toolInvalidatesSnapshotCache } from '../../dist/observability/live-device.js';

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

test('snapshot cache preserves exact per-platform receipts within one source generation', () => {
  let platform = 'ios';
  let deviceId = 'ios-device';
  setSnapshotAuthorityProvider(() => ({
    sessionId: 'session-a',
    claimEpoch: 1,
    sourceKey: 'source-a',
    worktreeKey: 'worktree-a',
    appRootKey: 'app-a',
    platform,
    deviceId,
    buildGeneration: 1,
    installGeneration: `${platform}-install`,
    runnerInstanceId: `${platform}-runner`,
    runnerClaim: `${platform}:${deviceId}`,
  }));
  cacheSnapshot('ios', NODES);
  platform = 'android';
  deviceId = 'android-device';
  cacheSnapshot('android', NODES);

  assert.deepEqual(getCachedSnapshot('ios')?.nodes, NODES);
  assert.deepEqual(getCachedSnapshot('android')?.nodes, NODES);
  setSnapshotAuthorityProvider(null);
});

test('snapshot cache rejects cross-session and stale-source receipts', () => {
  let sessionId = 'session-a';
  const source = {
    claimEpoch: 1,
    sourceKey: 'source-a',
    worktreeKey: 'worktree-a',
    appRootKey: 'app-a',
    platform: 'ios',
    deviceId: 'ios-device',
    buildGeneration: 1,
    installGeneration: 'ios-install',
    runnerInstanceId: 'ios-runner',
    runnerClaim: 'ios:ios-device',
  };
  setSnapshotAuthorityProvider(() => ({ ...source, sessionId }));
  cacheSnapshot('ios', NODES);
  sessionId = 'session-b';

  assert.equal(getCachedSnapshot('ios'), undefined);
  setSnapshotAuthorityProvider(null);
});

// toolInvalidatesSnapshotCache: the FAIL-SAFE rule at the MCP tool boundary.
// This is the load-bearing fix for the review finding that JS-level mutations
// (cdp_interact, cdp_navigate), the fastSwipe path, deeplinks, dispatch, reloads,
// and flows all bypass the runNative choke point.

test('cache invalidation: pure reads PRESERVE the cache (return false)', () => {
  for (const t of [
    'device_snapshot',
    'device_screenshot',
    'cdp_store_state',
    'cdp_component_tree',
    'cdp_navigation_state',
    'cdp_nav_graph',
    'cdp_status',
    'cdp_network_log',
    'expect_route',
    'expect_redux',
    'expect_visible_by_testid',
    'expect_text',
    'cross_platform_verify',
    'collect_logs',
  ]) {
    assert.equal(
      toolInvalidatesSnapshotCache(t),
      false,
      `${t} is a read and must preserve the cache`,
    );
  }
});

test('cache invalidation: screen-mutating tools INVALIDATE (return true) — incl. runNative-bypassing ones', () => {
  for (const t of [
    'cdp_interact',
    'cdp_navigate',
    'device_deeplink', // bypass runNative (the review finding)
    'device_press',
    'device_fill',
    'device_swipe',
    'device_scroll',
    'device_back',
    'device_longpress',
    'device_pinch',
    'device_batch',
    'maestro_run',
    'maestro_test_all',
    'cdp_run_action',
    'cdp_auto_login', // flows
    'cdp_reload',
    'cdp_restart', // lifecycle screen changes
    'cdp_dispatch',
    'cdp_evaluate',
    'cdp_mmkv',
    'cdp_set_shared_value', // 'other' mutators
  ]) {
    assert.equal(
      toolInvalidatesSnapshotCache(t),
      true,
      `${t} can change the screen and must invalidate`,
    );
  }
});

test('cache invalidation: device_find is a read unless it taps (action=click)', () => {
  assert.equal(toolInvalidatesSnapshotCache('device_find'), false);
  assert.equal(toolInvalidatesSnapshotCache('device_find', { text: 'x' }), false);
  assert.equal(toolInvalidatesSnapshotCache('device_find', { action: 'click' }), true);
});

test('cache invalidation: fail-safe — an unknown/new tool invalidates by default', () => {
  assert.equal(toolInvalidatesSnapshotCache('some_future_tool_we_have_not_classified'), true);
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
  assert.match(
    src,
    /SNAPSHOT_MUTATING_VERBS\.has\(/,
    'runNative must gate invalidation on the mutating-verb set',
  );
  assert.match(
    src,
    /markSnapshotDirty\(\)/,
    'runNative must call markSnapshotDirty() on mutating verbs',
  );
});

test('source guard: the central trackedTool boundary wires fail-safe cache invalidation', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, '../../dist/index.js'), 'utf-8');
  // Every external tool crosses trackedTool; the fail-safe invalidation must run there.
  assert.match(
    src,
    /toolInvalidatesSnapshotCache\(/,
    'trackedTool must consult the fail-safe predicate',
  );
  assert.match(
    src,
    /markSnapshotDirty\(\)/,
    'trackedTool must invalidate the cache for mutating tools',
  );
});
