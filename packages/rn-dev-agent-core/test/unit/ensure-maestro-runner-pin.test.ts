import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  withBoundExecutable,
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

function processBirthIdentity(pid: number): string {
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase();
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return `linux:${boot}:${fields[19]}`;
  }
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'native',
    'darwin-process-birth',
  );
  const result = spawnSync(helper, [String(pid)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return `darwin:${result.stdout.trim()}`;
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

test('installer verifies the complete archive before replacing the live pin-cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-archive-pin-'));
  const cache = join(root, 'cache');
  const payload = join(root, 'payload', 'maestro-runner');
  const archive = join(root, 'maestro-runner.tar.gz');
  const liveBin = join(
    cache,
    'maestro-runner',
    MAESTRO_RUNNER_PIN.version,
    'bin',
    'maestro-runner',
  );
  mkdirSync(join(payload, 'bin'), { recursive: true });
  mkdirSync(join(payload, 'drivers'), { recursive: true });
  writeFileSync(join(payload, 'bin', 'maestro-runner'), '#!/bin/sh\necho maestro-runner 1.1.24\n');
  chmodSync(join(payload, 'bin', 'maestro-runner'), 0o755);
  writeFileSync(join(payload, 'drivers', 'altered.apk'), 'altered');
  const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'maestro-runner']);
  assert.equal(packed.status, 0, String(packed.stderr));
  mkdirSync(dirname(liveBin), { recursive: true });
  writeFileSync(liveBin, '#!/bin/sh\necho existing\n');
  chmodSync(liveBin, 0o755);
  const toolDir = join(root, 'tools');
  const outsideStageMarker = join(root, 'outside-stage');
  const realMktemp = (process.env.PATH ?? '')
    .split(':')
    .map((entry) => join(entry, 'mktemp'))
    .find(existsSync);
  assert.ok(realMktemp);
  mkdirSync(toolDir);
  writeFileSync(
    join(toolDir, 'mktemp'),
    `#!/bin/sh\ncase "$*" in\n  *"$EXPECTED_STAGE_ROOT"*) exec "$REAL_MKTEMP" "$@" ;;\n  *) printf outside > "$OUTSIDE_STAGE_MARKER"; exit 97 ;;\nesac\n`,
  );
  chmodSync(join(toolDir, 'mktemp'), 0o755);

  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: pathToFileURL(archive).href,
    EXPECTED_STAGE_ROOT: join(cache, 'maestro-runner'),
    OUTSIDE_STAGE_MARKER: outsideStageMarker,
    REAL_MKTEMP: realMktemp,
    PATH: `${toolDir}:${process.env.PATH ?? ''}`,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /archive checksum/);
  assert.equal(readFileSync(liveBin, 'utf8'), '#!/bin/sh\necho existing\n');
  assert.throws(() => readFileSync(join(dirname(dirname(liveBin)), 'drivers', 'altered.apk')));
  assert.equal(existsSync(outsideStageMarker), false);
});

