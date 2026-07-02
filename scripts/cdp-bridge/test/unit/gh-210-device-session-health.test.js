// GH #210 Task 1: cdp_status.deviceSession reports the iOS rn-fast-runner liveness
// so the agent can see the XCUITest runner state before calling device_*. iOS-gated:
// the /health probe (:22088) and the foreign-runner `ps ax` scan run ONLY for an iOS
// session — Android leaves rnFastRunner:'dead' and skips both (A4, multi-review).
// GH #383: the probe is now the DETAILED variant ({liveness, staleReason,
// runnerProtocolVersion, runnerVersion}) and the health carries a runnerProtocol
// block whenever the runner is reachable (liveness !== 'dead').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceSessionHealth } from '../../dist/tools/device-session-health.js';
import { _setPluginVersionForTest } from '../../dist/runners/protocol.js';

const session = (over = {}) => ({
  name: 's',
  platform: 'ios',
  deviceId: 'UDID-1',
  openedAt: 'now',
  appId: 'com.x',
  ...over,
});

test('#210 health: no active session → sessionOpen:false, rnFastRunner:dead, probe NOT called', async () => {
  let probed = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => null,
    probeLiveness: async () => {
      probed++;
      return { liveness: 'alive' };
    },
    adopt: () => {},
  });
  assert.deepEqual(h, { sessionOpen: false, rnFastRunner: 'dead' });
  assert.equal(probed, 0, 'must not probe /health when no session is open');
});

test('#210 health: Android session → rnFastRunner:dead, probe + detectForeign NOT called (iOS-only)', async () => {
  let probed = 0,
    detected = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session({ platform: 'android' }),
    probeLiveness: async () => {
      probed++;
      return { liveness: 'alive' };
    },
    detectForeign: async () => {
      detected++;
      return { detected: true };
    },
    adopt: () => {},
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, 'dead', 'Android never uses the iOS runner');
  assert.equal(probed, 0, 'must not probe :22088 on Android');
  assert.equal(detected, 0, 'must not run the ps-scan on Android');
  assert.equal(h.foreignRunner, undefined);
});

test('#210 health: session open + runner alive → reports alive + appId/deviceId', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive' }),
    adopt: () => {},
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, 'alive');
  assert.equal(h.appId, 'com.x');
  assert.equal(h.deviceId, 'UDID-1');
});

test('#210 health: session open + runner stale → reports stale', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'stale' }),
    adopt: () => {},
  });
  assert.equal(h.rnFastRunner, 'stale');
});

test('#210 health: probe throws → degrades to dead (never throws)', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => {
      throw new Error('boom');
    },
    adopt: () => {},
  });
  assert.equal(h.rnFastRunner, 'dead');
});

test('#210 health: foreign Maestro/WDA flow detected → foreignRunner.detected', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive' }),
    detectForeign: async (udid) => (udid === 'UDID-1' ? { detected: true } : null),
    adopt: () => {},
  });
  assert.deepEqual(h.foreignRunner, { detected: true });
});

test('#210 health: detectForeign throws → omitted (best-effort, never throws)', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive' }),
    detectForeign: async () => {
      throw new Error('ps failed');
    },
    adopt: () => {},
  });
  assert.equal(h.foreignRunner, undefined);
});

test('gh-383: iOS session health reports runnerProtocol from the detailed probe', async () => {
  // Pin the plugin-version read to null: the real .claude-plugin/plugin.json is
  // reachable from dist in this repo and would otherwise leak a pluginVersion
  // key into the deepEqual below.
  _setPluginVersionForTest(null);
  try {
    const health = await getDeviceSessionHealth({
      getActiveSession: () => ({
        name: 's',
        platform: 'ios',
        deviceId: 'U1',
        appId: 'com.example',
        openedAt: 'now',
      }),
      probeLiveness: async () => ({
        liveness: 'stale',
        staleReason: 'version-skew',
        runnerProtocolVersion: 1,
        runnerVersion: '0.57.1',
      }),
      adopt: () => {},
    });
    assert.equal(health.rnFastRunner, 'stale');
    assert.deepEqual(health.runnerProtocol, {
      expected: 1,
      runner: 1,
      runnerVersion: '0.57.1',
      compatible: false,
    });
  } finally {
    _setPluginVersionForTest(undefined);
  }
});

test('gh-383: dead runner → no runnerProtocol block; alive runner → compatible:true', async () => {
  _setPluginVersionForTest(null);
  try {
    const dead = await getDeviceSessionHealth({
      getActiveSession: () => session(),
      probeLiveness: async () => ({ liveness: 'dead' }),
      adopt: () => {},
    });
    assert.equal(dead.rnFastRunner, 'dead');
    assert.equal(dead.runnerProtocol, undefined, 'unreachable runner has no protocol to report');

    const alive = await getDeviceSessionHealth({
      getActiveSession: () => session(),
      probeLiveness: async () => ({
        liveness: 'alive',
        runnerProtocolVersion: 1,
        runnerVersion: '0.57.1',
      }),
      adopt: () => {},
    });
    assert.deepEqual(alive.runnerProtocol, {
      expected: 1,
      runner: 1,
      runnerVersion: '0.57.1',
      compatible: true,
    });
  } finally {
    _setPluginVersionForTest(undefined);
  }
});

test('gh-383: adopt seam is called with the session deviceId before probing', async () => {
  const calls = [];
  await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive' }),
    adopt: (deviceId) => calls.push(deviceId),
  });
  assert.deepEqual(calls, ['UDID-1']);
});
