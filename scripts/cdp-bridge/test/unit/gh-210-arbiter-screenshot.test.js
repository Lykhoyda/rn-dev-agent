// GH #210 Task 3: device_screenshot has an OS-level (simctl/adb) fallback that is safe
// alongside a Maestro flow, so when a flow holds the lease it runs UNLEASED instead of
// refusing with BUSY_FLOW_ACTIVE. Narrow allowlist (FLOW_FALLBACK_TOOLS) — every other
// interaction tool is still refused during a flow. The flowActive getter lets the handler
// know to take the simctl path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSessionArbiter, arbiterWrap } from '../../dist/lifecycle/device-arbiter.js';

test('#210 arbiter: flowActive getter reflects a held flow lease', () => {
  const a = new DeviceSessionArbiter();
  assert.equal(a.flowActive, false);
  a.tryAcquire('flow', 'maestro_run');
  assert.equal(a.flowActive, true);
});

test('#210 arbiter: device_screenshot runs UNLEASED during a flow (fallback allowlist)', async () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire('flow', 'maestro_run');
  let ran = 0;
  const wrapped = arbiterWrap('device_screenshot', async () => { ran++; return { content: [] }; }, a);
  const res = await wrapped();
  assert.equal(ran, 1, 'screenshot handler must run during a flow (simctl path is flow-safe)');
  assert.ok(!res.isError, 'must not refuse device_screenshot during a flow');
});

test('#210 arbiter: a NON-allowlisted interaction tool is still refused during a flow', async () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire('flow', 'maestro_run');
  const wrapped = arbiterWrap('device_press', async () => ({ content: [] }), a);
  const res = await wrapped();
  assert.equal(res.isError, true);
});

test('#210 arbiter: device_screenshot still acquires a lease when NO flow (coordinates normally)', async () => {
  const a = new DeviceSessionArbiter();
  let snapshotDuring = -1;
  const wrapped = arbiterWrap('device_screenshot', async () => { snapshotDuring = a.snapshot.activeOps; return { content: [] }; }, a);
  await wrapped();
  assert.equal(snapshotDuring, 1, 'with no flow, screenshot holds an interaction lease while running');
});
