// GH #672: a second supervisor for the same app root must never misclassify the
// live owner. The historical `cdp-bridge` process-name needle matched no shipped
// entrypoint, so every real `supervisor.js` read as a reused PID: the contender
// unlinked the live lock, and the owner self-terminated on its next heartbeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile } from '../../dist/lifecycle/lockfile.js';

const OWNER_ENTRY = '/opt/plugins/rn-dev-agent/rn-dev-agent-core/dist/supervisor.js';
const OWNER_COMMAND = `node ${OWNER_ENTRY}`;
const PROJECT_ROOT = '/fake/project/root';

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'gh672-lock-'));
  return dir;
}

function lockfile(tmpDir, overrides = {}) {
  return new Lockfile({
    projectRoot: PROJECT_ROOT,
    tmpDir,
    uid: 501,
    clock: () => 1_700_000_000_000,
    selfPpid: () => 4242,
    processParent: () => 4242,
    ...overrides,
  });
}

function ownerLockBody(overrides = {}) {
  return {
    pid: 4711,
    projectRoot: PROJECT_ROOT,
    startedAt: 1_700_000_000_000 - 5_000,
    lastHeartbeat: 1_700_000_000_000 - 1_000,
    ppid: 4242,
    identity: OWNER_ENTRY,
    version: '0.71.5',
    ...overrides,
  };
}

test('GH#672: acquire records the owner entrypoint identity in the lock body', () => {
  const tmpDir = makeTmpDir();
  try {
    const owner = lockfile(tmpDir, { pid: 4711, processIdentity: OWNER_ENTRY });
    assert.equal(owner.acquire().status, 'acquired');
    const body = JSON.parse(readFileSync(owner.lockPath, 'utf8'));
    assert.equal(body.identity, OWNER_ENTRY);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GH#672: a second supervisor refuses instead of stealing a live supervisor.js lock', () => {
  const tmpDir = makeTmpDir();
  try {
    const owner = lockfile(tmpDir, { pid: 4711, processIdentity: OWNER_ENTRY });
    assert.equal(owner.acquire().status, 'acquired');

    const contender = lockfile(tmpDir, {
      pid: 4712,
      processIdentity: OWNER_ENTRY,
      processAlive: (pid) => pid === 4711,
      // The real owner's command line: it contains `supervisor.js`, never `cdp-bridge`.
      processName: (pid) => (pid === 4711 ? OWNER_COMMAND : null),
    });

    const result = contender.acquire();
    assert.equal(result.status, 'conflict', 'contender must refuse, not reclaim');
    assert.equal(result.pid, 4711);

    const body = JSON.parse(readFileSync(owner.lockPath, 'utf8'));
    assert.equal(body.pid, 4711, 'the live owner still holds its own lock body');
    assert.equal(owner.touch(), true, 'owner keeps ownership and never self-terminates');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GH#672: the refusal survives repeated contender attempts across ownership checks', () => {
  const tmpDir = makeTmpDir();
  try {
    const owner = lockfile(tmpDir, { pid: 4711, processIdentity: OWNER_ENTRY });
    owner.acquire();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const contender = lockfile(tmpDir, {
        pid: 5000 + attempt,
        processIdentity: OWNER_ENTRY,
        processAlive: (pid) => pid === 4711,
        processName: (pid) => (pid === 4711 ? OWNER_COMMAND : null),
      });
      assert.equal(contender.acquire().status, 'conflict', `attempt ${attempt} must refuse`);
      assert.equal(owner.touch(), true, `owner still owns the lock after attempt ${attempt}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GH#672: a relocated install still matches on the recorded entrypoint basename', () => {
  const tmpDir = makeTmpDir();
  try {
    const contender = lockfile(tmpDir, {
      pid: 4712,
      processAlive: () => true,
      processName: () => 'node /new/location/rn-dev-agent-core/dist/supervisor.js',
    });
    writeFileSync(
      contender.lockPath,
      JSON.stringify(ownerLockBody({ identity: '/old/location/core/dist/supervisor.js' })),
      'utf8',
    );

    assert.equal(contender.acquire().status, 'conflict');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GH#672: a genuinely reused PID is still reclaimed', () => {
  const tmpDir = makeTmpDir();
  try {
    const contender = lockfile(tmpDir, {
      pid: 4712,
      processAlive: () => true,
      processName: () => '/bin/zsh -l',
    });
    writeFileSync(contender.lockPath, JSON.stringify(ownerLockBody()), 'utf8');

    const result = contender.acquire();
    assert.equal(result.status, 'acquired', 'an unrelated process on the recorded PID is stale');
    const body = JSON.parse(readFileSync(contender.lockPath, 'utf8'));
    assert.equal(body.pid, 4712);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GH#672: a pre-0.72 lock without identity still recognises a live supervisor', () => {
  const tmpDir = makeTmpDir();
  try {
    const contender = lockfile(tmpDir, {
      pid: 4712,
      processAlive: () => true,
      processName: () => OWNER_COMMAND,
    });
    const legacy = ownerLockBody();
    delete legacy.identity;
    writeFileSync(contender.lockPath, JSON.stringify(legacy), 'utf8');

    assert.equal(
      contender.acquire().status,
      'conflict',
      'legacy locks fall back to shipped entrypoint markers, not the dead cdp-bridge needle',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
