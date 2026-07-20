import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { setActiveSession, clearActiveSession } from '../../dist/agent-device-wrapper.js';
import { selectTarget } from '../../dist/cdp/discovery.js';
import { shouldRecoverAndroidAccessibility } from '../../dist/runners/rn-android-runner-client.js';
import { createDeviceBatchHandler } from '../../dist/tools/device-batch.js';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import {
  createStatusHandler,
  sessionConnectFilters,
  targetMatchesSession,
} from '../../dist/tools/status.js';

const roots: string[] = [];
afterEach(() => {
  clearActiveSession();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function seedAction(): string {
  const root = mkdtempSync(join(tmpdir(), 'gh-589-action-'));
  roots.push(root);
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'opaque.yaml'),
    [
      '# id: opaque',
      '# intent: expose the terminal failure',
      '# tags: [regression]',
      '# mutates: false',
      '# status: experimental',
      '',
      '- tapOn:',
      '    id: "offscreen-control"',
      '',
    ].join('\n'),
  );
  return root;
}

test('GH #589: learned action surfaces maestro_run full-stream headline when bounded output is opaque', async () => {
  const root = seedAction();
  const headline =
    'Maestro flow failed at step "tapOn: id=offscreen-control" (SELECTOR_NOT_FOUND: offscreen-control)';
  const handler = createRunActionHandler({
    maestroRun: async () => ({
      isError: true as const,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: headline,
            meta: {
              output: 'runner preamble only',
              failedStep: { name: 'tapOn: id=offscreen-control' },
            },
          }),
        },
      ],
    }),
    repairAction: async () => {
      throw new Error('repair must not run for UNKNOWN');
    },
    replayDeps: () => null,
  });

  const result = await handler({
    actionId: 'opaque',
    projectRoot: root,
    platform: 'android',
    autoRepair: false,
  });
  const parsed = envelope(result);
  assert.equal(result.isError, true);
  assert.match(parsed.error, /offscreen-control/);
  assert.equal(parsed.meta.underlyingFailure, headline);
});

test('GH #589: physical Android session filters out an emulator CDP target', () => {
  const session = {
    name: 'physical',
    platform: 'android',
    deviceId: '46828c2c',
    appId: 'dev.fixture',
    openedAt: new Date().toISOString(),
  };
  const filters = sessionConnectFilters(session);
  assert.deepEqual(filters, {
    platform: 'android',
    bundleId: 'dev.fixture',
    deviceKind: 'physical',
  });

  const emulator = {
    id: 'emu',
    title: 'React Native',
    vm: 'Hermes',
    webSocketDebuggerUrl: 'ws://127.0.0.1/emu',
    platform: 'android' as const,
    description: 'dev.fixture',
    deviceName: 'sdk_gphone64_arm64 - 15 - API 35',
  };
  const physical = {
    ...emulator,
    id: 'phone',
    webSocketDebuggerUrl: 'ws://127.0.0.1/phone',
    deviceName: 'OnePlus BE2013',
  };

  assert.equal(targetMatchesSession(emulator, filters!), false);
  assert.equal(targetMatchesSession(physical, filters!), true);
  assert.deepEqual(
    selectTarget([emulator, physical], filters!).targets.map((target) => target.id),
    ['phone'],
  );
});

test('GH #589: cdp_status refuses an explicit platform that conflicts with the active session', async () => {
  setActiveSession({
    name: 'physical',
    platform: 'android',
    deviceId: '46828c2c',
    appId: 'dev.fixture',
  });
  let touchedClient = false;
  const fakeClient = {
    metroPort: 8081,
    get isConnected() {
      touchedClient = true;
      return false;
    },
  };
  const handler = createStatusHandler(
    () => fakeClient as never,
    () => undefined,
    () => fakeClient as never,
  );
  const result = await handler({ platform: 'ios' });
  const parsed = envelope(result);
  assert.equal(result.isError, true);
  assert.equal(parsed.code, 'TARGET_SESSION_MISMATCH');
  assert.equal(touchedClient, false, 'refusal must happen before any connect/relaunch side effect');
});

test('GH #589: missing target identity is refused instead of silently binding a physical session', () => {
  const target = {
    id: 'unknown',
    title: 'React Native Bridgeless',
    vm: 'Hermes',
    webSocketDebuggerUrl: 'ws://127.0.0.1/unknown',
    platform: 'android' as const,
    description: 'dev.fixture',
  };
  const selected = selectTarget([target], {
    platform: 'android',
    bundleId: 'dev.fixture',
    deviceKind: 'physical',
  });
  assert.deepEqual(selected.targets, []);
  assert.match(selected.warning!, /identity unavailable/);
});

test('GH #589: only accessibility-loss snapshots trigger the one-shot runner recovery', () => {
  assert.equal(
    shouldRecoverAndroidAccessibility('snapshot', {
      ok: false,
      error: { code: 'ACCESSIBILITY_UNAVAILABLE', message: 'system bars only' },
    }),
    true,
  );
  assert.equal(
    shouldRecoverAndroidAccessibility('snapshot', {
      ok: false,
      error: { code: 'SNAPSHOT_PARSE_FAILED', message: 'bad XML' },
    }),
    false,
  );
  assert.equal(
    shouldRecoverAndroidAccessibility('tap', {
      ok: false,
      error: { code: 'ACCESSIBILITY_UNAVAILABLE', message: 'not a snapshot' },
    }),
    false,
  );
});

test('GH #589: timed-out fill-like batch work never starts the next OTP slot', async () => {
  setActiveSession({
    name: 'otp',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.fixture',
  });
  const handler = createDeviceBatchHandler();
  const result = await handler({
    continueOnError: true,
    screenshotOn: 'none',
    finalSnapshot: 'none',
    steps: [
      { action: 'wait', ms: 40, timeoutMs: 1, optional: true },
      { action: 'wait', ms: 1 },
    ],
  });
  const parsed = envelope(result);
  assert.equal(result.isError, true);
  assert.equal(parsed.meta.failed_step.step, 1);
  assert.equal(parsed.meta.results.length, 1);
  assert.match(parsed.error, /remaining steps were not started/);
});

test('GH #589: ordinary continueOnError behavior remains available for synchronous failures', async () => {
  setActiveSession({
    name: 'known-good',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.fixture',
  });
  const handler = createDeviceBatchHandler();
  const result = await handler({
    continueOnError: true,
    screenshotOn: 'none',
    finalSnapshot: 'none',
    steps: [{ action: 'press' }, { action: 'wait', ms: 1 }],
  });
  const parsed = envelope(result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.steps_completed, 2);
});
