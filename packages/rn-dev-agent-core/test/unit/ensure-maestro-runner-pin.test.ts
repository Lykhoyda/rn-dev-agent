import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAESTRO_RUNNER_PIN,
  buildReplayEngineStatus,
  doctorPinnedRunner,
  exactPinRefusal,
  getMaestroRunnerPath,
  pinCacheRoot,
  pinnedRunnerBinPath,
} from '../../dist/domain/engine-pin.js';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'ensure-maestro-runner.sh',
);

function runEnsure(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('unsupported platform fails closed and does not download', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-cache-'));
  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Windows',
    RN_DEV_AGENT_UNAME_M: 'amd64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/should-not-hit',
  });
  assert.notEqual(result.status, 0);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /unsupported/i);
  assert.doesNotMatch(out, /Installing maestro-runner/);
});

test('missing pin-cache with a dead download URL is terminal', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-cache-'));
  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });
  assert.notEqual(result.status, 0);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /failed to download|ERROR/);
  assert.match(out, /1\.1\.24/);
});

test('older stub in pin-cache tries to converge rather than accepting drift', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-cache-'));
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin');
  mkdirSync(pinDir, { recursive: true });
  const bin = join(pinDir, 'maestro-runner');
  writeFileSync(bin, '#!/bin/sh\necho maestro-runner 1.0.9\n');
  chmodSync(bin, 0o755);
  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });
  assert.notEqual(result.status, 0);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /Converging|not exactly 1\.1\.24/);
  assert.doesNotMatch(out, /pin ok/);
});

test('newer stub in pin-cache is also refused', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-cache-'));
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin');
  mkdirSync(pinDir, { recursive: true });
  const bin = join(pinDir, 'maestro-runner');
  writeFileSync(bin, '#!/bin/sh\necho maestro-runner 1.2.0\n');
  chmodSync(bin, 0o755);
  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Linux',
    RN_DEV_AGENT_UNAME_M: 'x86_64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });
  assert.notEqual(result.status, 0);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /Converging|not exactly 1\.1\.24/);
});

test('doctorPinnedRunner truth table names missing/older/newer/checksum/unsupported', () => {
  const pinned = buildReplayEngineStatus('pinned-ok', '1.1.24', false, {
    selectedPath: '/cache/maestro-runner/1.1.24/bin/maestro-runner',
    provenance: 'pin-cache',
  });
  assert.equal(doctorPinnedRunner(pinned).ok, true);
  assert.equal(doctorPinnedRunner(pinned).correction, null);

  const missing = doctorPinnedRunner(buildReplayEngineStatus('not-installed', null, true));
  assert.equal(missing.ok, false);
  assert.match(String(missing.correction), /not installed/);

  const older = doctorPinnedRunner(buildReplayEngineStatus('drift-older', '1.0.9', false));
  assert.match(String(older.correction), /older/);
  assert.match(String(older.correction), /1\.0\.9/);

  const newer = doctorPinnedRunner(buildReplayEngineStatus('drift-newer', '1.2.0', false));
  assert.match(String(newer.correction), /newer/);

  const checksum = doctorPinnedRunner(
    buildReplayEngineStatus('checksum-mismatch', '1.1.24', false),
  );
  assert.match(String(checksum.correction), /checksum/);

  const unsupported = doctorPinnedRunner(
    buildReplayEngineStatus('unverified', '1.1.24', false),
    'win32-x64',
  );
  assert.match(String(unsupported.correction), /unsupported on win32-x64/);
});

test('exactPinRefusal is silent only for pinned-ok', () => {
  assert.equal(exactPinRefusal(buildReplayEngineStatus('pinned-ok', '1.1.24', false)), null);
  assert.match(
    String(exactPinRefusal(buildReplayEngineStatus('not-installed', null, true))),
    /refused/,
  );
  assert.match(String(exactPinRefusal(null)), /could not be detected/);
});

test('pin-cache helpers never resolve PATH or ~/.maestro-runner', () => {
  const prev = process.env.RN_DEV_AGENT_RUNNER_CACHE;
  const cache = mkdtempSync(join(tmpdir(), 'mr-cache-'));
  process.env.RN_DEV_AGENT_RUNNER_CACHE = cache;
  try {
    assert.equal(pinCacheRoot(), join(cache, 'maestro-runner', '1.1.24'));
    assert.equal(
      pinnedRunnerBinPath(),
      join(cache, 'maestro-runner', '1.1.24', 'bin', 'maestro-runner'),
    );
    assert.equal(getMaestroRunnerPath(), null);
    assert.doesNotMatch(pinnedRunnerBinPath(), /\/\.maestro-runner\//);
  } finally {
    if (prev === undefined) delete process.env.RN_DEV_AGENT_RUNNER_CACHE;
    else process.env.RN_DEV_AGENT_RUNNER_CACHE = prev;
  }
});
