// GH #628 — read-only park-anchor probe (AppState + isTestIdFrontmost over
// CDP, both bounded); never launches, taps, or navigates.

import type { ParkAnchorProbe } from './run-action.js';

export interface ParkProbeClient {
  readonly isConnected: boolean;
  evaluate(
    expression: string,
    awaitPromise?: boolean,
    timeoutMs?: number,
  ): Promise<{ value?: unknown; error?: string }>;
  bridgeWithFallback(call: string): string;
}

export const PARK_PROBE_TIMEOUT_MS = 4000;

// Bounded fail-open registry scan (CLAUDE.md pattern: prove module presence
// via __r.getModules() verboseName, never require()).
const APP_STATE_EXPR = `(function () {
  try {
    var r = globalThis.__r;
    var mods = r && typeof r.getModules === 'function' ? r.getModules() : null;
    if (!mods) return JSON.stringify({ state: 'unknown', reason: 'metro dev registry unavailable' });
    var scanned = 0;
    for (var key in mods) {
      if (++scanned > 40000) return JSON.stringify({ state: 'unknown', reason: 'registry scan budget exceeded' });
      var mod = mods[key];
      if (!mod || !mod.isInitialized || !mod.verboseName) continue;
      if (mod.verboseName.indexOf('Libraries/AppState/AppState') === -1) continue;
      var exp = mod.publicModule && mod.publicModule.exports;
      var appState = exp && (exp.default || exp);
      var state = appState && appState.currentState;
      return JSON.stringify({ state: typeof state === 'string' ? state : 'unknown' });
    }
    return JSON.stringify({ state: 'unknown', reason: 'AppState module not initialized' });
  } catch (e) {
    return JSON.stringify({ state: 'unknown', reason: String(e) });
  }
})()`;

type EvalOutcome =
  | { kind: 'value'; value: string }
  | { kind: 'unresponsive'; reason: string }
  | { kind: 'unreachable'; reason: string };

async function boundedEvaluate(
  client: ParkProbeClient,
  expression: string,
  timeoutMs: number,
): Promise<EvalOutcome> {
  let result: { value?: unknown; error?: string };
  try {
    result = await client.evaluate(expression, false, timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.startsWith('CDP timeout (')
      ? { kind: 'unresponsive', reason: `park probe got no answer within ${String(timeoutMs)}ms` }
      : { kind: 'unreachable', reason };
  }
  if (result.error || typeof result.value !== 'string') {
    return { kind: 'unreachable', reason: result.error ?? 'park probe read was unreadable' };
  }
  return { kind: 'value', value: result.value };
}

export function createParkAnchorProbe(
  getClient: () => ParkProbeClient,
  timeoutMs: number = PARK_PROBE_TIMEOUT_MS,
): (anchorId: string) => Promise<ParkAnchorProbe> {
  return async (anchorId) => {
    let client: ParkProbeClient;
    try {
      client = getClient();
    } catch (error) {
      return {
        status: 'unreachable',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!client.isConnected) {
      return { status: 'unreachable', reason: 'CDP client is not connected' };
    }

    const appState = await boundedEvaluate(client, APP_STATE_EXPR, timeoutMs);
    if (appState.kind !== 'value') return { status: appState.kind, reason: appState.reason };
    try {
      const parsed = JSON.parse(appState.value) as { state?: unknown };
      if (typeof parsed.state !== 'string') {
        return { status: 'unreachable', reason: 'AppState read was unreadable' };
      }
      if (parsed.state !== 'active' && parsed.state !== 'unknown') {
        return { status: 'backgrounded', reason: `AppState.currentState is "${parsed.state}"` };
      }
      // ponytail: 'unknown' stays fail-open — apps that never initialize
      // AppState would otherwise refuse forever; upgrade path is a native
      // runner foreground read if Android false-accepts show up in practice.
    } catch {
      return { status: 'unreachable', reason: 'AppState read was unreadable' };
    }

    const frontmost = await boundedEvaluate(
      client,
      client.bridgeWithFallback(`isTestIdFrontmost(${JSON.stringify(anchorId)})`),
      timeoutMs,
    );
    if (frontmost.kind !== 'value') return { status: frontmost.kind, reason: frontmost.reason };
    try {
      const parsed = JSON.parse(frontmost.value) as { visible?: unknown; reason?: unknown };
      if (typeof parsed.visible !== 'boolean') {
        return { status: 'unreachable', reason: 'frontmost check was unreadable' };
      }
      return parsed.visible
        ? { status: 'visible' }
        : {
            status: 'anchor-missing',
            reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
          };
    } catch {
      return { status: 'unreachable', reason: 'frontmost check was unreadable' };
    }
  };
}
