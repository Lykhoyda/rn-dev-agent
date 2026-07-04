import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  getAndroidRunnerCapabilities,
  _setFetchForTest as setAndroidFetch,
  _resetCapabilitiesForTest as resetAndroidCaps,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import { buildIosProbes, buildAndroidProbes } from '../../dist/lifecycle/settle.js';
import {
  runIOS,
  _setFetchForTest as setIosFetch,
  _setFastRunnerStateForTest,
  _resetCapabilitiesForTest as resetIosCaps,
} from '../../dist/runners/rn-fast-runner-client.js';

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });

const iosState = () => ({
  schemaVersion: 1, pid: process.pid, port: 22090,
  deviceId: 'TEST-UDID', bundleId: 'com.test', startedAt: '', protocolVersion: 1,
});

afterEach(() => {
  setIosFetch(globalThis.fetch);
  setAndroidFetch(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setAndroidRunnerStateForTest(null);
  resetAndroidCaps();
  resetIosCaps();
});

test('android /health probe parses + caches capabilities', async () => {
  setAndroidFetch(async () =>
    jsonResponse({ ok: true, protocolVersion: 1, capabilities: ['WINDOW_UPDATE'], commands: [] }),
  );
  const info = await probeAndroidRunnerHealthInfo(12345);
  assert.deepEqual(info.capabilities, ['WINDOW_UPDATE']);
  assert.deepEqual(getAndroidRunnerCapabilities(), ['WINDOW_UPDATE']);
});

test('runIOS dispatches isScreenStatic and returns {static}', async () => {
  _setFastRunnerStateForTest(iosState());
  let posted;
  setIosFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { static: true }, v: 1 });
  });
  const result = await runIOS({ command: 'isScreenStatic', bundleId: 'com.test' });
  assert.equal(posted.command, 'isScreenStatic');
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.data.static, true);
});

test('buildIosProbes.isScreenStatic maps envelope → boolean, failure → null', async () => {
  _setFastRunnerStateForTest(iosState());
  setIosFetch(async () => jsonResponse({ ok: true, data: { static: false }, v: 1 }));
  const probes = buildIosProbes('com.test');
  assert.equal(await probes.isScreenStatic(), false);
  setIosFetch(async () => { throw new Error('boom'); });
  assert.equal(await probes.isScreenStatic(), null);
});

test('buildAndroidProbes.isWindowUpdating posts timeoutMs and maps {updating}', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1, hostPort: 23456, devicePort: 7100, pid: process.pid,
    startedAt: '', protocolVersion: 1,
  });
  let posted;
  setAndroidFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { updating: false }, v: 1 });
  });
  const probes = buildAndroidProbes('com.test');
  assert.equal(await probes.isWindowUpdating(100), false);
  assert.equal(posted.timeoutMs, 100);
  assert.equal(posted.command, 'isWindowUpdating');
});

test('android probes degrade to null when the pinned host port no longer matches', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1, hostPort: 23456, devicePort: 7100, pid: process.pid,
    startedAt: '', protocolVersion: 1,
  });
  setAndroidFetch(async () => {
    throw new Error('must not post — pinned port mismatch');
  });
  const probes = buildAndroidProbes('com.test'); // pins 23456
  _setAndroidRunnerStateForTest({
    schemaVersion: 1, hostPort: 29999, devicePort: 7100, pid: process.pid,
    startedAt: '', protocolVersion: 1,
  });
  assert.equal(await probes.isWindowUpdating(100), null);
  assert.equal(await probes.snapshotHash(), null);
});