test('installed fast path refuses a payload changed after verified installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-live-payload-'));
  const scriptDir = join(root, 'scripts');
  const payload = join(root, 'payload', 'maestro-runner');
  const archive = join(root, 'maestro-runner.tar.gz');
  const cache = join(root, 'cache');
  const executionMarker = join(root, 'runner-executed');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(join(payload, 'bin'), { recursive: true });
  mkdirSync(join(payload, 'drivers'), { recursive: true });
  const runner = join(payload, 'bin', 'maestro-runner');
  writeFileSync(
    runner,
    `#!/bin/sh\nprintf executed > ${JSON.stringify(executionMarker)}\necho maestro-runner 1.1.24\n`,
    'utf8',
  );
  chmodSync(runner, 0o755);
  writeFileSync(join(payload, 'drivers', 'server.apk'), 'trusted-payload', 'utf8');
  const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'maestro-runner']);
  assert.equal(packed.status, 0, String(packed.stderr));
  const runnerSha = createHash('sha256').update(readFileSync(runner)).digest('hex');
  const archiveSha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const copiedScript = join(scriptDir, 'ensure-maestro-runner.sh');
  writeFileSync(copiedScript, readFileSync(SCRIPT), 'utf8');
  chmodSync(copiedScript, 0o755);
  const packagedNativeDir = join(root, 'rn-dev-agent-core', 'dist', 'native');
  const sourceNativeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native');
  mkdirSync(packagedNativeDir, { recursive: true });
  for (const name of [
    'darwin-process-birth',
    'darwin-process-birth.json',
    'linux-conditional-publication-x64',
    'linux-conditional-publication-x64.json',
    'linux-conditional-publication-arm64',
    'linux-conditional-publication-arm64.json',
  ]) {
    copyFileSync(join(sourceNativeDir, name), join(packagedNativeDir, name));
  }
  chmodSync(join(packagedNativeDir, 'darwin-process-birth'), 0o755);
  chmodSync(join(packagedNativeDir, 'linux-conditional-publication-x64'), 0o755);
  chmodSync(join(packagedNativeDir, 'linux-conditional-publication-arm64'), 0o755);
  writeFileSync(
    join(scriptDir, 'maestro-runner-pin.json'),
    JSON.stringify({
      version: '1.1.24',
      sha256: {
        'darwin-arm64': runnerSha,
        'darwin-x64': runnerSha,
        'linux-arm64': runnerSha,
        'linux-x64': runnerSha,
      },
      archiveSha256: {
        'darwin-arm64': archiveSha,
        'darwin-x64': archiveSha,
        'linux-arm64': archiveSha,
        'linux-x64': archiveSha,
      },
      knownQuirks: [],
    }),
    'utf8',
  );
  const env = {
    ...process.env,
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: pathToFileURL(archive).href,
  };

  const installed = spawnSync('bash', [copiedScript], { encoding: 'utf8', env });
  assert.equal(installed.status, 0, `${installed.stdout}${installed.stderr}`);
  assert.equal(existsSync(executionMarker), false);
  const liveDriver = join(
    cache,
    'maestro-runner',
    MAESTRO_RUNNER_PIN.version,
    'drivers',
    'server.apk',
  );
  writeFileSync(liveDriver, 'tampered-payload', 'utf8');

  const refused = spawnSync('bash', [copiedScript, '--print-bin'], { encoding: 'utf8', env });
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}${refused.stderr}`, /not exactly 1\.1\.24/);
  assert.equal(existsSync(executionMarker), false);
});

test('installer keeps the live pin when atomic publication fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-publication-rollback-'));
  const scriptDir = join(root, 'scripts');
  const payload = join(root, 'payload', 'maestro-runner');
  const archive = join(root, 'maestro-runner.tar.gz');
  const cache = join(root, 'cache');
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
  const liveMarker = join(pinDir, 'live-before-publication');
  mkdirSync(join(payload, 'bin'), { recursive: true });
  mkdirSync(join(pinDir, 'bin'), { recursive: true });
  mkdirSync(scriptDir);
  const runner = join(payload, 'bin', 'maestro-runner');
  writeFileSync(runner, '#!/bin/sh\necho maestro-runner 1.1.24\n', 'utf8');
  chmodSync(runner, 0o755);
  writeFileSync(join(pinDir, 'bin', 'maestro-runner'), '#!/bin/sh\necho previous\n', 'utf8');
  chmodSync(join(pinDir, 'bin', 'maestro-runner'), 0o755);
  writeFileSync(liveMarker, 'preserve-me', 'utf8');
  const packed = spawnSync('tar', ['-czf', archive, '-C', join(root, 'payload'), 'maestro-runner']);
  assert.equal(packed.status, 0, String(packed.stderr));
  const copiedScript = join(scriptDir, 'ensure-maestro-runner.sh');
  writeFileSync(copiedScript, readFileSync(SCRIPT), 'utf8');
  chmodSync(copiedScript, 0o755);
  writeFileSync(
    join(scriptDir, 'maestro-runner-pin.json'),
    JSON.stringify({
      version: MAESTRO_RUNNER_PIN.version,
      sha256: Object.fromEntries(
        ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((key) => [
          key,
          createHash('sha256').update(readFileSync(runner)).digest('hex'),
        ]),
      ),
      archiveSha256: Object.fromEntries(
        ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((key) => [
          key,
          createHash('sha256').update(readFileSync(archive)).digest('hex'),
        ]),
      ),
      knownQuirks: [],
    }),
    'utf8',
  );
  const nativeSource = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native');
  const nativeTarget = join(root, 'rn-dev-agent-core', 'dist', 'native');
  mkdirSync(nativeTarget, { recursive: true });
  for (const name of [
    'darwin-process-birth',
    'darwin-process-birth.json',
    'linux-conditional-publication-x64',
    'linux-conditional-publication-x64.json',
    'linux-conditional-publication-arm64',
    'linux-conditional-publication-arm64.json',
  ]) {
    copyFileSync(join(nativeSource, name), join(nativeTarget, name));
  }
  chmodSync(join(nativeTarget, 'darwin-process-birth'), 0o755);
  chmodSync(join(nativeTarget, 'linux-conditional-publication-x64'), 0o755);
  chmodSync(join(nativeTarget, 'linux-conditional-publication-arm64'), 0o755);
  const failingHelper = join(
    nativeTarget,
    process.platform === 'darwin'
      ? 'darwin-process-birth'
      : `linux-conditional-publication-${process.arch === 'arm64' ? 'arm64' : 'x64'}`,
  );
  writeFileSync(failingHelper, '#!/bin/sh\nexit 124\n', 'utf8');
  chmodSync(failingHelper, 0o755);
  const failingDigest = createHash('sha256').update(readFileSync(failingHelper)).digest('hex');
  const helperManifestPath = `${failingHelper}.json`;
  const helperManifest = JSON.parse(readFileSync(helperManifestPath, 'utf8'));
  writeFileSync(
    helperManifestPath,
    JSON.stringify({ ...helperManifest, binarySha256: failingDigest }),
    'utf8',
  );

  const result = spawnSync('bash', [copiedScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_UNAME_S: 'Darwin',
      RN_DEV_AGENT_UNAME_M: 'arm64',
      RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: pathToFileURL(archive).href,
    },
  });

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(liveMarker, 'utf8'), 'preserve-me');
  assert.equal(existsSync(join(pinDir, 'bin', 'maestro-runner')), true);

  copyFileSync(join(nativeSource, basename(failingHelper)), failingHelper);
  copyFileSync(join(nativeSource, `${basename(failingHelper)}.json`), `${failingHelper}.json`);
  chmodSync(failingHelper, 0o755);
  const converged = spawnSync('bash', [copiedScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_UNAME_S: 'Darwin',
      RN_DEV_AGENT_UNAME_M: 'arm64',
      RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: pathToFileURL(archive).href,
    },
  });
  assert.equal(converged.status, 0, `${converged.stdout}${converged.stderr}`);
  assert.equal(existsSync(liveMarker), false);
  assert.equal(
    readFileSync(join(pinDir, 'bin', 'maestro-runner'), 'utf8'),
    readFileSync(runner, 'utf8'),
  );
});

test('installer reclaims a stale ownerless legacy lock', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-ownerless-lock-'));
  const lock = join(cache, 'maestro-runner', `.install-${MAESTRO_RUNNER_PIN.version}.lock`);
  mkdirSync(lock, { recursive: true });
  const stale = new Date(Date.now() - 10_000);
  utimesSync(lock, stale, stale);

  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /failed to download/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /timed out waiting/);
  assert.equal(existsSync(lock), false);
});

test('installer waits beyond ten seconds for a healthy lock owner', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-lock-wait-'));
  const lock = join(cache, 'maestro-runner', `.install-${MAESTRO_RUNNER_PIN.version}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  const holder = spawn(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs"); const p=process.argv[1]; fs.writeFileSync(p, String(process.pid)); setTimeout(() => { fs.unlinkSync(p); }, 11000);',
      lock,
    ],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 100 && !existsSync(lock); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(lock), true);

  const startedAt = Date.now();
  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });
  const elapsedMs = Date.now() - startedAt;
  if (holder.exitCode === null) {
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  }

  assert.ok(elapsedMs >= 10_000);
  assert.match(`${result.stdout}${result.stderr}`, /failed to download/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /timed out waiting/);
});

