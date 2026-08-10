import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  buildRunAndroidArgs,
  establishInteractionBaseline,
  settleWithRetryIfNoChange,
} from '../../dist/agent-device-wrapper.js';
import {
  clearRefMap,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import { okResult } from '../../dist/utils.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../dist/runners/rn-android-runner-client.js';
import { REQUIRED_ANDROID_COMMANDS } from '../../dist/runners/protocol.js';
import { scopeSnapshotNodesForFind } from '../../dist/tools/device-interact.js';

const appId = 'com.example.app';
const appHome = {
  ref: '@e1',
  type: 'android.widget.TextView',
  label: 'Home',
  identifier: 'tab-home',
  packageName: appId,
  rect: { x: 0, y: 700, width: 180, height: 80 },
};
const systemHome = {
  ref: '@e2',
  type: 'android.widget.ImageView',
  label: 'Home',
  identifier: 'home',
  packageName: 'com.android.systemui',
  rect: { x: 180, y: 780, width: 80, height: 80 },
};

afterEach(() => {
  clearRefMap();
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
});

test('Android find scope excludes system chrome unless explicitly opted in', () => {
  const nodes = [appHome, systemHome];
  assert.deepEqual(scopeSnapshotNodesForFind(nodes, 'android', appId, false), [appHome]);
  assert.deepEqual(scopeSnapshotNodesForFind(nodes, 'android', appId, true), nodes);
  assert.deepEqual(scopeSnapshotNodesForFind(nodes, 'ios', appId, false), nodes);
});

test('Android find scope fails closed when app ownership is unavailable', () => {
  assert.deepEqual(scopeSnapshotNodesForFind([systemHome], 'android', undefined, false), []);
});

test('fresh testID refs use exact accessibility ownership instead of snapshot coordinates', () => {
  updateRefMapFromFlat([
    {
      ref: '@e7',
      type: 'android.widget.Switch',
      identifier: 'settings-theme-toggle',
      rect: { x: 900, y: 400, width: 120, height: 60 },
      checked: false,
      enabled: true,
      hittable: true,
    },
  ]);

  assert.deepEqual(buildRunAndroidArgs(['press', '@e7'], appId), {
    command: 'tap',
    x: 960,
    y: 430,
    exactIdentifier: 'settings-theme-toggle',
    exactType: 'android.widget.Switch',
    bundleId: appId,
  });
  assert.equal(
    buildRunAndroidArgs(['press', '@e7', '--include-system-ui'], appId).includeSystemUi,
    true,
  );
});

test('Android runner reports a rejected tap as failure instead of success', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-5554',
    bundleId: appId,
    startedAt: '2026-08-10T00:00:00.000Z',
    protocolVersion: 1,
  });
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          protocolVersion: 1,
          commands: [...REQUIRED_ANDROID_COMMANDS],
        }),
      );
    }
    return new Response(JSON.stringify({ ok: true, data: { tapped: false }, v: 1 }));
  });

  const result = await runAndroid({
    command: 'tap',
    x: 960,
    y: 430,
    exactIdentifier: 'settings-theme-toggle',
    exactType: 'android.widget.Switch',
    bundleId: appId,
  });
  const envelope = JSON.parse(result.content[0].text) as {
    ok: boolean;
    code: string;
    meta: { mutation: string };
  };
  assert.equal(result.isError, true);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'INTERACTION_NOT_ACTUATED');
  assert.equal(envelope.meta.mutation, 'none');
});

test('Switch checked-state changes are observable to interaction settlement', () => {
  const base = {
    ref: '@e7',
    type: 'android.widget.Switch',
    identifier: 'settings-theme-toggle',
    rect: { x: 900, y: 400, width: 120, height: 60 },
    enabled: true,
    hittable: true,
  };
  assert.notEqual(
    hashSnapshotNodes([{ ...base, checked: false }]),
    hashSnapshotNodes([{ ...base, checked: true }]),
  );
});

test('device_find exposes a typed explicit system-UI opt-in', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  assert.match(source, /includeSystemUi:\s*z\s*\.boolean\(\)/);
  assert.match(source, /Android matching is app-window-only by default/);
});

test('Android runner scopes exact presses and refuses rejected accessibility actions', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      '..',
      'rn-android-runner',
      'app',
      'src',
      'androidTest',
      'java',
      'dev',
      'lykhoyda',
      'rndevagent',
      'androidrunner',
      'CommandDispatcher.kt',
    ),
    'utf8',
  );
  assert.match(source, /packageName == appPackage/);
  assert.match(source, /performAction\(AccessibilityNodeInfo\.ACTION_CLICK\)/);
  assert.match(source, /if \(!dispatched\) \{\s*throw ExactPressException/);
});

