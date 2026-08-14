import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// GH #629: the first-start retry is permitted only when the failed attempt
// actually reached the launch xcodebuild. ensureFastRunner swallows every
// startFastRunner error, so the launch counter is the sole evidence — a
// failure BEFORE the launch step (artifact resolution, missing project, a
// failed cold build) must leave it untouched, or the retry re-pays the whole
// multi-minute build window on a deterministically broken checkout.

// The runner directory is resolved at module load, so point it at an empty
// stand-in before importing: startFastRunner then fails at project resolution,
// which is upstream of both the build steps and spawn().
const runnerRoot = mkdtempSync(join(tmpdir(), 'gh-629-runner-root-'));
mkdirSync(join(runnerRoot, 'rn-fast-runner'), { recursive: true });
process.env.RN_DEV_AGENT_NATIVE_RUNNER_ROOT = runnerRoot;

const { startFastRunner, getRunnerLaunchCount, awaitSpawnedRunnerExit } = await import(
  '../../dist/runners/rn-fast-runner-client.js'
);

test.after(() => {
  rmSync(runnerRoot, { recursive: true, force: true });
  delete process.env.RN_DEV_AGENT_NATIVE_RUNNER_ROOT;
});

test('a start that fails before the launch step does not advance the launch count', async () => {
  const saved = {
    sessionId: process.env.RN_DEV_AGENT_SESSION_ID,
    claimEpoch: process.env.RN_DEV_AGENT_CLAIM_EPOCH,
  };
  process.env.RN_DEV_AGENT_SESSION_ID = `gh-629-${randomUUID()}`;
  process.env.RN_DEV_AGENT_CLAIM_EPOCH = '1';
  const before = getRunnerLaunchCount();
  try {
    await assert.rejects(
      startFastRunner(randomUUID().toUpperCase(), 'com.example.gh629'),
      /RnFastRunner\.xcodeproj not found/,
    );
    assert.equal(
      getRunnerLaunchCount(),
      before,
      'no launch child existed, so the retry gate must stay closed',
    );
  } finally {
    if (saved.sessionId === undefined) delete process.env.RN_DEV_AGENT_SESSION_ID;
    else process.env.RN_DEV_AGENT_SESSION_ID = saved.sessionId;
    if (saved.claimEpoch === undefined) delete process.env.RN_DEV_AGENT_CLAIM_EPOCH;
    else process.env.RN_DEV_AGENT_CLAIM_EPOCH = saved.claimEpoch;
  }
});

test('the settle refuses when the launch handle belongs to a newer generation', async () => {
  // A concurrent dispatch's start replaces the global handle. Signalling it
  // would SIGKILL a runner this caller never launched, so a generation the
  // module no longer recognises must refuse — immediately, without settling.
  const t0 = Date.now();
  assert.equal(await awaitSpawnedRunnerExit(50, getRunnerLaunchCount() + 1), false);
  assert.ok(Date.now() - t0 < 500, 'a foreign generation must short-circuit, not wait or signal');
});

test('the settle proceeds for the generation the caller actually observed', async () => {
  assert.equal(await awaitSpawnedRunnerExit(50, getRunnerLaunchCount()), true);
});

test('a start refused for missing session authority does not advance the launch count', async () => {
  const saved = {
    sessionId: process.env.RN_DEV_AGENT_SESSION_ID,
    claimEpoch: process.env.RN_DEV_AGENT_CLAIM_EPOCH,
  };
  delete process.env.RN_DEV_AGENT_SESSION_ID;
  delete process.env.RN_DEV_AGENT_CLAIM_EPOCH;
  const before = getRunnerLaunchCount();
  try {
    await assert.rejects(
      startFastRunner(randomUUID().toUpperCase(), 'com.example.gh629'),
      /SESSION_AUTHORITY_REQUIRED/,
    );
    assert.equal(getRunnerLaunchCount(), before);
  } finally {
    if (saved.sessionId !== undefined) process.env.RN_DEV_AGENT_SESSION_ID = saved.sessionId;
    if (saved.claimEpoch !== undefined) process.env.RN_DEV_AGENT_CLAIM_EPOCH = saved.claimEpoch;
  }
});
