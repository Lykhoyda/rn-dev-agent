// GH #397 Phase 1 — engine pin manifest + pure classification truth table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAESTRO_RUNNER_PIN,
  classifyEnginePin,
  compareVersions,
  buildReplayEngineStatus,
  doctorPinnedRunner,
  enginePinCaveat,
  getEngineStatus,
  strictPinRefusal,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
} from '../../dist/domain/engine-pin.js';

const KEY = 'darwin-arm64';
const PIN_HASH = MAESTRO_RUNNER_PIN.sha256[KEY] as string;

test('gh-397: pin constant matches the tested engine', () => {
  assert.equal(MAESTRO_RUNNER_PIN.version, '1.1.24');
  assert.match(PIN_HASH, /^[0-9a-f]{64}$/);
  const ids = MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id);
  assert.deepEqual(ids, ['android-pre-o-unsupported']);
});

test('gh-397: exported pin identity is deeply immutable', () => {
  const checksum = MAESTRO_RUNNER_PIN.sha256[KEY];
  assert.throws(() => {
    (MAESTRO_RUNNER_PIN.sha256 as Record<string, string>)[KEY] = 'f'.repeat(64);
  });
  assert.throws(() => {
    (MAESTRO_RUNNER_PIN as { version: string }).version = '9.9.9';
  });
  assert.equal(MAESTRO_RUNNER_PIN.version, '1.1.24');
  assert.equal(MAESTRO_RUNNER_PIN.sha256[KEY], checksum);
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
  assert.equal(classifyEnginePin(d('1.2.0', 'f'.repeat(64)), KEY), 'drift-newer');
  assert.equal(classifyEnginePin(d('1.0.8', 'f'.repeat(64)), KEY), 'drift-older');
  assert.equal(classifyEnginePin(d('1.1.24', 'f'.repeat(64)), KEY), 'checksum-mismatch');
  assert.equal(classifyEnginePin(d('1.1.24', PIN_HASH), KEY), 'pinned-ok');
  assert.equal(
    classifyEnginePin(d('1.1.24', 'f'.repeat(64)), 'win32-x64'),
    'unverified',
    'no manifest hash for this platform — pinned-ok must mean version AND hash verified',
  );
  assert.equal(
    classifyEnginePin(d('1.1.24', null), KEY),
    'unverified',
    'expected hash exists but hashing failed — must not claim pinned-ok',
  );
  assert.equal(
    classifyEnginePin(d('1.0.x', PIN_HASH), KEY),
    'unknown-version',
    'malformed version must not compare equal via NaN',
  );
  assert.equal(classifyEnginePin(d('1.1.24-beta', PIN_HASH), KEY), 'unknown-version');
});

test('gh-397: buildReplayEngineStatus picks engine + carries quirk ids', () => {
  const ok = buildReplayEngineStatus('pinned-ok', '1.1.24', true);
  assert.equal(ok.engine, 'maestro-runner');
  assert.deepEqual(ok.pin, { pinned: '1.1.24', status: 'pinned-ok' });
  assert.ok(ok.quirks.includes('android-pre-o-unsupported'));
  assert.equal(buildReplayEngineStatus('not-installed', null, true).engine, 'none');
  assert.equal(buildReplayEngineStatus('not-installed', null, false).engine, 'none');
  assert.equal(buildReplayEngineStatus('unverified', '1.2.0', false).engine, 'none');
});

test('gh-397: enginePinCaveat only fires on drift/checksum states', () => {
  assert.equal(enginePinCaveat(buildReplayEngineStatus('pinned-ok', '1.1.24', true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('not-installed', null, true)), null);
  assert.equal(enginePinCaveat(buildReplayEngineStatus('unknown-version', null, true)), null);
  const drift = enginePinCaveat(buildReplayEngineStatus('drift-newer', '1.2.0', true));
  assert.ok(drift !== null);
  assert.match(drift, /1\.2\.0/);
  assert.match(drift, /1\.1\.24/);
  assert.match(drift, /untested/i);
  const bad = enginePinCaveat(buildReplayEngineStatus('checksum-mismatch', '1.1.24', true));
  assert.ok(bad !== null);
  assert.match(bad, /checksum/i);
});

test('gh-397: getEngineStatus revalidates across sequential spawn boundaries', async () => {
  _resetEngineStatusForTest();
  let execCalls = 0;
  let version = '1.1.24';
  const resolvers = {
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      execCalls++;
      return `maestro-runner ${version}\n  Commit:  9728809`;
    },
    hashFile: () => PIN_HASH,
    cliPresent: () => false,
    platformKey: KEY,
  };
  const s1 = await getEngineStatus(resolvers);
  assert.equal(s1.pin.status, 'pinned-ok');
  assert.equal(s1.version, '1.1.24');
  version = '1.2.0';
  const s2 = await getEngineStatus(resolvers);
  assert.equal(execCalls, 2);
  assert.equal(s2.pin.status, 'drift-newer');
  assert.equal(s2.version, '1.2.0');
});

test('gh-397: checksum mismatch is classified before executing the binary', async () => {
  _resetEngineStatusForTest();
  let execCalls = 0;
  const s = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      execCalls += 1;
      return 'maestro-runner 1.1.24';
    },
    hashFile: () => 'f'.repeat(64),
    platformKey: KEY,
  });
  assert.equal(s.pin.status, 'checksum-mismatch');
  assert.equal(s.version, null);
  assert.equal(execCalls, 0);
  _resetEngineStatusForTest();
});

