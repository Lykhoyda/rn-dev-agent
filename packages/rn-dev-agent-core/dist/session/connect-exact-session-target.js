import { targetMatchesSession } from '../tools/status.js';
import { filterTargetsForExactDevice, proveTargetDeviceAssociation, } from './target-device-authority.js';
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Connect the production session pin to exactly one app/device target on its
 * allocated Metro. Each listing gets only one transport attempt: a stale target
 * is fully reset before the next exact-port listing, rather than monopolizing
 * the outer re-registration deadline with CDP's ordinary five-attempt loop.
 */
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
            }, 'default', 1);
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
            // A successful handshake can still leave transport state and pending CDP
            // work behind when the mandatory probe times out. Reset the whole client
            // before re-listing; no stale socket or debugger runs in parallel.
            try {
                await exactClient.disconnect();
            }
            catch {
                // Replacement below is the fail-closed reset even if close itself errs.
            }
            exactClient = dependencies.createClient(input.metroPort);
            dependencies.setClient(exactClient);
        }
        const remainingMs = deadline - now();
        if (remainingMs > 0)
            await wait(Math.min(250, remainingMs));
    } while (now() < deadline);
    const leaf = lastError === undefined ? 'no exact target was advertised' : errorMessage(lastError);
    throw new Error(`CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register after launch. Last exact-connect failure: ${leaf}`, { cause: lastError });
}
