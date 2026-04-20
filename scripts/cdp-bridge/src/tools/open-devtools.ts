import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult } from '../utils.js';
import { supportsNativeMultiDebugger } from '../cdp/multiplexer.js';

/**
 * cdp_open_devtools — M1 / Phase 90 Tier 1 MVP.
 *
 * Report the React Native DevTools frontend URL for the currently connected app,
 * along with whether DevTools can coexist with the MCP session (RN >= 0.85 native
 * multi-debugger) or requires the proxy path (RN < 0.85, M1b).
 *
 * This tool is read-only — it does not start the multiplexer proxy or mutate any
 * CDP state. The proxy wiring is deferred to M1b (Phase 100, pending a live
 * simulator session for end-to-end verification).
 *
 * Output shape (on success):
 *   {
 *     devtoolsUrl: string | null,  // Metro-served DevTools frontend URL, or null if unavailable
 *     inspectorWsUrl: string,       // Direct Hermes CDP WS URL (what DevTools connects to)
 *     mode: 'native' | 'proxy-required',
 *     supportsMultipleDebuggers: boolean,
 *     rnVersion: { major, minor, patch } | null,
 *     guidance: string,             // Human-readable instructions
 *   }
 */

interface OpenDevToolsResult {
  devtoolsUrl: string | null;
  inspectorWsUrl: string;
  mode: 'native' | 'proxy-required';
  supportsMultipleDebuggers: boolean;
  rnVersion: { major: number; minor: number; patch: number } | null;
  guidance: string;
}

const NATIVE_GUIDANCE = [
  'React DevTools can connect to the inspector URL below while your MCP session stays active.',
  'Open the DevTools URL in Chrome (or paste the inspectorWsUrl directly into a DevTools fusebox instance).',
  'Native multi-debugger support on RN >= 0.85 means no proxy is needed — both connections multiplex transparently.',
].join('\n');

const PROXY_REQUIRED_GUIDANCE = [
  'Your RN version does not support native multi-debugger. Using React DevTools will evict the MCP session (CDP close code 1006).',
  'M1 (this release) ships detection + capability reporting; automatic proxy wiring is tracked as M1b (Phase 100, pending live simulator verification).',
  'Workaround today: close the MCP CC session while using DevTools, reopen when done. OR upgrade to RN >= 0.85.',
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
    const inspectorWsUrl = `ws://127.0.0.1:${metroPort}/inspector/debug?device=${encodeURIComponent(target.id)}&page=${encodeURIComponent(target.id)}`;

    // DevTools frontend is served by Metro at /debugger-frontend/rn_fusebox.html
    // Query params hand the frontend the WS URL it should connect to. Metro auto-loads the React DevTools bundle.
    const devtoolsUrl = `http://127.0.0.1:${metroPort}/debugger-frontend/rn_fusebox.html?ws=127.0.0.1:${metroPort}/inspector/debug?device=${encodeURIComponent(target.id)}%26page=${encodeURIComponent(target.id)}`;

    // Probe app info for RN version. Best-effort — if probe fails, we still report
    // inspectorWsUrl and assume proxy-required.
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

    const result: OpenDevToolsResult = {
      devtoolsUrl: supportsMultiple ? devtoolsUrl : null,
      inspectorWsUrl,
      mode: supportsMultiple ? 'native' : 'proxy-required',
      supportsMultipleDebuggers: supportsMultiple,
      rnVersion,
      guidance: supportsMultiple ? NATIVE_GUIDANCE : PROXY_REQUIRED_GUIDANCE,
    };

    return okResult(result);
  };
}
