import { okResult, failResult } from '../utils.js';
export function createConnectHandler(getClient, setClient, createClient) {
    return async (args) => {
        let client = getClient();
        if (client.isConnected) {
            const target = client.connectedTarget;
            return okResult({
                alreadyConnected: true,
                port: client.metroPort,
                target: target ? { id: target.id, title: target.title, vm: target.vm } : null,
            });
        }
        if (args.metroPort && args.metroPort !== client.metroPort) {
            await client.disconnect();
            client = createClient(args.metroPort);
            setClient(client);
        }
        try {
            const msg = await client.autoConnect(args.metroPort, args.platform);
            const target = client.connectedTarget;
            return okResult({
                connected: true,
                message: msg,
                port: client.metroPort,
                target: target ? { id: target.id, title: target.title, vm: target.vm } : null,
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
