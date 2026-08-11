// Regression coverage for atomic runner unbind and refusal of unsupported split stores.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openSessionRegistry } from '../../../dist/session/registry.js';
import { unbindNativeRunner } from '../../../dist/session/runner-binding.js';

const PLATFORM = 'ios';
const DEVICE = 'SIM-UDID-692';
const APP = 'com.example.app';
const PORT = 8711;
const RUNNER_KEY = `${PLATFORM}:${DEVICE}:${PORT}`;
const RECOVERY_CAPABILITY = 'recovery-capability';
const RECOVERY_WORKER = 'recovery-worker';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rn-gh692-unbind-'));
  roots.push(root);
  let now = 1_000_000;
  const ownerStates = new Map<string, string>();
  const registry = openSessionRegistry(join(root, 'registry.sqlite3'), {
    now: () => now,
    ownerStatus: (owner: { sessionId: string }) => ownerStates.get(owner.sessionId) ?? 'unknown',
    listenerStatus: () => 'absent',
    leaseMs: 30_000,
  });
  return { registry, ownerStates, advance: (ms: number) => (now += ms) };
}

function runnerBoundOwner(f: ReturnType<typeof fixture>, sessionId = 'owner-a') {
  f.ownerStates.set(sessionId, 'match');
  const session = f.registry.createSession({
    sessionId,
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4100, token: `birth-${sessionId}` },
    source: { kind: 'git', contentRoot: '/src/worktree-1' },
    bindings: {},
  });
  f.registry.claimResources(session, [
    { type: 'source', key: 'worktree-1' },
    { type: 'metro-port', key: '8248' },
    { type: 'observe-port', key: '7396' },
  ]);
  f.registry.updateBindings(session, {
    state: 'device_claimed',
    claimResources: [{ type: 'device', key: `${PLATFORM}:${DEVICE}` }],
    bindings: {
      metroPort: 8248,
      observePort: 7396,
      device: { platform: PLATFORM, deviceId: DEVICE, appId: APP },
      install: null,
    },
  });
  f.registry.updateBindings(session, {
    state: 'runtime_bound',
    claimResources: [{ type: 'runner', key: RUNNER_KEY }],
    bindings: {
      runner: {
        platform: PLATFORM,
        port: PORT,
        pid: 55555,
        processBirth: 'runner-birth-token',
        instanceId: 'runner-instance-1',
        sessionId,
        claimEpoch: session.claimEpoch,
        capability: 'runner-capability',
        deviceId: DEVICE,
        appId: APP,
        protocolVersion: 3,
      },
    },
  });
  return session;
}

type Registry = ReturnType<typeof openSessionRegistry>;
type SessionRef = ReturnType<Registry['createSession']>;

function runnerClaim(registry: Registry, session: SessionRef) {
  return registry
    .getSessionStatus(session.sessionId)
    ?.claims.find((claim: { type: string; key: string }) => claim.type === 'runner');
}

function runnerBinding(registry: Registry, session: SessionRef) {
  return registry.getSessionStatus(session.sessionId)?.bindings.runner ?? null;
}

function asRuntime(registry: unknown, session: SessionRef) {
  return { requireAvailable: () => ({ registry, session }) } as Parameters<
    typeof unbindNativeRunner
  >[0];
}

function blockedContender(f: ReturnType<typeof fixture>, prior: SessionRef) {
  f.ownerStates.set(prior.sessionId, 'mismatch');
  f.ownerStates.set('contender-b', 'match');
  const contender = f.registry.createSession({
    sessionId: 'contender-b',
    sourceKey: 'repo',
    worktreeKey: 'worktree-1',
    appRootKey: '.',
    supervisor: { pid: 4200, token: 'birth-contender-b' },
    source: { kind: 'git', contentRoot: '/src/worktree-1' },
    bindings: {},
  });
  let holder: { sessionId: string; claimEpoch: number } | undefined;
  try {
    f.registry.claimResources(contender, [{ type: 'source', key: 'worktree-1' }]);
  } catch (error) {
    holder = (error as { holder?: { sessionId: string; claimEpoch: number } }).holder;
  }
  assert.equal(holder?.sessionId, prior.sessionId);
  f.registry.updateBindings(contender, {
    state: 'blocked',
    bindings: {
      metroPort: 8249,
      observePort: 7397,
      recoveryCapabilityHash: createHash('sha256').update(RECOVERY_CAPABILITY).digest('hex'),
      adoptionRequired: { sessionId: holder!.sessionId, claimEpoch: holder!.claimEpoch },
    },
  });
  f.registry.bindRecoveryWorker(
    contender,
    { instanceId: RECOVERY_WORKER, pid: 9001, token: 'recovery-birth' },
    RECOVERY_CAPABILITY,
  );
  const handles = f.registry.getSessionStatus(contender.sessionId)?.bindings.recoveryHandles as
    | { adoptStale?: { token?: string } }
    | undefined;
  assert.ok(handles?.adoptStale?.token);
  return { contender, handle: handles.adoptStale.token };
}

