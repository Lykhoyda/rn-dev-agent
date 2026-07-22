import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
  buildRunIOSArgs,
} from '../../dist/agent-device-wrapper.js';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';
import {
  clearRefMap,
  getFreshRefTarget,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import {
  dismissKeyboardWithParity,
  healKeyboardOccludedTap,
} from '../../dist/runners/keyboard-guard.js';
import { createDeviceBatchHandler } from '../../dist/tools/device-batch.js';
import { failResult, okResult } from '../../dist/utils.js';

const node = {
  ref: '@e7',
  type: 'Button',
  identifier: 'wizard-next-btn',
  rect: { x: 20, y: 550, width: 200, height: 44 },
};

test('GH-588 Slice D: guarded ref carries versioned fresh bounds and keyboard state', () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 41, keyboardVisible: true });
  assert.deepEqual(getFreshRefTarget('@e7'), {
    rect: node.rect,
    snapshotGeneration: 41,
    keyboardStateAtSnapshot: true,
  });
  const args = buildRunIOSArgs(['press', '@e7']);
  assert.deepEqual(args.targetBounds, node.rect);
  assert.equal(args.snapshotGeneration, 41);
  assert.equal(args.keyboardStateAtSnapshot, true);
});

test('GH-588 Slice D: stale/unknown keyboard geometry is not advertised as fresh', () => {
  clearRefMap();
  updateRefMapFromFlat([node]);
  const args = buildRunIOSArgs(['press', '@e7']);
  assert.equal(args.targetBounds, undefined);
  assert.equal(args.snapshotGeneration, undefined);
});

test('GH-588 Slice D: raw-coordinate press stays explicitly geometry-unknown', () => {
  const args = buildRunIOSArgs(['press', '120', '700']);
  assert.equal(args.x, 120);
  assert.equal(args.y, 700);
  assert.equal(args.targetBounds, undefined);
  assert.equal(args.snapshotGeneration, undefined);
});

test('GH-588 Slice D: shared heal dismisses, verifies fresh hidden state, and retries exactly once', async () => {
  let retries = 0;
  const first = failResult(
    'KEYBOARD_DISMISS_FAILED: native tiers failed',
    'KEYBOARD_DISMISS_FAILED',
  );
  const healed = await healKeyboardOccludedTap(first, {
    dismissViaJs: async () => true,
    refreshSnapshot: async () => okResult({ nodes: [node], keyboardVisible: false }),
    retryTap: async () => {
      retries += 1;
      return okResult({ tapped: true });
    },
  });
  const envelope = JSON.parse(healed.content[0]!.text) as { meta?: Record<string, unknown> };
  assert.equal(retries, 1);
  assert.equal(envelope.meta?.keyboardGuard, 'auto_dismissed');
  assert.equal(envelope.meta?.via, 'js');
});

test('GH-588 Slice D: hideKeyboard reaches JS, polls to proven hidden state, and reports its tier', async () => {
  let snapshots = 0;
  const result = await dismissKeyboardWithParity({
    nativeDismiss: async () =>
      failResult('KEYBOARD_DISMISS_FAILED: native tiers failed', 'KEYBOARD_DISMISS_FAILED'),
    dismissViaJs: async () => true,
    refreshSnapshot: async () => {
      snapshots += 1;
      return okResult({ nodes: [node], keyboardVisible: snapshots < 2 });
    },
  });
  const envelope = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    data?: { via?: string; attemptedTiers?: string[] };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.via, 'js');
  assert.deepEqual(envelope.data?.attemptedTiers, ['native-control', 'native-swipe', 'js']);
  assert.equal(snapshots, 2);
});

