import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs } from '../../dist/agent-device-wrapper.js';
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
import { healKeyboardOccludedTap } from '../../dist/runners/keyboard-guard.js';
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
