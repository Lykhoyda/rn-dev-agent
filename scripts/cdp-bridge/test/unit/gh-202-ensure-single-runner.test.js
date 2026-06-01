import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLegacyRunnerPids,
  shouldRemoveDaemonFiles,
  ensureSingleRunner,
} from '../../dist/runners/ensure-single-runner.js';

// Realistic `ps -A -o pid=,args=` lines (synthetic; see field-verification note).
const PS = [
  '  501 /Users/x/Library/.../AgentDeviceRunner.app/AgentDeviceRunner -udid UDID-A',
  '  502 /Users/x/Library/.../AgentDeviceRunnerUITests-Runner.app/... -udid UDID-A',
  '  777 /Users/x/Library/.../AgentDeviceRunner.app/AgentDeviceRunner -udid UDID-OTHER',
  '  900 /Users/x/.../RnFastRunnerUITests-Runner.app/... -udid UDID-A',
  '  123 /usr/bin/node /some/unrelated/process',
].join('\n');

test('GH#202 selectLegacyRunnerPids: only AgentDeviceRunner procs on the target UDID', () => {
  assert.deepEqual(selectLegacyRunnerPids(PS, 'UDID-A').sort(), [501, 502]);
});

test('GH#202 selectLegacyRunnerPids: skips other simulators and never our RnFastRunner', () => {
  assert.deepEqual(selectLegacyRunnerPids(PS, 'UDID-OTHER'), [777]);
  assert.ok(!selectLegacyRunnerPids(PS, 'UDID-A').includes(900));
});

test('GH#202 shouldRemoveDaemonFiles: remove only when daemon PID is dead or absent', () => {
  assert.equal(shouldRemoveDaemonFiles(4242, () => true), false);  // alive → keep
  assert.equal(shouldRemoveDaemonFiles(4242, () => false), true);  // dead → remove
  assert.equal(shouldRemoveDaemonFiles(null, () => true), true);   // no pid → orphan → remove
});

function baseDeps(over = {}) {
  return {
    listProcesses: () => PS,
    kill: () => {},
    isAlive: () => false,
    readDaemonPid: () => null,
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    ...over,
  };
}

test('GH#202 ensureSingleRunner (device-open): SIGTERMs scoped legacy pids', async () => {
  const killed = [];
  const r = await ensureSingleRunner({ udid: 'UDID-A' }, baseDeps({
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    isAlive: () => false, // dead after SIGTERM → no SIGKILL escalation
  }));
  assert.deepEqual(r.killedPids.sort(), [501, 502]);
  assert.ok(killed.includes('501:SIGTERM'));
  assert.ok(!killed.some((k) => k.endsWith('SIGKILL')));
});

test('GH#202 ensureSingleRunner (device-open): escalates to SIGKILL when still alive', async () => {
  const killed = [];
  await ensureSingleRunner({ udid: 'UDID-OTHER' }, baseDeps({
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    isAlive: () => true, // survives SIGTERM → SIGKILL
  }));
  assert.ok(killed.includes('777:SIGTERM'));
  assert.ok(killed.includes('777:SIGKILL'));
});

test('GH#202 ensureSingleRunner (startup, no udid): never scans/kills processes; only dead-pid file cleanup', async () => {
  const removed = [];
  const r = await ensureSingleRunner({}, baseDeps({
    listProcesses: () => assert.fail('startup pass must not scan processes'),
    readDaemonPid: () => 4242,
    isAlive: () => false, // daemon dead → orphan
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(r.killedPids.length, 0);
  assert.equal(removed.length, 2); // daemon.json + daemon.lock
  assert.equal(r.removedFiles.length, 2);
});

test('GH#202 ensureSingleRunner: keeps daemon files when the daemon PID is alive', async () => {
  const removed = [];
  const r = await ensureSingleRunner({}, baseDeps({
    readDaemonPid: () => 4242,
    isAlive: () => true, // alive → may belong to another project → keep
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(removed.length, 0);
  assert.ok(r.warnings.some((w) => /alive/.test(w)));
});
