// #519 review finding 4: a pre-#395 runner artifact passes every staleness
// gate (protocol unchanged, no new verbs, runnerVersion is env-passed at
// launch) while still emitting hittable=false for every node. The compiled-in
// HONEST_HITTABLE capability is the only artifact-truthful signal — a healthy
// probe that doesn't advertise it queues a one-shot advisory note through the
// existing pendingFastRunnerArtifactNote channel (surfaced as meta.note by the
// open/dispatch paths). Advisory only: liveness stays 'alive'.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeFastRunnerLivenessDetailed,
  consumePendingFastRunnerArtifactNote,
  _resetStaleHittableWarnForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS } from '../../dist/runners/protocol.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.58.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});
const aliveBody = (capabilities) => ({
  ok: true,
  status: 200,
  bodyOk: true,
  protocolVersion: 1,
  runnerVersion: '0.58.0',
  commands: [...REQUIRED_IOS_COMMANDS],
  ...(capabilities !== undefined ? { capabilities } : {}),
});

beforeEach(() => {
  consumePendingFastRunnerArtifactNote();
  _resetStaleHittableWarnForTest();
});

test('gh-519: alive artifact without HONEST_HITTABLE queues a stale-hittable advisory', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.equal(d.liveness, 'alive', 'advisory never degrades liveness');
  const note = consumePendingFastRunnerArtifactNote();
  assert.ok(note !== undefined, 'advisory note queued');
  assert.match(note, /hittable/i);
  assert.match(note, /#395/);
});

test('gh-519: artifact advertising HONEST_HITTABLE queues no note', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps(aliveBody(['SCREEN_STATIC', 'HONEST_HITTABLE'])),
  );
  assert.equal(d.liveness, 'alive');
  assert.equal(consumePendingFastRunnerArtifactNote(), undefined);
});

test('gh-519: capabilities-less (pre-#385) alive artifact also warns — it predates #395 too', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps(aliveBody(undefined)));
  assert.equal(d.liveness, 'alive');
  assert.match(consumePendingFastRunnerArtifactNote() ?? '', /hittable/i);
});

test('gh-519: advisory is warn-once per process', async () => {
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(consumePendingFastRunnerArtifactNote() !== undefined);
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.equal(consumePendingFastRunnerArtifactNote(), undefined, 'no re-nag on later probes');
});

test('gh-519: an occupied pending-note slot defers the advisory without spending the warn budget', async () => {
  // Both notes share the same text, so a clobber is not directly observable —
  // but the guard's side effect is: a probe that finds the slot occupied must
  // early-return BEFORE marking warned, so the advisory still fires on the
  // next free-slot probe. An overwrite implementation would have consumed the
  // warn budget and queue nothing at step 3.
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  _resetStaleHittableWarnForTest();
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(consumePendingFastRunnerArtifactNote() !== undefined, 'original note still present');
  await probeFastRunnerLivenessDetailed(deps(aliveBody(['SCREEN_STATIC'])));
  assert.ok(
    consumePendingFastRunnerArtifactNote() !== undefined,
    'warn budget survived the occupied-slot probe and fires once the slot frees',
  );
});
