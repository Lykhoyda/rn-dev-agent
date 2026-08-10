import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
  androidOutsideAppWindowRefusal,
  buildRunAndroidArgs,
  establishInteractionBaseline,
  outsideAppWindowFailResult,
  rebuildHealedAndroidArgs,
  settleWithRetryIfNoChange,
} from '../../dist/agent-device-wrapper.js';
import {
  clearRefMap,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
  isSystemUiRefAuthorized,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import { okResult } from '../../dist/utils.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';
import { hashAndroidAppSnapshotNodes } from '../../dist/lifecycle/settle.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  classifyAndroidHealth,
  runAndroid,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';
import {
  createDeviceFocusNextHandler,
  focusNextPressArgs,
  pressCandidate,
  scopeSnapshotNodesForFind,
} from '../../dist/tools/device-interact.js';

const appId = 'com.example.app';
const appHome = {
  ref: '@e1',
  type: 'android.widget.TextView',
  label: 'Home',
  identifier: 'tab-home',
  packageName: appId,
  rect: { x: 0, y: 700, width: 180, height: 80 },
};
const imeKey = {
  ref: '@e3',
  type: 'android.inputmethodservice.Keyboard$Key',
  label: 'Done',
  identifier: 'key_pos_ime_action',
  packageName: 'com.google.android.inputmethod.latin',
  rect: { x: 800, y: 1200, width: 200, height: 100 },
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
  _setRunAgentDeviceForTest(null);
  _setActiveSessionForTest(null);
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

test('explicit system-UI find scope is preserved on the returned ref', async () => {
  updateRefMapFromFlat([appHome, systemHome]);
  const result = await pressCandidate(
    {
      ref: systemHome.ref,
      label: systemHome.label,
      testID: systemHome.identifier,
      type: systemHome.type,
    },
    undefined,
    undefined,
    true,
  );
  const envelope = JSON.parse(result.content[0].text) as {
    data: { ref: string; scope: string };
  };
  assert.equal(envelope.data.scope, 'system-ui-explicit');
  assert.equal(isSystemUiRefAuthorized(systemHome.ref), true);
  assert.equal(buildRunAndroidArgs(['press', systemHome.ref], appId).includeSystemUi, true);
});

test('system-UI ref authorization never crosses snapshot generations', async () => {
  updateRefMapFromFlat([systemHome]);
  await pressCandidate(
    { ref: systemHome.ref, testID: systemHome.identifier, type: systemHome.type },
    undefined,
    undefined,
    true,
  );
  updateRefMapFromFlat([appHome]);
  assert.equal(isSystemUiRefAuthorized(systemHome.ref), false);
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

test('stale-ref healing rebuilds exact ownership and explicit system scope', () => {
  updateRefMapFromFlat([
    {
      ref: '@e9',
      type: 'android.widget.Switch',
      identifier: 'settings-theme-toggle',
      rect: { x: 700, y: 300, width: 100, height: 50 },
      enabled: true,
      hittable: true,
    },
  ]);
  assert.deepEqual(rebuildHealedAndroidArgs(['press', '@e7'], '@e9', appId, true), {
    command: 'tap',
    x: 750,
    y: 325,
    exactIdentifier: 'settings-theme-toggle',
    exactType: 'android.widget.Switch',
    includeSystemUi: true,
    bundleId: appId,
  });
});

test('stale Android runners without scoped exact-interaction semantics are rejected', () => {
  const common = {
    protocolVersion: 1,
    commands: [...REQUIRED_ANDROID_COMMANDS],
  };
  assert.deepEqual(classifyAndroidHealth(common), {
    compatible: false,
    reason: 'missing-features',
    missing: ['APP_SCOPED_EXACT_INTERACTION'],
  });
  assert.deepEqual(
    classifyRunnerCompatibility(common, null, REQUIRED_ANDROID_COMMANDS, REQUIRED_ANDROID_FEATURES),
    {
      compatible: false,
      reason: 'missing-features',
      missing: ['APP_SCOPED_EXACT_INTERACTION'],
    },
  );
  assert.deepEqual(
    classifyRunnerCompatibility(
      { ...common, capabilities: [...REQUIRED_ANDROID_FEATURES] },
      null,
      REQUIRED_ANDROID_COMMANDS,
      REQUIRED_ANDROID_FEATURES,
    ),
    { compatible: true },
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
          capabilities: [...REQUIRED_ANDROID_FEATURES],
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

test('effect hashes ignore system-window changes and observe owned-app changes', () => {
  const baseApp = { ...appHome, checked: false };
  const changedApp = { ...appHome, checked: true };
  const baseSystem = { ...systemHome, checked: false };
  const changedSystem = { ...systemHome, checked: true };
  assert.equal(
    hashAndroidAppSnapshotNodes([baseApp, baseSystem], appId),
    hashAndroidAppSnapshotNodes([baseApp, changedSystem], appId),
  );
  assert.notEqual(
    hashAndroidAppSnapshotNodes([baseApp, baseSystem], appId),
    hashAndroidAppSnapshotNodes([changedApp, baseSystem], appId),
  );
  assert.equal(hashAndroidAppSnapshotNodes([baseApp], undefined), null);
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

test('device_press documents the Android app-window scope and its system-UI escape hatch', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  assert.match(source, /refused with OUTSIDE_APP_WINDOW/);
  assert.match(source, /device_find with includeSystemUi=true and action="click"/);
});

test('a snapshot-minted system-UI ref is refused by name instead of guessed at', () => {
  updateRefMapFromFlat([appHome, systemHome]);
  const refusal = androidOutsideAppWindowRefusal(['press', systemHome.ref], appId);
  assert.deepEqual(refusal, {
    ref: systemHome.ref,
    packageName: 'com.android.systemui',
    appId,
  });

  const failure = outsideAppWindowFailResult({
    ref: systemHome.ref,
    packageName: 'com.android.systemui',
    appId,
  });
  const envelope = JSON.parse(failure.content[0].text) as {
    ok: boolean;
    code: string;
    error: string;
    meta: { mutation: string; packageName: string; hint: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'OUTSIDE_APP_WINDOW');
  assert.equal(envelope.meta.mutation, 'none');
  assert.equal(envelope.meta.packageName, 'com.android.systemui');
  assert.match(envelope.error, /outside the owned app window/);
  assert.match(envelope.meta.hint, /device_find with includeSystemUi=true and action="click"/);
});

test('the app-window refusal covers every ref-scoped Android mutating verb', () => {
  updateRefMapFromFlat([appHome, systemHome]);
  for (const verb of ['press', 'tap', 'longpress']) {
    assert.equal(
      androidOutsideAppWindowRefusal([verb, systemHome.ref], appId)?.packageName,
      'com.android.systemui',
      `${verb} must refuse an outside-app ref`,
    );
  }
  assert.equal(
    androidOutsideAppWindowRefusal(['fill', systemHome.ref, 'hello'], appId)?.packageName,
    'com.android.systemui',
  );
});

test('owned-app refs, explicit system scope, and coordinate taps stay unrefused', async () => {
  updateRefMapFromFlat([appHome, systemHome]);
  assert.equal(androidOutsideAppWindowRefusal(['press', appHome.ref], appId), null);
  assert.equal(androidOutsideAppWindowRefusal(['press', '960', '430'], appId), null);
  assert.equal(
    androidOutsideAppWindowRefusal(['press', systemHome.ref, '--include-system-ui'], appId),
    null,
  );

  await pressCandidate(
    { ref: systemHome.ref, testID: systemHome.identifier, type: systemHome.type },
    undefined,
    undefined,
    true,
  );
  assert.equal(androidOutsideAppWindowRefusal(['press', systemHome.ref], appId), null);
});

test('device_focus_next keeps actuating the Android IME key it already matched', () => {
  updateRefMapFromFlat([appHome, imeKey]);
  const args = focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId);
  assert.deepEqual(args, ['press', imeKey.ref, '--include-system-ui']);
  assert.equal(androidOutsideAppWindowRefusal(args, appId), null);
  assert.equal(buildRunAndroidArgs(args, appId).includeSystemUi, true);
});

test('the focus-next keyboard grant never leaks into device_press', () => {
  updateRefMapFromFlat([appHome, imeKey, systemHome]);
  focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId);
  assert.equal(isSystemUiRefAuthorized(imeKey.ref), false);
  assert.equal(
    androidOutsideAppWindowRefusal(['press', imeKey.ref], appId)?.packageName,
    'com.google.android.inputmethod.latin',
  );
  assert.equal(buildRunAndroidArgs(['press', imeKey.ref], appId).includeSystemUi, undefined);
  assert.equal(
    androidOutsideAppWindowRefusal(['press', systemHome.ref], appId)?.packageName,
    'com.android.systemui',
  );
});

test('focus-next claims no system scope for owned-app keys or non-Android sessions', () => {
  assert.deepEqual(focusNextPressArgs(appHome.ref, appHome.packageName, 'android', appId), [
    'press',
    appHome.ref,
  ]);
  assert.deepEqual(focusNextPressArgs('e3', imeKey.packageName, 'ios', appId), ['press', '@e3']);
  assert.deepEqual(focusNextPressArgs(imeKey.ref, undefined, 'android', appId), [
    'press',
    imeKey.ref,
  ]);
  assert.deepEqual(focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', undefined), [
    'press',
    imeKey.ref,
  ]);
});

test('device_focus_next presses the IME key on Android instead of reporting it missing', async () => {
  _setActiveSessionForTest({
    name: 'gh-736',
    platform: 'android',
    appId,
    openedAt: '2026-08-10T00:00:00.000Z',
  });
  const dispatched: string[][] = [];
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    dispatched.push(cliArgs);
    if (cliArgs[0] === 'snapshot') {
      return okResult({ nodes: [appHome, imeKey] });
    }
    return cliArgs.includes('--include-system-ui')
      ? okResult({ tapped: true, method: 'accessibility-action' })
      : outsideAppWindowFailResult({
          ref: imeKey.ref,
          packageName: imeKey.packageName,
          appId,
        });
  });

  const result = await createDeviceFocusNextHandler()({});
  const envelope = JSON.parse(result.content[0].text) as {
    ok: boolean;
    meta: { keyUsed: string };
  };
  assert.equal(result.isError, undefined);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.keyUsed, 'Done');
  assert.deepEqual(dispatched[1], ['press', imeKey.ref, '--include-system-ui']);
});

test('device_focus_next reports a refused key press truthfully, not as a missing key', async () => {
  _setActiveSessionForTest({
    name: 'gh-736',
    platform: 'android',
    appId,
    openedAt: '2026-08-10T00:00:00.000Z',
  });
  _setRunAgentDeviceForTest(async (cliArgs: string[]) =>
    cliArgs[0] === 'snapshot'
      ? okResult({ nodes: [appHome, imeKey] })
      : outsideAppWindowFailResult({
          ref: imeKey.ref,
          packageName: imeKey.packageName,
          appId,
        }),
  );

  const result = await createDeviceFocusNextHandler()({});
  const envelope = JSON.parse(result.content[0].text) as { ok: boolean; code: string };
  assert.equal(result.isError, true);
  assert.equal(envelope.code, 'OUTSIDE_APP_WINDOW');
  assert.notEqual(envelope.code, 'KEYBOARD_NEXT_NOT_FOUND');
});

test('healing a stale ref onto system chrome is refused, not silently retargeted', () => {
  updateRefMapFromFlat([appHome]);
  updateRefMapFromFlat([systemHome]);
  assert.equal(
    androidOutsideAppWindowRefusal(['press', '@e1'], appId, systemHome.ref)?.packageName,
    'com.android.systemui',
  );
  assert.equal(androidOutsideAppWindowRefusal(['press', '@e1'], appId, 'e2')?.ref, '@e2');
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
  assert.match(source, /return clickableAncestorOrSelf\(chosen, requested\)/);
  // The typed refusal survives when no unique safe target exists.
  assert.match(source, /"exact-target-ambiguous"/);
  assert.match(source, /"exact-target-unresolved"/);
  assert.match(source, /ExactPressSafety\.traversalComplete\(stack\.size\)/);
  assert.match(source, /ExactPressSafety\.liveTargetIsHittable/);
  assert.match(source, /"exact-target-not-hittable"/);
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
