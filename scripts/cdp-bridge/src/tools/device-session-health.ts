import type { FastRunnerLiveness } from '../runners/rn-fast-runner-client.js';
import type { SessionState } from '../types.js';
import { getActiveSession as defaultGetActiveSession } from '../agent-device-wrapper.js';
import { probeFastRunnerLiveness } from '../runners/rn-fast-runner-client.js';

export interface DeviceSessionHealth {
  sessionOpen: boolean;
  rnFastRunner: FastRunnerLiveness;
  appId?: string;
  deviceId?: string;
  foreignRunner?: { detected: true };
}

export interface DeviceSessionHealthDeps {
  getActiveSession?: () => SessionState | null;
  probeLiveness?: () => Promise<FastRunnerLiveness>;
  detectForeign?: (udid?: string) => Promise<{ detected: true } | null>;
}

export async function getDeviceSessionHealth(
  deps: DeviceSessionHealthDeps = {},
): Promise<DeviceSessionHealth> {
  const getSession = deps.getActiveSession ?? defaultGetActiveSession;
  const probe = deps.probeLiveness ?? probeFastRunnerLiveness;

  const session = getSession();
  if (!session) return { sessionOpen: false, rnFastRunner: 'dead' };

  const health: DeviceSessionHealth = { sessionOpen: true, rnFastRunner: 'dead' };
  if (session.appId) health.appId = session.appId;
  if (session.deviceId) health.deviceId = session.deviceId;

  if (session.platform === 'ios') {
    try {
      health.rnFastRunner = await probe();
    } catch {
      health.rnFastRunner = 'dead';
    }
    if (deps.detectForeign) {
      try {
        const f = await deps.detectForeign(session.deviceId);
        if (f) health.foreignRunner = f;
      } catch {
        /* best-effort: a failed ps scan must never fail cdp_status */
      }
    }
  }
  return health;
}
