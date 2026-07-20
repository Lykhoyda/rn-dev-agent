import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  _setFastRunnerStateForTest,
  _setFetchForTest,
  getRunnerPostMortem,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';

function state() {
  _setFastRunnerStateForTest({
    schemaVersion: 1,
    pid: 999_999_999,
    port: 22088,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
    provenance: 'build-local',
  } as never);
}

function timeoutFetch() {
  _setFetchForTest(async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { command?: string };
    assert.equal(body.command, 'type');
    return new Response(
      JSON.stringify({
        ok: false,
        v: 2,
        error: { code: 'MAIN_THREAD_TIMEOUT', message: 'main thread execution timed out' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

function body(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    code?: string;
    data?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
}

test('GH-588 Slice C: deterministic wedge hook is compile-gated out of release artifacts', () => {
  const source = readFileSync(
    new URL(
      '../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+CommandExecution.swift',
      import.meta.url,
    ),
    'utf8',
  );
  const releaseWorkflow = readFileSync(
    new URL('../../../../.github/workflows/runner-artifacts.yml', import.meta.url),
    'utf8',
  );
  assert.match(source, /#if RN_FAST_RUNNER_TEST_FAULTS/);
  assert.doesNotMatch(releaseWorkflow, /RN_FAST_RUNNER_TEST_FAULTS/);
});

test('GH-588 Slice C: timeout succeeds only as exact-readback recovery', async () => {
  state();
  timeoutFetch();
  const result = body(
    await runIOS({
      command: 'type',
      text: 'exact',
      _verifyExactReadback: async (expected) => ({
        matches: expected === 'exact',
        actual: 'exact',
      }),
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data?.recovered, true);
  assert.equal(result.data?.verification, 'exact-readback');
  const recovery = result.meta?.runnerTimeoutRecovery as { reaped?: boolean } | undefined;
  assert.equal(recovery?.reaped, true);
  assert.equal('runnerTimeoutShim' in (result.meta ?? {}), false);
});

test('GH-588 Slice C: mismatch and unavailable CDP fail closed as RUNNER_TIMEOUT', async () => {
  for (const verify of [
    async () => ({ matches: false, actual: 'wrong' }),
    async () => {
      throw new Error('CDP down');
    },
  ]) {
    state();
    timeoutFetch();
    const result = body(
      await runIOS({ command: 'type', text: 'exact', _verifyExactReadback: verify }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'RUNNER_TIMEOUT');
  }
});

test('GH-588 Slice C: adopted runner postmortem is honestly unavailable', () => {
  state();
  assert.deepEqual(getRunnerPostMortem(), { available: false, provenance: 'adopted' });
});

test('GH-588 Slice C: a second mutator is refused while the triggering runner is poisoned', async () => {
  state();
  timeoutFetch();
  let entered!: () => void;
  const readbackEntered = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  const first = runIOS({
    command: 'type',
    text: 'exact',
    _verifyExactReadback: async () => {
      entered();
      await hold;
      return { matches: true, actual: 'exact' };
    },
  });
  await readbackEntered;
  const second = body(await runIOS({ command: 'tap', x: 10, y: 10 }));
  assert.equal(second.code, 'RUNNER_TIMEOUT');
  assert.equal((second.meta as { dispatched?: boolean }).dispatched, false);
  release();
  await first;
});
