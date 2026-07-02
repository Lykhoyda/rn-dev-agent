import type {
  FastRunnerLiveness,
  FastRunnerLivenessDetail,
} from '../runners/rn-fast-runner-client.js';
import type { SessionState } from '../types.js';
import { getActiveSession as defaultGetActiveSession } from '../agent-device-wrapper.js';
import {
  probeFastRunnerLivenessDetailed,
  adoptPersistedFastRunnerState,
} from '../runners/rn-fast-runner-client.js';
import { RUNNER_PROTOCOL_VERSION, getPluginVersion } from '../runners/protocol.js';

export interface DeviceSessionHealth {
  sessionOpen: boolean;
  rnFastRunner: FastRunnerLiveness;
  appId?: string;
  deviceId?: string;
  foreignRunner?: { detected: true };
  runnerProtocol?: {
    expected: number;
    runner?: number;
    runnerVersion?: string;
    pluginVersion?: string;
    compatible: boolean;
  };
}

export interface DeviceSessionHealthDeps {
  getActiveSession?: () => SessionState | null;
  probeLiveness?: () => Promise<FastRunnerLivenessDetail>;
  detectForeign?: (udid?: string) => Promise<{ detected: true } | null>;
  adopt?: (deviceId: string | undefined) => void;
}

export async function getDeviceSessionHealth(
  deps: DeviceSessionHealthDeps = {},
): Promise<DeviceSessionHealth> {
  const getSession = deps.getActiveSession ?? defaultGetActiveSession;
  const probe = deps.probeLiveness ?? probeFastRunnerLivenessDetailed;

  const session = getSession();
  if (!session) return { sessionOpen: false, rnFastRunner: 'dead' };

  const health: DeviceSessionHealth = { sessionOpen: true, rnFastRunner: 'dead' };
  if (session.appId) health.appId = session.appId;
  if (session.deviceId) health.deviceId = session.deviceId;

  if (session.platform === 'ios') {
    // GH #383: adopt persisted per-device runner state before probing so a
    // respawned bridge worker reports the runner it would actually reuse.
    const adopt = deps.adopt ?? adoptPersistedFastRunnerState;
    adopt(session.deviceId);
    try {
      const detail = await probe();
      health.rnFastRunner = detail.liveness;
      if (detail.liveness !== 'dead') {
        const plugin = getPluginVersion();
        health.runnerProtocol = {
          expected: RUNNER_PROTOCOL_VERSION,
          ...(detail.runnerProtocolVersion !== undefined
            ? { runner: detail.runnerProtocolVersion }
            : {}),
          ...(detail.runnerVersion !== undefined ? { runnerVersion: detail.runnerVersion } : {}),
          ...(plugin !== null ? { pluginVersion: plugin } : {}),
          compatible: detail.liveness === 'alive',
        };
      }
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
