import type { CDPClient } from '../cdp-client.js';
import { okResult, withConnection } from '../utils.js';

export function createNetworkLogHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { limit: number; filter?: string; clear: boolean; device?: string }, client) => {
    const scope = args.device ?? client.activeDeviceKey;

    if (args.clear) {
      client.networkBufferManager.clear(scope === 'all' ? undefined : scope);
      return okResult({ cleared: true, device: scope });
    }

    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

    let entries = args.filter !== undefined
      ? client.networkBufferManager.filter(scope, (e) => e.url.includes(args.filter!))
      : client.networkBufferManager.getLast(scope, limit);

    if (args.filter !== undefined && entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return okResult({ mode: client.networkMode, device: scope, count: entries.length, requests: entries });
  });
}
