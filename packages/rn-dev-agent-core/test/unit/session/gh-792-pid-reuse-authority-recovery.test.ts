// GH #792: an ungracefully dead owner whose recorded pid the OS has recycled into an
// unrelated process must stay recoverable. A birth token is only ever recorded for a
// process this user could read, so a pid the kernel refuses to let us inspect or
// signal is positively NOT the recorded owner — that is disproof, not uncertainty.
// Strict refusal still stands for a proven-live owner and for an identity that is
// genuinely unreadable.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { probeProcessBirth } from '../../../dist/session/process-birth.js';
import { inspectSessionOwner } from '../../../dist/session/process-owner.js';
import { stopBoundObserve, stopBoundRunner } from '../../../dist/session/process-cleanup.js';
import { HEADLESS_SESSION_RECOVERY_COMMAND } from '../../../dist/session/recovery-remedy.js';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { runStartupOwnerCleanup } from '../../../dist/session/startup-cleanup.js';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';
import { createAuthorityStateLayout } from '../../../dist/session/state-root.js';

const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
const OWNER = { sessionId: 'owner', pid: 4242, token: 'birth-owner' };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryStateHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'rn-gh-792-'));
  roots.push(root);
  return root;
}

const present = (token: string) =>
  ({ status: 'present', birth: { pid: OWNER.pid, source: 'linux-proc', token } }) as const;

test('GH #792: the smallest counterfactual pair — same pid, birth match versus birth mismatch', () => {
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'alive',
      probeBirth: () => present('birth-owner'),
    }),
    'match',
  );
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'alive',
      probeBirth: () => present('birth-of-the-recycling-process'),
    }),
    'mismatch',
  );
});

test('GH #792: a pid this user cannot inspect is disproof, while an unreadable identity stays unknown', () => {
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'absent', reason: 'foreign' }),
    }),
    'mismatch',
  );
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'absent' }),
    }),
    'mismatch',
  );
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'unknown',
  );
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'unknown',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'unknown',
  );
  assert.equal(
    inspectSessionOwner(OWNER, {
      processState: () => 'dead',
      probeBirth: () => ({ status: 'unknown' }),
    }),
    'mismatch',
  );
});

test('GH #792: probeProcessBirth reports a signal-denied pid as absent, never as unknown', () => {
  const unreadable = { run: () => '', platform: 'aix' as NodeJS.Platform };
  assert.deepEqual(
    probeProcessBirth(OWNER.pid, { ...unreadable, signalPermission: () => 'denied' }),
    {
      status: 'absent',
      reason: 'foreign',
    },
  );
  assert.deepEqual(
    probeProcessBirth(OWNER.pid, { ...unreadable, signalPermission: () => 'permitted' }),
    { status: 'unknown' },
  );
  // ESRCH stays `unknown` here: every platform branch already reports a missing process as
  // absent from its own read, and `inspectSessionOwner` proves that case via `kill(pid, 0)`
  // before it ever probes. Widening it would break the fail-closed contract that an
  // unavailable identity path answers `unknown`.
  assert.deepEqual(
    probeProcessBirth(OWNER.pid, { ...unreadable, signalPermission: () => 'absent' }),
    { status: 'unknown' },
  );
  assert.deepEqual(
    probeProcessBirth(OWNER.pid, { ...unreadable, signalPermission: () => 'unknown' }),
    { status: 'unknown' },
  );
});

test('GH #792: EPERM is never disproof on Windows, and never consulted for an invalid pid', () => {
  // `uv_kill` opens the target for PROCESS_TERMINATE even for signal 0, so integrity-level
  // isolation denies a LIVE same-user elevated process — and the state root cannot be
  // uid-pinned there, so "recorded owners are same-user" is unenforced. Releasing on EPERM
  // would steal a live owner's authority.
  const onWindows = (permission: 'denied' | 'absent') =>
    probeProcessBirth(OWNER.pid, {
      platform: 'win32',
      run: () => '',
      executableDependencies: { exists: () => false },
      signalPermission: () => permission,
    });
  assert.deepEqual(onWindows('denied'), { status: 'unknown' });
  // A non-pid must never reach `process.kill`, where 0 and negatives address process groups.
  const consulted: number[] = [];
  for (const pid of [0, -4242, 1.5]) {
    assert.deepEqual(
      probeProcessBirth(pid, {
        platform: 'linux',
        read: () => {
          throw new Error('unreadable');
        },
        signalPermission: (value: number) => {
          consulted.push(value);
          return 'denied';
        },
      }),
      { status: 'unknown' },
    );
  }
  assert.deepEqual(consulted, []);
});

