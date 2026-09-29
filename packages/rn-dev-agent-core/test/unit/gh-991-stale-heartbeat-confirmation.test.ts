// GH #991: after a host sleep a polling contender can read the owner's pre-sleep heartbeat
// before the owner's first post-wake tick; heartbeat staleness alone must persist a grace interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile } from '../../dist/lifecycle/lockfile.js';

const NOW = 1_700_000_000_000;
const GRACE_MS = 30_000;
const OWNER = {
  pid: 85744,
  projectRoot: '/p',
  startedAt: NOW - 3_600_000,
  lastHeartbeat: NOW - 20 * 60_000,
  ppid: 4242,
};
const confirm = { confirmStaleHeartbeat: true };

function withContender(run, overrides = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gh991-stale-'));
  const clock = { now: NOW };
  try {
    const contender = new Lockfile({
      projectRoot: '/p',
      pid: 12345,
      tmpDir,
      uid: 501,
      clock: () => clock.now,
      processAlive: (pid) => pid === OWNER.pid,
      processName: () => 'node /x/rn-dev-agent-core/dist/supervisor.js',
      processParent: () => OWNER.ppid,
      staleMs: 90_000,
      ...overrides,
    });
    writeFileSync(contender.lockPath, JSON.stringify(OWNER), 'utf8');
    run(contender, clock);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const lockOwner = (contender) => JSON.parse(readFileSync(contender.lockPath, 'utf8')).pid;

test('a single stale-heartbeat sighting of a live owner is not a reclaim', () => {
  withContender((contender) => {
    assert.equal(contender.acquire(confirm).status, 'conflict');
    assert.equal(lockOwner(contender), OWNER.pid);
  });
});

test('back-to-back sightings inside the grace interval are not a reclaim', () => {
  withContender((contender, clock) => {
    assert.equal(contender.acquire(confirm).status, 'conflict');
    assert.equal(contender.acquire(confirm).status, 'conflict');
    clock.now += GRACE_MS - 1;
    assert.equal(contender.acquire(confirm).status, 'conflict');
    assert.equal(lockOwner(contender), OWNER.pid);
  });
});

test('an owner that refreshes after waking is never reclaimed', () => {
  withContender((contender, clock) => {
    assert.equal(contender.acquire(confirm).status, 'conflict');
    writeFileSync(contender.lockPath, JSON.stringify({ ...OWNER, lastHeartbeat: NOW }), 'utf8');
    clock.now += GRACE_MS;
    assert.equal(contender.acquire(confirm).status, 'conflict');
    clock.now = NOW + 90_001;
    assert.equal(
      contender.acquire(confirm).status,
      'conflict',
      'a refreshed heartbeat that later goes stale starts a new grace interval',
    );
    clock.now += GRACE_MS;
    assert.equal(contender.acquire(confirm).status, 'acquired');
  });
});

test('the same stale heartbeat a full grace interval later is a wedged owner and is reclaimed', () => {
  withContender((contender, clock) => {
    assert.equal(contender.acquire(confirm).status, 'conflict');
    clock.now += GRACE_MS;
    assert.equal(contender.acquire(confirm).status, 'acquired');
    assert.equal(lockOwner(contender), 12345);
  });
});

test('an owner that refreshes between the confirming reads keeps its lock', () => {
  let lockPath = '';
  let refreshOnProbe = false;
  withContender(
    (contender, clock) => {
      lockPath = contender.lockPath;
      assert.equal(contender.acquire(confirm).status, 'conflict');
      clock.now += GRACE_MS;
      refreshOnProbe = true;
      assert.equal(contender.acquire(confirm).status, 'conflict');
      const body = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(body.pid, OWNER.pid);
      assert.equal(body.lastHeartbeat, clock.now);
    },
    {
      processParent: () => {
        if (refreshOnProbe) {
          refreshOnProbe = false;
          const now = NOW + GRACE_MS;
          writeFileSync(lockPath, JSON.stringify({ ...OWNER, lastHeartbeat: now }), 'utf8');
        }
        return OWNER.ppid;
      },
    },
  );
});

test('a dead owner is still reclaimed on the first sighting', () => {
  withContender((contender) => {
    writeFileSync(contender.lockPath, JSON.stringify({ ...OWNER, pid: 99999 }), 'utf8');
    assert.equal(contender.acquire(confirm).status, 'acquired');
  });
});
