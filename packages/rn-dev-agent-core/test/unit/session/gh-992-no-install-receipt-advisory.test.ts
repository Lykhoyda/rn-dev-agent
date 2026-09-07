// GH #992 reported `rn-session ensure-metro: install receipt generation not
// preserved (no-install-receipt)` as a second defect next to the Metro startup
// failure. It is not: the line is an advisory printed BEFORE Metro starts, on
// the first build of every session (no receipt exists until `complete-build`
// issues one after a successful platform build). This test pins that the
// advisory is emitted as stderr guidance only and that the command's terminal
// failure is the Metro startup refusal, never the missing receipt.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('GH #992: no-install-receipt is a pre-start advisory, not an independent failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-session-cli-no-receipt-'));
  const appRoot = join(root, 'app');
  const stateHome = join(root, 'state');
  const previousStateHome = process.env.XDG_STATE_HOME;
  try {
    execFileSync('git', ['init', '-q', appRoot]);
    execFileSync('git', ['-C', appRoot, 'config', 'user.email', 'test@example.invalid']);
    execFileSync('git', ['-C', appRoot, 'config', 'user.name', 'Test']);
    // Neither Expo nor bare RN: Metro startup refuses deterministically without
    // spawning anything, which stands in for the reporter's startup failure.
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
    // A fresh session: device bound, port allocated, no Metro and no install
    // receipt yet — exactly the state of the first managed build.
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

    const result = spawnSync(process.execPath, [cliPath, 'ensure-metro'], {
      cwd: appRoot,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        RN_DEV_AGENT_SESSION_ID: session.sessionId,
      },
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0);
    const lines = result.stderr.split('\n').filter(Boolean);
    const advisoryIndex = lines.findIndex((line) =>
      /^rn-session ensure-metro: install receipt generation not preserved \(no-install-receipt\); pin_dev_client will refuse until the receipt and Metro generations agree — rebuild to reissue the install receipt$/.test(
        line,
      ),
    );
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
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    rmSync(root, { force: true, recursive: true });
  }
});
