import type { CDPClient } from '../cdp-client.js';
import { okResult, withConnection } from '../utils.js';
import { shouldShowMetroClearHint, METRO_CLEAR_HINT_TEXT } from './metro-clear-hint.js';

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

    // M11: include hint when buffer has stayed empty for >60s. The network
    // manager tracks per-device lastPush, so the idle reference is
    // max(connectedAt, lastPush[scope]). 'all' scope has no single lastPush,
    // so fall back to connectedAt only.
    const lastEventAt = scope === 'all' ? null : client.networkBufferManager.getLastPush(scope);
    const hint = shouldShowMetroClearHint(
      { connectedAt: client.connectedAt, lastEventAt: lastEventAt ?? null, now: client.now },
      entries.length === 0,
    ) ? METRO_CLEAR_HINT_TEXT : undefined;
    const resultOpts = hint ? { meta: { hint } } : undefined;

    return okResult({ mode: client.networkMode, device: scope, count: entries.length, requests: entries }, resultOpts);
  });
}