test('gh-397: version drift is diagnosed only after checksum verification', async () => {
  _resetEngineStatusForTest();
  const older = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => 'maestro-runner 1.0.9',
    hashFile: () => PIN_HASH,
    platformKey: KEY,
  });
  const newer = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => 'maestro-runner 1.2.0',
    hashFile: () => PIN_HASH,
    platformKey: KEY,
  });
  assert.equal(older.pin.status, 'drift-older');
  assert.equal(older.version, '1.0.9');
  assert.equal(newer.pin.status, 'drift-newer');
  assert.equal(newer.version, '1.2.0');
  _resetEngineStatusForTest();
});

test('gh-397: newer cache drift is reported without executing its binary', async () => {
  _resetEngineStatusForTest();
  const previousCache = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  try {
    for (const [version, expected, expectedVersion] of [
      ['1.0.9', 'checksum-mismatch', null],
      ['1.2.0', 'unverified', '1.2.0'],
    ] as const) {
      const cache = mkdtempSync(join(tmpdir(), 'rn-versioned-runner-cache-'));
      const binDir = join(cache, 'maestro-runner', version, 'bin');
      const marker = join(cache, 'executed');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, 'maestro-runner'),
        `#!/bin/sh\necho executed > "${marker}"\necho maestro-runner ${version}\n`,
      );
      chmodSync(join(binDir, 'maestro-runner'), 0o755);
      process.env.RN_DEV_AGENT_RUNNER_CACHE = cache;

      const status = await getEngineStatus();
      const doctor = doctorPinnedRunner(status);

      assert.equal(status.pin.status, expected);
      assert.equal(doctor.status, expected);
      assert.equal(status.version, expectedVersion);
      assert.equal(doctor.installedVersion, expectedVersion);
      assert.equal(status.selectedPath, join(binDir, 'maestro-runner'));
      assert.equal(status.engine, 'none');
      if (version === '1.2.0') {
        assert.match(String(doctor.correction), /unverified newer/);
        assert.match(String(doctor.correction), /will not be executed/);
      }
      assert.throws(() => readFileSync(marker));
    }
  } finally {
    if (previousCache === undefined) delete process.env.RN_DEV_AGENT_RUNNER_CACHE;
    else process.env.RN_DEV_AGENT_RUNNER_CACHE = previousCache;
    _resetEngineStatusForTest();
  }
});

test('gh-397: trusted historical checksum proves older drift without execution', async () => {
  _resetEngineStatusForTest();
  const previousCache = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  const cache = mkdtempSync(join(tmpdir(), 'rn-trusted-runner-cache-'));
  const bin = join(cache, 'maestro-runner', '1.0.9', 'bin', 'maestro-runner');
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\nexit 99\n');
  chmodSync(bin, 0o755);
  process.env.RN_DEV_AGENT_RUNNER_CACHE = cache;
  let executed = false;
  try {
    const status = await getEngineStatus({
      binPath: () => bin,
      hashFile: () => '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
      execVersion: async () => {
        executed = true;
        return 'maestro-runner 1.0.9';
      },
      platformKey: KEY,
    });
    assert.equal(status.pin.status, 'drift-older');
    assert.equal(status.version, '1.0.9');
    assert.equal(executed, false);
  } finally {
    if (previousCache === undefined) delete process.env.RN_DEV_AGENT_RUNNER_CACHE;
    else process.env.RN_DEV_AGENT_RUNNER_CACHE = previousCache;
    _resetEngineStatusForTest();
  }
});

test('gh-397: getEngineStatus refuses execution when hashing fails', async () => {
  _resetEngineStatusForTest();
  let execCalls = 0;
  const s = await getEngineStatus({
    binPath: () => '/fake/maestro-runner',
    execVersion: async () => {
      execCalls += 1;
      throw new Error('spawn failure');
    },
    hashFile: () => {
      throw new Error('EACCES');
    },
    cliPresent: () => true,
    platformKey: KEY,
  });
  assert.equal(s.pin.status, 'unverified');
  assert.equal(s.engine, 'none');
  assert.equal(execCalls, 0);
  _resetEngineStatusForTest();
});

test('gh-397: explicit test status overrides live detection', async () => {
  _resetEngineStatusForTest();
  const seeded = buildReplayEngineStatus('drift-newer', '1.1.0', false);
  _setEngineStatusForTest(seeded);
  assert.equal(await getEngineStatus(), seeded);
  _resetEngineStatusForTest();
});

test('gh-397: strictPinRefusal refuses proven divergence only, and only when opted in', () => {
  const st = (cls: Parameters<typeof buildReplayEngineStatus>[0]) =>
    buildReplayEngineStatus(cls, '1.1.0', false);
  assert.equal(strictPinRefusal(st('drift-newer'), undefined), null, 'no env, no refusal');
  assert.equal(strictPinRefusal(st('drift-newer'), '0'), null);
  assert.equal(strictPinRefusal(null, '1'), null, 'no status, no refusal');
  for (const cls of ['drift-newer', 'drift-older', 'checksum-mismatch'] as const) {
    const msg = strictPinRefusal(st(cls), '1');
    assert.ok(msg !== null, `${cls} must refuse under strict`);
    assert.match(msg, /RN_ENGINE_PIN_STRICT/);
  }
  for (const cls of ['pinned-ok', 'unverified', 'unknown-version', 'not-installed'] as const) {
    assert.equal(strictPinRefusal(st(cls), '1'), null, `${cls} must NOT refuse (not proven drift)`);
  }
  assert.ok(strictPinRefusal(st('drift-older'), 'true') !== null, "'true' also opts in");
});
