// GH #382 (Story 01): cdp_status.deviceSession surfaces how the iOS rn-fast-runner
// artifact was obtained (prebuilt cache/download vs local xcodebuild) so /doctor can
// report "prebuilt v<X>" vs "local-built".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceSessionHealth } from '../../dist/tools/device-session-health.js';

const session = (over = {}) => ({
  name: 's',
  platform: 'ios',
  deviceId: 'UDID-1',
  openedAt: 'now',
  appId: 'com.x',
  ...over,
});

test('#382 health: reports runnerProvenance from persisted state when runner alive', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive', runnerVersion: '0.62.3' }),
    adopt: () => {},
    getRunnerState: () => ({ provenance: 'prebuilt' }),
  });
  assert.equal(h.runnerProvenance, 'prebuilt');
});

test('#382 health: does not read/report provenance when runner is dead', async () => {
  let reads = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'dead' }),
    adopt: () => {},
    getRunnerState: () => {
      reads++;
      return { provenance: 'prebuilt' };
    },
  });
  assert.equal(h.runnerProvenance, undefined);
  assert.equal(reads, 0, 'a dead runner has no meaningful provenance to report');
});

test('#382 health: omits runnerProvenance when state records none', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => ({ liveness: 'alive' }),
    adopt: () => {},
    getRunnerState: () => ({}),
  });
  assert.equal(h.runnerProvenance, undefined);
});
