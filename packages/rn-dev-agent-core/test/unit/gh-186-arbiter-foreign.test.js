import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DeviceSessionArbiter, arbiterWrap } from '../../dist/lifecycle/device-arbiter.js';
import { ForeignFlowGate } from '../../dist/lifecycle/foreign-flow-gate.js';

const WARNING = {
  platform: 'ios',
  code: 'IOS_XCUITEST_COMPETITOR',
  message: 'foreign maestro flow on this simulator',
  processLines: ['77 maestro-driver-iosUITests-Runner'],
};
const okHandler = async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] });

function foreignOpts(over = {}) {
  return {
    gate: new ForeignFlowGate({ detect: async () => WARNING, ttlMs: 5000, now: () => 0 }),
    getUdid: () => 'UDID-A',
    enabled: () => true,
    ...over,
  };
}

test('GH#186 arbiter: interaction tool refuses BUSY_FOREIGN_FLOW when a foreign flow is live', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts());
  const res = await wrapped({});
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.code, 'BUSY_FOREIGN_FLOW');
  assert.match(body.error, /foreign/i);
  assert.match(
    body.error,
    /cdp_component_tree|introspection|L1/i,
    'message points at the safe L1 alternatives',
  );
  assert.match(body.error, /RN_IOS_FOREIGN_GUARD/, 'message names the opt-out');
  assert.equal(inst.snapshot.activeOps, 0, 'no lease was taken');
});

test('GH#186 arbiter: flow tool (maestro_run) refuses the same way', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('maestro_run', okHandler, inst, foreignOpts());
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.code, 'BUSY_FOREIGN_FLOW');
});

test('GH#186 arbiter: introspection (L1) tools NEVER consult the gate', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('cdp_store_state', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(scans, 0);
});

test('GH#186 arbiter: no iOS session (getUdid null) skips detection entirely', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap(
    'device_press',
    okHandler,
    inst,
    foreignOpts({ gate, getUdid: () => null }),
  );
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(scans, 0);
});

test('GH#186 arbiter: disabled knob skips the refusal', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap(
    'device_press',
    okHandler,
    inst,
    foreignOpts({ enabled: () => false }),
  );
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
});

test('GH#186 arbiter: our OWN flow lease skips the foreign check (a detected driver is then our own L3 run)', async () => {
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => 0,
  });
  const inst = new DeviceSessionArbiter();
  const flowLease = inst.tryAcquire('flow', 'maestro_run');
  assert.equal(flowLease.ok, true);
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.code, 'BUSY_FLOW_ACTIVE', 'local-flow refusal wins, no foreign scan');
  assert.equal(scans, 0);
});

// Plan-review BLOCKER: after OUR flow lease releases, the spawned maestro
// driver (which carries the udid) keeps tearing down WDA for several seconds
// and matches the detector — the first tap after our own maestro_run would
// read a stale BUSY_FOREIGN_FLOW. Busting the cache does NOT help (a fresh
// scan still sees the dying PID); a teardown GRACE window on the arbiter does.
test('GH#186 arbiter: teardown grace — no foreign scan within FOREIGN_GRACE_MS of our own flow release', async () => {
  let t = 0;
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => t,
  });
  const inst = new DeviceSessionArbiter(() => t);
  const lease = inst.tryAcquire('flow', 'maestro_run');
  t += 1000;
  inst.release(lease.lease); // our flow just ended
  t += 4000; // < grace (10s)
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true, 'tap goes through — the dying driver is OURS');
  assert.equal(scans, 0, 'no scan during the grace window');
  t += 7000; // past grace → scans resume
  const body2 = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body2.code, 'BUSY_FOREIGN_FLOW');
  assert.ok(scans >= 1);
});

test('GH#186 arbiter: releasing a NON-flow lease does not start a grace window', async () => {
  let t = 0;
  let scans = 0;
  const gate = new ForeignFlowGate({
    detect: async () => {
      scans += 1;
      return WARNING;
    },
    ttlMs: 5000,
    now: () => t,
  });
  const inst = new DeviceSessionArbiter(() => t);
  const lease = inst.tryAcquire('interaction', 'device_fill');
  t += 100;
  inst.release(lease.lease);
  t += 100;
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.code, 'BUSY_FOREIGN_FLOW', 'interaction releases do not suppress the guard');
});

test('GH#186 arbiter: no foreign flow → normal lease + handler runs', async () => {
  const gate = new ForeignFlowGate({ detect: async () => null, ttlMs: 5000, now: () => 0 });
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts({ gate }));
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.ok, true);
  assert.equal(inst.snapshot.activeOps, 0, 'lease released after the handler');
});

test('GH#186 arbiter: refusal extras carry the warning detail + scan timing (envelope meta)', async () => {
  const inst = new DeviceSessionArbiter();
  const wrapped = arbiterWrap('device_press', okHandler, inst, foreignOpts());
  const body = JSON.parse((await wrapped({})).content[0].text);
  assert.equal(body.meta.foreignRunner.code, 'IOS_XCUITEST_COMPETITOR');
  assert.ok('foreignScan' in (body.meta?.timings_ms ?? {}), 'meta.timings_ms.foreignScan present');
});

// index.ts wiring pin (repo pattern: source-text assertion, cf. gh-202-kill-legacy-wiring)
const indexSrc = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
  'utf8',
);

test('GH#186 index.ts registers the foreign-gate udid provider from the active session', () => {
  assert.match(indexSrc, /setForeignGateUdidProvider\(/);
});

test('GH#186 screenshot routing treats a foreign flow like a local one (simctl path)', () => {
  const srcPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../src/tools/device-list.ts',
  );
  const listSrc = readFileSync(srcPath, 'utf8');
  assert.match(listSrc, /flowActive:\s*arbiter\.flowActive\s*\|\|\s*foreignFlowGate\.lastActive/);
});