test('installer does not age-reclaim a demonstrably live lock owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-reused-pid-lock-'));
  const cache = join(root, 'cache');
  const lock = join(cache, 'maestro-runner', `.install-${MAESTRO_RUNNER_PIN.version}.lock`);
  const toolDir = join(root, 'tools');
  mkdirSync(dirname(lock), { recursive: true });
  mkdirSync(toolDir);
  writeFileSync(lock, `${process.pid}\n${processBirthIdentity(process.pid)}\n`);
  const stale = new Date(Date.now() - 120_000);
  utimesSync(lock, stale, stale);
  writeFileSync(join(toolDir, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(toolDir, 'sleep'), 0o755);

  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
    RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS: '12',
    PATH: `${toolDir}:${process.env.PATH ?? ''}`,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /timed out waiting/);
  assert.equal(existsSync(lock), true);
});

test('installer reclaims a stale lock after its pid is reused', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-reused-pid-lock-'));
  const lock = join(cache, 'maestro-runner', `.install-${MAESTRO_RUNNER_PIN.version}.lock`);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.pid}\nlinux:not-this-process\n`);
  const stale = new Date(Date.now() - 120_000);
  utimesSync(lock, stale, stale);

  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'http://127.0.0.1:1/missing.tar.gz',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /failed to download/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /timed out waiting/);
  assert.equal(existsSync(lock), false);
});

test('installer applies one deadline across lock wait and download', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-total-deadline-'));
  const cache = join(root, 'cache');
  const lock = join(cache, 'maestro-runner', `.install-${MAESTRO_RUNNER_PIN.version}.lock`);
  const toolDir = join(root, 'tools');
  const marker = join(root, 'curl-max-time');
  mkdirSync(dirname(lock), { recursive: true });
  mkdirSync(toolDir);
  writeFileSync(
    join(toolDir, 'curl'),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--max-time" ]; then\n    shift\n    printf "%s" "$1" > "$CURL_TIMEOUT_MARKER"\n  fi\n  shift\ndone\nexit 1\n',
  );
  chmodSync(join(toolDir, 'curl'), 0o755);
  const holder = spawn(
    process.execPath,
    [
      '-e',
      'const fs=require("node:fs"); const p=process.argv[1]; fs.writeFileSync(p,String(process.pid)); setTimeout(()=>fs.unlinkSync(p),2000);',
      lock,
    ],
    { stdio: 'ignore' },
  );
  for (let attempt = 0; attempt < 100 && !existsSync(lock); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(lock), true);

  const result = runEnsure({
    RN_DEV_AGENT_RUNNER_CACHE: cache,
    RN_DEV_AGENT_UNAME_S: 'Darwin',
    RN_DEV_AGENT_UNAME_M: 'arm64',
    RN_DEV_AGENT_TEST_INSTALL_BUDGET_SECONDS: '15',
    RN_DEV_AGENT_MAESTRO_DOWNLOAD_URL: 'https://example.invalid/runner.tar.gz',
    CURL_TIMEOUT_MARKER: marker,
    PATH: `${toolDir}:${process.env.PATH ?? ''}`,
  });
  if (holder.exitCode === null) {
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  }

  assert.notEqual(result.status, 0);
  const maxTime = Number(readFileSync(marker, 'utf8'));
  assert.ok(maxTime >= 1 && maxTime <= 5);
  assert.match(`${result.stdout}${result.stderr}`, /failed to download/);
});

test('pin manifest owns checksums for every supported release archive', () => {
  assert.deepEqual(Object.keys(MAESTRO_RUNNER_PIN.archiveSha256).sort(), [
    'darwin-arm64',
    'darwin-x64',
    'linux-arm64',
    'linux-x64',
  ]);
  for (const digest of Object.values(MAESTRO_RUNNER_PIN.archiveSha256)) {
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
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
  assert.equal(unsupported.platformStatus, 'unsupported');
  assert.equal(unsupported.platformKey, 'win32-x64');
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

test('bound executable keeps verified bytes when the source path is replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-bound-executable-'));
  const executable = join(root, 'maestro-runner');
  const replacement = join(root, 'replacement');
  writeFileSync(executable, '#!/bin/sh\necho trusted\n', 'utf8');
  writeFileSync(replacement, '#!/bin/sh\necho replaced\n', 'utf8');
  const expected = createHash('sha256').update(readFileSync(executable)).digest('hex');

  const observed = await withBoundExecutable(executable, expected, async (boundPath) => {
    renameSync(replacement, executable);
    return readFileSync(boundPath, 'utf8');
  });

  assert.equal(observed, '#!/bin/sh\necho trusted\n');
  assert.equal(readFileSync(executable, 'utf8'), '#!/bin/sh\necho replaced\n');

  const symlink = join(root, 'symlink-runner');
  symlinkSync(executable, symlink);
  await assert.rejects(
    () => withBoundExecutable(symlink, expected, async () => 'unreachable'),
    /identity changed/,
  );
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

const COLLECT_FEEDBACK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'collect-feedback.sh',
);

test('verify.sh help advertises only the owned action corpus', () => {
  const result = spawnSync('bash', [VERIFY, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--flow-dir \.rn-agent\/actions/);
  assert.doesNotMatch(result.stdout, /e2e\/flows|any other directory/);
});

test('test manifest cannot redefine canonical checksums or authorize execution', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-checksum-override-'));
  const marker = join(cache, 'runner-executed');
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin');
  mkdirSync(pinDir, { recursive: true });
  const bin = join(pinDir, 'maestro-runner');
  writeFileSync(bin, `#!/bin/sh\necho hit > "${marker}"\necho maestro-runner 1.1.24\n`);
  chmodSync(bin, 0o755);
  const fakeSha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const manifest = join(cache, 'same-version-other-checksums.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      version: MAESTRO_RUNNER_PIN.version,
      sha256: {
        'darwin-arm64': fakeSha,
        'darwin-x64': fakeSha,
        'linux-x64': fakeSha,
        'linux-arm64': fakeSha,
      },
      knownQuirks: [],
    }),
  );
  const printed = spawnSync('bash', [SCRIPT, '--print-pin-json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_TEST_PIN_MANIFEST: manifest,
    },
  });
  assert.equal(printed.status, 0);
  assert.deepEqual(JSON.parse(printed.stdout), MAESTRO_RUNNER_PIN);

  const refused = spawnSync('bash', [SCRIPT, '--print-bin'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_TEST_PIN_MANIFEST: manifest,
    },
  });
  assert.notEqual(refused.status, 0);
  assert.throws(() => readFileSync(marker));
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

