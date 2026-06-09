import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNED_PACKAGES,
  isProtectedPid,
} from '../../dist/runners/release-android-slot.js';

test('GH#237 OWNED_PACKAGES: exactly our two in-tree runner packages', () => {
  assert.deepEqual(OWNED_PACKAGES, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 isProtectedPid: true for our own pid or parent pid', () => {
  assert.equal(isProtectedPid(4242, 4242, 9), true);   // == self
  assert.equal(isProtectedPid(9, 4242, 9), true);      // == parent
  assert.equal(isProtectedPid(777, 4242, 9), false);   // unrelated
});

import { releaseAndroidInteractionSlot } from '../../dist/runners/release-android-slot.js';

function baseDeps(over = {}) {
  return {
    stopOwnRunner: async () => {},
    adbForceStop: async () => {},
    resolveSerial: () => [],
    readDaemonPid: () => null,
    isAlive: () => false,
    protectedPids: () => ({ selfPid: 4242, parentPid: 9 }),
    kill: () => {},
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    killLegacy: () => true,
    now: () => 0,
    ...over,
  };
}

test('GH#237 release: order is stopOwnRunner → force-stop both pkgs → daemon', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot({ deviceId: 'emulator-5554' }, baseDeps({
    stopOwnRunner: async () => { order.push('stop'); },
    adbForceStop: async (pkg) => { order.push(`force:${pkg}`); },
    readDaemonPid: () => null,
  }));
  assert.deepEqual(order, [
    'stop',
    'force:dev.lykhoyda.rndevagent.androidrunner.test',
    'force:dev.lykhoyda.rndevagent.androidrunner',
  ]);
  assert.equal(r.stoppedOwnRunner, true);
  assert.deepEqual(r.forceStoppedPackages, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 release: deviceId resolves to an -s serial passed to force-stop', async () => {
  const serials = [];
  await releaseAndroidInteractionSlot({ deviceId: 'emulator-5554' }, baseDeps({
    resolveSerial: (id) => (id ? ['-s', id] : []),
    adbForceStop: async (_pkg, serial) => { serials.push(serial.join(' ')); },
  }));
  assert.deepEqual(serials, ['-s emulator-5554', '-s emulator-5554']);
});

test('GH#237 release: killLegacy()=false skips daemon kill but still does steps 1+2', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    killLegacy: () => false,
    stopOwnRunner: async () => order.push('stop'),
    adbForceStop: async () => order.push('force'),
    readDaemonPid: () => { throw new Error('daemon must not be read when killLegacy=false'); },
    kill: () => assert.fail('must not kill daemon when killLegacy=false'),
  }));
  assert.deepEqual(order, ['stop', 'force', 'force']);
  assert.equal(r.killedDaemonPids.length, 0);
});

test('GH#237 release: kills a live, non-protected legacy daemon (SIGTERM→SIGKILL)', async () => {
  const killed = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 777,
    isAlive: () => true,
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    fileExists: () => false,
  }));
  assert.deepEqual(r.killedDaemonPids, [777]);
  assert.ok(killed.includes('777:SIGTERM'));
  assert.ok(killed.includes('777:SIGKILL'));
});

test('GH#237 release: REFUSES to kill the daemon when its PID is our own/parent', async () => {
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 4242,
    isAlive: () => true,
    protectedPids: () => ({ selfPid: 4242, parentPid: 9 }),
    kill: () => assert.fail('must NOT kill our own process'),
    fileExists: () => true,
    removeFile: () => assert.fail('must keep daemon files for a live (our-own) daemon'),
  }));
  assert.equal(r.killedDaemonPids.length, 0);
  assert.ok(r.warnings.some((w) => /our own process\/parent/.test(w)));
});

test('GH#237 release: removes orphaned daemon files when the daemon PID is dead', async () => {
  const removed = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 4242,
    isAlive: () => false,
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(removed.length, 2);
  assert.equal(r.removedFiles.length, 2);
});

test('GH#237 release: never throws when stopOwnRunner fails (idempotent/best-effort)', async () => {
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    stopOwnRunner: async () => { throw new Error('runner already stopped'); },
  }));
  assert.equal(r.stoppedOwnRunner, false);
  assert.ok(r.warnings.some((w) => /stopping the Android runner failed/.test(w)));
});

test('GH#237 release: skips SIGKILL when SIGTERM is sufficient', async () => {
  let calls = 0;
  const killed = [];
  await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 777,
    isAlive: () => calls++ === 0,   // alive before SIGTERM, dead after
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    fileExists: () => false,
  }));
  assert.ok(killed.includes('777:SIGTERM'));
  assert.ok(!killed.includes('777:SIGKILL'));
});

test('GH#237 release: keeps daemon files when the kill itself fails (daemon may be alive)', async () => {
  const removed = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 777,
    isAlive: () => true,
    kill: () => { throw new Error('EPERM'); },
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(removed.length, 0);
  assert.ok(r.warnings.some((w) => /kill daemon 777 failed/.test(w)));
});

test('GH#237 release: resolveSerial throwing does not abort (best-effort, never throws)', async () => {
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    resolveSerial: () => { throw new Error('adb down'); },
    adbForceStop: async () => assert.fail('force-stop must be skipped when serial resolution fails'),
  }));
  assert.deepEqual(r.forceStoppedPackages, []);
  assert.ok(r.warnings.some((w) => /resolveSerial failed/.test(w)));
});