test('GH-588 Slice D: batch hideKeyboard surfaces JS tier in its per-step receipt', async () => {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'dev.fixture' });
  _setRunAgentDeviceForTest(async (cliArgs) =>
    cliArgs[0] === 'keyboard'
      ? failResult('KEYBOARD_DISMISS_FAILED: native tiers failed', 'KEYBOARD_DISMISS_FAILED')
      : okResult({ nodes: [node], keyboardVisible: false }),
  );
  const client = {
    isConnected: true,
    helpersInjected: true,
    evaluate: async () => ({ value: JSON.stringify({ dismissed: true }) }),
  };
  try {
    const result = await createDeviceBatchHandler(() => client as never)({
      steps: [{ action: 'hideKeyboard' }],
      finalSnapshot: 'none',
    });
    const envelope = JSON.parse(result.content[0]!.text) as {
      data?: { results?: Array<{ data?: { via?: string } }> };
    };
    assert.equal(envelope.data?.results?.[0]?.data?.via, 'js');
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('GH-588 Slice D: hideKeyboard no-keyboard disconfirmation performs no dismissal', async () => {
  let jsCalls = 0;
  const result = await dismissKeyboardWithParity({
    nativeDismiss: async () =>
      okResult({ wasVisible: false, dismissed: false, visible: false, via: null }),
    dismissViaJs: async () => {
      jsCalls += 1;
      return true;
    },
    refreshSnapshot: async () => okResult({ keyboardVisible: false }),
  });
  const envelope = JSON.parse(result.content[0]!.text) as {
    data?: { keyboardGuard?: string; via?: string };
  };
  assert.equal(envelope.data?.keyboardGuard, 'no_keyboard');
  assert.equal(envelope.data?.via, 'no_keyboard');
  assert.equal(jsCalls, 0);
});

test('GH-588 Slice D: protocol N-1 guarded press dismisses first client-side', async () => {
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: process.pid,
    port: 22088,
    deviceId: 'legacy-fixture',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  } as never);
  const commands: string[] = [];
  _setFetchForTest(async (_url, init) => {
    const command = (JSON.parse(String(init?.body)) as { command: string }).command;
    commands.push(command);
    return new Response(
      JSON.stringify(
        command === 'keyboardDismiss'
          ? { ok: true, v: 1, data: { wasVisible: true, dismissed: true, visible: false } }
          : {
              ok: true,
              v: 1,
              data: { tapped: true, keyboardGuard: 'legacy-point-result-ignored' },
            },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const result = await runIOS({ command: 'tap', x: 10, y: 20 });
  assert.equal(result.isError, undefined);
  assert.deepEqual(commands, ['keyboardDismiss', 'tap']);
  const envelope = JSON.parse(result.content[0]!.text) as { meta?: Record<string, unknown> };
  assert.equal(envelope.meta?.keyboardGuard, 'auto_dismissed');
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
});

test('GH-588 Slice D: failed post-check performs no tap', async () => {
  let retries = 0;
  const first = failResult(
    'KEYBOARD_DISMISS_FAILED: native tiers failed',
    'KEYBOARD_DISMISS_FAILED',
  );
  const result = await healKeyboardOccludedTap(first, {
    dismissViaJs: async () => true,
    refreshSnapshot: async () => okResult({ nodes: [node], keyboardVisible: true }),
    retryTap: async () => {
      retries += 1;
      return okResult({ tapped: true });
    },
  });
  assert.equal(result, first);
  assert.equal(retries, 0);
});

test('GH-588 Slice D: producers that never report visibility are degraded, not refused', async () => {
  let snapshots = 0;
  // The Android runner answers `keyboard dismiss` with {dismissed:true} only.
  const androidDismiss = await dismissKeyboardWithParity({
    nativeDismiss: async () => okResult({ dismissed: true }),
    refreshSnapshot: async () => {
      snapshots += 1;
      return okResult({ nodes: [node] });
    },
  });
  const envelope = JSON.parse(androidDismiss.content[0]!.text) as {
    ok: boolean;
    data?: { keyboardGuard?: string; visibilityProof?: string };
  };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.keyboardGuard, 'auto_dismissed');
  assert.equal(envelope.data?.visibilityProof, 'unavailable');
  // Polling a producer that never emits visibility must not burn every attempt.
  assert.equal(snapshots, 1);

  let retries = 0;
  const healed = await healKeyboardOccludedTap(
    failResult('KEYBOARD_OCCLUDED: keyboard covers the target', 'KEYBOARD_OCCLUDED'),
    {
      dismissViaJs: async () => true,
      refreshSnapshot: async () => okResult({ nodes: [node] }),
      retryTap: async () => {
        retries += 1;
        return okResult({ tapped: true });
      },
    },
  );
  assert.equal(retries, 1);
  assert.equal(healed.isError, undefined);
});

test('GH-588 Slice D: an observed-visible keyboard still refuses both paths', async () => {
  const refused = await dismissKeyboardWithParity({
    nativeDismiss: async () => okResult({ dismissed: true, visible: true }),
    refreshSnapshot: async () => okResult({ nodes: [node], keyboardVisible: true }),
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /KEYBOARD_DISMISS_FAILED/);
});

function fastRunnerV1State() {
  return {
    schemaVersion: 1,
    pid: process.pid,
    port: 22089,
    deviceId: 'legacy-fixture',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  } as never;
}

function v1DismissFetch(snapshotNodes: unknown[], commands: string[]) {
  return async (_url: unknown, init: { body?: unknown }) => {
    const command = (JSON.parse(String(init?.body)) as { command: string }).command;
    commands.push(command);
    const body =
      command === 'keyboardDismiss'
        ? { ok: true, v: 1, data: { wasVisible: true, dismissed: true, visible: false } }
        : command === 'snapshot'
          ? { ok: true, v: 1, data: { nodes: snapshotNodes } }
          : { ok: true, v: 1, data: { tapped: true } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('GH-588 Slice D: protocol N-1 ref target re-resolves without keyboard-state metadata', async () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 41, keyboardVisible: true });
  _setFastRunnerStateForTest(fastRunnerV1State());
  const commands: string[] = [];
  _setFetchForTest(
    v1DismissFetch(
      [{ index: 7, type: 'Button', identifier: 'wizard-next-btn', rect: node.rect }],
      commands,
    ) as never,
  );
  try {
    const result = await runIOS({ command: 'tap', x: 10, y: 20, _targetRef: '@e7' } as never);
    assert.equal(result.isError, undefined);
    assert.deepEqual(commands, ['keyboardDismiss', 'snapshot', 'tap']);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  }
});

test('GH-588 Slice D: a positionally reused ref refuses instead of tapping a foreign element', async () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 41, keyboardVisible: true });
  _setFastRunnerStateForTest(fastRunnerV1State());
  const commands: string[] = [];
  _setFetchForTest(
    v1DismissFetch(
      [{ index: 7, type: 'Button', identifier: 'delete-account-btn', rect: node.rect }],
      commands,
    ) as never,
  );
  try {
    const result = await runIOS({ command: 'tap', x: 10, y: 20, _targetRef: '@e7' } as never);
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0]!.text) as {
      code?: string;
      meta?: { keyboardGuard?: string; reResolved?: boolean };
    };
    // The dismissal succeeded; the ref is what went stale, so the remedy is a
    // fresh snapshot, not a CDP reconnect.
    assert.equal(envelope.code, 'STALE_REF');
    assert.equal(envelope.meta?.keyboardGuard, 'auto_dismissed');
    assert.equal(envelope.meta?.reResolved, false);
    assert.deepEqual(commands, ['keyboardDismiss', 'snapshot']);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  }
});