test('gh-692: successful unbind removes claim and binding together', () => {
  const f = fixture();
  const owner = runnerBoundOwner(f);
  assert.ok(runnerClaim(f.registry, owner));
  assert.ok(runnerBinding(f.registry, owner));

  unbindNativeRunner(asRuntime(f.registry, owner));

  assert.equal(runnerClaim(f.registry, owner), undefined);
  assert.equal(runnerBinding(f.registry, owner), null);
  assert.equal(f.registry.getSessionStatus(owner.sessionId)?.state, 'device_bound');
  f.registry.close();
});

test('gh-692: an unbind whose registry write fails leaves claim and binding fully consistent', () => {
  const f = fixture();
  const owner = runnerBoundOwner(f);

  // A rejected atomic write must preserve both the claim and binding for retry.
  const failing = new Proxy(f.registry as object, {
    get(target, prop, receiver) {
      if (prop === 'updateBindings') {
        return () => {
          throw new Error('SIMULATED_DEATH: interrupted before the bindings write committed');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  assert.throws(
    () => unbindNativeRunner(asRuntime(failing, owner)),
    /SIMULATED_DEATH/,
    'interrupted unbind surfaces the failure',
  );

  const claim = runnerClaim(f.registry, owner);
  const binding = runnerBinding(f.registry, owner);
  assert.ok(
    claim,
    'runner claim row must survive a failed unbind — its deletion without the binding write is the GH #692 split',
  );
  assert.ok(binding, 'runner binding must survive a failed unbind');
  assert.equal(f.registry.getSessionStatus(owner.sessionId)?.state, 'runtime_bound');

  // The consistent store keeps the unbind retryable.
  unbindNativeRunner(asRuntime(f.registry, owner));
  assert.equal(runnerClaim(f.registry, owner), undefined);
  assert.equal(runnerBinding(f.registry, owner), null);
  f.registry.close();
});

test('gh-692: an unbind against changed session authority mutates nothing', () => {
  const f = fixture();
  const owner = runnerBoundOwner(f);

  const staleRef = { sessionId: owner.sessionId, claimEpoch: owner.claimEpoch + 1 };
  assert.throws(
    () => unbindNativeRunner(asRuntime(f.registry, staleRef as SessionRef)),
    /SESSION_OWNER_LOST/,
  );

  assert.ok(runnerClaim(f.registry, owner), 'claim untouched under a stale session ref');
  assert.ok(runnerBinding(f.registry, owner), 'binding untouched under a stale session ref');
  f.registry.close();
});

test('gh-692: healthy dead-owner adoption still transfers and completes the runner cleanup', () => {
  const f = fixture();
  const owner = runnerBoundOwner(f);
  const { contender, handle } = blockedContender(f, owner);

  f.registry.adoptStaleWithHandle(contender, handle, RECOVERY_WORKER);
  assert.equal(f.registry.getSessionStatus(contender.sessionId)?.state, 'handoff_cleanup');

  const obligation = f.registry.beginHandoffCleanupResource(contender, RECOVERY_WORKER, 'runner');
  assert.ok(obligation, 'runner cleanup obligation transferred to the adopter');
  f.registry.completeHandoffCleanupResource(contender, RECOVERY_WORKER, 'runner');
  f.registry.finishHandoffCleanup(contender, RECOVERY_WORKER);
  assert.equal(f.registry.getSessionStatus(contender.sessionId)?.state, 'source_bound');
  f.registry.close();
});

test('gh-692: a store already split by an interrupted legacy unbind still refuses adoption', () => {
  const f = fixture();
  const owner = runnerBoundOwner(f);
  // Divergent stores (claim gone, binding present) are unsupported legacy state:
  // adoption must keep the exact anti-steal refusal rather than relax ownership.
  f.registry.releaseResources(owner, [{ type: 'runner', key: RUNNER_KEY }]);
  const { contender, handle } = blockedContender(f, owner);

  assert.throws(
    () => f.registry.adoptStaleWithHandle(contender, handle, RECOVERY_WORKER),
    (error: { code?: string }) => error.code === 'RUNNER_OWNERSHIP_MISMATCH',
  );
  assert.equal(f.registry.getSessionStatus(contender.sessionId)?.state, 'blocked');
  f.registry.close();
});