test('GH #792: a real recycled pid is disproved against real processes, without signalling them', () => {
  // A controlled long-lived child stands in for the recycled pid deterministically: it is
  // a real same-user process at a real pid, carrying a birth identity that is not the one
  // the store recorded. This is the same-user half of the reuse case and needs no
  // assumption about any other process on the host.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    stdio: 'ignore',
  });
  try {
    assert.ok(child.pid);
    const probe = probeProcessBirth(child.pid);
    const owner = (token: string) =>
      inspectSessionOwner({ sessionId: 'owner', pid: child.pid as number, token });
    if (probe.status === 'present') {
      assert.equal(owner('a-prior-owners-birth'), 'mismatch');
      assert.equal(owner(probe.birth.token), 'match');
    } else {
      // A loaded host can time out the identity read. `unknown` is the only acceptable
      // answer then — never a `mismatch` inferred from something weaker than proof.
      assert.equal(probe.status, 'unknown');
      assert.equal(owner('a-prior-owners-birth'), 'unknown');
    }
  } finally {
    child.kill('SIGKILL');
  }

  // pid 1 is the other half: a real process this user cannot inspect. It exists on every
  // supported host, is only ever read, and is never signalled here.
  assert.equal(
    inspectSessionOwner({ sessionId: 'owner', pid: 1, token: 'not-this-owner' }),
    'mismatch',
  );
  // This process is never foreign to itself. Its identity read can still time out on a
  // loaded host, and `unknown` is the conservative answer there — but `absent` never is.
  const self = probeProcessBirth(process.pid);
  assert.notEqual(self.status, 'absent');
  if (self.status !== 'present') return;
  assert.equal(
    inspectSessionOwner({ sessionId: 'owner', pid: process.pid, token: self.birth.token }),
    'match',
  );
  assert.equal(
    inspectSessionOwner({ sessionId: 'owner', pid: process.pid, token: 'a-prior-birth' }),
    'mismatch',
  );
});

function wedgedFixture(ownerStatus: (owner: { sessionId: string }) => string) {
  const root = temporaryStateHome();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    ownerStatus,
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const dead = registry.createSession({
    sessionId: 'dead-owner',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4242, token: 'birth-owner' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(dead, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8300' },
  ]);
  registry.updateBindings(dead, { state: 'source_bound', bindings: { metroPort: 8300 } });
  return {
    registry,
    input: {
      registry,
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey: '.',
      appRoot: join(root, 'app'),
    },
  };
}

test('GH #792: startup cleanup releases an owner whose pid was recycled into a foreign process', async () => {
  const foreignOccupant = (owner: { sessionId: string; pid: number; token: string }) =>
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'absent', reason: 'foreign' }),
    });
  const fixture = wedgedFixture(foreignOccupant as never);
  const outcome = await runStartupOwnerCleanup(fixture.input);
  assert.equal(outcome.status, 'clean');
  assert.deepEqual(outcome.released, ['dead-owner']);
  assert.equal(fixture.registry.findStartupCleanupCandidate(fixture.input), null);
  fixture.registry.close();
});

test('GH #792: a proven-live owner is never released and a genuinely unreadable one still refuses', async () => {
  const live = wedgedFixture(((owner: { sessionId: string; pid: number; token: string }) =>
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => present(owner.token),
    })) as never);
  const liveOutcome = await runStartupOwnerCleanup(live.input);
  assert.equal(liveOutcome.status, 'refused');
  assert.equal(liveOutcome.refusal?.code, 'RESOURCE_CLAIM_CONFLICT');
  assert.deepEqual(liveOutcome.released, []);
  assert.notEqual(live.registry.findStartupCleanupCandidate(live.input), null);
  live.registry.close();

  const unreadable = wedgedFixture(((owner: { sessionId: string; pid: number; token: string }) =>
    inspectSessionOwner(owner, {
      processState: () => 'alive',
      probeBirth: () => ({ status: 'unknown' }),
    })) as never);
  const unreadableOutcome = await runStartupOwnerCleanup(unreadable.input);
  assert.equal(unreadableOutcome.status, 'refused');
  assert.deepEqual(unreadableOutcome.released, []);
  assert.notEqual(unreadable.registry.findStartupCleanupCandidate(unreadable.input), null);
  unreadable.registry.close();
});

const runnerBinding = (platform: 'ios' | 'android') => ({
  pid: 4242,
  processBirth: 'birth-runner',
  platform,
  deviceId: platform === 'ios' ? 'sim-1' : 'emulator-5554',
  port: 9200,
  instanceId: 'runner-instance-1',
  capability: 'runner-capability',
});

const foreignProbe = () => ({ status: 'absent', reason: 'foreign' }) as const;
const recycledProbe = () =>
  ({
    status: 'present',
    birth: { pid: 4242, source: 'linux-proc', token: 'birth-of-the-recycling-process' },
  }) as const;

