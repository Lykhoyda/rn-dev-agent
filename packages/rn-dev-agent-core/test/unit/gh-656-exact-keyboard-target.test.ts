import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs, tapRetryPolicy } from '../../dist/agent-device-wrapper.js';
import {
  clearRefMap,
  getFreshRefTarget,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import {
  _setCapabilitiesForTest,
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_IOS_FEATURES,
} from '../../dist/runners/protocol.js';
import {
  isKeyboardOccludedRefusal,
  surfaceKeyboardGuard,
} from '../../dist/runners/keyboard-guard.js';
import { failResult } from '../../dist/utils.js';

const rect = { x: 5, y: 590, width: 39, height: 54 };
const key = { ref: '@e7', type: 'Key', label: 'Q', identifier: 'key-q', rect };

function state(protocolVersion = 2) {
  return {
    schemaVersion: 1,
    pid: process.pid,
    port: 22656,
    deviceId: 'gh656-device',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion,
  } as never;
}

function seed(type = 'Key') {
  clearRefMap();
  updateRefMapFromFlat([{ ...key, type }], {
    snapshotGeneration: 41,
    keyboardVisible: true,
  });
}

test('GH-656: current ref threads runner-owned exact descriptor; raw coordinates do not', () => {
  seed();
  assert.deepEqual(getFreshRefTarget('@e7'), {
    rect,
    snapshotGeneration: 41,
    snapshotNodeIndex: 7,
    snapshotElementType: 'Key',
    snapshotLabel: 'Q',
    snapshotIdentifier: 'key-q',
    keyboardStateAtSnapshot: true,
  });
  const ref = buildRunIOSArgs(['press', '@e7']);
  assert.equal(ref.snapshotNodeIndex, 7);
  assert.equal(ref.snapshotElementType, 'Key');
  assert.equal(ref.snapshotLabel, 'Q');
  assert.equal(ref.snapshotIdentifier, 'key-q');
  assert.deepEqual(ref.targetBounds, rect);
  const raw = buildRunIOSArgs(['press', '25', '617']);
  assert.equal(raw.snapshotNodeIndex, undefined);
  assert.equal(raw.snapshotElementType, undefined);
});

test('GH-656: old generation and noncanonical types cannot seed a keyboard descriptor', () => {
  seed();
  updateRefMapFromFlat(
    [
      {
        ref: '@e0',
        type: 'Button',
        label: 'Continue',
        rect: { x: 10, y: 10, width: 80, height: 40 },
      },
    ],
    { snapshotGeneration: 42, keyboardVisible: false },
  );
  assert.equal(getFreshRefTarget('@e7'), null);
  for (const type of ['Button', 'Other', 'key', 'KEY']) {
    seed(type);
    assert.equal(buildRunIOSArgs(['press', '@e7']).snapshotElementType, type);
  }
});

test('GH-656: exact keyboard refs are ineligible for hierarchy no-change replay', () => {
  seed();
  assert.equal(tapRetryPolicy(['press', '@e7'], 'tap', 25, 617, {}).eligible, false);
  seed('Button');
  assert.equal(tapRetryPolicy(['press', '@e7'], 'tap', 25, 617, {}).eligible, true);
});

test('GH-656: iOS feature compatibility rejects old swipe-capable artifacts only when required', () => {
  const health = {
    protocolVersion: 2,
    commands: [...REQUIRED_IOS_COMMANDS],
    capabilities: [] as string[],
  };
  assert.deepEqual(
    classifyRunnerCompatibility(health, null, REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES),
    { compatible: false, reason: 'missing-features', missing: ['EXACT_KEYBOARD_TARGET_GUARD'] },
  );
  assert.deepEqual(
    classifyRunnerCompatibility(
      { ...health, capabilities: ['EXACT_KEYBOARD_TARGET_GUARD'] },
      null,
      REQUIRED_IOS_COMMANDS,
      REQUIRED_IOS_FEATURES,
    ),
    { compatible: true },
  );
  // Android callers do not pass the iOS feature requirement.
  assert.deepEqual(classifyRunnerCompatibility(health, null), { compatible: true });
});

test('GH-656: missing feature and protocol-v1 key target refuse before dismissal or tap', async () => {
  seed();
  const args = buildRunIOSArgs(['press', '@e7']);
  for (const protocolVersion of [1, 2]) {
    _setFastRunnerStateForTest(state(protocolVersion));
    _setCapabilitiesForTest([]);
    let dispatches = 0;
    _setFetchForTest(async () => {
      dispatches += 1;
      throw new Error('must not dispatch');
    });
    const result = await runIOS(args);
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /RN_FAST_RUNNER_STALE/);
    assert.equal(dispatches, 0);
  }
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
});

test('GH-656: feature-capable runner receives the full descriptor and surfaces bounded telemetry', async () => {
  seed();
  _setFastRunnerStateForTest(state());
  _setCapabilitiesForTest(['EXACT_KEYBOARD_TARGET_GUARD']);
  const bodies: Record<string, unknown>[] = [];
  _setFetchForTest(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return new Response(
      JSON.stringify({
        ok: true,
        v: 2,
        data: { message: 'tapped', keyboardGuard: 'keyboard_target', keyboardGuardMs: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  try {
    const result = surfaceKeyboardGuard(await runIOS(buildRunIOSArgs(['press', '@e7'])));
    assert.equal(result.isError, undefined);
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.snapshotNodeIndex, 7);
    assert.equal(bodies[0]?.snapshotElementType, 'Key');
    assert.equal(bodies[0]?.snapshotLabel, 'Q');
    assert.equal(bodies[0]?.snapshotIdentifier, 'key-q');
    const envelope = JSON.parse(result.content[0]!.text) as { meta?: Record<string, unknown> };
    assert.equal(envelope.meta?.keyboardGuard, 'keyboard_target');
    assert.doesNotMatch(result.content[0]!.text, /field|value|textContent/i);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
    _setCapabilitiesForTest([]);
  }
});

test('GH-656: typed keyboard target stale is non-healable', () => {
  const stale = failResult(
    'KEYBOARD_TARGET_STALE: live target changed; no gesture was performed',
    'KEYBOARD_TARGET_STALE',
    { mutation: 'none' },
  );
  assert.equal(isKeyboardOccludedRefusal(stale), false);
  assert.match(stale.content[0]!.text, /"mutation":"none"/);
});
