import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { QaDispatchContext } from '../../../dist/domain/qa-dispatch.js';
import {
  createDeviceAcceptSystemDialogHandler,
  _setFetchSnapshotNodesForTest,
  _resetFetchSnapshotNodesForTest,
  _setPressCandidateForTest,
  _resetPressCandidateForTest,
  _setRunMaestroInlineForTest,
  _resetRunMaestroInlineForTest,
  _setIosSessionActiveForTest,
  _resetIosSessionActiveForTest,
} from '../../../dist/handlers/device-system-dialog.js';
import { runMaestroInline } from '../../../dist/maestro-invoke.js';
import { spawnManagedProcessGroup } from '../../../dist/lifecycle/managed-automation.js';
import { buildReplayEngineStatus, MAESTRO_RUNNER_PIN } from '../../../dist/domain/engine-pin.js';
import { failResult, okResult } from '../../../dist/utils.js';

afterEach(() => {
  _resetFetchSnapshotNodesForTest();
  _resetPressCandidateForTest();
  _resetRunMaestroInlineForTest();
  _resetIosSessionActiveForTest();
});

function dialog() {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async (_allowCache, context) => {
    assert.ok(context, 'QA snapshot must carry the operation context');
    return {
      ok: true,
      nodes: [
        { ref: '@e0', type: 'Alert', label: 'Permission' },
        { ref: '@e1', type: 'Button', label: 'Allow' },
        { ref: '@e2', type: 'Button', label: 'OK' },
      ],
      provenance: { source: 'fresh', originAuthority: 'not-proven' },
    };
  });
  _setRunMaestroInlineForTest(async () => {
    assert.fail('inline fallback must not run');
  });
}

test('QA dialog does not probe another label after an erroring press', async () => {
  dialog();
  let presses = 0;
  _setPressCandidateForTest(async (_candidate, _action, _client, _system, context) => {
    context!.authorize();
    presses++;
    return failResult('unknown press outcome');
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /ACTION_OUTCOME_UNCERTAIN/,
  );
  assert.equal(presses, 1);
  assert.equal(context.authorizations, 1);
});

test('QA dialog notices a guard swallowed into a successful result', async () => {
  dialog();
  let now = 1;
  _setPressCandidateForTest(async (_candidate, _action, _client, _system, context) => {
    now = 10;
    try {
      context!.authorize();
    } catch {
      /* Simulate a legacy handler swallowing the guard. */
    }
    return okResult({ tapped: true });
  });
  const context = new QaDispatchContext(10, () => now);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /EVIDENCE_EXPIRED/,
  );
  assert.equal(context.authorizations, 0);
});

test('QA dialog cannot use unknown snapshot as inline fallback authority', async () => {
  dialog();
  _setFetchSnapshotNodesForTest(async () => ({ ok: false, reason: 'fetch-failed' }));
  _setPressCandidateForTest(async () => {
    assert.fail('no snapshot, no press');
  });
  const context = new QaDispatchContext(10, () => 1);
  await assert.rejects(
    createDeviceAcceptSystemDialogHandler()({ platform: 'ios', qaContext: context }),
    /ACTION_CONTEXT_CHANGED/,
  );
  assert.equal(context.authorizations, 0);
});

test('actual inline spawn guard survives expiry after managed execution entry', async () => {
  let now = 1;
  let pins = 0;
  let spawns = 0;
  const context = new QaDispatchContext(10, () => now);
  const result = await runMaestroInline(
    '- tapOn: Continue',
    {
      platform: 'ios',
      appId: 'qa.app',
      qaContext: context,
    },
    {
      chooseDispatch: () => ({
        runner: 'maestro',
        binPath: '/fake/maestro',
        buildArgs: () => [],
      }),
      resolveEngineStatus: async () => {
        pins++;
        return buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false);
      },
      spawnManaged: (bin, args, options) => {
        now = 10;
        return spawnManagedProcessGroup(bin, args, options, {
          spawn: () => {
            spawns++;
            throw new Error('unexpected spawn');
          },
        });
      },
    },
  );
  assert.equal(pins, 2);
  assert.equal(spawns, 0);
  assert.equal(result.passed, false);
  assert.equal(context.authorizations, 0);
  assert.throws(() => context.assertComplete(), /EVIDENCE_EXPIRED/);
});

test('actual inline spawn consumes authorization even if spawn throws', async () => {
  let spawns = 0;
  const context = new QaDispatchContext(10, () => 1);
  const result = await runMaestroInline(
    '- tapOn: Continue',
    {
      platform: 'ios',
      appId: 'qa.app',
      qaContext: context,
    },
    {
      chooseDispatch: () => ({
        runner: 'maestro',
        binPath: '/fake/maestro',
        buildArgs: () => [],
      }),
      resolveEngineStatus: async () =>
        buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false),
      spawnManaged: (bin, args, options) =>
        spawnManagedProcessGroup(bin, args, options, {
          spawn: () => {
            spawns++;
            throw new Error('spawn outcome unknown');
          },
        }),
    },
  );
  assert.equal(spawns, 1);
  assert.equal(result.passed, false);
  assert.equal(context.authorizations, 1);
});