test('GH #792: runner cleanup no longer wedges on a recycled runner pid, and signals nothing', async () => {
  for (const probe of [foreignProbe, recycledProbe]) {
    const signalled: number[] = [];
    await stopBoundRunner(runnerBinding('ios'), probe, (pid: number) => {
      signalled.push(pid);
    });
    assert.deepEqual(signalled, [], 'a pid that is not ours is never signalled');
  }
  await assert.rejects(
    stopBoundRunner(
      runnerBinding('ios'),
      () => ({ status: 'unknown' }),
      () => {},
    ),
    /RUNNER_ADOPTION_REQUIRED/,
  );
});

test('GH #792: a recycled Android runner pid still gets its device-side cleanup, unsignalled', async () => {
  // The host process being gone is exactly when orphaned instrumentation is most likely
  // to survive on the device, so the adb leg must still run. It is fenced upstream by
  // `verifyStartupOwnerObligation`, which re-proves the dead owner still holds this exact
  // runner claim before any of this executes.
  for (const probe of [foreignProbe, recycledProbe]) {
    const signalled: number[] = [];
    const adb: string[][] = [];
    await stopBoundRunner(
      runnerBinding('android'),
      probe,
      (pid: number) => {
        signalled.push(pid);
      },
      2_000,
      async (args: string[]) => {
        adb.push(args);
        return { stdout: '', stderr: '' };
      },
    );
    assert.deepEqual(signalled, [], 'a pid that is not ours is never signalled');
    assert.ok(
      adb.some((args) => args.includes('force-stop')),
      'device-side runner termination still runs',
    );
    assert.ok(
      adb.every((args) => args[0] === '-s' && args[1] === 'emulator-5554'),
      'every adb call is pinned to the exact recorded serial',
    );
  }
});

test('GH #792: observe cleanup completes on a recycled observe pid without contacting it', async () => {
  const binding = {
    port: 7400,
    pid: 4242,
    processBirth: 'birth-observe',
    instanceId: 'instance-1',
    cleanupCapability: 'capability',
  };
  for (const probe of [foreignProbe, recycledProbe]) {
    let requests = 0;
    await stopBoundObserve(
      binding,
      () => ({ status: 'listening', pid: 4242 }),
      probe,
      2_000,
      (async () => {
        requests += 1;
        return new Response(null, { status: 200 });
      }) as never,
    );
    assert.equal(requests, 0, 'no stop request is sent to a stranger holding the port');
  }
  // An identity that vanished while the listener still reports our pid is a genuine
  // inconsistency, not a recycled pid, and still refuses.
  await assert.rejects(
    stopBoundObserve(
      binding,
      () => ({ status: 'listening', pid: 4242 }),
      () => ({ status: 'absent' }),
      2_000,
      (async () => new Response(null, { status: 200 })) as never,
    ),
    /OBSERVE_AUTHORITY_MISMATCH/,
  );
});

