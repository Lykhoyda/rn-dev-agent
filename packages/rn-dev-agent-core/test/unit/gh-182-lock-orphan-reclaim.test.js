// GH #182: a LIVE orphaned bridge (its Claude Code parent died, so it's reparented)
// holds the single-instance lock; PID-dead/mtime/name reclaim can't catch a live owner.
// Fix: reclaim a live owner whose PARENT CHANGED from the PPID it recorded at creation
// (orphaned), reclaim a wedged owner via a stale heartbeat, and — for pre-0.39 locks with
// no recorded ppid — fall back to PPID===1. Container-safe (CC as PID 1 stays PID 1 →
// unchanged → not stolen). Multi-review hardened (Gemini HIGH / Codex C1/C2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lockfile, defaultProcessParent } from '../../dist/lifecycle/lockfile.js';

const NOW = 1_700_000_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'gh182-lock-'));

function prep(tmpDir, ownerBody, contenderOpts = {}) {
  const contender = new Lockfile({
    projectRoot: '/p',
    pid: 12345,
    tmpDir,
    uid: 501,
    clock: () => NOW,
    processAlive: () => true,
    processName: () => 'node cdp-bridge',
    ...contenderOpts,
  });
  writeFileSync(contender.lockPath, JSON.stringify(ownerBody, null, 2), 'utf8');
  return contender;
}

// ── parent-CHANGED reclaim (new-format lock with recorded ppid) ──
test('#182: reclaims a LIVE owner whose parent CHANGED (orphaned — CC died)', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: NOW, lastHeartbeat: NOW, ppid: 4242 },
      { processAlive: (p) => p === 85744, processParent: () => 1, staleMs: 90_000 },
    );
    assert.equal(
      c.acquire().status,
      'acquired',
      'orphaned (parent changed 4242→1) must be reclaimed',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#182 container-safe: does NOT steal a healthy owner whose PPID is 1 AND was 1 at creation', () => {
  const tmpDir = tmp();
  try {
    // CC runs as PID 1 (devcontainer/no-init): owner recorded ppid 1, live parent still 1 → unchanged → healthy.
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: NOW, lastHeartbeat: NOW, ppid: 1 },
      { processAlive: (p) => p === 85744, processParent: () => 1, staleMs: 90_000 },
    );
    assert.equal(
      c.acquire().status,
      'conflict',
      'PPID 1 unchanged since creation is NOT an orphan (container) — must not steal',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#182 safety: does NOT steal a healthy owner whose parent is unchanged', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: NOW, lastHeartbeat: NOW, ppid: 4242 },
      { processAlive: (p) => p === 85744, processParent: () => 4242, staleMs: 90_000 },
    );
    assert.equal(c.acquire().status, 'conflict', 'unchanged parent → healthy → not stolen');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#182 fail-safe: PPID lookup failure (null) does NOT trigger reclaim', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: NOW, lastHeartbeat: NOW, ppid: 4242 },
      { processAlive: (p) => p === 85744, processParent: () => null, staleMs: 90_000 },
    );
    assert.equal(c.acquire().status, 'conflict', 'null PPID lookup fails safe to conflict');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── pre-0.39 lock (no recorded ppid): PPID===1 fallback ──
test('#182 legacy: reclaims a no-ppid lock whose live owner PPID is 1', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: NOW }, // pre-0.39: no ppid, no lastHeartbeat
      {
        processAlive: (p) => p === 85744,
        processParent: () => 1,
        staleMs: 90_000,
        clock: () => NOW,
      },
    );
    assert.equal(
      c.acquire().status,
      'acquired',
      'legacy orphan (no ppid, live PPID 1) reclaimed via ===1 fallback',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#182 legacy: does NOT reclaim a no-ppid lock with a real parent + fresh mtime', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      { pid: 85744, projectRoot: '/p', startedAt: Date.now() },
      {
        processAlive: (p) => p === 85744,
        processParent: () => 4242,
        staleMs: 90_000,
        clock: () => Date.now(),
      },
    );
    assert.equal(
      c.acquire().status,
      'conflict',
      'legacy lock, real parent, fresh mtime → not reclaimed',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── heartbeat (wedged-alive) ──
test('#182 heartbeat: reclaims a live owner (unchanged parent) whose heartbeat is stale (wedged)', () => {
  const tmpDir = tmp();
  try {
    const c = prep(
      tmpDir,
      {
        pid: 85744,
        projectRoot: '/p',
        startedAt: NOW - 200_000,
        lastHeartbeat: NOW - 120_000,
        ppid: 4242,
      },
      {
        processAlive: (p) => p === 85744,
        processParent: () => 4242,
        staleMs: 90_000,
        clock: () => NOW,
      },
    );
    assert.equal(
      c.acquire().status,
      'acquired',
      'stale-heartbeat (wedged) owner must be reclaimed',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── real ps -o ppid= reader ──
test('#182 defaultProcessParent: real PPID for self; null for a bogus PID (fail-safe)', () => {
  const ppid = defaultProcessParent(process.pid);
  assert.ok(typeof ppid === 'number' && ppid > 0, `expected real PPID, got ${ppid}`);
  assert.equal(defaultProcessParent(999999999), null, 'non-existent PID → null');
});

// ── acquire records the owner ppid (input to parent-changed detection) ──
test('#182: acquire records the owner PPID in the lock body', () => {
  const tmpDir = tmp();
  try {
    const lf = new Lockfile({
      projectRoot: '/p',
      pid: 12345,
      tmpDir,
      uid: 501,
      clock: () => NOW,
      selfPpid: () => 4242,
    });
    lf.acquire();
    assert.equal(
      JSON.parse(readFileSync(lf.lockPath, 'utf8')).ppid,
      4242,
      'acquire stamps the owner PPID',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── touch(): heartbeat refresh + usurp detection (returns false when stolen) ──
test('#182 touch(): refreshes + returns true when owned; returns false (no clobber) when usurped', () => {
  const tmpDir = tmp();
  try {
    let t = NOW;
    const lf = new Lockfile({
      projectRoot: '/p',
      pid: 12345,
      tmpDir,
      uid: 501,
      clock: () => t,
      processAlive: () => false,
      processName: () => null,
      selfPpid: () => 4242,
    });
    lf.acquire();
    t = NOW + 30_000;
    assert.equal(lf.touch(), true, 'touch returns true while we own the lock');
    assert.equal(
      JSON.parse(readFileSync(lf.lockPath, 'utf8')).lastHeartbeat,
      NOW + 30_000,
      'heartbeat refreshed',
    );
    // A foreign owner usurped our slot (e.g. after a sleep/wake reclaim) → touch reports false + no clobber.
    writeFileSync(
      lf.lockPath,
      JSON.stringify({
        pid: 99999,
        projectRoot: '/p',
        startedAt: NOW,
        lastHeartbeat: NOW,
        ppid: 7,
      }),
      'utf8',
    );
    assert.equal(
      lf.touch(),
      false,
      'touch returns false when usurped (signals the bridge to self-terminate)',
    );
    assert.equal(
      JSON.parse(readFileSync(lf.lockPath, 'utf8')).pid,
      99999,
      'did not resurrect a lock we no longer own',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
