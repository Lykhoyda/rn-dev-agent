import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAESTRO_RUNNER_PIN,
  PINNED_RUNNER_DIAGNOSE_HINT,
  PINNED_RUNNER_INSTALL_HINT,
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

const VERIFY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'verify.sh',
);

const RN_VERIFY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'bin',
  'rn-verify',
);

function writePinnedStub(cache: string) {
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin');
  mkdirSync(pinDir, { recursive: true });
  const bin = join(pinDir, 'maestro-runner');
  writeFileSync(bin, '#!/bin/sh\necho maestro-runner 1.1.24\n');
  chmodSync(bin, 0o755);
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const manifest = join(cache, 'pin.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      version: '1.1.24',
      sha256: {
        'darwin-arm64': sha,
        'darwin-x64': sha,
        'linux-x64': sha,
        'linux-arm64': sha,
      },
      knownQuirks: [],
    }),
  );
  return { bin, manifest };
}

test('--print-bin emits the pin-cache path only when version and checksum match', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-print-bin-'));
  const { bin, manifest } = writePinnedStub(cache);
  const result = spawnSync('bash', [SCRIPT, '--print-bin'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_PIN_MANIFEST: manifest,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), bin);
  assert.doesNotMatch(result.stdout, /Installing maestro-runner/);
});

test('--print-bin ignores a PATH maestro-runner when the pin-cache is missing', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-print-bin-miss-'));
  const pathDir = mkdtempSync(join(tmpdir(), 'mr-path-decoy-'));
  const marker = join(cache, 'path-hit');
  writeFileSync(
    join(pathDir, 'maestro-runner'),
    `#!/bin/sh\necho PATH_HIT > "${marker}"\necho maestro-runner 9.9.9\n`,
  );
  chmodSync(join(pathDir, 'maestro-runner'), 0o755);
  const result = spawnSync('bash', [SCRIPT, '--print-bin'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${pathDir}:${process.env.PATH ?? ''}`,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/should-not-hit',
    },
  });
  assert.notEqual(result.status, 0);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /ensure-maestro-runner|pin-cache|not exactly/);
  assert.doesNotMatch(out, /PATH_HIT/);
  assert.throws(() => readFileSync(marker));
});

test('verify.sh refuses PATH or ~/.maestro-runner and names the supported correction', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-verify-'));
  const pathDir = mkdtempSync(join(tmpdir(), 'mr-verify-path-'));
  const marker = join(cache, 'verify-path-hit');
  writeFileSync(
    join(pathDir, 'maestro-runner'),
    `#!/bin/sh\necho PATH_HIT > "${marker}"\necho maestro-runner 9.9.9\n`,
  );
  chmodSync(join(pathDir, 'maestro-runner'), 0o755);
  const result = spawnSync('bash', [VERIFY, '--platform', 'ios', '--flow-dir', cache], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${pathDir}:${process.env.PATH ?? ''}`,
      HOME: cache,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/should-not-hit',
    },
  });
  assert.equal(result.status, 2);
  const out = `${result.stdout}${result.stderr}`;
  assert.match(out, /ensure-maestro-runner\.sh/);
  assert.doesNotMatch(out, /open\.devicelab\.dev\/install\/maestro-runner/);
  assert.throws(() => readFileSync(marker));
});

test('tracked bin/rn-verify resolves the pin helper through its symlink', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-bin-verify-'));
  const result = spawnSync(RN_VERIFY, ['--platform', 'ios', '--flow-dir', cache], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/should-not-hit',
    },
  });
  assert.equal(result.status, 2);
  const out = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(out, /not found next to verify\.sh/);
  assert.match(out, /ensure-maestro-runner\.sh/);
});

test('pin install and diagnose hints name both host plugin roots', () => {
  assert.match(PINNED_RUNNER_INSTALL_HINT, /RN_DEV_AGENT_CODEX_PLUGIN_ROOT/);
  assert.match(PINNED_RUNNER_DIAGNOSE_HINT, /maestro-runner-pin\.js diagnose/);
  assert.match(PINNED_RUNNER_DIAGNOSE_HINT, /RN_DEV_AGENT_CODEX_PLUGIN_ROOT/);
});