test('GH-588 Slice D: an unlabeled ref is never re-served on type alone', async () => {
  clearRefMap();
  updateRefMapFromFlat([{ ref: '@e7', type: 'Button', rect: node.rect }], {
    snapshotGeneration: 41,
    keyboardVisible: true,
  });
  _setFastRunnerStateForTest(fastRunnerV1State());
  const commands: string[] = [];
  _setFetchForTest(
    v1DismissFetch([{ index: 7, type: 'Button', rect: node.rect }], commands) as never,
  );
  try {
    const result = await runIOS({ command: 'tap', x: 10, y: 20, _targetRef: '@e7' } as never);
    assert.equal(result.isError, true);
    const envelope = JSON.parse(result.content[0]!.text) as {
      code?: string;
      meta?: { keyboardGuard?: string; reResolved?: boolean };
    };
    // The dismissal succeeded; the ref is what went stale, so the remedy is a
    // fresh snapshot, not a CDP reconnect.
    assert.equal(envelope.code, 'STALE_REF');
    assert.equal(envelope.meta?.keyboardGuard, 'auto_dismissed');
    assert.equal(envelope.meta?.reResolved, false);
    assert.deepEqual(commands, ['keyboardDismiss', 'snapshot']);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setFastRunnerStateForTest(null);
  }
});

test('GH-588 Slice D: a native dismiss that never ran is not reported as an attempted tier', async () => {
  const refused = await dismissKeyboardWithParity({
    nativeDismiss: async () =>
      failResult('RUNNER_TIMEOUT: runner never answered', 'RUNNER_TIMEOUT'),
    refreshSnapshot: async () => okResult({ nodes: [node], keyboardVisible: true }),
  });
  const envelope = JSON.parse(refused.content[0]!.text) as { meta?: { attemptedTiers?: string[] } };
  assert.equal(refused.isError, true);
  assert.deepEqual(envelope.meta?.attemptedTiers, []);
});