test('test manifest cannot redefine the production pin version', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-version-override-'));
  const marker = join(cache, 'runner-executed');
  const pinDir = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version, 'bin');
  mkdirSync(pinDir, { recursive: true });
  const bin = join(pinDir, 'maestro-runner');
  writeFileSync(bin, `#!/bin/sh\necho hit > "${marker}"\necho maestro-runner 9.9.9\n`);
  chmodSync(bin, 0o755);
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const manifest = join(cache, 'other-pin.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      version: '9.9.9',
      sha256: {
        'darwin-arm64': sha,
        'darwin-x64': sha,
        'linux-x64': sha,
        'linux-arm64': sha,
      },
      knownQuirks: [],
    }),
  );
  const result = spawnSync('bash', [SCRIPT, '--print-bin'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RN_DEV_AGENT_RUNNER_CACHE: cache,
      RN_DEV_AGENT_TEST_PIN_MANIFEST: manifest,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /not exactly 1\.1\.24/);
  assert.throws(() => readFileSync(marker));
});

test('feedback collection uses package-local pin diagnosis without executing ambient runner', () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'rn-feedback-pin-'));
  const scriptsDir = join(pluginRoot, 'scripts');
  const runtimeDir = join(pluginRoot, 'rn-dev-agent-core', 'dist');
  const home = join(pluginRoot, 'home');
  const ambientDir = join(home, '.maestro-runner', 'bin');
  const diagnoseMarker = join(pluginRoot, 'diagnose-used');
  const ambientMarker = join(pluginRoot, 'ambient-used');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(ambientDir, { recursive: true });
  const collector = join(scriptsDir, 'collect-feedback.sh');
  writeFileSync(collector, readFileSync(COLLECT_FEEDBACK));
  chmodSync(collector, 0o755);
  writeFileSync(
    join(runtimeDir, 'maestro-runner-pin.js'),
    `const { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(diagnoseMarker)}, 'yes');\nconsole.log(JSON.stringify({ status: 'pinned-ok', installedVersion: '1.1.24', pinned: '1.1.24', provenance: 'pin-cache' }));\nprocess.exit(1);\n`,
  );
  writeFileSync(
    join(ambientDir, 'maestro-runner'),
    `#!/bin/sh\necho ambient > "${ambientMarker}"\necho maestro-runner 9.9.9\n`,
  );
  chmodSync(join(ambientDir, 'maestro-runner'), 0o755);

  const result = spawnSync('bash', [collector], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, RN_PROJECT_ROOT: pluginRoot },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(diagnoseMarker, 'utf8'), 'yes');
  assert.throws(() => readFileSync(ambientMarker));
  assert.equal(
    JSON.parse(result.stdout).environment.maestro_runner,
    '1.1.24 (pinned-ok, pin-cache)',
  );
});

