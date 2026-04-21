import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult } from '../utils.js';
import { supportsNativeMultiDebugger } from '../cdp/multiplexer.js';

/**
 * cdp_open_devtools — M1 / Phase 90 Tier 1 + M1b (Phase 100).
 *
 * Report the React Native DevTools frontend URL for the currently connected app,
 * and on RN < 0.85 automatically start the multiplexer proxy so DevTools can
 * coexist with the MCP session (native multi-debugger kicks in on RN >= 0.85).
 *
 * Output shape (on success):
 *   {
 *     devtoolsUrl: string,          // DevTools frontend URL (points at proxy when proxy-active)
 *     inspectorWsUrl: string,        // WS URL to connect DevTools to (proxy port in proxy-active mode)
 *     hermesWsUrl: string,           // Direct Hermes WS URL (what the proxy talks to upstream)
 *     mode: 'native' | 'proxy-active',
 *     supportsMultipleDebuggers: boolean,
 *     rnVersion: { major, minor, patch } | null,
 *     proxyPort: number | null,      // proxy port when mode='proxy-active'
 *     guidance: string,              // Human-readable instructions
 *   }
 */

interface OpenDevToolsResult {
  devtoolsUrl: string;
  inspectorWsUrl: string;
  hermesWsUrl: string;
  mode: 'native' | 'proxy-active';
  supportsMultipleDebuggers: boolean;
  rnVersion: { major: number; minor: number; patch: number } | null;
  proxyPort: number | null;
  guidance: string;
}

const NATIVE_GUIDANCE = [
  'React DevTools can connect to the inspector URL below while your MCP session stays active.',
  'Open the devtoolsUrl in Chrome (or paste the inspectorWsUrl directly into a DevTools fusebox instance).',
  'Native multi-debugger support on RN >= 0.85 means no proxy is needed — both connections multiplex transparently.',
].join('\n');

const PROXY_ACTIVE_GUIDANCE = [
  'Your RN version does not support native multi-debugger; the multiplexer proxy has been started so React DevTools can coexist with the MCP.',
  'Open the devtoolsUrl in Chrome. DevTools will connect to the proxy (inspectorWsUrl); the MCP is already routing through it.',
  'The proxy stops automatically when the MCP disconnects, or explicitly via cdp_disconnect.',
].join('\n');

export function createOpenDevToolsHandler(getClient: () => CDPClient) {
  return async (): Promise<ReturnType<typeof okResult | typeof failResult>> => {
    const client = getClient();
    if (!client.isConnected) {
      return failResult('cdp_open_devtools: not connected. Call cdp_status first to auto-connect to the live app.');
    }

    const target = client.connectedTarget;
    if (!target) {
      return failResult('cdp_open_devtools: no target selected. Run cdp_connect or cdp_status.');
    }

    const metroPort = client.metroPort;
    const hermesWsUrl = `ws://127.0.0.1:${metroPort}/inspector/debug?device=${encodeURIComponent(target.id)}&page=${encodeURIComponent(target.id)}`;

    // Probe app info for RN version. Best-effort — if probe fails, treat as
    // proxy-required (conservative default: use the proxy so DevTools doesn't evict the MCP).
    let rnVersion: OpenDevToolsResult['rnVersion'] = null;
    let supportsMultiple = false;
    try {
      const probe = await client.evaluate(
        'JSON.stringify(__RN_AGENT?.getAppInfo ? JSON.parse(__RN_AGENT.getAppInfo()).rnVersion : null)',
      );
      if (probe.value && typeof probe.value === 'string' && probe.value !== 'null') {
        const parsed = JSON.parse(probe.value) as unknown;
        supportsMultiple = supportsNativeMultiDebugger(parsed);
        if (parsed && typeof parsed === 'object') {
          const v = parsed as { major?: unknown; minor?: unknown; patch?: unknown };
          if (typeof v.major === 'number' && typeof v.minor === 'number' && typeof v.patch === 'number') {
            rnVersion = { major: v.major, minor: v.minor, patch: v.patch };
          }
        }
      }
    } catch { /* leave rnVersion null, supportsMultiple false */ }

    if (supportsMultiple) {
      // Native multi-debugger: DevTools connects directly to Hermes via Metro's
      // /inspector/debug endpoint. No proxy needed.
      const devtoolsUrl = `http://127.0.0.1:${metroPort}/debugger-frontend/rn_fusebox.html?ws=127.0.0.1:${metroPort}/inspector/debug?device=${encodeURIComponent(target.id)}%26page=${encodeURIComponent(target.id)}`;
      return okResult({
        devtoolsUrl,
        inspectorWsUrl: hermesWsUrl,
        hermesWsUrl,
        mode: 'native',
        supportsMultipleDebuggers: true,
        rnVersion,
        proxyPort: null,
        guidance: NATIVE_GUIDANCE,
      } satisfies OpenDevToolsResult);
    }

    // Proxy path: start (or reuse) the multiplexer so DevTools and MCP coexist.
    let proxyUrl: string;
    try {
      proxyUrl = await client.startProxy();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult(`cdp_open_devtools: failed to start multiplexer proxy: ${message}`);
    }
    const proxyPort = client.proxyMultiplexer?.port ?? null;
    if (proxyPort === null) {
      // Defensive: startProxy resolved but the multiplexer has no port. Indicates an
      // internal state drift — fail loudly rather than return a half-working URL.
      return failResult('cdp_open_devtools: multiplexer started but has no bound port');
    }
    // DevTools frontend still lives on Metro (it's static HTML + JS served over HTTP).
    // Only the WS destination changes: DevTools → proxy (loopback); proxy → Hermes.
    const devtoolsUrl = `http://127.0.0.1:${metroPort}/debugger-frontend/rn_fusebox.html?ws=127.0.0.1:${proxyPort}`;

    return okResult({
      devtoolsUrl,
      inspectorWsUrl: proxyUrl,
      hermesWsUrl,
      mode: 'proxy-active',
      supportsMultipleDebuggers: false,
      rnVersion,
      proxyPort,
      guidance: PROXY_ACTIVE_GUIDANCE,
    } satisfies OpenDevToolsResult);
  };
}
