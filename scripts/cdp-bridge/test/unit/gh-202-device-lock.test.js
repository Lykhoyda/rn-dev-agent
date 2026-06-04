import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLock, isDeviceLockStale } from '../../dist/lifecycle/device-lock.js';

const UDID = '78F7D2A1-1022-4BCE-8787-C0E130EF9831';
const FIXED = 1_700_000_000_000;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'device-lock-test-'));
}

function makeLock(dir, over = {}) {
  return new DeviceLock({
    udid: UDID,
    projectRoot: over.projectRoot ?? '/proj/a',
    appId: over.appId ?? 'com.example.app',
    pid: over.pid ?? 4242,
    uid: 501,
    tmpDir: dir,
    version: '0-test',
    clock: over.clock ?? (() => FIXED),
    processAlive: over.processAlive ?? (() => true),
    staleMs: over.staleMs ?? 90_000,
  });
}

test('GH#202 isDeviceLockStale: stale when PID dead OR heartbeat too old, fresh otherwise', () => {
  const body = { pid: 1, projectRoot: '/p', platform: 'ios', udid: UDID, startedAt: FIXED, lastHeartbeat: FIXED };
  assert.equal(isDeviceLockStale(body, FIXED, () => false, 90_000), true);            // dead PID
  assert.equal(isDeviceLockStale(body, FIXED + 91_000, () => true, 90_000), true);    // stale heartbeat
  assert.equal(isDeviceLockStale(body, FIXED + 1_000, () => true, 90_000), false);    // alive + fresh
});

test('GH#202 DeviceLock.acquire: clean state → acquired, writes body keyed on UDID', () => {
  const dir = tmp();
  try {
    const lock = makeLock(dir);
    const r = lock.acquire();
    assert.equal(r.status, 'acquired');
    assert.ok(lock.lockPath.includes(`device-501-ios-${UDID}`));
    assert.ok(existsSync(lock.lockPath));
    const body = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    assert.equal(body.udid, UDID);
    assert.equal(body.pid, 4242);
    assert.equal(body.platform, 'ios');
    assert.equal(body.startedAt, FIXED);
    assert.equal(body.lastHeartbeat, FIXED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: conflict when a LIVE holder owns the UDID', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111 }).acquire();
    const r = makeLock(dir, { pid: 2222, processAlive: () => true, clock: () => FIXED + 1_000 }).acquire();
    assert.equal(r.status, 'conflict');
    assert.equal(r.holder.pid, 1111);
    assert.equal(r.holder.udid, UDID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: reclaims when holder PID is dead', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111 }).acquire();
    const r = makeLock(dir, { pid: 2222, processAlive: () => false }).acquire();
    assert.equal(r.status, 'acquired');
    assert.equal(JSON.parse(readFileSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`), 'utf8')).pid, 2222);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: reclaims when holder heartbeat is stale', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111, clock: () => FIXED }).acquire();
    const r = makeLock(dir, { pid: 2222, processAlive: () => true, clock: () => FIXED + 91_000 }).acquire();
    assert.equal(r.status, 'acquired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.touch: refreshes lastHeartbeat for the owner', () => {
  const dir = tmp();
  try {
    let t = FIXED;
    const lock = makeLock(dir, { pid: 7, clock: () => t });
    lock.acquire();
    t = FIXED + 30_000;
    lock.touch();
    assert.equal(JSON.parse(readFileSync(lock.lockPath, 'utf8')).lastHeartbeat, FIXED + 30_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.release: unlinks only when we are the owner', () => {
  const dir = tmp();
  try {
    const owner = makeLock(dir, { pid: 7 });
    owner.acquire();
    assert.ok(existsSync(owner.lockPath));
    owner.release();
    assert.ok(!existsSync(owner.lockPath));

    writeFileSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`),
      JSON.stringify({ pid: 999, projectRoot: '/p', platform: 'ios', udid: UDID, startedAt: FIXED, lastHeartbeat: FIXED }), 'utf8');
    makeLock(dir, { pid: 8 }).release();   // never acquired → no-op
    assert.ok(existsSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.touch: does NOT resurrect a lock another bridge reclaimed (pid changed)', () => {
  const dir = tmp();
  try {
    const owner = makeLock(dir, { pid: 7 });
    owner.acquire();
    writeFileSync(owner.lockPath,
      JSON.stringify({ pid: 999, projectRoot: '/proj/b', platform: 'ios', udid: UDID, startedAt: 1, lastHeartbeat: 1 }), 'utf8');
    owner.touch();   // we no longer own it → must NOT overwrite
    assert.equal(JSON.parse(readFileSync(owner.lockPath, 'utf8')).pid, 999);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock: a foreign/corrupt body is treated as reclaimable', () => {
  const dir = tmp();
  try {
    const lockPath = join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`);
    writeFileSync(lockPath, JSON.stringify({ pid: 1, projectRoot: '/p', platform: 'android', udid: UDID, startedAt: 1, lastHeartbeat: 9_999_999_999_999 }), 'utf8');
    const r = makeLock(dir, { pid: 2222, processAlive: () => true }).acquire();
    assert.equal(r.status, 'acquired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