test('verify.sh refuses PATH or ~/.maestro-runner and names the supported correction', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-verify-'));
  const flowDir = join(cache, '.rn-agent', 'actions');
  mkdirSync(flowDir, { recursive: true });
  const pathDir = mkdtempSync(join(tmpdir(), 'mr-verify-path-'));
  const marker = join(cache, 'verify-path-hit');
  writeFileSync(
    join(pathDir, 'maestro-runner'),
    `#!/bin/sh\necho PATH_HIT > "${marker}"\necho maestro-runner 9.9.9\n`,
  );
  chmodSync(join(pathDir, 'maestro-runner'), 0o755);
  const result = spawnSync('bash', [VERIFY, '--platform', 'ios', '--flow-dir', flowDir], {
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

test('semantic verifier refuses an unowned flow directory before runner detection', () => {
  const flowDir = mkdtempSync(join(tmpdir(), 'mr-unowned-verify-'));
  writeFileSync(join(flowDir, 'flow.yaml'), '- launchApp\n', 'utf8');
  const entry = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'dist',
    'maestro-runner-pin.js',
  );

  const result = spawnSync(
    process.execPath,
    [entry, 'verify-actions', '--platform', 'ios', '--flow-dir', flowDir],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.match(`${result.stdout}${result.stderr}`, /outside an owned \.rn-agent\/actions corpus/);
});

test('verify.sh delegates replay to the packaged semantic verifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'mr-verify-delegate-'));
  const pathDir = join(root, 'bin');
  const flowDir = join(root, 'flows');
  const marker = join(root, 'node-args');
  mkdirSync(pathDir);
  mkdirSync(flowDir);
  writeFileSync(join(flowDir, 'flow.yaml'), '- launchApp\n');
  writeFileSync(join(pathDir, 'node'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${marker}"\n`);
  chmodSync(join(pathDir, 'node'), 0o755);
  const result = spawnSync('bash', [VERIFY, '--platform', 'ios', '--flow-dir', flowDir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${pathDir}:${process.env.PATH ?? ''}` },
  });
  assert.equal(result.status, 0);
  const args = readFileSync(marker, 'utf8').trim().split('\n');
  assert.match(args[0], /maestro-runner-pin\.js$/);
  assert.deepEqual(args.slice(1, 6), [
    'verify-actions',
    '--platform',
    'ios',
    '--flow-dir',
    flowDir,
  ]);
});

test('tracked bin/rn-verify resolves the pin helper through its symlink', () => {
  const cache = mkdtempSync(join(tmpdir(), 'mr-bin-verify-'));
  const flowDir = join(cache, '.rn-agent', 'actions');
  mkdirSync(flowDir, { recursive: true });
  const result = spawnSync(RN_VERIFY, ['--platform', 'ios', '--flow-dir', flowDir], {
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
