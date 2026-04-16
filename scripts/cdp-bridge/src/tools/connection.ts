import type { CDPClient } from '../cdp-client.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';

interface ConnectArgs {
  metroPort?: number;
  platform?: string;
  targetId?: string;
  bundleId?: string;
  force?: boolean;
}

interface DisconnectArgs {
  // intentionally empty
}

interface TargetsArgs {
  metroPort?: number;
}

export function createConnectHandler(
  getClient: () => CDPClient,
  setClient: (c: CDPClient) => void,
  createClient: (port: number) => CDPClient,
) {
  return async (args: ConnectArgs): Promise<ToolResult> => {
    let client = getClient();

    // GH #21: Check if already connected to the correct platform
    if (client.isConnected && !args.force) {
      const target = client.connectedTarget;
      if (args.platform) {
        const requestedPlatform = args.platform.toLowerCase();
        const currentPlatform = target?.platform?.toLowerCase();
        const titleMatch = `${target?.title ?? ''} ${target?.description ?? ''}`.toLowerCase().includes(requestedPlatform);
        if (currentPlatform !== requestedPlatform && !titleMatch) {
          // Platform mismatch — force reconnection to correct target
          await client.disconnect();
          client = createClient(client.metroPort);
          setClient(client);
        } else {
          return okResult({
            alreadyConnected: true,
            port: client.metroPort,
            target: target ? { id: target.id, title: target.title, vm: target.vm, platform: target.platform ?? null } : null,
          });
        }
      } else {
        return okResult({
          alreadyConnected: true,
          port: client.metroPort,
          target: target ? { id: target.id, title: target.title, vm: target.vm, platform: target.platform ?? null } : null,
        });
      }
    } else if (client.isConnected && args.force) {
      // Force reconnection regardless of current state
      const port = args.metroPort ?? client.metroPort;
      await client.disconnect();
      client = createClient(port);
      setClient(client);
    }

    if (args.metroPort && args.metroPort !== client.metroPort) {
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
    } catch (err) {
      return failResult(err instanceof Error ? err.message : String(err));
    }
  };
}

export function createDisconnectHandler(
  getClient: () => CDPClient,
  setClient: (c: CDPClient) => void,
  createClient: (port: number) => CDPClient,
) {
  return async (_args: DisconnectArgs): Promise<ToolResult> => {
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

export function createTargetsHandler(getClient: () => CDPClient) {
  return async (args: TargetsArgs): Promise<ToolResult> => {
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
    } catch (err) {
      return failResult(err instanceof Error ? err.message : String(err));
    }
  };
}
