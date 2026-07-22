import { okResult, failResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { sessionConnectFilters, targetMatchesSession } from './status.js';
import { TargetSelectionError } from '../cdp/discovery.js';
export function createConnectHandler(getClient, setClient, createClient) {
    return async (args) => {
        let client = getClient();
        const session = getActiveSession();
        const sessionFilters = sessionConnectFilters(session);
        if (args.platform &&
            sessionFilters?.platform &&
            args.platform.toLowerCase() !== sessionFilters.platform) {
            return failResult(`cdp_connect requested ${args.platform}, but the active session is bound to ${sessionFilters.platform}; refusing cross-platform fallback. This is platform affinity, not iOS UDID identity.`, 'TARGET_SESSION_MISMATCH', { deviceSession: session });
        }
        if (args.bundleId &&
            sessionFilters?.bundleId &&
            args.bundleId.toLowerCase() !== sessionFilters.bundleId.toLowerCase()) {
            return failResult(`cdp_connect requested bundleId ${args.bundleId}, but the active session is bound to ${sessionFilters.bundleId}.`, 'TARGET_SESSION_MISMATCH', { deviceSession: session });
        }
        const effectiveFilters = {
            ...sessionFilters,
            ...(args.platform ? { platform: args.platform.toLowerCase() } : {}),
            ...(args.bundleId ? { bundleId: args.bundleId } : {}),
            ...(args.targetId ? { targetId: args.targetId } : {}),
        };
        // CDP-001 + GH #21: when already connected, compare ALL requested filter
        // dimensions before short-circuiting. Previous logic only checked platform
        // and silently kept stale targets when targetId/bundleId/metroPort
        // changed, leaving callers attached to the wrong Hermes page.
        if (client.isConnected && !args.force) {
            const target = client.connectedTarget;
            const portMismatch = typeof args.metroPort === 'number' && args.metroPort !== client.metroPort;
            const targetIdMismatch = typeof effectiveFilters.targetId === 'string' &&
                effectiveFilters.targetId.length > 0 &&
                effectiveFilters.targetId !== target?.id;
            // Bundle authority is enforced inside targetMatchesSession, which must
            // come from one internally consistent Metro identity field, never an
            // arbitrary token elsewhere in title/argv-like prose.
            const sessionMismatch = !targetMatchesSession(target ?? null, effectiveFilters);
            if (portMismatch || targetIdMismatch || sessionMismatch) {
                // Honour requested filters by reconnecting; fall through to autoConnect below.
                const port = args.metroPort ?? client.metroPort;
                await client.disconnect();
                client = createClient(port);
                setClient(client);
            }
            else {
                return okResult({
                    alreadyConnected: true,
                    port: client.metroPort,
                    target: target
                        ? {
                            id: target.id,
                            title: target.title,
                            vm: target.vm,
                            platform: target.platform ?? null,
                        }
                        : null,
                });
            }
        }
        else if (client.isConnected && args.force) {
            // Force reconnection regardless of current state
            const port = args.metroPort ?? client.metroPort;
            await client.disconnect();
            client = createClient(port);
            setClient(client);
        }
        else if (typeof args.metroPort === 'number' && args.metroPort !== client.metroPort) {
            // Not connected yet but a different port was requested — re-create the
            // client on the new port before autoConnect.
            await client.disconnect();
            client = createClient(args.metroPort);
            setClient(client);
        }
        try {
            const msg = await client.autoConnect(args.metroPort, effectiveFilters);
            const target = client.connectedTarget;
            if (!targetMatchesSession(target, effectiveFilters)) {
                await client.disconnect();
                throw new TargetSelectionError(effectiveFilters.targetId ? 'TARGET_PLATFORM_CONFLICT' : 'PLATFORM_TARGET_NOT_FOUND', `Connected target failed post-connect affinity validation for platform=${effectiveFilters.platform ?? 'unspecified'} bundleId=${effectiveFilters.bundleId ?? 'unspecified'}. The socket was disconnected; run cdp_targets and relaunch the requested app.`, target ? [target] : []);
            }
            return okResult({
                connected: true,
                message: msg,
                port: client.metroPort,
                target: target
                    ? {
                        id: target.id,
                        title: target.title,
                        vm: target.vm,
                        platform: target.platform ?? null,
                        description: target.description ?? null,
                        appId: target.appId ?? null,
                    }
                    : null,
            });
        }
        catch (err) {
            if (err instanceof TargetSelectionError) {
                // Refusal must not wedge the session: disconnect() disposes the shared
                // client, so recreate it (mirrors createDisconnectHandler) or every
                // later cdp_connect/cdp_status fails with "Client is disposed".
                const port = client.metroPort;
                await client.disconnect().catch(() => undefined);
                setClient(createClient(port));
                return failResult(err.message, err.code, {
                    candidates: err.candidates.map((target) => ({
                        id: target.id,
                        title: target.title,
                        deviceName: target.deviceName ?? null,
                        description: target.description ?? null,
                        appId: target.appId ?? null,
                        platform: target.platform ?? null,
                        confidence: target.platformInference ?? 'probed',
                    })),
                    affinity: 'cross-platform-only; iOS UDID identity is unavailable from Metro',
                });
            }
            return failResult(err instanceof Error ? err.message : String(err));
        }
    };
}
export function createDisconnectHandler(getClient, setClient, createClient) {
    return async (_args) => {
        const client = getClient();
        const wasConnected = client.isConnected;
        const port = client.metroPort;
        await client.disconnect();
        setClient(createClient(port));
        return okResult({
            disconnected: true,
            wasConnected,
        });
    };
}
export function createTargetsHandler(getClient) {
    return async (args) => {
        const client = getClient();
        try {
            const { port, targets } = await client.listTargets(args.metroPort);
            const connectedId = client.connectedTarget?.id ?? null;
            return okResult({
                port,
                count: targets.length,
                connectedTargetId: connectedId,
                targets: targets.map((t) => ({
                    id: t.id,
                    title: t.title,
                    vm: t.vm,
                    description: t.description ?? null,
                    appId: t.appId ?? null,
                    platform: t.platform ?? null,
                    connected: t.id === connectedId,
                })),
            });
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
    };
}
