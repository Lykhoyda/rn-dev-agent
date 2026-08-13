import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { OwnerStatus, SessionOwner } from '../../../dist/session/registry.js';
import {
  createSupervisorAuthority,
  resolveSupervisorAuthorityForSpawn,
  supervisorSessionIsTerminal,
  type SupervisorAuthority,
} from '../../../dist/session/supervisor-authority.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const source = {
  kind: 'git' as const,
  contentRoot: '/repo',
  appRoot: '/repo/apps/mobile',
  sourceKey: 'source-key',
  worktreeKey: 'worktree-key',
  appRootKey: 'app-key',
  head: 'abc123',
};

const foreignSource = {
  ...source,
  worktreeKey: 'foreign-worktree',
};

interface MintInput {
  pid: number;
  token: string;
  ownerStatus: (owner: SessionOwner) => OwnerStatus;
  source?: typeof source;
}

function mint(stateDir: string, input: MintInput): SupervisorAuthority {
  return createSupervisorAuthority({
    stateDir,
    source: input.source ?? source,
    supervisorBirth: {
      pid: input.pid,
      source: 'linux-proc',
      token: input.token,
    },
    uid: '501',
    startHeartbeat: false,
    ownerStatus: input.ownerStatus,
  });
}

function recoveryOf(authority: SupervisorAuthority) {
  return authority.registry.inspectRecoveryRequirement(authority.session.sessionId);
}

function stateOf(authority: SupervisorAuthority) {
  return authority.registry.getSessionStatus(authority.session.sessionId)?.state;
}

