import { CDPProbeTimeoutError } from '../cdp/connect.js';
import { targetMatchesSession } from '../tools/status.js';
import { filterTargetsForExactDevice, proveTargetDeviceAssociation, } from './target-device-authority.js';
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export async function connectExactSessionTarget(input, timeoutMs, dependencies) {
    const now = dependencies.now ?? Date.now;
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let exactClient = dependencies.getClient();
    if (exactClient.metroPort !== input.metroPort) {
        await exactClient.disconnect();
        exactClient = dependencies.createClient(input.metroPort);
        dependencies.setClient(exactClient);
    }
    const deadline = now() + timeoutMs;
    let lastError;
    let firstProbeError;
    do {
        try {
            const listed = await exactClient.listTargetsExact(input.metroPort);
            if (listed.port !== input.metroPort) {
                throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: target discovery escaped the allocated Metro port');
            }
            const sessionCandidates = listed.targets.filter((candidate) => targetMatchesSession(candidate, {
                platform: input.platform,
                bundleId: input.appId,
            }));
            const exactCandidates = await filterTargetsForExactDevice({
                platform: input.platform,
                deviceId: input.deviceId,
                targets: sessionCandidates,
            }, dependencies);
            if (exactCandidates.length !== 1) {
                throw new Error(`CDP_TARGET_AUTHORITY_MISMATCH: expected one target on the exact device, found ${exactCandidates.length}`);
            }
            await exactClient.connectExact(input.metroPort, {
                platform: input.platform,
                bundleId: input.appId,
                targetId: exactCandidates[0].id,
            }, 'default', input.platform === 'android' ? 1 : 5);
            const target = exactClient.connectedTarget;
            if (!target ||
                exactClient.metroPort !== input.metroPort ||
                !targetMatchesSession(target, {
                    platform: input.platform,
                    bundleId: input.appId,
                })) {
                throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: exact dev-client target was not found on the claimed Metro');
            }
            await proveTargetDeviceAssociation({
                platform: input.platform,
                deviceId: input.deviceId,
                targetDeviceName: target.deviceName,
            }, dependencies);
            return {
                targetId: target.id,
                connectionGeneration: exactClient.connectionGeneration,
                deviceId: input.deviceId,
            };
        }
        catch (error) {
            lastError = error;
            if (input.platform === 'android') {
                if (error instanceof CDPProbeTimeoutError)
                    firstProbeError ??= error;
                try {
                    await exactClient.disconnect();
                }
                catch { }
                exactClient = dependencies.createClient(input.metroPort);
                dependencies.setClient(exactClient);
            }
        }
        const remainingMs = deadline - now();
        if (remainingMs > 0)
            await wait(Math.min(250, remainingMs));
    } while (now() < deadline);
    const leafError = firstProbeError ?? lastError;
    const leaf = leafError === undefined ? 'no exact target was advertised' : errorMessage(leafError);
    throw new Error(`CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register after launch. Last exact-connect failure: ${leaf}`, { cause: leafError });
}
