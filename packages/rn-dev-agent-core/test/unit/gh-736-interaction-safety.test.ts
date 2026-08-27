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
  IME_KEY_FLAG,
  markSnapshotDirty,
  outsideAppWindowFailResult,
  rebuildHealedAndroidArgs,
  settleAfterMutationWithOutcome,
  settleWithRetryIfNoChange,
  tapRetryPolicy,
} from '../../dist/agent-device-wrapper.js';
import {
  clearRefMap,
  getLastSnapshotHash,
  invalidateLastSnapshotHash,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import { failResult, okResult } from '../../dist/utils.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';
import { hashAndroidAppSnapshotNodes } from '../../dist/lifecycle/settle.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  AndroidFeaturesStaleError,
  androidRetryCleanupContext,
  classifyAndroidHealth,
  reapMismatchedAndroidRunner,
  runBoundedAndroidRunnerRebuild,
  runAndroid,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
} from '../../dist/runners/protocol.js';
import {
  _setImePackageResolverForTest,
  createDeviceFindHandler,
  createDeviceFocusNextHandler,
  focusNextPressArgs,
  parseDefaultInputMethodPackage,
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
const imePackage = 'com.google.android.inputmethod.latin';
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
const systemBack = {
  ref: '@e4',
  type: 'android.widget.ImageView',
  label: 'Back',
  identifier: 'back',
  packageName: 'com.android.systemui',
  rect: { x: 20, y: 780, width: 80, height: 80 },
};
const systemOverview = {
  ref: '@e5',
  type: 'android.widget.ImageView',
  label: 'Overview',
  identifier: 'recent_apps',
  packageName: 'com.android.systemui',
  rect: { x: 340, y: 780, width: 80, height: 80 },
};
const appTasks = {
  ref: '@e6',
  type: 'android.widget.TextView',
  label: 'Tasks',
  identifier: 'tab-tasks',
  packageName: appId,
  rect: { x: 180, y: 700, width: 180, height: 80 },
};
const expoDeveloperMenuText = {
  ref: '@e7',
  type: 'android.widget.TextView',
  label: 'This is the developer menu. It gives you access to useful tools.',
  packageName: appId,
  rect: { x: 40, y: 430, width: 360, height: 100 },
};
const expoDeveloperMenuContinue = {
  ref: '@e8',
  type: 'android.widget.Button',
  label: 'Continue',
  packageName: appId,
  rect: { x: 40, y: 650, width: 360, height: 70 },
};

afterEach(() => {
  clearRefMap();
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
  _setRunAgentDeviceForTest(null);
  _setActiveSessionForTest(null);
  _setImePackageResolverForTest(null);
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

test('device_find excludes Android Home, Back, and Overview unless explicitly opted in', async () => {
  _setActiveSessionForTest({
    name: 'gh-736',
    platform: 'android',
    appId,
    openedAt: '2026-08-10T00:00:00.000Z',
  });
  const nodes = [appHome, systemHome, systemBack, systemOverview];
  let snapshots = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    assert.equal(cliArgs[0], 'snapshot');
    snapshots++;
    return okResult({ nodes });
  });
  const find = createDeviceFindHandler();

  const ownedHome = JSON.parse((await find({ text: 'Home', exact: true })).content[0].text) as {
    ok: boolean;
    data: { ref: string; testID: string };
  };
  assert.equal(ownedHome.ok, true);
  assert.deepEqual(ownedHome.data, { ref: appHome.ref, label: 'Home', testID: 'tab-home' });

  for (const label of ['Back', 'Overview']) {
    const excluded = JSON.parse((await find({ text: label, exact: true })).content[0].text) as {
      ok: boolean;
      meta: { code: string; query: string };
    };
    assert.equal(excluded.ok, false);
    assert.equal(excluded.meta.code, 'NOT_FOUND');
    assert.equal(excluded.meta.query, label);
  }

  for (const node of [systemHome, systemBack, systemOverview]) {
    const explicit = JSON.parse(
      (
        await find({
          text: node.identifier,
          exact: true,
          includeSystemUi: true,
        })
      ).content[0].text,
    ) as {
      ok: boolean;
      data: { ref: string; scope: string };
    };
    assert.equal(explicit.ok, true);
    assert.equal(explicit.data.ref, node.ref);
    assert.equal(explicit.data.scope, 'system-ui-explicit');
  }

  assert.equal(snapshots, 1, 'all matches must be scoped from one authoritative snapshot');
});

test('an app-owned Expo Developer Menu exposes only its visible supported path', async () => {
  markSnapshotDirty('android');
  _setActiveSessionForTest({
    name: 'gh-736-expo-menu',
    platform: 'android',
    appId,
    openedAt: '2026-08-23T00:00:00.000Z',
  });
  let foreground: 'menu' | 'app' = 'menu';
  let presses = 0;
  _setRunAgentDeviceForTest(async (cliArgs: string[]) => {
    if (cliArgs[0] === 'snapshot') {
      return okResult({
        nodes:
          foreground === 'menu'
            ? [expoDeveloperMenuText, expoDeveloperMenuContinue, systemHome]
            : [appHome, appTasks, systemHome],
      });
    }
    assert.deepEqual(cliArgs, ['press', expoDeveloperMenuContinue.ref]);
    presses++;
    foreground = 'app';
    return okResult({ tapped: true, method: 'accessibility-action' });
  });
  const find = createDeviceFindHandler();

  const covered = JSON.parse(
    (await find({ text: 'Tasks', exact: true, action: 'click' })).content[0].text,
  ) as { ok: boolean; error: string; meta: { code: string; query: string } };
  assert.equal(covered.ok, false);
  assert.equal(covered.meta.code, 'NOT_FOUND');
  assert.equal(covered.meta.query, 'Tasks');
  assert.equal(presses, 0, 'a covered app control must not dispatch');

  const dismissed = JSON.parse(
    (await find({ text: 'Continue', exact: true, action: 'click' })).content[0].text,
  ) as { ok: boolean; data: { tapped: boolean } };
  assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
  assert.equal(dismissed.data.tapped, true);
  assert.equal(presses, 1);

  markSnapshotDirty('android');
  const visible = JSON.parse((await find({ text: 'Tasks', exact: true })).content[0].text) as {
    ok: boolean;
    data: { ref: string; testID: string };
  };
  assert.equal(visible.ok, true);
  assert.equal(visible.data.ref, appTasks.ref);
  assert.equal(visible.data.testID, appTasks.identifier);
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
  assert.equal(
    buildRunAndroidArgs(['press', systemHome.ref, '--include-system-ui'], appId).includeSystemUi,
    true,
  );
});

test('an explicit system-UI press never grants a later untyped device_press', async () => {
  updateRefMapFromFlat([systemHome]);
  await pressCandidate(
    { ref: systemHome.ref, testID: systemHome.identifier, type: systemHome.type },
    undefined,
    undefined,
    true,
  );
  assert.equal(buildRunAndroidArgs(['press', systemHome.ref], appId).includeSystemUi, undefined);
  assert.equal(
    androidOutsideAppWindowRefusal(['press', systemHome.ref], appId)?.packageName,
    'com.android.systemui',
  );
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

test('fresh visible-label refs use exact accessibility ownership instead of raw coordinates', () => {
  updateRefMapFromFlat([
    {
      ref: '@e121',
      type: 'android.widget.TextView',
      label: 'Tasks',
      identifier: '',
      packageName: appId,
      rect: { x: 426, y: 1480, width: 48, height: 24 },
      enabled: true,
      hittable: true,
    },
  ]);

  assert.deepEqual(buildRunAndroidArgs(['press', '@e121'], appId), {
    command: 'tap',
    x: 450,
    y: 1492,
    exactLabel: 'Tasks',
    exactType: 'android.widget.TextView',
    bundleId: appId,
  });
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
    missing: ['APP_SCOPED_EXACT_INTERACTION', 'APP_SCOPED_EXACT_LABEL_INTERACTION'],
  });
  assert.deepEqual(
    classifyRunnerCompatibility(common, null, REQUIRED_ANDROID_COMMANDS, REQUIRED_ANDROID_FEATURES),
    {
      compatible: false,
      reason: 'missing-features',
      missing: ['APP_SCOPED_EXACT_INTERACTION', 'APP_SCOPED_EXACT_LABEL_INTERACTION'],
    },
  );
  assert.deepEqual(
    classifyRunnerCompatibility(
      { ...common, capabilities: ['APP_SCOPED_EXACT_INTERACTION'] },
      null,
      REQUIRED_ANDROID_COMMANDS,
      REQUIRED_ANDROID_FEATURES,
    ),
    {
      compatible: false,
      reason: 'missing-features',
      missing: ['APP_SCOPED_EXACT_LABEL_INTERACTION'],
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

test('missing exact-label capability uses the bounded artifact rebuild path', async () => {
  const error = new AndroidFeaturesStaleError(
    ['APP_SCOPED_EXACT_LABEL_INTERACTION'],
    appId,
    '46828c2c',
  );
  assert.match(error.message, /^RUNNER_FEATURES_STALE:/);
  assert.deepEqual(androidRetryCleanupContext(null, error), { deviceId: '46828c2c' });

  let rebuilt = 0;
  const result = await runBoundedAndroidRunnerRebuild(
    error,
    async () => {
      rebuilt++;
      return 'rebuilt';
    },
    async () => {},
    {
      acquire: () => ({
        status: 'acquired',
        lock: { ownerNonce: 'gh-736', pluginVersion: 'test' },
      }),
      heartbeat: () => true,
      complete: () => true,
      beginCleanup: () => true,
      release: () => true,
      markCleanupUnverified: () => true,
      heartbeatIntervalMs: 60_000,
    },
  );
  assert.equal(result, 'rebuilt');
  assert.equal(rebuilt, 1);
});

test('unbound stale-feature cleanup waits for current-session runner resources to release', async () => {
  const error = new AndroidFeaturesStaleError(
    ['APP_SCOPED_EXACT_LABEL_INTERACTION'],
    appId,
    '46828c2c',
  );
  const cleanupContext = androidRetryCleanupContext(null, error);
  const events: string[] = [];
  let verificationAttempts = 0;

  await reapMismatchedAndroidRunner(
    cleanupContext,
    async ({ deviceId, includeLegacy }) => {
      events.push(`release:${deviceId}:${String(includeLegacy)}`);
      return {
        stoppedOwnRunner: true,
        forceStoppedPackages: [
          'dev.lykhoyda.rndevagent.androidrunner.test',
          'dev.lykhoyda.rndevagent.androidrunner',
        ],
      };
    },
    async ({ deviceId }) => {
      verificationAttempts += 1;
      events.push(`verify:${deviceId}:${verificationAttempts}`);
      if (verificationAttempts === 1) {
        throw new Error(
          `RUNNER_CLEANUP_UNCONFIRMED: Android runner resources remain for ${deviceId}`,
        );
      }
    },
    undefined,
    { attempts: 2, intervalMs: 0, delay: async () => events.push('settle') },
  );

  assert.deepEqual(events, [
    'release:46828c2c:false',
    'verify:46828c2c:1',
    'settle',
    'verify:46828c2c:2',
  ]);
});

test('unbound stale-feature cleanup remains truthful when runner resources never release', async () => {
  const error = new AndroidFeaturesStaleError(
    ['APP_SCOPED_EXACT_LABEL_INTERACTION'],
    appId,
    '46828c2c',
  );
  let verificationAttempts = 0;

  await assert.rejects(
    reapMismatchedAndroidRunner(
      androidRetryCleanupContext(null, error),
      async () => ({
        stoppedOwnRunner: true,
        forceStoppedPackages: [
          'dev.lykhoyda.rndevagent.androidrunner.test',
          'dev.lykhoyda.rndevagent.androidrunner',
        ],
      }),
      async ({ deviceId }) => {
        verificationAttempts += 1;
        throw new Error(
          `RUNNER_CLEANUP_UNCONFIRMED: Android runner resources remain for ${deviceId}`,
        );
      },
      undefined,
      { attempts: 2, intervalMs: 0, delay: async () => {} },
    ),
    /RUNNER_CLEANUP_UNCONFIRMED: Android runner resources remain for 46828c2c/,
  );
  assert.equal(verificationAttempts, 2);
});

test('Android runner reports a rejected tap truthfully per dispatch mechanism', async () => {
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
  const commandBodies: Array<Record<string, unknown>> = [];
  _setFetchForTest(async (url, init) => {
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
    commandBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
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

  const visibleLabelResult = await runAndroid({
    command: 'tap',
    x: 450,
    y: 1492,
    exactLabel: 'Tasks',
    exactType: 'android.widget.TextView',
    bundleId: appId,
  });
  const visibleLabelEnvelope = JSON.parse(visibleLabelResult.content[0].text) as {
    code: string;
    meta: { mutation: string };
  };
  assert.equal(visibleLabelResult.isError, true);
  assert.equal(visibleLabelEnvelope.code, 'INTERACTION_NOT_ACTUATED');
  assert.equal(visibleLabelEnvelope.meta.mutation, 'none');
  assert.equal(commandBodies[1]?.exactLabel, 'Tasks');
  assert.equal(commandBodies[1]?.exactType, 'android.widget.TextView');

  const coordinateResult = await runAndroid({
    command: 'tap',
    x: 960,
    y: 430,
    bundleId: appId,
  });
  const coordinateEnvelope = JSON.parse(coordinateResult.content[0].text) as {
    ok: boolean;
    code: string;
    meta: { mutation: string; attempts: number };
  };
  assert.equal(coordinateResult.isError, true);
  assert.equal(coordinateEnvelope.code, 'INTERACTION_EFFECT_UNVERIFIED');
  assert.equal(coordinateEnvelope.meta.mutation, 'possible');
  assert.equal(coordinateEnvelope.meta.attempts, 1);
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
  assert.equal(
    androidOutsideAppWindowRefusal(['press', systemHome.ref], appId)?.packageName,
    'com.android.systemui',
  );
});

test('device_focus_next keeps actuating the Android IME key it already matched', () => {
  updateRefMapFromFlat([appHome, imeKey]);
  const args = focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId, imePackage);
  assert.deepEqual(args, ['press', imeKey.ref, '--include-system-ui', IME_KEY_FLAG]);
  assert.equal(androidOutsideAppWindowRefusal(args, appId), null);
  assert.equal(buildRunAndroidArgs(args, appId).includeSystemUi, true);
});

test('a verified IME key press is neither effect-probed nor re-dispatched', async () => {
  updateRefMapFromFlat([appHome, imeKey]);
  const args = focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId, imePackage);
  const policy = tapRetryPolicy(args, 'tap', 850, 1250, {});
  assert.equal(policy.verificationRequired, false);
  assert.equal(policy.eligible, false);
  assert.equal(
    await establishInteractionBaseline({ platform: 'android', appId }, policy),
    undefined,
  );

  let dispatches = 0;
  const actuated = okResult({ tapped: true, method: 'accessibility-action' });
  const settled = await settleWithRetryIfNoChange(
    actuated,
    async () => {
      dispatches++;
      return actuated;
    },
    { platform: 'android', verb: 'press', appId },
    policy,
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({
        snapshotHash: async () => 'UNCHANGED',
        sleep: async () => {},
        now: () => 0,
      }),
      wait: async () => ({ settled: true, method: 'hierarchy', hierarchyChanged: false }),
    },
  );
  assert.equal(dispatches, 0, 'a keyboard key must never be actuated twice');
  assert.equal(settled.isError, undefined);
  const envelope = JSON.parse(settled.content[0].text) as { ok: boolean; code?: string };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.code, undefined);
});

test('ordinary app taps keep fail-closed effect verification without replay eligibility', () => {
  updateRefMapFromFlat([appHome, imeKey]);
  const policy = tapRetryPolicy(['press', appHome.ref], 'tap', 90, 740, {});
  assert.equal(policy.verificationRequired, true);
  assert.equal(policy.eligible, false);
  const systemUiPolicy = tapRetryPolicy(
    ['press', systemHome.ref, '--include-system-ui'],
    'tap',
    220,
    820,
    {},
  );
  assert.equal(
    systemUiPolicy.verificationRequired,
    true,
    'explicit system-UI scope alone must not buy a verification exemption',
  );
});

test('the IME grant requires the real default IME, not any outside-app window', () => {
  assert.deepEqual(
    focusNextPressArgs(systemHome.ref, systemHome.packageName, 'android', appId, imePackage),
    ['press', systemHome.ref],
  );
  assert.deepEqual(focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId, null), [
    'press',
    imeKey.ref,
  ]);
  assert.deepEqual(
    focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId, 'com.other.ime'),
    ['press', imeKey.ref],
  );
});

test('the default-IME probe accepts only a well-formed package', () => {
  assert.equal(parseDefaultInputMethodPackage(`${imePackage}/.LatinIME\n`), imePackage);
  assert.equal(parseDefaultInputMethodPackage(`  ${imePackage}  \n`), imePackage);
  assert.equal(parseDefaultInputMethodPackage('null\n'), null);
  assert.equal(parseDefaultInputMethodPackage(''), null);
  assert.equal(parseDefaultInputMethodPackage('rm -rf /\n'), null);
});

test('the focus-next keyboard grant never leaks into device_press', () => {
  updateRefMapFromFlat([appHome, imeKey, systemHome]);
  focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', appId, imePackage);
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
  assert.deepEqual(
    focusNextPressArgs(appHome.ref, appHome.packageName, 'android', appId, imePackage),
    ['press', appHome.ref],
  );
  assert.deepEqual(focusNextPressArgs('e3', imeKey.packageName, 'ios', appId, imePackage), [
    'press',
    '@e3',
  ]);
  assert.deepEqual(focusNextPressArgs(imeKey.ref, undefined, 'android', appId, imePackage), [
    'press',
    imeKey.ref,
  ]);
  assert.deepEqual(
    focusNextPressArgs(imeKey.ref, imeKey.packageName, 'android', undefined, imePackage),
    ['press', imeKey.ref],
  );
});

test('device_focus_next presses the IME key on Android instead of reporting it missing', async () => {
  _setActiveSessionForTest({
    name: 'gh-736',
    platform: 'android',
    appId,
    openedAt: '2026-08-10T00:00:00.000Z',
  });
  _setImePackageResolverForTest(async () => imePackage);
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
  assert.deepEqual(dispatched[1], ['press', imeKey.ref, '--include-system-ui', IME_KEY_FLAG]);
});

test('device_focus_next reports a refused key press truthfully, not as a missing key', async () => {
  _setActiveSessionForTest({
    name: 'gh-736',
    platform: 'android',
    appId,
    openedAt: '2026-08-10T00:00:00.000Z',
  });
  _setImePackageResolverForTest(async () => null);
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
  assert.match(source, /requireNoSameWindowOccluder\(clickable, requested\)/);
  assert.match(source, /ExactPressSafety\.sameWindowOcclusion\(targetPath, it\)/);
  assert.match(source, /ExactPressSafety\.OcclusionVerdict\.OCCLUDED -> occluded = true/);
  assert.match(source, /else -> zOrderUnresolved = true/);
  assert.match(source, /candidate\.isClickable/);
  assert.match(source, /requireNoSameWindowOccluder\(clickable, requested\)\s*return clickable/);
  assert.match(source, /"exact-target-not-hittable"/);
  // A coordinate outside the display is refused before any injection.
  assert.match(
    source,
    /CoordinateBounds\.contains\(device\.displayWidth, device\.displayHeight, x, y\)/,
  );
  assert.match(source, /"coordinate-out-of-bounds"/);
});

const baselinePolicy = { eligible: false, verificationRequired: true, targetKey: 'tap@960,430' };
const probeDeps = (outcome: unknown, hash = 'BASELINE') => ({
  enabled: () => true,
  capabilities: () => [],
  probes: () => ({ snapshotHash: async () => hash, sleep: async () => {}, now: () => 0 }),
  wait: async () => outcome,
});

test('a navigation effect false-negative is uncertain but never re-actuates', async () => {
  updateRefMapFromFlat([appHome]);
  let redispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true, method: 'accessibility-action' }),
    async () => {
      redispatches++;
      return okResult({ tapped: true, method: 'accessibility-action' });
    },
    { platform: 'android', verb: 'tap', appId, initialSnapshotHash: 'BASELINE' },
    { ...baselinePolicy, eligible: true },
    probeDeps({ settled: true, method: 'window-gate', ms: 5, hierarchyChanged: false }),
  );
  const envelope = JSON.parse(result.content[0].text) as {
    code: string;
    meta: { attempts: number; mutation: string; tapRetried?: boolean };
  };
  assert.equal(redispatches, 0);
  assert.equal(envelope.code, 'INTERACTION_EFFECT_UNVERIFIED');
  assert.equal(envelope.meta.attempts, 1);
  assert.equal(envelope.meta.mutation, 'possible');
  assert.equal(envelope.meta.tapRetried, undefined);
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

test('a possibly dispatched gesture drops the effect baseline it may have invalidated', async () => {
  updateRefMapFromFlat([appHome]);
  assert.notEqual(getLastSnapshotHash(), null);
  await settleAfterMutationWithOutcome(
    failResult('refused before actuation', 'INTERACTION_NOT_ACTUATED', { mutation: 'none' }),
    { platform: 'android', verb: 'tap', appId },
    probeDeps(null),
  );
  assert.notEqual(getLastSnapshotHash(), null);

  await settleAfterMutationWithOutcome(
    failResult('the gesture may have landed', 'INTERACTION_EFFECT_UNVERIFIED', {
      mutation: 'possible',
    }),
    { platform: 'android', verb: 'tap', appId },
    probeDeps(null),
  );
  assert.equal(getLastSnapshotHash(), null);
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
