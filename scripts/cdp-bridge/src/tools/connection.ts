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

    // CDP-001 + GH #21: when already connected, compare ALL requested filter
    // dimensions before short-circuiting. Previous logic only checked platform
    // and silently kept stale targets when targetId/bundleId/metroPort
    // changed, leaving callers attached to the wrong Hermes page.
    if (client.isConnected && !args.force) {
      const target = client.connectedTarget;
      const haystack = `${target?.title ?? ''} ${target?.description ?? ''}`.toLowerCase();

      const portMismatch = typeof args.metroPort === 'number' && args.metroPort !== client.metroPort;
      const targetIdMismatch = typeof args.targetId === 'string' && args.targetId.length > 0 && args.targetId !== target?.id;
      // Phase 134.5 (deepsec BUG: other-logic-bug): the prior substring
      // check would treat `com.example.app` as "already connected" when
      // the actual target is `com.example.app-test` or `com.example.app2`
      // — anything that contained the bundleId as a substring. Use a
      // word-boundary check anchored on non-bundle-id characters so
      // `com.example.app` matches `... com.example.app ...` but not
      // `... com.example.app-test ...`. Bundle IDs use `[A-Za-z0-9._-]`,
      // so the boundary must be anything outside that set.
      const bundleIdLower = typeof args.bundleId === 'string' ? args.bundleId.toLowerCase() : '';
      const bundleMatched = bundleIdLower.length > 0
        && new RegExp(`(^|[^A-Za-z0-9._-])${bundleIdLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9._-]|$)`).test(haystack);
      const bundleMismatch = typeof args.bundleId === 'string' && args.bundleId.length > 0 && !bundleMatched;
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
    } else if (typeof args.metroPort === 'number' && args.metroPort !== client.metroPort) {
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
