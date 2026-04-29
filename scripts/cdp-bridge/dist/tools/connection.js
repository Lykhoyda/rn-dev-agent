import { okResult, failResult } from '../utils.js';
export function createConnectHandler(getClient, setClient, createClient) {
    return async (args) => {
        let client = getClient();
        // CDP-001 + GH #21: when already connected, compare ALL requested filter
        // dimensions before short-circuiting. Previous logic only checked platform
        // and silently kept stale targets when targetId/bundleId/metroPort
        // changed, leaving callers attached to the wrong Hermes page.
        if (client.isConnected && !args.force) {
            const target = client.connectedTarget;
            const haystack = `${target?.title ?? ''} ${target?.description ?? ''}`.toLowerCase();
            const portMismatch = typeof args.metroPort === 'number' && args.metroPort !== client.metroPort;
            const targetIdMismatch = typeof args.targetId === 'string' && args.targetId.length > 0 && args.targetId !== target?.id;
            const bundleMismatch = typeof args.bundleId === 'string' && args.bundleId.length > 0
                && !haystack.includes(args.bundleId.toLowerCase());
            let platformMismatch = false;
            if (typeof args.platform === 'string' && args.platform.length > 0) {
                const requestedPlatform = args.platform.toLowerCase();
                const currentPlatform = target?.platform?.toLowerCase();
                const titleMatch = haystack.includes(requestedPlatform);
                platformMismatch = currentPlatform !== requestedPlatform && !titleMatch;
            }
            if (portMismatch || targetIdMismatch || bundleMismatch || platformMismatch) {
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
                    target: target ? { id: target.id, title: target.title, vm: target.vm, platform: target.platform ?? null } : null,
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
            const msg = await client.autoConnect(args.metroPort, {
                platform: args.platform,
                targetId: args.targetId,
                bundleId: args.bundleId,
            });
            const target = client.connectedTarget;
            return okResult({
                connected: true,
                message: msg,
                port: client.metroPort,
                target: target ? { id: target.id, title: target.title, vm: target.vm, platform: target.platform ?? null, description: target.description ?? null } : null,
            });
        }
        catch (err) {
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
                targets: targets.map(t => ({
                    id: t.id,
                    title: t.title,
                    vm: t.vm,
                    description: t.description ?? null,
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
