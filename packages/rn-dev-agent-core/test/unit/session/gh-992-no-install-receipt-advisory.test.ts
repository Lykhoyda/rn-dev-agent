// GH #992 reported `rn-session ensure-metro: install receipt generation not
// preserved (no-install-receipt)` as a second defect next to the Metro startup
// failure. It is not: the line is an advisory printed BEFORE Metro starts, on
// the first build of every session (no receipt exists until `complete-build`
// issues one after a successful platform build). These tests pin that the
// advisory is emitted as stderr guidance only, that the command's terminal
// failure is the Metro startup refusal, never the missing receipt, and that a
// malformed `.rn-agent/config.json` readiness budget refuses before either.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import {
  createAuthorityStateLayout,
  writeSessionSecret,
} from '../../../dist/session/state-root.js';
import { readProcessBirth } from '../../../dist/session/process-birth.js';

const cliPath = new URL('../../../dist/rn-session.js', import.meta.url).pathname;
const supervisorBirthToken = readProcessBirth(process.pid)?.token ?? 'fixture';
const ADVISORY =
  /^rn-session ensure-metro: install receipt generation not preserved \(no-install-receipt\); pin_dev_client will refuse until the receipt and Metro generations agree — rebuild to reissue the install receipt$/m;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

// A fresh session on the first managed build: device bound, port allocated, no
// Metro binding and no install receipt yet. `package.json` is neither Expo nor
// bare RN so Metro startup refuses deterministically without spawning anything,
// standing in for the reporter's startup failure.
async function withFirstBuildSession(
  prefix: string,
  run: (fixture: {
    appRoot: string;
    ensureMetro: () => ReturnType<typeof spawnSync<string>>;
  }) => Promise<void> | void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    writeFileSync(join(appRoot, 'package.json'), '{}\n');
    execFileSync('git', ['-C', appRoot, 'add', 'package.json']);
    execFileSync('git', ['-C', appRoot, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    mkdirSync(join(appRoot, '.rn-agent', 'integration'), { recursive: true });
    writeFileSync(
      join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json'),
      '{"version":1}\n',
    );

    process.env.XDG_STATE_HOME = stateHome;
    const source = resolveSourceIdentity(appRoot);
    const layout = createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, {
      ownerStatus: () => 'match',
      listenerStatus: () => 'absent',
    });
    const metroPort = await freePort();
    const session = registry.createSession({
      sessionId: 'session-first-build',
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: process.pid, token: supervisorBirthToken },
      source: { ...source },
      bindings: {
        metroPort,
        device: { platform: 'ios', deviceId: 'SIM-FIRST', appId: 'dev.example' },
      },
    });
    registry.updateBindings(session, { state: 'device_bound', bindings: {} });
    registry.close();
    writeSessionSecret(layout, session.sessionId, {
      signerCapability: 'signer',
      observeCapability: 'observe',
      recoveryCapability: 'recovery',
    });

    await run({
      appRoot,
      ensureMetro: () =>
        spawnSync(process.execPath, [cliPath, 'ensure-metro'], {
          cwd: appRoot,
          env: {
            ...process.env,
            XDG_STATE_HOME: stateHome,
            RN_DEV_AGENT_SESSION_ID: session.sessionId,
          },
          encoding: 'utf8',
        }),
    });
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
}

test('GH #992: no-install-receipt is a pre-start advisory, not an independent failure', async () => {
  await withFirstBuildSession('rn-session-cli-no-receipt-', ({ ensureMetro }) => {
    const result = ensureMetro();

    assert.notEqual(result.status, 0);
    const lines = result.stderr.split('\n').filter(Boolean);
    const advisoryIndex = lines.findIndex((line) => ADVISORY.test(line));
    assert.notEqual(advisoryIndex, -1, `advisory missing from stderr:\n${result.stderr}`);
    // The terminal failure is Metro's, printed after the advisory, and does
    // not name the receipt: the receipt is a consequence of the build never
    // running, not a cause.
    const failureIndex = lines.findIndex((line) => line.startsWith('METRO_START_UNAVAILABLE:'));
    assert.notEqual(failureIndex, -1, `Metro refusal missing from stderr:\n${result.stderr}`);
    assert.ok(advisoryIndex < failureIndex, 'the advisory precedes the Metro refusal');
    assert.doesNotMatch(lines[failureIndex], /install receipt|no-install-receipt/);
    assert.equal(
      lines.filter((line) => /no-install-receipt/.test(line)).length,
      1,
      'the receipt is mentioned once, as guidance',
    );
    assert.equal(result.stdout, '', 'no ensure-metro success record is written');
  });
});

test('GH #992: a malformed metro.readinessTimeoutMs refuses ensure-metro before any marker or advisory', async () => {
  await withFirstBuildSession('rn-session-cli-bad-timeout-', ({ appRoot, ensureMetro }) => {
    writeFileSync(
      join(appRoot, '.rn-agent', 'config.json'),
      '{ "metro": { "readinessTimeoutMs": "90s" } }\n',
    );
    const result = ensureMetro();

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /^METRO_READINESS_TIMEOUT_INVALID: \.rn-agent\/config\.json metro\.readinessTimeoutMs must be an integer between 1000 and 600000 milliseconds \(got "90s"\); fix or remove the key to use the 90000 ms default$/m,
    );
    assert.doesNotMatch(result.stderr, ADVISORY, 'refused before the receipt advisory');
    assert.doesNotMatch(result.stderr, /METRO_START_UNAVAILABLE/, 'Metro was never started');
    assert.equal(
      existsSync(join(appRoot, '.rn-agent', 'integration', 'authority-marker.js')),
      false,
      'no authority marker is written for a refused configuration',
    );
  });
});

test('GH #992: a valid metro.readinessTimeoutMs is accepted and Metro startup proceeds', async () => {
  await withFirstBuildSession('rn-session-cli-good-timeout-', ({ appRoot, ensureMetro }) => {
    writeFileSync(
      join(appRoot, '.rn-agent', 'config.json'),
      '{ "metro": { "readinessTimeoutMs": 120000 } }\n',
    );
    const result = ensureMetro();

    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /METRO_READINESS_TIMEOUT_INVALID/);
    assert.match(result.stderr, ADVISORY);
    assert.match(result.stderr, /^METRO_START_UNAVAILABLE:/m);
  });
});

test('GH #992: resolve-metro-readiness reports the derived adapter timeout without a session', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-resolve-timeout-'));
  try {
    writeFileSync(join(root, 'package.json'), '{}\n');
    const absent = spawnSync(process.execPath, [cliPath, 'resolve-metro-readiness'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(absent.status, 0, absent.stderr);
    assert.deepEqual(JSON.parse(absent.stdout), {
      readinessTimeoutMs: 90_000,
      source: 'default',
      ensureMetroCliTimeoutMs: 120_000,
    });

    mkdirSync(join(root, '.rn-agent'), { recursive: true });
    writeFileSync(
      join(root, '.rn-agent', 'config.json'),
      '{ "metro": { "readinessTimeoutMs": 150000 } }\n',
    );
    const configured = spawnSync(process.execPath, [cliPath, 'resolve-metro-readiness'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(configured.status, 0, configured.stderr);
    assert.deepEqual(JSON.parse(configured.stdout), {
      readinessTimeoutMs: 150_000,
      source: 'config',
      ensureMetroCliTimeoutMs: 175_000,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