test('GH#767: repeated fresh transports converge after release and no remaining claims', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-repeat-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'match';

  const owner = mint(stateDir, { pid: 101, token: 'owner-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'match');
  const blocked = mint(stateDir, { pid: 202, token: 'blocked-birth', ownerStatus });
  ownerStates.set(blocked.session.sessionId, 'match');
  assert.equal(stateOf(blocked), 'blocked');

  owner.registry.releaseSession(owner.session);
  ownerStates.set(owner.session.sessionId, 'mismatch');
  assert.equal(recoveryOf(blocked).requirement, 'transport-restart');
  assert.equal(recoveryOf(blocked).priorOwner, 'absent');
  assert.equal(blocked.registry.getClaim('source', source.worktreeKey), null);

  assert.throws(() =>
    blocked.registry.createSession({
      sessionId: blocked.session.sessionId,
      sourceKey: source.sourceKey,
      worktreeKey: source.worktreeKey,
      appRootKey: source.appRootKey,
      supervisor: { pid: 999, token: 'duplicate-id' },
      source,
    }),
  );
  assert.equal(stateOf(blocked), 'blocked', 'insert failure must roll back the fence clear');
  assert.equal(recoveryOf(blocked).priorOwner, 'absent');

  const first = mint(stateDir, { pid: 303, token: 'fresh-1-birth', ownerStatus });
  ownerStates.set(first.session.sessionId, 'match');
  try {
    assert.equal(stateOf(first), 'source_bound');
    assert.equal(stateOf(blocked), 'released');
    assert.equal(
      first.registry.getClaim('source', source.worktreeKey)?.sessionId,
      first.session.sessionId,
    );

    const overlapping = mint(stateDir, { pid: 305, token: 'overlap-birth', ownerStatus });
    try {
      assert.equal(stateOf(overlapping), 'blocked');
      assert.equal(recoveryOf(overlapping).priorOwner, 'live');
      assert.equal(
        first.registry.getClaim('source', source.worktreeKey)?.sessionId,
        first.session.sessionId,
      );
    } finally {
      await overlapping.close();
    }
  } finally {
    await first.close();
  }

  const second = mint(stateDir, { pid: 404, token: 'fresh-2-birth', ownerStatus });
  ownerStates.set(second.session.sessionId, 'match');
  try {
    assert.equal(stateOf(second), 'source_bound');
    assert.equal(
      second.registry.getClaim('source', source.worktreeKey)?.sessionId,
      second.session.sessionId,
    );
  } finally {
    await second.close();
    await blocked.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  }
});

test('GH#767: a blocked absent-prior session is reminted on the documented transport restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-remint-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'match';

  const owner = mint(stateDir, { pid: 101, token: 'owner-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'match');
  const blocked = mint(stateDir, { pid: 202, token: 'blocked-birth', ownerStatus });
  owner.registry.releaseSession(owner.session);
  ownerStates.set(owner.session.sessionId, 'mismatch');

  assert.equal(recoveryOf(blocked).priorOwner, 'absent');
  assert.equal(supervisorSessionIsTerminal(blocked), true);

  const resolution = resolveSupervisorAuthorityForSpawn(blocked, () =>
    mint(stateDir, { pid: 303, token: 'remint-birth', ownerStatus }),
  );
  try {
    assert.equal(resolution.minted, true);
    assert.ok(resolution.authority);
    assert.notEqual(resolution.authority.session.sessionId, blocked.session.sessionId);
    assert.equal(stateOf(resolution.authority), 'source_bound');
  } finally {
    await resolution.authority?.close();
    await owner.close().catch(() => undefined);
  }
});

test('GH#767: a live owner is never cleared or reminted', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-live-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'match';

  const owner = mint(stateDir, { pid: 101, token: 'owner-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'match');
  const blocked = mint(stateDir, { pid: 202, token: 'blocked-birth', ownerStatus });
  try {
    assert.equal(stateOf(blocked), 'blocked');
    assert.equal(recoveryOf(blocked).priorOwner, 'live');
    assert.equal(supervisorSessionIsTerminal(blocked), false);
    assert.equal(supervisorSessionIsTerminal(owner), false);

    const resolution = resolveSupervisorAuthorityForSpawn(blocked, () => {
      throw new Error('a live owner must never be reminted away');
    });
    assert.equal(resolution.minted, false);
    assert.equal(resolution.authority, blocked);

    const contender = mint(stateDir, { pid: 303, token: 'fresh-live-birth', ownerStatus });
    try {
      assert.equal(stateOf(contender), 'blocked');
      assert.equal(recoveryOf(contender).priorOwner, 'live');
      assert.equal(stateOf(owner), 'source_bound');
      assert.equal(
        owner.registry.getClaim('source', source.worktreeKey)?.sessionId,
        owner.session.sessionId,
      );
    } finally {
      await contender.close();
    }
  } finally {
    await blocked.close();
    await owner.close();
  }
});

test('GH#767: an ambiguous owner is treated as live and the fence stays', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-unknown-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'unknown';

  const owner = mint(stateDir, { pid: 101, token: 'owner-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'unknown');
  const blocked = mint(stateDir, { pid: 202, token: 'blocked-birth', ownerStatus });
  try {
    assert.equal(stateOf(blocked), 'blocked');
    assert.equal(recoveryOf(blocked).priorOwner, 'unknown');
    assert.equal(supervisorSessionIsTerminal(blocked), false);

    const contender = mint(stateDir, { pid: 303, token: 'fresh-unknown-birth', ownerStatus });
    try {
      assert.equal(stateOf(contender), 'blocked');
      assert.equal(recoveryOf(contender).priorOwner, 'unknown');
      assert.equal(
        owner.registry.getClaim('source', source.worktreeKey)?.sessionId,
        owner.session.sessionId,
      );
    } finally {
      await contender.close();
    }
  } finally {
    await blocked.close();
    await owner.close();
  }
});

test('GH#767: a foreign worktree blocked row is not discarded by another admission', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-foreign-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'match';

  const foreignOwner = mint(stateDir, {
    pid: 101,
    token: 'foreign-owner-birth',
    ownerStatus,
    source: foreignSource,
  });
  ownerStates.set(foreignOwner.session.sessionId, 'match');
  const foreignBlocked = mint(stateDir, {
    pid: 202,
    token: 'foreign-blocked-birth',
    ownerStatus,
    source: foreignSource,
  });
  foreignOwner.registry.releaseSession(foreignOwner.session);
  ownerStates.set(foreignOwner.session.sessionId, 'mismatch');
  assert.equal(recoveryOf(foreignBlocked).priorOwner, 'absent');

  const local = mint(stateDir, { pid: 303, token: 'local-birth', ownerStatus });
  ownerStates.set(local.session.sessionId, 'match');
  try {
    assert.equal(stateOf(local), 'source_bound');
    assert.equal(stateOf(foreignBlocked), 'blocked');
    assert.equal(recoveryOf(foreignBlocked).priorOwner, 'absent');
  } finally {
    await local.close();
    await foreignBlocked.close().catch(() => undefined);
    await foreignOwner.close().catch(() => undefined);
  }
});

test('GH#767: proven-stale non-absent recovery is not reminted', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'rn-gh767-stale-'));
  roots.push(stateDir);
  const ownerStates = new Map<string, OwnerStatus>();
  const ownerStatus = (owner: SessionOwner): OwnerStatus =>
    ownerStates.get(owner.sessionId) ?? 'match';

  const owner = mint(stateDir, { pid: 101, token: 'owner-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'match');
  const blocked = mint(stateDir, { pid: 202, token: 'blocked-birth', ownerStatus });
  ownerStates.set(owner.session.sessionId, 'mismatch');

  try {
    assert.equal(recoveryOf(blocked).priorOwner, 'stale');
    assert.equal(supervisorSessionIsTerminal(blocked), false);
    assert.notEqual(owner.registry.getClaim('source', source.worktreeKey), null);
    const resolution = resolveSupervisorAuthorityForSpawn(blocked, () => {
      throw new Error('a proven-stale owner must not be reminted away');
    });
    assert.equal(resolution.minted, false);
    assert.equal(resolution.authority, blocked);
    assert.equal(
      owner.registry.getClaim('source', source.worktreeKey)?.sessionId,
      owner.session.sessionId,
    );
  } finally {
    await blocked.close();
    await owner.close();
  }
});
