import { applyNetworkHookEntry } from './event-handlers.js';
import { logger } from '../logger.js';
import type { DeviceBufferManager } from '../ring-buffer.js';
import type { NetworkEntry } from '../types.js';

const DRAIN_EXPR = `(function(){
  var b = globalThis.__RN_AGENT_NET_BUF__ || [];
  globalThis.__RN_AGENT_NET_BUF__ = [];
  return JSON.stringify(b);
})()`;

interface DrainableClient {
  networkMode: 'cdp' | 'hook' | 'none';
  activeDeviceKey: string;
  networkBufferManager: DeviceBufferManager<NetworkEntry, string>;
  evaluate: (expr: string) => Promise<{ value?: unknown; error?: string }>;
}

/**
 * Drain the in-app hook-mode network ring buffer into the bridge's
 * DeviceBufferManager. Called on demand by the network-reading tools
 * (cdp_network_log, cdp_wait_for_network, cdp_network_body) — MCP is
 * pull-based, so buffering lives app-side until someone reads.
 *
 * Destructive read: the swap is atomic (Hermes JS is single-threaded). With
 * two bridges connected to one app the first drain wins — accepted, the
 * device-ownership lock makes that rare. Two drains from one bridge are
 * ordered by the single CDP socket (no interleaving hazard); a drain whose
 * evaluate times out after the app-side swap loses that batch — inherent to
 * destructive read, consistent with fail-open. Response bodies are unaffected:
 * cdp_network_body reads the separate __RN_AGENT_RESPONSE_BODIES__ cache.
 *
 * Fail-open by contract: a read tool must never error because the drain
 * failed (app mid-reload, stale helpers); it just returns what the bridge
 * already buffered. Returns the number of entries applied.
 */
export async function drainNetworkHookBuffer(client: DrainableClient): Promise<number> {
  if (client.networkMode !== 'hook') return 0;
  try {
    const result = await client.evaluate(DRAIN_EXPR);
    if (result.error || typeof result.value !== 'string') return 0;
    const entries = JSON.parse(result.value) as Array<{ t?: unknown; d?: unknown; ts?: unknown }>;
    if (!Array.isArray(entries)) return 0;
    let applied = 0;
    for (const e of entries) {
      if (!e || typeof e.t !== 'string' || !e.d || typeof (e.d as { id?: unknown }).id !== 'string') continue;
      const atMs = typeof e.ts === 'number' ? e.ts : undefined;
      applyNetworkHookEntry(
        e.t,
        e.d as { id: string; method?: string; url?: string; status?: number; duration_ms?: number },
        client.networkBufferManager,
        client.activeDeviceKey,
        atMs,
      );
      applied++;
    }
    return applied;
  } catch (err) {
    logger.warn('CDP', `net-hook drain failed (fail-open): ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}
