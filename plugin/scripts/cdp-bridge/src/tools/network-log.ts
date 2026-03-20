import type { CDPClient } from '../cdp-client.js';
import { okResult, withConnection } from '../utils.js';

export function createNetworkLogHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { limit: number; filter?: string; clear: boolean }, client) => {
    if (args.clear) {
      client.networkBuffer.clear();
      return okResult({ cleared: true });
    }

    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

    let entries = args.filter !== undefined
      ? client.networkBuffer.filter(e => e.url.includes(args.filter!))
      : client.networkBuffer.getLast(limit);

    if (args.filter !== undefined && entries.length > limit) {
      entries = entries.slice(-limit);
    }

    return okResult({ mode: client.networkMode, count: entries.length, requests: entries });
  });
}
