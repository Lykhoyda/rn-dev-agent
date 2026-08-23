// GH #705 follow-up: maestro_test_all runs the same clearState corpus flows
// maestro_run learned to survive, but it never re-issued the install receipt
// after Maestro's reinstall — the first clearState flow in a corpus rotated
// axis I and broke every later flow and device_* call. It also resolved the
// iOS app container via generic `booted` instead of the authority-bound
// simulator UDID that maestro_run passes.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import {
  createAuthorityGate,
  hasManagedInstallReissueAuthority,
  reissueManagedInstallAuthority,
} from '../../dist/session/authority-gate.js';
import { reissueInstallBinding } from '../../dist/session/install-reissue.js';
import { createMaestroTestAllHandler } from '../../dist/tools/maestro-test-all.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import { flowUsesClearState } from '../../dist/tools/resolve-ios-app-file.js';
import { okResult } from '../../dist/utils.js';
import {
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  buildReplayEngineStatus,
  MAESTRO_RUNNER_PIN,
  RunnerCacheUnavailableError,
} from '../../dist/domain/engine-pin.js';

beforeEach(() =>
  _setEngineStatusForTest(buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false)),
);
afterEach(() => _resetEngineStatusForTest());

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';
const APP_FILE = '/tmp/rn-appfile-snapshots/TestApp.app';

const CLEAR_STATE_FLOW = [
  `appId: ${APP_ID}`,
  '---',
  '- launchApp:',
  '    clearState: true',
  '- tapOn:',
  '    id: "sign-in"',
  '',
].join('\n');

const PLAIN_FLOW = [
  `appId: ${APP_ID}`,
  '---',
  '- launchApp',
  '- tapOn:',
  '    id: "browse"',
  '',
].join('\n');

const corpusRoots: string[] = [];
after(() => {
  for (const root of corpusRoots) rmSync(root, { recursive: true, force: true });
});

function seedCorpus(flows: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rn-test-all-corpus-'));
  corpusRoots.push(root);
  const corpus = join(root, '.maestro');
  mkdirSync(corpus, { recursive: true });
  for (const [name, content] of Object.entries(flows)) {
    writeFileSync(join(corpus, name), content, 'utf-8');
  }
  return corpus;
}

function runnerLog(): string {
  return [
    'Single device execution mode',
    `Building WDA for device ${EXACT} (team ID: )`,
    `Starting WDA on device ${EXACT} (port: 8447)`,
    'Flow execution completed: 1 passed, 0 failed, 0 skipped',
  ].join('\n');
}

function fakeRunnerDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

interface SuiteFixture {
  /** `exec:clearState` / `exec:plain` per dispatched stage, `reissue` per commit. */
  events: string[];
  reissues: string[];
  resolvedDeviceIds: (string | undefined)[];
  handler: ReturnType<typeof createMaestroTestAllHandler>;
}

function suiteFixture(
  opts: { failTapStages?: boolean; cacheRefusal?: boolean } = {},
): SuiteFixture {
  const events: string[] = [];
  const reissues: string[] = [];
  const resolvedDeviceIds: (string | undefined)[] = [];
  const readFlow = (args: string[]): string => {
    // The stage executor rewrites the temp flow file before each dispatch.
    return readFileSync(args[args.length - 1], 'utf-8');
  };
  const handler = createMaestroTestAllHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run) => run(),
    claimNativeOrigin: async () => {},
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {},
    reproveManagedOrigin: async () => {},
    completeRunnerPark: async () => {},
    reissueInstallReceipt: async () => {
      events.push('reissue');
      reissues.push('reissued');
      if (opts.cacheRefusal) throw new Error('receipt reissue masked cache refusal');
    },
    resolveAppFile: (platform, flowText, _headerAppId, explicitAppFile, deps) => {
      resolvedDeviceIds.push(deps?.deviceId);
      if (explicitAppFile) return { ok: true, appFile: explicitAppFile };
      if (platform !== 'ios' || !flowUsesClearState(flowText)) return { ok: true };
      return { ok: true, appFile: APP_FILE };
    },
    execFile: async (_file, args) => {
      const flowText = readFlow(args);
      events.push(flowUsesClearState(flowText) ? 'exec:clearState' : 'exec:plain');
      if (opts.cacheRefusal) {
        throw new RunnerCacheUnavailableError('cache', 'EACCES');
      }
      const index = args.indexOf('--output');
      const dir = args[index + 1];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'maestro-runner.log'), runnerLog(), 'utf8');
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          device: { id: EXACT, platform: 'ios' },
          flows: [{ device: { id: EXACT, platform: 'ios' } }],
        }),
        'utf8',
      );
      if (opts.failTapStages && flowText.includes('tapOn')) {
        throw Object.assign(new Error('runner exited 1'), {
          stdout: '',
          stderr: 'Element not found',
          code: 1,
        });
      }
      return { stdout: runnerLog(), stderr: '' };
    },
  });
  return { events, reissues, resolvedDeviceIds, handler };
}