test('GH #792: an abandoned blocked contender leaves no record that wedges the next attempt', async () => {
  const proven = new Map<string, string>([
    ['dead-owner', 'mismatch'],
    ['dead-contender', 'mismatch'],
    ['live-contender', 'match'],
  ]);
  const root = temporaryStateHome();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    ownerStatus: (owner: { sessionId: string }) => proven.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const owner = registry.createSession({
    sessionId: 'dead-owner',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4242, token: 'birth-owner' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
  for (const sessionId of ['dead-contender', 'live-contender']) {
    const contender = registry.createSession({
      sessionId,
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey: '.',
      supervisor: { pid: 4343, token: `birth-${sessionId}` },
      source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
      bindings: {},
    });
    registry.updateBindings(contender, {
      state: 'blocked',
      bindings: { adoptionRequired: { sessionId: 'dead-owner', claimEpoch: owner.claimEpoch } },
    });
  }
  const outcome = await runStartupOwnerCleanup({
    registry,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    appRoot: join(root, 'app'),
  });
  assert.equal(outcome.status, 'clean');
  assert.deepEqual(outcome.discardedContenders, ['dead-contender']);
  assert.equal(registry.getSessionStatus('dead-contender')?.state, 'released');
  assert.equal(registry.getSessionStatus('live-contender')?.state, 'blocked');

  // The invariant is about the NEXT attempt, so admit one and prove it is unobstructed.
  proven.set('next-attempt', 'match');
  const next = registry.createSession({
    sessionId: 'next-attempt',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4444, token: 'birth-next-attempt' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(next, [{ type: 'source', key: 'worktree-1' }]);
  registry.updateBindings(next, { state: 'source_bound', bindings: {} });
  assert.equal(
    registry.inspectRecoveryRequirement('next-attempt').requirement,
    'none',
    'the next attempt owns the worktree outright',
  );
  const live = registry.findSessionsByWorktree('worktree-1').map((status) => status.sessionId);
  assert.ok(live.includes('next-attempt'));
  assert.ok(
    !live.includes('dead-contender'),
    'a discarded contender never becomes a later prior owner',
  );
  registry.close();
});

test('GH #792: the headless recovery path releases a wedged root from a real command', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-792-fixture"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const run = (command: string) => {
    const stdout = execFileSync(
      process.execPath,
      [join(distRoot, 'session-doctor.js'), command, '--json'],
      { cwd: appRoot, encoding: 'utf8', env: environment },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  };

  const clean = run('report');
  assert.equal(clean.wedged, false);
  assert.equal(clean.sameRootOwner, 'absent');
  assert.match(String(clean.authorityStore), /registry\.sqlite3$/);

  // Seed the exact reported wedge: an owner whose recorded pid now hosts an unrelated
  // process this user cannot inspect. pid 1 is read-only evidence and is never signalled.
  const source = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const owner = registry.createSession({
    sessionId: 'recycled-pid-owner',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: 1, token: 'birth-of-the-dead-owner' },
    source: { ...source, model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: source.worktreeKey }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  registry.close();

  const stale = run('report');
  assert.equal(stale.sameRootOwner, 'stale');
  assert.equal(stale.ownerIsThisRoot, true);
  assert.match(String(stale.remedy), /session-doctor\.js" repair/);

  const repaired = run('repair');
  assert.equal(repaired.status, 'clean');
  assert.deepEqual(repaired.released, ['recycled-pid-owner']);
  assert.equal(run('report').sameRootOwner, 'absent');
});

test('GH #801: session-doctor reports unrecoverable cleanup without a repair remedy', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-801-fixture"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const source = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const owner = registry.createSession({
    sessionId: 'missing-metro-proof-owner',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: source.appRootKey,
    supervisor: { pid: 1, token: 'birth-of-the-dead-owner' },
    source: { ...source, model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: source.worktreeKey }]);
  registry.updateBindings(owner, {
    state: 'source_bound',
    bindings: { metro: { mode: 'managed', port: 8300 } },
  });
  registry.beginStartupOwnerCleanup(owner);
  const nextAction =
    'Managed Metro stop proof is unavailable; preserve this authority state and report METRO_CLEANUP_PENDING.';
  registry.recordStartupCleanupRefusal(owner, {
    code: 'METRO_CLEANUP_PENDING',
    reason: 'managed Metro could not be stopped with exact process authority',
    cause: 'managed-metro-stop-proof-missing',
    nextAction,
  });
  registry.close();

  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [join(distRoot, 'session-doctor.js'), 'report', '--json'],
      { cwd: appRoot, encoding: 'utf8', env: environment },
    );
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout);
  }
  const report = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(report.wedged, true);
  assert.equal(report.repairable, false);
  assert.equal(report.remedy, nextAction);
  assert.equal(
    (report.startupCleanupBlocked as { cause?: string }).cause,
    'managed-metro-stop-proof-missing',
  );
  assert.doesNotMatch(String(report.remedy), /session-doctor\.js" repair|\/mcp|reconnect/i);
});

