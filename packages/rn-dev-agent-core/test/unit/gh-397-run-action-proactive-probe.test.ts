// GH #397 Phase 2 — proactive blind-probe: at-risk runs skip maestro entirely
// when the CDP anchor oracle succeeds; every other combination falls through
// to today's maestro-first behavior (fail-open).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRunActionHandler } from '../../dist/tools/run-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';
import { appendRunRecordToSidecar } from '../helpers/action-state.ts';

let project: ReturnType<typeof createTmpProject>;
beforeEach(() => {
  project = createTmpProject();
});
afterEach(() => {
  project.cleanup();
});

function replayFixtureYaml({
  id = 'demo',
  selector = 'fab-create-task',
}: { id?: string; selector?: string } = {}): string {
  return [
    'appId: com.test.app',
    '---',
    `# id: ${id}`,
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    `    id: "${selector}"`,
    '',
  ].join('\n');
}

const PASS_ENV = {
  ok: true,
  data: {
    passed: true,
    output: 'Flow PASSED',
    flowFile: 'x',
    platform: 'ios',
    transport: 'maestro-runner',
    transportVersion: '1.0.9',
    fallback: 'none',
    steps: [{ index: 0, name: 'tapOn', verb: 'tapOn', status: 'pass', durationMs: 10 }],
  },
};

function fakeMaestroRun(env: { ok: boolean }, counter: { calls: number }) {
  return async () => {
    counter.calls++;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(env) }],
      ...(env.ok === false ? { isError: true } : {}),
    };
  };
}

function treeWith(id: string): unknown {
  return { testID: id, children: [] };
}

function makeReplayDeps({ present }: { present: boolean }) {
  const pressCalls: string[] = [];
  const deps = {
    pressByTestId: async (id: string): Promise<void> => {
      pressCalls.push(id);
    },
    typeByTestId: async (): Promise<void> => {},
    treeFor: async (id: string): Promise<unknown> =>
      present ? treeWith(id) : { testID: 'some-other-element', children: [] },
    launchApp: async (): Promise<void> => {},
    settle: async (): Promise<void> => {},
  };
  return { deps, pressCalls };
}

function readEnvelope(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

const IOS26_CTX = async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 26 });

function lastRun(id: string): any {
  return project.readSidecar(id).runHistory.at(-1);
}

test('gh-397: at-risk (ios26) + anchor present → zero maestro calls, transport cdp-js, blindProbe recorded', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay, pressCalls } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'cdp-js');
  assert.deepEqual(env.data.blindProbe, { atRisk: 'ios26', skippedMaestro: true });
  assert.ok(env.data.timings_ms, 'probe path carries timings_ms');
  assert.equal(counter.calls, 0, 'maestro must NOT be invoked');
  assert.deepEqual(pressCalls, ['fab-create-task']);
  const rec = lastRun('demo');
  assert.equal(rec.transport, 'cdp-js');
  assert.equal(rec.deviceId, 'UDID-1');
  assert.deepEqual(rec.blindProbe, { atRisk: 'ios26', skippedMaestro: true });
});

test('gh-397: probe-routed pass does NOT auto-promote the experimental action', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, { calls: 0 }),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.match(project.readYaml('demo'), /# status: experimental/);
});

test('gh-397: not at-risk (iOS 18, clean history) → maestro path exactly as today', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.data.passed, true);
  assert.equal(env.data.transport, 'maestro-runner');
  assert.equal(counter.calls, 1, 'maestro runs normally');
  assert.equal(lastRun('demo').deviceId, 'UDID-1');
});

test('gh-397: at-risk + anchor ABSENT → falls through to maestro (fail-open)', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: false });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).data.passed, true);
  assert.equal(counter.calls, 1);
});

// Mechanism note: firstReplayTestId() normalizes the WHOLE flow and returns
// null when ANY step is unsupported, so this exercises the anchor-null
// fall-through; the UnsupportedStepError catch in the implementation is
// defensive-only and unreachable via this gate.
test('gh-397: at-risk + unsupported step grammar → falls through to maestro (fail-open, unlike reactive path)', async () => {
  const yamlWithScroll = [
    'appId: com.test.app',
    '---',
    '# id: demo',
    '# intent: test fixture',
    '# tags: [fixture]',
    '# mutates: false',
    '# status: experimental',
    '',
    '- launchApp:',
    '    stopApp: false',
    '- tapOn:',
    '    id: "fab-create-task"',
    '- scroll',
    '',
  ].join('\n');
  project.seedAction('demo', yamlWithScroll);
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).data.passed, true);
  assert.equal(counter.calls, 1, 'unsupported grammar must not block the maestro path');
});