function parseEnvelope(result: { content: { text: string }[] }): {
  ok: boolean;
  code?: string;
  data?: {
    passed: number;
    failed: number;
    results: { name: string; passed: boolean; error?: string }[];
  };
} {
  return JSON.parse(result.content[0].text);
}

test('GH#705-followup a clearState corpus flow re-issues the install receipt', async () => {
  const { events, reissues, handler } = suiteFixture();
  const flowDir = seedCorpus({ '10-login.yaml': CLEAR_STATE_FLOW, '20-browse.yaml': PLAIN_FLOW });
  const envelope = parseEnvelope(await handler({ platform: 'ios', flowDir }));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.passed, 2);
  assert.deepEqual(reissues, ['reissued']);
  // The receipt is committed AFTER the reinstalling flow ran (a receipt issued
  // before Maestro's reinstall would be stale) and before the next flow.
  assert.deepEqual(events, [
    'exec:clearState',
    'exec:plain',
    'reissue',
    'exec:plain',
    'exec:plain',
  ]);
});

test('GH#705-followup a failed clearState flow still re-issues the receipt', async () => {
  const { events, reissues, handler } = suiteFixture({ failTapStages: true });
  const flowDir = seedCorpus({ '10-login.yaml': CLEAR_STATE_FLOW });
  const envelope = parseEnvelope(await handler({ platform: 'ios', flowDir }));
  assert.equal(envelope.data?.failed, 1);
  assert.deepEqual(reissues, ['reissued']);
  assert.deepEqual(events, ['exec:clearState', 'exec:plain', 'reissue']);
});

test('a batch cache refusal before clearState execution does not re-issue the receipt', async () => {
  const { events, reissues, handler } = suiteFixture({ cacheRefusal: true });
  const flowDir = seedCorpus({ '10-login.yaml': CLEAR_STATE_FLOW });
  const result = await handler({ platform: 'ios', flowDir });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'WDA_BOOTSTRAP_FAILED');
  assert.match(envelope.error, /RUNNER_CACHE_UNAVAILABLE: cache: EACCES/);
  assert.deepEqual(reissues, []);
  assert.deepEqual(events, ['exec:clearState']);
});

test('GH#705-followup a corpus without clearState never re-issues', async () => {
  const { reissues, handler } = suiteFixture();
  const flowDir = seedCorpus({ '20-browse.yaml': PLAIN_FLOW });
  const envelope = parseEnvelope(await handler({ platform: 'ios', flowDir }));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data?.passed, 1);
  assert.deepEqual(reissues, []);
});

test('GH#705-followup the app container resolves against the exact bound simulator, never booted', async () => {
  const { resolvedDeviceIds, handler } = suiteFixture();
  const flowDir = seedCorpus({ '10-login.yaml': CLEAR_STATE_FLOW, '20-browse.yaml': PLAIN_FLOW });
  await handler({ platform: 'ios', flowDir });
  assert.equal(resolvedDeviceIds.length, 2);
  for (const deviceId of resolvedDeviceIds) {
    assert.equal(deviceId, EXACT);
  }
});

// --- Gate-level: the managedInstallReissue capability for maestro_test_all ---

const BOUND_INSTALL = {
  platform: 'ios',
  deviceId: EXACT,
  appId: APP_ID,
  artifactDigest: 'attested-digest',
  installGeneration: 'generation-1',
  buildGeneration: 3,
};

function gateFixture() {
  // Live install state as the device would present it: the fake "reinstall"
  // rotates the generation while (usually) keeping the attested bytes.
  const installed = { digest: 'attested-digest', generation: 'generation-1' };
  const status = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git', appRoot: process.cwd() },
    bindings: {
      install: { ...BOUND_INSTALL },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: null,
      device: { platform: 'ios', deviceId: EXACT, appId: APP_ID },
      runner: { instanceId: 'runner' },
      observe: null,
      proof: null,
    } as Record<string, unknown>,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session: unknown, input: { operationId: string }) => ({
      operationId: input.operationId,
      sessionId: 'session-a',
      claimEpoch: 4,
      authorityVersion: 9,
    }),
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: () => true,
    runWithOperation: async (_operation: unknown, callback: () => unknown) => callback(),
    commitPlatformAuthorityReceipts: () => {},
    endOperation: () => {},
    cancelOperation: () => {},
    refreshOperation: (operation: { authorityVersion: number }) => ({
      ...operation,
      authorityVersion: status.authorityVersion,
    }),
    replaceBindingsDuringOperation: (
      operation: { authorityVersion: number },
      input: { bindings: Record<string, unknown> },
    ) => {
      status.bindings = { ...status.bindings, ...input.bindings };
      status.authorityVersion += 1;
      return { ...operation, authorityVersion: operation.authorityVersion + 1 };
    },
  };
  const runtime = {
    requireAvailable: () => ({ registry, session: { sessionId: 'session-a', claimEpoch: 4 } }),
    status: () => status,
  };
  // Axis I's identity is derived from the live install state, exactly as the
  // real probe hashes the installed container — a reinstall the tool did not
  // re-issue MUST move the postflight identity.
  const probe = async ({ axis }: { axis: string }) => ({
    axis,
    identity: axis === 'I' ? `I:${installed.generation}` : `${axis}-identity`,
  });
  return { installed, registry, runtime, status, probe };
}