test('GH #792: every recovery remedy names an executable path for interactive and headless clients', () => {
  const owners = new Map<string, string>();
  const root = temporaryStateHome();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    ownerStatus: (owner: { sessionId: string }) => owners.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const session = (sessionId: string, appRootKey = '.') =>
    registry.createSession({
      sessionId,
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey,
      supervisor: { pid: 4242, token: `birth-${sessionId}` },
      source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
      bindings: {},
    });
  const owner = session('owner');
  registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
  const contender = session('contender');
  registry.updateBindings(contender, {
    state: 'blocked',
    bindings: { adoptionRequired: { sessionId: 'owner', claimEpoch: owner.claimEpoch } },
  });

  const remedy = (status: string): string => {
    owners.set('owner', status);
    return registry.inspectRecoveryRequirement('contender').nextAction;
  };
  const provenDead = remedy('mismatch');
  const live = remedy('match');
  const unprovable = remedy('unknown');
  const orphan = session('orphan-contender');
  registry.updateBindings(orphan, {
    state: 'blocked',
    bindings: { adoptionRequired: { sessionId: 'owner', claimEpoch: owner.claimEpoch + 99 } },
  });
  const claimGone = registry.inspectRecoveryRequirement('orphan-contender').nextAction;
  registry.close();

  // Where recovery is automatic, the remedy must hand over the command that performs it.
  for (const [label, text] of [
    ['proven dead', provenDead],
    ['claim epoch gone', claimGone],
  ] as const) {
    assert.match(text, /session-doctor\.js" repair/, label);
    assert.match(text, /\/mcp/, `${label} must still name the interactive path`);
  }
  // Where it is not, the remedy must say how to identify the holder before repairing —
  // never "restart and hope".
  for (const [label, text] of [
    ['live owner', live],
    ['unprovable owner', unprovable],
  ] as const) {
    assert.match(text, /session-doctor\.js" report/, label);
    assert.match(text, /session-doctor\.js" repair/, label);
    assert.match(text, /never force-released/, label);
  }
  for (const text of [provenDead, claimGone, live, unprovable]) {
    assert.match(text, /session-authority/, 'every remedy carries its docs anchor');
    assert.doesNotMatch(
      text,
      /^[^`]*\/mcp[^.]*\.$/,
      `a remedy must never be restart-only: ${text}`,
    );
  }
});

test('GH #792: repair never reports success while this root stays wedged by another app root', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-792-cross-root"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const run = (command: string) => {
    try {
      return {
        code: 0,
        payload: JSON.parse(
          execFileSync(process.execPath, [join(distRoot, 'session-doctor.js'), command, '--json'], {
            cwd: appRoot,
            encoding: 'utf8',
            env: environment,
          }),
        ) as Record<string, unknown>,
      };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return {
        code: failure.status ?? 1,
        payload: JSON.parse(String(failure.stdout)) as Record<string, unknown>,
      };
    }
  };

  const source = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const ownerAppRoot = join(appRoot, 'packages', 'other-app');
  const owner = registry.createSession({
    sessionId: 'other-app-root-owner',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: 'packages/other-app',
    supervisor: { pid: 1, token: 'birth-of-the-dead-owner' },
    source: {
      ...source,
      appRoot: ownerAppRoot,
      appRootKey: 'packages/other-app',
      model: 'grouped-v1',
    },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: source.worktreeKey }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  registry.close();

  const before = run('report');
  assert.equal(before.payload.wedged, true);
  assert.equal(before.payload.ownerIsThisRoot, false);
  assert.equal(before.code, 1);

  // The remedy is only executable if the payload says which root can run it.
  assert.equal(before.payload.ownerAppRoot, ownerAppRoot);
  assert.equal(before.payload.ownerSession, 'other-app-ro');
  assert.notEqual(before.payload.ownerAppRoot, before.payload.appRoot);

  const repaired = run('repair');
  assert.deepEqual(repaired.payload.released, []);
  assert.equal(repaired.payload.wedged, true, 'a no-op cleanup must not read as recovered');
  assert.equal(repaired.code, 1);
  assert.match(String(repaired.payload.remedy), /different app root/);
  assert.equal(repaired.payload.ownerAppRoot, ownerAppRoot);
  // Repair from here just failed, so the remedy must send the reader to the root that can
  // succeed — never back to closing an owner this branch already proved dead.
  assert.match(String(repaired.payload.remedy), /from that app root/);
  assert.doesNotMatch(String(repaired.payload.remedy), /close that session/);
  assert.equal(run('report').payload.wedged, true);
});

test('GH #792: report names the holder it tells the reader to act on, and never a pid', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-792-holder"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const source = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const self = probeProcessBirth(process.pid);
  const seedLiveOwner = (sessionId: string) => {
    const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
    const owner = registry.createSession({
      sessionId,
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      // A real live owner: this test process, read only and never signalled.
      supervisor: {
        pid: process.pid,
        token: self.status === 'present' ? self.birth.token : 'unreadable-identity',
      },
      source: { ...source, model: 'grouped-v1' },
      bindings: {},
    });
    registry.claimResources(owner, [{ type: 'source', key: source.worktreeKey }]);
    registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
    registry.close();
    return owner;
  };
  const report = () => {
    let stdout = '';
    try {
      stdout = execFileSync(
        process.execPath,
        [join(distRoot, 'session-doctor.js'), 'report', '--json'],
        { cwd: appRoot, encoding: 'utf8', env: environment },
      );
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout);
    }
    return JSON.parse(stdout) as Record<string, unknown>;
  };

  const empty = report();
  assert.equal(empty.sameRootOwner, 'absent');
  assert.equal(empty.ownerSession, undefined, 'no owner means no holder to name');

  const first = seedLiveOwner('holder-alpha-0001');
  const held = report();
  assert.ok(['live', 'unprovable'].includes(String(held.sameRootOwner)));
  assert.equal(held.ownerSession, 'holder-alpha');
  assert.equal(held.ownerAppRoot, source.appRoot);
  // The remedy tells the reader to close that session, so the payload must discriminate it.
  assert.match(String(held.remedy), /names the owning app root and session/);
  // A truncated session id identifies the holder; a pid never travels in this payload.
  assert.doesNotMatch(JSON.stringify(held), new RegExp(`\\b${process.pid}\\b`));
  assert.equal(
    Object.keys(held).some((key) => /pid/i.test(key)),
    false,
    JSON.stringify(Object.keys(held)),
  );

  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  registry.releaseSession(first);
  registry.close();
  seedLiveOwner('holder-bravo-0002');
  const second = report();
  assert.equal(second.ownerSession, 'holder-bravo');
  assert.notEqual(second.ownerSession, held.ownerSession);
});

test('GH #792: the headless remedy command resolves under every host that ships the core', () => {
  const root = temporaryStateHome();
  const packaged = (host: string) => {
    const pluginRoot = join(root, host);
    mkdirSync(join(pluginRoot, 'rn-dev-agent-core', 'dist'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rn-dev-agent-core', 'dist', 'session-doctor.js'),
      `process.stdout.write(${JSON.stringify(host)});\n`,
    );
    return pluginRoot;
  };
  const claude = packaged('claude');
  const codex = packaged('codex');
  // Run the remedy exactly as an agent would: through a shell, with only the variables
  // that host actually exports.
  const run = (exported: Record<string, string>) => {
    const environment: Record<string, string | undefined> = { ...process.env, ...exported };
    for (const key of [
      'CLAUDE_PLUGIN_ROOT',
      'RN_DEV_AGENT_CODEX_PLUGIN_ROOT',
      'CODEX_PLUGIN_ROOT',
    ]) {
      if (!(key in exported)) delete environment[key];
    }
    return execFileSync('/bin/sh', ['-c', HEADLESS_SESSION_RECOVERY_COMMAND], {
      encoding: 'utf8',
      env: environment,
    });
  };
  assert.equal(run({ CLAUDE_PLUGIN_ROOT: claude }), 'claude');
  // The Codex launcher only ever exports RN_DEV_AGENT_CODEX_PLUGIN_ROOT
  // (packages/codex-plugin/bin/cdp-supervisor.js), so the remedy must resolve from it.
  assert.equal(run({ RN_DEV_AGENT_CODEX_PLUGIN_ROOT: codex }), 'codex');
  assert.equal(run({ CODEX_PLUGIN_ROOT: codex }), 'codex');
  assert.equal(
    run({ CLAUDE_PLUGIN_ROOT: claude, RN_DEV_AGENT_CODEX_PLUGIN_ROOT: codex }),
    'claude',
  );

  // Read outside any host process — a human copying the remedy out of supervisor stderr —
  // the command must name what is missing instead of failing on a path that exists nowhere.
  const bareEnvironment: Record<string, string | undefined> = { ...process.env };
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'RN_DEV_AGENT_CODEX_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT']) {
    delete bareEnvironment[key];
  }
  const bare = spawnSync('/bin/sh', ['-c', HEADLESS_SESSION_RECOVERY_COMMAND], {
    encoding: 'utf8',
    env: bareEnvironment,
  });
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /CODEX_PLUGIN_ROOT: set it to the installed rn-dev-agent plugin root/);
  assert.doesNotMatch(
    bare.stderr,
    /Cannot find module/,
    `an unresolved plugin root must not read as a missing file: ${bare.stderr}`,
  );
});

test('GH #792: session-doctor refuses a mistyped explicit state home instead of inventing one', () => {
  const root = temporaryStateHome();
  const appRoot = join(root, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-792-state-home"}');
  const mistyped = join(root, 'authority-home-typo');
  for (const command of ['report', 'repair']) {
    const result = spawnSync(
      process.execPath,
      [join(distRoot, 'session-doctor.js'), command, '--json'],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          RN_DEV_AGENT_STATE_DIR: mistyped,
          RN_DEV_AGENT_DECLARED_ROOT: appRoot,
          RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
        },
      },
    );
    assert.notEqual(result.status, 0, command);
    assert.match(
      result.stderr,
      /^AUTHORITY_STATE_HOME_UNKNOWN: requested state home has no authority registry/,
      command,
    );
    assert.equal(result.stdout, '', `${command} must not answer from a store it never opened`);
    assert.equal(existsSync(mistyped), false, `${command} must not create the requested home`);
    assert.doesNotMatch(
      result.stderr,
      /session-doctor\.js" repair/,
      'repairing cannot fix an unusable state home, so the remedy must not loop back to it',
    );
  }
});

function deadOwnerWithRunnerObligation() {
  const root = temporaryStateHome();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    ownerStatus: (owner: { sessionId: string }) =>
      owner.sessionId === 'dead-owner' ? 'mismatch' : 'match',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const dead = registry.createSession({
    sessionId: 'dead-owner',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4242, token: 'birth-owner' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(dead, [
    { type: 'source', key: 'worktree-1' },
    { type: 'device', key: 'ios:sim-1' },
    { type: 'runner', key: 'ios:sim-1:9200' },
  ]);
  registry.updateBindings(dead, {
    state: 'device_claimed',
    bindings: {
      device: { platform: 'ios', deviceId: 'sim-1', appId: 'com.example.app' },
      runner: {
        platform: 'ios',
        deviceId: 'sim-1',
        port: 9200,
        capability: 'runner-capability',
        instanceId: 'runner-instance',
        processBirth: 'runner-birth',
        pid: 9911,
      },
    },
  });
  return {
    registry,
    input: {
      registry,
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey: '.',
      appRoot: join(root, 'app'),
    },
  };
}

test('GH #792: an unmet obligation on a proven-dead owner never tells the agent to close it', async () => {
  const fixture = deadOwnerWithRunnerObligation();
  const outcome = await runStartupOwnerCleanup(fixture.input, {
    stopBoundRunner: async () => {
      throw Object.assign(new Error('RUNNER_ADOPTION_REQUIRED: runner identity is unavailable'), {
        code: 'RUNNER_ADOPTION_REQUIRED',
      });
    },
  });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'RUNNER_ADOPTION_REQUIRED');
  const remedy = String(outcome.refusal?.nextAction);
  // The owner is already proven dead here, so "close that session" is unactionable advice.
  assert.doesNotMatch(remedy, /close that session/, remedy);
  assert.match(remedy, /RUNNER_ADOPTION_REQUIRED/, 'the remedy must name the unmet obligation');
  assert.match(remedy, /session-doctor\.js" report/);
  assert.match(remedy, /session-doctor\.js" repair/);

  // The same wedge as the blocked contender sees it.
  const contender = fixture.registry.createSession({
    sessionId: 'contender',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4343, token: 'birth-contender' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  fixture.registry.updateBindings(contender, {
    state: 'blocked',
    bindings: {
      adoptionRequired: { sessionId: 'dead-owner', claimEpoch: 1 },
    },
  });
  const requirement = fixture.registry.inspectRecoveryRequirement('contender');
  assert.equal(requirement.priorOwner, 'stale');
  assert.equal(requirement.startupCleanupBlocked?.code, 'RUNNER_ADOPTION_REQUIRED');
  assert.doesNotMatch(String(requirement.nextAction), /close that session/);
  assert.match(String(requirement.nextAction), /session-doctor\.js" repair/);
  fixture.registry.close();
});

test('GH #792: a live or unprovable owner still gets the close-the-holder remedy', async () => {
  for (const status of ['match', 'unknown'] as const) {
    const root = temporaryStateHome();
    const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
      ownerStatus: () => status,
      listenerStatus: () => 'absent',
      leaseMs: 30_000,
    });
    const owner = registry.createSession({
      sessionId: 'owner',
      sourceKey: 'repo',
      worktreeKey: 'worktree-1',
      appRootKey: '.',
      supervisor: { pid: 4242, token: 'birth-owner' },
      source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
      bindings: {},
    });
    registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
    registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
    const outcome = await runStartupOwnerCleanup(
      {
        registry,
        sourceKey: 'repo',
        worktreeKey: 'worktree-1',
        appRootKey: '.',
        appRoot: join(root, 'app'),
      },
      {},
    );
    assert.equal(outcome.status, 'refused', status);
    assert.match(String(outcome.refusal?.nextAction), /close that session/, status);
    registry.close();
  }
});

test('GH #792: a live-owner repair reaps abandoned contenders and still refuses the owner', async () => {
  const proven = new Map<string, string>([
    ['live-owner', 'match'],
    ['dead-contender', 'mismatch'],
  ]);
  const root = temporaryStateHome();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    ownerStatus: (owner: { sessionId: string }) => proven.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const owner = registry.createSession({
    sessionId: 'live-owner',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4242, token: 'birth-owner' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  const contender = registry.createSession({
    sessionId: 'dead-contender',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4343, token: 'birth-contender' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.updateBindings(contender, {
    state: 'blocked',
    bindings: { adoptionRequired: { sessionId: 'live-owner', claimEpoch: owner.claimEpoch } },
  });

  const outcome = await runStartupOwnerCleanup({
    registry,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    appRoot: join(root, 'app'),
  });
  assert.equal(outcome.status, 'refused');
  assert.deepEqual(outcome.released, [], 'a live owner is never released');
  assert.equal(registry.getClaim('source', 'worktree-1')?.sessionId, 'live-owner');
  // What the docs promise about running repair against a live session: the owner survives,
  // but abandoned claim-less contender rows are still reaped.
  assert.deepEqual(outcome.discardedContenders, ['dead-contender']);
  assert.equal(registry.getSessionStatus('dead-contender')?.state, 'released');
  assert.match(String(outcome.refusal?.nextAction), /close that session/);
  registry.close();
});

test('GH #792: an expired lease with an unprovable owner keeps the close-the-holder remedy', async () => {
  const root = temporaryStateHome();
  let clock = 1_000_000;
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    now: () => clock,
    ownerStatus: () => 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  const owner = registry.createSession({
    sessionId: 'unprovable-owner',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4242, token: 'birth-owner' },
    source: { kind: 'git', contentRoot: '/src/worktree-1', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: 'worktree-1' }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  clock += 3_600_000;

  const outcome = await runStartupOwnerCleanup({
    registry,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    appRoot: join(root, 'app'),
  });
  assert.equal(outcome.status, 'refused');
  assert.equal(outcome.refusal?.code, 'STALE_LEASE_NOT_RECLAIMABLE');
  assert.deepEqual(outcome.released, [], 'lease expiry is never authority to release');
  assert.match(String(outcome.refusal?.nextAction), /close that session/);
  assert.doesNotMatch(String(outcome.refusal?.nextAction), /outstanding obligation/);
  registry.close();
});

test('GH #792: a cross-root owner is never described as same-root in the same report', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  writeFileSync(join(appRoot, 'package.json'), '{"name":"gh-792-live-cross-root"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const source = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  // This test process is a real, provably live owner; it is only ever read, never signalled.
  const self = probeProcessBirth(process.pid);
  const owner = registry.createSession({
    sessionId: 'other-app-root-live-owner',
    sourceKey: source.sourceKey,
    worktreeKey: source.worktreeKey,
    appRootKey: 'packages/other-app',
    supervisor: {
      pid: process.pid,
      token: self.status === 'present' ? self.birth.token : 'unreadable-identity',
    },
    source: { ...source, appRootKey: 'packages/other-app', model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: source.worktreeKey }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  registry.close();

  let stdout = '';
  try {
    stdout = execFileSync(
      process.execPath,
      [join(distRoot, 'session-doctor.js'), 'report', '--json'],
      { cwd: appRoot, encoding: 'utf8', env: environment },
    );
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout);
  }
  const payload = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(payload.ownerIsThisRoot, false);
  assert.notEqual(payload.sameRootOwner, 'absent');
  assert.doesNotMatch(
    String(payload.remedy),
    /same-root/,
    `a remedy must not claim same-root while ownerIsThisRoot is false: ${String(payload.remedy)}`,
  );
  assert.match(String(payload.remedy), /different app root or declared source/);
});

test('GH #792: declared-manifest drift gets the manifest remedy, not a self-referential root', () => {
  const stateHome = temporaryStateHome();
  const appRoot = join(stateHome, 'app');
  mkdirSync(appRoot);
  const manifest = join(appRoot, 'package.json');
  writeFileSync(manifest, '{"name":"gh-792-declared","version":"1.0.0"}');
  const environment = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    RN_DEV_AGENT_DECLARED_ROOT: appRoot,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const run = (command: string) => {
    try {
      return {
        code: 0,
        payload: JSON.parse(
          execFileSync(process.execPath, [join(distRoot, 'session-doctor.js'), command, '--json'], {
            cwd: appRoot,
            encoding: 'utf8',
            env: environment,
          }),
        ) as Record<string, unknown>,
      };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return {
        code: failure.status ?? 1,
        payload: JSON.parse(String(failure.stdout)) as Record<string, unknown>,
      };
    }
  };

  const before = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  const layout = createAuthorityStateLayout(join(stateHome, 'rn-dev-agent'));
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const owner = registry.createSession({
    sessionId: 'declared-source-owner',
    sourceKey: before.sourceKey,
    worktreeKey: before.worktreeKey,
    appRootKey: before.appRootKey,
    supervisor: { pid: 1, token: 'birth-of-the-dead-owner' },
    source: { ...before, model: 'grouped-v1' },
    bindings: {},
  });
  registry.claimResources(owner, [{ type: 'source', key: before.worktreeKey }]);
  registry.updateBindings(owner, { state: 'source_bound', bindings: {} });
  registry.close();

  // Editing a declared manifest re-derives sourceKey while the worktree and app root keys
  // stay identical, so the claim survives on a root that can no longer match it.
  writeFileSync(manifest, '{"name":"gh-792-declared","version":"1.0.1"}');
  const after = resolveSourceIdentity(appRoot, {
    declaredRoot: appRoot,
    declaredManifests: ['package.json'],
  });
  assert.notEqual(after.sourceKey, before.sourceKey);
  assert.equal(after.worktreeKey, before.worktreeKey);
  assert.equal(after.appRootKey, before.appRootKey);

  const report = run('report');
  assert.equal(report.payload.ownerIsThisRoot, false);
  assert.equal(report.payload.ownerMismatch, 'source-identity');
  assert.equal(report.payload.sameRootOwner, 'stale');
  // The owner's app root IS this directory, so re-rooting the repair is a loop.
  assert.equal(report.payload.ownerAppRoot, report.payload.appRoot);
  const remedy = String(report.payload.remedy);
  assert.match(remedy, /declared manifests/);
  assert.doesNotMatch(remedy, /from that app root/, remedy);
  assert.match(remedy, /session-doctor\.js" repair/);

  // Restoring the manifests is what makes this root's repair reachable again.
  const stillWedged = run('repair');
  assert.deepEqual(stillWedged.payload.released, []);
  assert.equal(stillWedged.code, 1);
  writeFileSync(manifest, '{"name":"gh-792-declared","version":"1.0.0"}');
  const repaired = run('repair');
  assert.deepEqual(repaired.payload.released, ['declared-source-owner']);
  assert.equal(repaired.code, 0);
  assert.equal(run('report').payload.sameRootOwner, 'absent');
});
