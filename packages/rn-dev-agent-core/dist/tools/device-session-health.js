import { getActiveSession as defaultGetActiveSession } from '../agent-device-wrapper.js';
import { probeFastRunnerLivenessDetailed, adoptPersistedFastRunnerState, getFastRunnerState, } from '../runners/rn-fast-runner-client.js';
import { RUNNER_PROTOCOL_VERSION, getPluginVersion } from '../runners/protocol.js';
export async function getDeviceSessionHealth(deps = {}) {
    const getSession = deps.getActiveSession ?? defaultGetActiveSession;
    const probe = deps.probeLiveness ?? probeFastRunnerLivenessDetailed;
    const session = getSession();
    if (!session)
        return { sessionOpen: false, rnFastRunner: 'dead' };
    const health = { sessionOpen: true, rnFastRunner: 'dead' };
    if (session.appId)
        health.appId = session.appId;
    if (session.deviceId)
        health.deviceId = session.deviceId;
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
                    ...(detail.missingCommands !== undefined
                        ? { missingCommands: detail.missingCommands }
                        : {}),
                    compatible: detail.liveness === 'alive',
                };
                // GH #384: omit empty lists — every pre-#384 runner reports
                // capabilities: [] from /health, so surfacing [] would add noise to
                // every cdp_status call. Absence = "runner alive, no capabilities active".
                if (detail.capabilities !== undefined && detail.capabilities.length > 0) {
                    health.runnerCapabilities = detail.capabilities;
                }
                // GH #382: report the artifact provenance recorded at start (adopt() above
                // loaded the per-device state a reachable runner would reuse).
                const runnerState = (deps.getRunnerState ?? getFastRunnerState)();
                if (runnerState?.provenance)
                    health.runnerProvenance = runnerState.provenance;
            }
        }
        catch {
            health.rnFastRunner = 'dead';
        }
        if (deps.detectForeign) {
            try {
                const f = await deps.detectForeign(session.deviceId);
                if (f)
                    health.foreignRunner = f;
            }
            catch {
                /* best-effort: a failed ps scan must never fail cdp_status */
            }
        }
    }
    return health;
}