test('GH#705-followup maestro_test_all commits a re-issued receipt through the gate', async () => {
  const { installed, runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: () => ({
          platform: 'ios' as const,
          deviceId: EXACT,
          appId: APP_ID,
          artifactDigest: installed.digest,
          installGeneration: installed.generation,
        }),
      }),
  });

  const wrapped = gate.wrap('maestro_test_all', async (args: Record<string, unknown>) => {
    // The corpus contained a clearState flow: Maestro reinstalled the app.
    installed.generation = 'generation-2';
    assert.equal(hasManagedInstallReissueAuthority(args), true);
    await reissueManagedInstallAuthority(args);
    return okResult({ passed: 1, failed: 0 });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, true, envelope.error);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('GH#705-followup a foreign reinstall still refuses maestro_test_all with axis I', async () => {
  const { installed, runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, {
    probe,
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: () => ({
          platform: 'ios' as const,
          deviceId: EXACT,
          appId: APP_ID,
          artifactDigest: installed.digest,
          installGeneration: installed.generation,
        }),
      }),
  });

  const wrapped = gate.wrap('maestro_test_all', async (args: Record<string, unknown>) => {
    installed.digest = 'foreign-digest';
    installed.generation = 'generation-2';
    await reissueManagedInstallAuthority(args);
    return okResult({ passed: 1, failed: 0 });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-1',
  );
});

test('GH#705-followup the real suite handler re-issues through the gate-provided authority', async () => {
  const { installed, runtime, status, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, {
    probe,
    // Managed-origin machinery the clearState flow's stages exercise for real.
    relaunchBoundRuntime: async () => undefined,
    reconnectBoundRuntime: async () => undefined,
    refreshRuntimeBinding: async () => ({ targetId: 'target-1', connectionGeneration: 1 }),
    reissueInstallBinding: (install: Record<string, unknown> | undefined) =>
      reissueInstallBinding(install, {
        captureInstalled: () => ({
          platform: 'ios' as const,
          deviceId: EXACT,
          appId: APP_ID,
          artifactDigest: installed.digest,
          installGeneration: installed.generation,
        }),
      }),
  });

  const flowDir = seedCorpus({ '10-login.yaml': CLEAR_STATE_FLOW });
  // Axis S requires the corpus to live inside the session's app root.
  (status.source as { appRoot: string }).appRoot = join(flowDir, '..');
  // No reissueInstallReceipt (or any authority callback) injected: the handler
  // must obtain every one of them from the gate-decorated args.
  const handler = createMaestroTestAllHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run, opts) => {
      await opts?.completeRunnerPark?.();
      return run();
    },
    execFile: async (_file, args) => {
      const flowText = readFileSync(args[args.length - 1], 'utf-8');
      if (flowUsesClearState(flowText)) {
        // Maestro reinstalled the attested artifact: the generation rotates.
        installed.generation = 'generation-2';
      }
      const index = args.indexOf('--output');
      const dir = args[index + 1];
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'maestro-runner.log'), runnerLog(), 'utf8');
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          device: { id: EXACT, platform: 'ios' },
          flows: [{ device: { id: EXACT, platform: 'ios' } }],
        }),
        'utf8',
      );
      return { stdout: runnerLog(), stderr: '' };
    },
    resolveAppFile: (platform, flowText, _headerAppId, explicitAppFile, deps) => {
      assert.equal(deps?.deviceId, EXACT);
      if (explicitAppFile) return { ok: true, appFile: explicitAppFile };
      if (platform !== 'ios' || !flowUsesClearState(flowText)) return { ok: true };
      return { ok: true, appFile: APP_FILE };
    },
  });

  const wrapped = gate.wrap('maestro_test_all', handler as never);
  const envelope = JSON.parse(
    (await wrapped({ platform: 'ios', flowDir })).content[0].text,
  ) as ReturnType<typeof parseEnvelope>;
  assert.equal(envelope.ok, true, JSON.stringify(envelope).slice(0, 400));
  assert.equal(envelope.data?.passed, 1);
  assert.equal(
    (status.bindings.install as { installGeneration: string }).installGeneration,
    'generation-2',
  );
});

test('GH#705-followup axis I moving without a re-issue is still lost authority', async () => {
  const { installed, runtime, probe } = gateFixture();
  const gate = createAuthorityGate(runtime, { probe });

  const wrapped = gate.wrap('maestro_test_all', async () => {
    // An out-of-band reinstall: nothing proved the artifact, nothing re-issued.
    installed.generation = 'generation-9';
    return okResult({ passed: 1, failed: 0 });
  });

  const envelope = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
});
