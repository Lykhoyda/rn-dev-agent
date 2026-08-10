import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';
import { clearRefMap, updateRefMapFromFlat } from '../../dist/fast-runner-ref-map.js';
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
