import type { CDPClient } from '../cdp-client.js';
import { okResult, withConnection } from '../utils.js';
import { shouldShowMetroClearHint, METRO_CLEAR_HINT_TEXT } from './metro-clear-hint.js';
import { drainNetworkHookBuffer } from '../cdp/net-hook-drain.js';

export interface NetworkLogArgs {
  limit: number;
  filter?: string;
  method?: string | string[];
  since?: string;
  clear: boolean;
  device?: string;
}

export function createNetworkLogHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: NetworkLogArgs, client) => {
    const scope = args.device ?? client.activeDeviceKey;
    // Drain targets the active device; `scope` only filters the read — intentionally decoupled.
    await drainNetworkHookBuffer(client);

    if (args.clear) {
      client.networkBufferManager.clear(scope === 'all' ? undefined : scope);
      return okResult({ cleared: true, device: scope });
    }

    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);

    const wantedMethods = args.method
      ? (Array.isArray(args.method) ? args.method : [args.method]).map((m) => m.toUpperCase())
      : null;
    // Normalize since to UTC Z-form. Entry timestamps come from
    // `new Date().toISOString()` (always Z), so a user-supplied offset like
    // `+02:00` would mis-compare under naive lexicographic order.
    let since: string | undefined;
    if (args.since !== undefined) {
      const parsed = new Date(args.since);
      since = Number.isNaN(parsed.getTime()) ? args.since : parsed.toISOString();
    }
    const urlNeedle = args.filter;

    const hasFilters = urlNeedle !== undefined || wantedMethods !== null || since !== undefined;

    let matches = hasFilters
      ? client.networkBufferManager.filter(scope, (e) => {
          if (urlNeedle !== undefined && !e.url.includes(urlNeedle)) return false;
          if (since !== undefined && e.timestamp < since) return false;
          if (wantedMethods !== null && !wantedMethods.includes(e.method.toUpperCase())) return false;
          return true;
        })
      : client.networkBufferManager.getLast(scope, limit);

    // True candidate count before the limit slice. The filtered path already
    // holds every match in `matches`; the unfiltered getLast() caps at `limit`,
    // so consult the buffer size to know whether older entries were dropped —
    // otherwise truncated could never be true on the unfiltered path.
    const totalMatches = hasFilters
      ? matches.length
      : (scope === 'all' ? client.networkBufferManager.totalSize : client.networkBufferManager.size(scope));
    const sliced = matches.length > limit ? matches.slice(-limit) : matches;
    const truncated = totalMatches > sliced.length;

    const lastEventAt = scope === 'all' ? null : client.networkBufferManager.getLastPush(scope);
    const hint = shouldShowMetroClearHint(
      { connectedAt: client.connectedAt, lastEventAt: lastEventAt ?? null, now: client.now },
      sliced.length === 0,
    ) ? METRO_CLEAR_HINT_TEXT : undefined;
    const resultOpts = hint ? { meta: { hint } } : undefined;

    return okResult(
      {
        mode: client.networkMode,
        device: scope,
        count: sliced.length,
        requests: sliced,
        ...(truncated ? { truncated: true, total_matches: totalMatches } : {}),
      },
      resultOpts,
    );
  });
}
