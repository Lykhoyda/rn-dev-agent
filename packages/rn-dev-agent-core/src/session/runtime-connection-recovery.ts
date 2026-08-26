import type { CDPClient } from '../cdp-client.js';
import type { SessionStatus } from './registry.js';

const RECONNECT_WAIT_MS = 30_000;

export async function recoverAuthoritativeRuntimeConnection(
  status: SessionStatus,
  client: CDPClient,
  dependencies: {
    getClient(): CDPClient;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<CDPClient> {
  if (client !== dependencies.getClient()) return client;
  const metro = status.bindings.metro as { port?: unknown } | undefined;
  const device = status.bindings.device as { platform?: unknown; appId?: unknown } | undefined;
  const metroPort = metro?.port;
  const platform = device?.platform;
  const appId = device?.appId;
  if (
    !Number.isSafeInteger(metroPort) ||
    (platform !== 'ios' && platform !== 'android') ||
    typeof appId !== 'string' ||
    !client.matchesAuthoritativeSessionPolicy(Number(metroPort), {
      platform,
      bundleId: appId,
    })
  ) {
    return client;
  }

  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (client.reconnectState.active) {
    const deadline = now() + RECONNECT_WAIT_MS;
    while (client.reconnectState.active && now() < deadline) await wait(500);
    if (client.reconnectState.active || !client.isConnected) {
      throw new Error('RECONNECT_TIMEOUT: authoritative background reconnect did not complete');
    }
  } else if (!client.isConnected) {
    await client.autoConnect();
  }
  return dependencies.getClient();
}

export async function withRecoveredAuthoritativeRuntime<T>(
  status: SessionStatus,
  connectedClient: CDPClient,
  operation: (client: CDPClient) => Promise<T>,
  dependencies: { getClient(): CDPClient },
): Promise<T> {
  let client = await recoverAuthoritativeRuntimeConnection(status, connectedClient, dependencies);
  try {
    return await operation(client);
  } catch (error) {
    if (
      client !== dependencies.getClient() ||
      (client.isConnected && !client.reconnectState.active)
    ) {
      throw error;
    }
    client = await recoverAuthoritativeRuntimeConnection(status, client, dependencies);
    return operation(client);
  }
}