test('exact press disambiguates duplicates by the requested point and clicks the clickable ancestor', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      '..',
      'rn-android-runner',
      'app',
      'src',
      'androidTest',
      'java',
      'dev',
      'lykhoyda',
      'rndevagent',
      'androidrunner',
      'CommandDispatcher.kt',
    ),
    'utf8',
  );
  // Duplicate testIDs/labels in a list stay actuable: the @ref centre picks one.
  assert.match(source, /private fun nodeContaining\(/);
  assert.match(source, /bounds\.contains\(requested\.x, requested\.y\)/);
  assert.match(source, /nodeContaining\(matches, requested\)/);
  // A labelled non-clickable node routes to its nearest clickable ancestor.
  assert.match(source, /private fun clickableAncestorOrSelf\(/);
  assert.match(source, /return clickableAncestorOrSelf\(chosen\)/);
  // The typed refusal survives when no unique safe target exists.
  assert.match(source, /"exact-target-ambiguous"/);
});

const baselinePolicy = { eligible: true, verificationRequired: true, targetKey: 'tap@960,430' };
const probeDeps = (outcome: unknown, hash = 'BASELINE') => ({
  enabled: () => true,
  capabilities: () => [],
  probes: () => ({ snapshotHash: async () => hash, sleep: async () => {}, now: () => 0 }),
  wait: async () => outcome,
});

test('a mutating verb that invalidated the baseline does not fail the next tap', async () => {
  updateRefMapFromFlat([appHome]);
  invalidateLastSnapshotHash(); // what device_scroll/back/fill leave behind
  assert.equal(getLastSnapshotHash(), null);

  const baseline = await establishInteractionBaseline(
    { platform: 'android', appId },
    baselinePolicy,
    probeDeps(null),
  );
  assert.equal(baseline, 'BASELINE');

  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => okResult({ tapped: true }),
    { platform: 'android', verb: 'tap', appId, initialSnapshotHash: baseline },
    baselinePolicy,
    probeDeps({ settled: true, method: 'window-gate', ms: 5, hierarchyChanged: true }),
  );
  const envelope = JSON.parse(result.content[0].text) as { ok: boolean };
  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
});

test('a device_batch step with settle:false neither probes a baseline nor fails the tap', async () => {
  updateRefMapFromFlat([appHome]);
  invalidateLastSnapshotHash();
  let probes = 0;
  const deps = {
    enabled: () => true,
    capabilities: () => [],
    probes: () => ({
      snapshotHash: async () => {
        probes++;
        return 'BASELINE';
      },
      sleep: async () => {},
      now: () => 0,
    }),
    wait: async () => {
      throw new Error('settle must not run when it is disabled');
    },
  };
  const settle = { enabled: false };

  assert.equal(
    await establishInteractionBaseline(
      { platform: 'android', appId, settle },
      baselinePolicy,
      deps,
    ),
    undefined,
  );
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => okResult({ tapped: true }),
    { platform: 'android', verb: 'tap', appId, settle },
    baselinePolicy,
    deps,
  );
  const envelope = JSON.parse(result.content[0].text) as { ok: boolean };
  assert.equal(probes, 0);
  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
});

test('RN_SETTLE=0 opts out of effect verification instead of failing every Android tap', async () => {
  updateRefMapFromFlat([appHome]);
  invalidateLastSnapshotHash();
  process.env.RN_SETTLE = '0';
  try {
    assert.equal(
      await establishInteractionBaseline({ platform: 'android', appId }, baselinePolicy, {
        probes: () => ({
          snapshotHash: async () => 'BASELINE',
          sleep: async () => {},
          now: () => 0,
        }),
      }),
      undefined,
    );
    const result = await settleWithRetryIfNoChange(
      okResult({ tapped: true }),
      async () => okResult({ tapped: true }),
      { platform: 'android', verb: 'tap', appId },
      baselinePolicy,
      {},
    );
    const envelope = JSON.parse(result.content[0].text) as { ok: boolean };
    assert.equal(result.isError, undefined);
    assert.equal(envelope.ok, true);
  } finally {
    delete process.env.RN_SETTLE;
  }
});

test('an established baseline is reused, and no baseline is taken when verification is off', async () => {
  updateRefMapFromFlat([appHome]);
  const cached = getLastSnapshotHash();
  assert.notEqual(cached, null);
  assert.equal(
    await establishInteractionBaseline(
      { platform: 'android', appId },
      baselinePolicy,
      probeDeps(null),
    ),
    cached,
  );
  invalidateLastSnapshotHash();
  assert.equal(
    await establishInteractionBaseline(
      { platform: 'android', appId },
      { eligible: false, verificationRequired: false, targetKey: '' },
      probeDeps(null),
    ),
    undefined,
  );
});
