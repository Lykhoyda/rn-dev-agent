// GH #418: cdp_status.deviceSession.runnerProtocol names the missing verbs so
// a stale artifact is diagnosable before any device_* call fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceSessionHealth } from '../../dist/tools/device-session-health.js';

const SESSION = { platform: 'ios', appId: 'com.example', deviceId: 'U1' };

test('gh-418 status: stale/missing-commands surfaces missingCommands', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => SESSION,
    adopt: () => {},
    probeLiveness: async () => ({
      liveness: 'stale',
      staleReason: 'missing-commands',
      missingCommands: ['keyboardDismiss'],
      runnerProtocolVersion: 1,
    }),
  });
  assert.equal(h.rnFastRunner, 'stale');
  assert.deepEqual(h.runnerProtocol?.missingCommands, ['keyboardDismiss']);
  assert.equal(h.runnerProtocol?.compatible, false);
});

test('gh-418 status: alive runner has no missingCommands key', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => SESSION,
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1 }),
  });
  assert.equal('missingCommands' in (h.runnerProtocol ?? {}), false);
});
