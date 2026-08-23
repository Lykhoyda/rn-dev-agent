import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MAESTRO_RUNNER_PIN,
  RunnerCacheUnavailableError,
  buildReplayEngineStatus,
  runnerCacheBootstrapFailure,
} from '../../dist/domain/engine-pin.js';
import { runMaestroInline } from '../../dist/maestro-invoke.js';
import { createMaestroTestAllHandler } from '../../dist/tools/maestro-test-all.js';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

const pinnedStatus = () =>
  buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: '/fake/maestro-runner',
    provenance: 'pin-cache',
  });

const dispatch = () => ({
  runner: 'maestro-runner' as const,
  binPath: '/fake/maestro-runner',
  buildArgs: () => [],
});

test('inline Maestro maps cache refusal to WDA_BOOTSTRAP_FAILED', async () => {
  const result = await runMaestroInline(
    '- tapOn:\n    id: "continue"',
    { platform: 'ios', appId: 'com.test.app' },
    {
      chooseDispatch: dispatch,
      resolveEngineStatus: async () => pinnedStatus(),
      spawnManaged: async () => {
        throw new RunnerCacheUnavailableError('cache', 'EACCES');
      },
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.errorCode, 'WDA_BOOTSTRAP_FAILED');
  assert.match(String(result.error), /RUNNER_CACHE_UNAVAILABLE: cache: EACCES/);
  assert.match(String(result.error), /No foreign cache path was changed/);
});

test('Maestro batch stops on cache refusal with a typed failure', async () => {
  const flowDir = mkdtempSync(join(tmpdir(), 'runner-cache-suite-'));
  try {
    writeFileSync(
      join(flowDir, 'browse.yaml'),
      'appId: com.test.app\n---\n- tapOn:\n    id: "browse"\n',
    );
    const handler = createMaestroTestAllHandler({
      getActiveSession: () =>
        ({ platform: 'ios', deviceId: 'SIM', appId: 'com.test.app' }) as never,
      chooseDispatch: dispatch,
      resolveEngineStatus: async () => pinnedStatus(),
      parkFlow: async (run) => run(),
      claimNativeOrigin: async () => {},
      completeNativeOrigin: async () => {},
      relaunchManagedApp: async () => {},
      reproveManagedOrigin: async () => {},
      completeRunnerPark: async () => {},
      execFile: async () => {
        throw new RunnerCacheUnavailableError('cache', 'FOREIGN_PATH');
      },
    });

    const result = await handler({ platform: 'ios', flowDir });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'WDA_BOOTSTRAP_FAILED');
    assert.equal(envelope.meta.executed, 0);
    assert.equal(envelope.meta.failed, 1);
    assert.match(envelope.error, /RUNNER_CACHE_UNAVAILABLE: cache: FOREIGN_PATH/);
  } finally {
    rmSync(flowDir, { recursive: true, force: true });
  }
});

test('exact action replay preserves cache-specific bootstrap guidance', async () => {
  const project = createTmpProject();
  try {
    project.seedAction(
      'login-en',
      fixtureYaml({ id: 'login-en', bundleId: 'com.rndevagent.testapp', status: 'active' }),
      null,
    );
    const cacheError = new RunnerCacheUnavailableError('cache', 'EEXIST');
    const error = runnerCacheBootstrapFailure(cacheError);
    const handler = createPinnedRunActionHandler({
      maestroRun: async () => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              code: 'WDA_BOOTSTRAP_FAILED',
              error,
              meta: {
                passed: false,
                output: '',
                terminal: {
                  exitClass: 'before-first-step',
                  bootstrapEvidence: cacheError.message,
                },
              },
            }),
          },
        ],
        isError: true as const,
      }),
    });

    const result = await handler({
      actionId: 'login-en',
      projectRoot: project.root,
      platform: 'ios',
      autoRepair: false,
    });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, 'WDA_BOOTSTRAP_FAILED');
    assert.match(envelope.error, /No foreign cache path was changed/);
    assert.doesNotMatch(envelope.error, /check network access|No preparation or cache mutation/);
  } finally {
    project.cleanup();
  }
});