test('gh-397: android → context never consulted, maestro path', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  let ctxCalls = 0;
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    blindProbeContext: async () => {
      ctxCalls++;
      return { deviceId: 'emulator-5554', iosRuntimeMajor: null };
    },
  });
  await handler({ actionId: 'demo', projectRoot: project.root, platform: 'android' });
  assert.equal(ctxCalls, 0);
  assert.equal(counter.calls, 1);
});

test('gh-397: RN_BLIND_PROBE=0 disables the gate even on at-risk runtimes', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  process.env.RN_BLIND_PROBE = '0';
  try {
    const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
    assert.equal(readEnvelope(result).data.transport, 'maestro-runner');
    assert.equal(counter.calls, 1, 'maestro path with the gate disabled');
    assert.equal(
      lastRun('demo').deviceId,
      'UDID-1',
      'deviceId still threads while opted out — a clean pass must be able to clear the latch',
    );
  } finally {
    delete process.env.RN_BLIND_PROBE;
  }
});

test('gh-588 V2b: per-call allow reaches normal fallback while binding env remains disabled', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  process.env.RN_BLIND_PROBE = '0';
  try {
    const result = await handler({
      actionId: 'demo',
      projectRoot: project.root,
      platform: 'ios',
      blindProbeMode: 'allow',
    });
    const env = readEnvelope(result);
    assert.equal(env.data.transport, 'cdp-js');
    assert.equal(env.data.blindProbeMode, 'allow');
    assert.equal(counter.calls, 0, 'the explicit call override must not invoke maestro');
    assert.equal(process.env.RN_BLIND_PROBE, '0', 'the sole MCP process policy is not mutated');
  } finally {
    delete process.env.RN_BLIND_PROBE;
  }
});

test('gh-397: prior TRANSPORT_BLIND history + anchor present → probe routes even on iOS 18', async () => {
  project.seedAction('demo', replayFixtureYaml());
  appendRunRecordToSidecar(project.root, 'demo', {
    timestamp: '2026-07-01T00:00:00Z',
    durationMs: 500,
    status: 'fail',
    failureCode: 'TRANSPORT_BLIND',
    trigger: 'agent',
    deviceId: 'UDID-1',
  });
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.data.transport, 'cdp-js');
  assert.deepEqual(env.data.blindProbe, { atRisk: 'prior-transport-blind', skippedMaestro: true });
  assert.equal(counter.calls, 0);
});

test('gh-397: orchestration exception still persists a RunRecord with deviceId', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const handler = createRunActionHandler({
    maestroRun: async () => {
      throw new Error('boom');
    },
    blindProbeContext: async () => ({ deviceId: 'UDID-1', iosRuntimeMajor: 18 }),
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  assert.equal(readEnvelope(result).ok, false);
  assert.equal(lastRun('demo').deviceId, 'UDID-1');
});

test('gh-397: probe-routed replay failure records FALLBACK_REPLAY_FAILED, maestro still skipped', async () => {
  project.seedAction('demo', replayFixtureYaml());
  const counter = { calls: 0 };
  const { deps: replay } = makeReplayDeps({ present: true });
  replay.pressByTestId = async () => {
    throw new Error('element unmounted');
  };
  const handler = createRunActionHandler({
    maestroRun: fakeMaestroRun(PASS_ENV, counter),
    replayDeps: () => replay,
    blindProbeContext: IOS26_CTX,
    probeRetry: { attempts: 1, delayMs: 0 },
  });
  const result = await handler({ actionId: 'demo', projectRoot: project.root, platform: 'ios' });
  const env = readEnvelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.code, 'FALLBACK_REPLAY_FAILED');
  assert.equal(counter.calls, 0, 'the verdict came from the fallback, not maestro');
  const rec = lastRun('demo');
  assert.equal(rec.failureCode, 'FALLBACK_REPLAY_FAILED');
  assert.equal(rec.transport, 'cdp-js');
});
