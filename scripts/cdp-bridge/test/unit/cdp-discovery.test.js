import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterValidTargets, selectTarget } from '../../dist/cdp/discovery.js';

test('filterValidTargets drops targets without webSocketDebuggerUrl', () => {
  const out = filterValidTargets([
    { id: '1', vm: 'Hermes' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://127.0.0.1:8081/a' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2');
});

test('filterValidTargets drops Experimental targets', () => {
  const out = filterValidTargets([
    { id: '1', title: 'Experimental JS', vm: 'Hermes', webSocketDebuggerUrl: 'ws://x/a' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://x/b' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, '2');
});

test('filterValidTargets accepts React Native targets without Hermes VM', () => {
  const out = filterValidTargets([
    { id: '1', title: 'React Native Bridge', webSocketDebuggerUrl: 'ws://x/a' },
    { id: '2', description: 'React Native: whatever', webSocketDebuggerUrl: 'ws://x/b' },
    { id: '3', title: 'Chrome tab', webSocketDebuggerUrl: 'ws://x/c' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(t => t.id).sort(), ['1', '2']);
});

test('filterValidTargets rewrites IPv6 localhost to 127.0.0.1', () => {
  const out = filterValidTargets([
    { id: '1', vm: 'Hermes', webSocketDebuggerUrl: 'ws://[::1]:8081/abc' },
    { id: '2', vm: 'Hermes', webSocketDebuggerUrl: 'ws://[::]:8081/def' },
  ]);
  assert.ok(out[0].webSocketDebuggerUrl.includes('127.0.0.1'));
  assert.ok(!out[0].webSocketDebuggerUrl.includes('[::1]'));
  assert.ok(out[1].webSocketDebuggerUrl.includes('127.0.0.1'));
});

test('selectTarget sorts by page id descending (newest session first)', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-3', platform: 'ios' },
    { id: 'page-2', platform: 'ios' },
  ];
  const { targets: sorted } = selectTarget(targets);
  assert.deepEqual(sorted.map(t => t.id), ['page-3', 'page-2', 'page-1']);
});

test('selectTarget with platform filter returns matching targets only', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-2', platform: 'android' },
    { id: 'page-3', platform: 'ios' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 2);
  assert.equal(warning, undefined);
  assert.ok(sorted.every(t => t.platform === 'ios'));
});

test('selectTarget falls back to text match when no platform property matches', () => {
  const targets = [
    { id: 'page-1', title: 'Hermes ios', description: 'org.foo.ios' },
    { id: 'page-2', title: 'Android Metro' },
  ];
  const { targets: sorted } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, 'page-1');
});

test('selectTarget returns warning when platform filter matches nothing', () => {
  const targets = [
    { id: 'page-1', platform: 'ios', description: 'org.foo.a' },
    { id: 'page-2', platform: 'ios', description: 'org.foo.b' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, 'android');
  assert.equal(sorted.length, 2);
  assert.ok(warning);
  assert.match(warning, /android/);
});

test('selectTarget with no filter returns every target sorted', () => {
  const targets = [
    { id: 'page-1', platform: 'ios' },
    { id: 'page-2', platform: 'android' },
  ];
  const { targets: sorted, warning } = selectTarget(targets);
  assert.equal(sorted.length, 2);
  assert.equal(warning, undefined);
});

// ── B111 / D635: targetId + bundleId filters ──────────────────────────

test('selectTarget with targetId returns only the exact-id match', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { targetId: '6f8d21-2' });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '6f8d21-2');
  assert.equal(warning, undefined);
});

test('selectTarget with unknown targetId falls through with warning', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { targetId: 'does-not-exist' });
  assert.equal(sorted.length, 2); // fell back to all
  assert.ok(warning);
  assert.match(warning, /targetId "does-not-exist" matched no targets/);
});

test('selectTarget with bundleId filters zombie targets out', () => {
  const targets = [
    { id: '008aba-1', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted } = selectTarget(targets, { bundleId: 'com.rndevagent.testapp' });
  assert.equal(sorted.length, 2);
  assert.ok(sorted.every(t => t.description === 'com.rndevagent.testapp'));
  // Sort still picks the highest page id within the bundle
  assert.equal(sorted[0].id, '6f8d21-2');
});

test('selectTarget with unknown bundleId falls through with warning', () => {
  const targets = [
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted, warning } = selectTarget(targets, { bundleId: 'com.different.app' });
  assert.equal(sorted.length, 2);
  assert.ok(warning);
  assert.match(warning, /bundleId "com.different.app" matched no targets/);
});

test('selectTarget preferredBundleId is soft filter — only applies when it narrows', () => {
  const targets = [
    { id: '008aba-2', platform: 'ios', description: 'host.exp.Exponent' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  // Preferred matches one target → narrows to it
  const { targets: narrowed } = selectTarget(targets, { preferredBundleId: 'com.rndevagent.testapp' });
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0].description, 'com.rndevagent.testapp');

  // Preferred matches nothing → doesn't eliminate candidates
  const { targets: fallthrough } = selectTarget(targets, { preferredBundleId: 'com.other.app' });
  assert.equal(fallthrough.length, 2);
});

test('selectTarget: targetId takes precedence over bundleId', () => {
  const targets = [
    { id: '6f8d21-1', platform: 'ios', description: 'com.rndevagent.testapp' },
    { id: '6f8d21-2', platform: 'ios', description: 'com.rndevagent.testapp' },
  ];
  const { targets: sorted } = selectTarget(targets, {
    targetId: '6f8d21-1',
    bundleId: 'com.rndevagent.testapp',
  });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '6f8d21-1');
});

test('selectTarget: legacy string signature still works', () => {
  const targets = [
    { id: '1', platform: 'ios' },
    { id: '2', platform: 'android' },
  ];
  const { targets: sorted } = selectTarget(targets, 'ios');
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].id, '1');
});
