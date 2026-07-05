// GH #397 Phase 1 — engine pin manifest + pure classification truth table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAESTRO_RUNNER_PIN,
  classifyEnginePin,
  compareVersions,
  buildReplayEngineStatus,
  enginePinCaveat,
  getEngineStatus,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
} from '../../dist/domain/engine-pin.js';

const KEY = 'darwin-arm64';
const PIN_HASH = MAESTRO_RUNNER_PIN.sha256[KEY] as string;

test('gh-397: pin constant matches the tested engine', () => {
  assert.equal(MAESTRO_RUNNER_PIN.version, '1.0.9');
  assert.match(PIN_HASH, /^[0-9a-f]{64}$/);
  const ids = MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id);
  assert.ok(ids.includes('android-hidekeyboard-noop'));
  assert.ok(ids.includes('requires-adb-on-ios'));
});

test('gh-397: compareVersions is numeric per segment', () => {
  assert.equal(compareVersions('1.0.9', '1.0.9'), 0);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.8', '1.0.9'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('gh-397: classification truth table', () => {
  const d = (v: string | null, h: string | null, inst = true) => ({
    installed: inst,
    version: v,
    sha256: h,
  });
  assert.equal(classifyEnginePin(d(null, null, false), KEY), 'not-installed');
  assert.equal(classifyEnginePin(d(null, PIN_HASH), KEY), 'unknown-version');
  assert.equal(classifyEnginePin(d('1.1.0', 'f'.repeat(64)), KEY), 'drift-newer');
  assert.equal(classifyEnginePin(d('1.0.8', 'f'.repeat(64)), KEY), 'drift-older');
  assert.equal(classifyEnginePin(d('1.0.9', 'f'.repeat(64)), KEY), 'checksum-mismatch');
  assert.equal(classifyEnginePin(d('1.0.9', PIN_HASH), KEY), 'pinned-ok');
  assert.equal(
    classifyEnginePin(d('1.0.9', 'f'.repeat(64)), 'linux-x64'),
    'unverified',
    'no manifest hash for this platform — pinned-ok must mean version AND hash verified',
  );
  assert.equal(
    classifyEnginePin(d('1.0.9', null), KEY),
    'unverified',
    'expected hash exists but hashing failed — must not claim pinned-ok',
  );
  assert.equal(
    classifyEnginePin(d('1.0.x', PIN_HASH), KEY),
    'unknown-version',
    'malformed version must not compare equal via NaN',
  );
  assert.equal(classifyEnginePin(d('1.0.9-beta', PIN_HASH), KEY), 'unknown-version');
});

test('gh-397: buildReplayEngineStatus picks engine + carries quirk ids', () => {
  const ok = buildReplayEngineStatus('pinned-ok', '1.0.9', true);
  assert.equal(ok.engine, 'maestro-runner');
  assert.deepEqual(ok.pin, { pinned: '1.0.9', status: 'pinned-ok' });
  assert.ok(ok.quirks.includes('android-hidekeyboard-noop'));
  assert.equal(buildReplayEngineStatus('not-installed', null, true).engine, 'maestro-cli');
  assert.equal(buildReplayEngineStatus('not-installed', null, false).engine, 'none');
});

test('gh-397: enginePinCaveat only fires on drift/checksum states', () => {
  assert.equal(enginePinCaveat(buildReplayEngineStatus('pinned-ok', '1.0.9', true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('not-installed', null, true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('unknown-version', null, true)), null);
  const drift = enginePinCaveat(buildReplayEngineStatus('drift-newer', '1.1.0', true));
  assert.ok(drift !== null);
  assert.match(drift, /1\.1\.0/);
  assert.match(drift, /1\.0\.9/);
  assert.match(drift, /untested/i);
  const bad = enginePinCaveat(buildReplayEngineStatus('checksum-mismatch', '1.0.9', true));
  assert.ok(bad !== null);
  assert.match(bad, /checksum/i);
});

test('gh-397: getEngineStatus detects via injected resolvers and caches', async () => {
  _resetEngineStatusForTest();
  let execCalls = 0;
  const resolvers = {
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      execCalls++;
      return 'maestro-runner 1.0.9\n  Commit:  c25dc55';
    },
    hashFile: () => PIN_HASH,
    cliPresent: () => false,
    platformKey: KEY,
  };
  const s1 = await getEngineStatus(resolvers);
  assert.equal(s1.pin.status, 'pinned-ok');
  assert.equal(s1.version, '1.0.9');
  const s2 = await getEngineStatus(resolvers);
  assert.equal(execCalls, 1, 'second call must hit the cache');
  assert.equal(s2, s1);
});

test('gh-397: getEngineStatus fails open on resolver errors', async () => {
  _resetEngineStatusForTest();
  const s = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      throw new Error('spawn failure');
    },
    hashFile: () => {
      throw new Error('EACCES');
    },
    cliPresent: () => true,
    platformKey: KEY,
  });
  assert.equal(s.pin.status, 'unknown-version');
  assert.equal(s.engine, 'maestro-runner');
  _resetEngineStatusForTest();
});

test('gh-397: _setEngineStatusForTest seeds the cache (for maestro-run tests)', async () => {
  _resetEngineStatusForTest();
  const seeded = buildReplayEngineStatus('drift-newer', '1.1.0', false);
  _setEngineStatusForTest(seeded);
  assert.equal(await getEngineStatus(), seeded);
  _resetEngineStatusForTest();
});
