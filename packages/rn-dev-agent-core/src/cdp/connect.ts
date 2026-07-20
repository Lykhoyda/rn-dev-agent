import WebSocket from 'ws';
import { logger } from '../logger.js';
import { metroOrigin } from '../ws-origin.js';
import { resolveBundleId } from '../project-config.js';
import { discover } from './discovery.js';
import type { SelectTargetFilters } from './discovery.js';
import { sleep } from './state.js';
import { CDP_TIMEOUT_FAST } from './timeout-config.js';
import { probeReactReachable } from './setup.js';
import type { CDPClientState, EvaluateResult, HermesTarget } from '../types.js';

// GH #184: distinguishes a quick health-check connect (cdp_status) from every
// other connect path. Only 'status' connects run the bounded picker probe; all
// other paths keep the full waitForReact budget for legitimate slow builds.
export type ConnectIntent = 'default' | 'status';

// Budget for the status-scoped React-reachability probe. Generous enough to
// clear a normal Bridgeless reload (React ready in <~2s) but far below setup()'s
// 30s waitForReact, so cdp_status fails fast instead of hanging when the Dev
// Client picker blocks the bundle. Env-overridable for tuning/tests.
const PICKER_PROBE_BUDGET_MS = (() => {
  const n = parseInt(process.env.RN_PICKER_PROBE_BUDGET_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

/**
 * GH #184: thrown when a status-scoped connect can't reach React within the
 * bounded budget on a non-Hermes target — the signature of the Expo Dev Client
 * "Development servers" picker leaving stale C++ targets advertised while the
 * bundle never loads. status.ts maps it to a fast, actionable failResult
 * instead of letting setup() burn the full 30s waitForReact.
 */
export class PickerBlockingBundleError extends Error {
  readonly target: HermesTarget;
  constructor(target: HermesTarget) {
    super(
      `Dev Client picker appears to be blocking the bundle: React was not reachable on target ` +
        `"${target.title}" (vm=${target.vm}). If the Expo "Development servers" picker is showing on ` +
        `the simulator, select your Metro server, then retry cdp_status. (If the bundle is still building, just retry.)`,
    );
    this.name = 'PickerBlockingBundleError';
    this.target = target;
  }
}

/**
 * GH #184: run the bounded picker probe only for a status-intent connect against
 * a non-Hermes target. Hermes targets are skipped so a genuinely slow Hermes
 * first-build keeps the full waitForReact budget rather than being aborted.
 */
export function shouldRunPickerProbe(intent: ConnectIntent, target: HermesTarget): boolean {
  return intent === 'status' && target.vm !== 'Hermes';
}

export interface ConnectFilters {
  platform?: string;
  deviceKind?: 'emulator' | 'physical';
  targetId?: string;
  bundleId?: string;
  preferredBundleId?: string;
}

export interface ConnectContext {
  isDisposed(): boolean;
  isReconnecting(): boolean;
  isSoftReconnectRequested(): boolean;
  getState(): CDPClientState;
  setState(s: CDPClientState): void;
  getPort(): number;
  setPort(v: number): void;
  getConnectFilters(): ConnectFilters;
  setConnectFilters(v: ConnectFilters): void;
  getWs(): WebSocket | null;
  setWs(ws: WebSocket | null): void;
  setHelpersInjected(v: boolean): void;
  setConnectedTarget(t: HermesTarget | null): void;
  setConnectedAt(ms: number | null): void;
  now(): number;
  incrementConnectionGeneration(): number;
  evaluate(expr: string): Promise<EvaluateResult>;
  sendWithTimeout(method: string, params: unknown, ms: number): Promise<unknown>;
  handleMessage(data: WebSocket.RawData): void;
  handleClose(code: number): void;
  rejectAllPending(reason: Error): void;
  setup(): Promise<void>;
  /**
   * M1b (Phase 100+): when non-null, connectToTarget routes through this URL
   * instead of the target's direct `webSocketDebuggerUrl`. This is how the
   * CDPClient rides the local multiplexer proxy, allowing React Native DevTools
   * (or any second consumer) to coexist on RN < 0.85.
   */
  getProxyUrl(): string | null;
}

export async function autoConnect(
  ctx: ConnectContext,
  portHint?: number,
  filters?: ConnectFilters,
  intent: ConnectIntent = 'default',
): Promise<string> {
  if (ctx.getState() === 'connecting' || ctx.isReconnecting()) {
    throw new Error('Already connecting to Metro...');
  }
  if (ctx.isDisposed()) {
    throw new Error('Client is disposed. Create a new CDPClient instance.');
  }
  const effective: ConnectFilters = { ...filters };
  if (!effective.platform) {
    const envPlatform = process.env.RN_PREFERRED_PLATFORM;
    if (envPlatform && envPlatform !== 'auto') effective.platform = envPlatform;
  }
  // B111 (D643): auto-populate preferredBundleId from project-config so the
  // smart auto-selection in selectTarget fires for callers that didn't pass
  // explicit filters. resolveBundleId returns null when no app.json — graceful no-op.
  if (!effective.preferredBundleId) {
    const resolved = resolveBundleId(effective.platform ?? 'ios');
    if (resolved) effective.preferredBundleId = resolved;
  }
  return discoverAndConnect(ctx, portHint, effective, discover, intent);
}

export async function discoverAndConnect(
  ctx: ConnectContext,
  portHint?: number,
  filters?: ConnectFilters,
  // B111 (D643): injectable for unit tests — defaults to real discover. Production
  // call sites pass nothing, so behavior is unchanged. Tests pass a stub.
  discoverFn: typeof discover = discover,
  // GH #184: connect intent threaded to connectToTarget. Kept last so existing
  // callers (and tests passing discoverFn as the 4th arg) are unaffected.
  intent: ConnectIntent = 'default',
): Promise<string> {
  if (ctx.isDisposed()) {
    throw new Error('Client is disposed. Create a new CDPClient instance.');
  }

  if (portHint) ctx.setPort(portHint);
  // B111 (D643/G7): preserve _connectFilters across softReconnect — only overwrite
  // when caller explicitly passes filters. softReconnect calls with filters=undefined
  // so the previously-set targetId/bundleId/preferredBundleId survive the reload.
  if (filters !== undefined) ctx.setConnectFilters(filters);
  ctx.setState('connecting');

  const mergedFilters = ctx.getConnectFilters();
  const filtersForDiscover: SelectTargetFilters = {
    platform: mergedFilters.platform,
    deviceKind: mergedFilters.deviceKind,
    targetId: mergedFilters.targetId,
    bundleId: mergedFilters.bundleId,
    preferredBundleId: mergedFilters.preferredBundleId,
  };

  let result;
  try {
    result = await discoverFn(ctx.getPort(), filtersForDiscover);
  } catch (err) {
    ctx.setState('disconnected');
    throw err;
  }

  const { port: metroPort, targets: sorted, warning: selectionWarning } = result;
  ctx.setPort(metroPort);

  // B111 (D643/G9): selectTarget hard-fails (returns []) on explicit filter
  // mismatch — surface that as a connect error rather than crashing on the
  // candidate loop's connectedTarget! non-null assertion below.
  if (sorted.length === 0) {
    ctx.setState('disconnected');
    throw new Error(selectionWarning ?? 'No matching CDP targets found.');
  }

  let connectedTarget: HermesTarget | null = null;
  for (let idx = 0; idx < sorted.length; idx++) {
    const candidate = sorted[idx];
    const isLast = idx === sorted.length - 1;
    try {
      await connectToTarget(ctx, candidate, 5, intent);
      const devCheck = await ctx.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
      if (devCheck.value === true) {
        connectedTarget = candidate;
        break;
      }
      console.error(
        `CDP: target ${candidate.id} (${candidate.title}) has __DEV__=${devCheck.value}, skipping`,
      );
      if (!isLast) {
        closeAndResetWs(ctx);
        ctx.setState('disconnected');
        ctx.setHelpersInjected(false);
        ctx.setConnectedTarget(null);
        continue;
      }
      console.error('CDP: no target with __DEV__=true found, using last available target');
      connectedTarget = candidate;
    } catch (err) {
      // GH #184: picker-blocking affects the whole bundle — every other
      // candidate is the same stale C++ target, so don't waste a probe on each.
      if (err instanceof PickerBlockingBundleError) {
        ctx.setState('disconnected');
        throw err;
      }
      if (!isLast) continue;
      throw err;
    }
  }

  const generation = ctx.incrementConnectionGeneration();
  logger.info(
    'CDP',
    `Connected to target ${connectedTarget!.id} (${connectedTarget!.title}) on port ${metroPort}, generation=${generation}`,
  );

  // GH #59 #5: persist the resolved platform into _connectFilters when the
  // caller didn't pin one explicitly. Without this, softReconnect after
  // cdp_reload has nothing to filter on and may pick the wrong simulator
  // (e.g. iOS user reloads, sortTargets returns Android first, reconnect
  // lands on Android). Explicit filters from the caller already survive
  // (B111/D643/G7); this closes the auto-detect gap.
  const stickyFilters = stickyPlatformFilters(ctx.getConnectFilters(), connectedTarget!.platform);
  if (stickyFilters) ctx.setConnectFilters(stickyFilters);

  const msg = `Connected to ${connectedTarget!.title} on port ${metroPort}`;
  return selectionWarning ? `${msg}. WARNING: ${selectionWarning}` : msg;
}

/**
 * GH #59 #5: pure helper that pins the resolved platform into a copy of the
 * current connect filters when (a) no platform filter was explicitly set and
 * (b) the connect resolved a target whose platform we now know. Returns null
 * when no update is needed — caller skips the setConnectFilters call.
 *
 * Extracted so the auto-detect → reconnect-stays-on-same-platform invariant
 * can be unit-tested without spinning a real WebSocket connect.
 */
export function stickyPlatformFilters(
  current: ConnectFilters,
  resolvedPlatform: string | undefined,
): ConnectFilters | null {
  if (current.platform) return null;
  if (!resolvedPlatform) return null;
  return { ...current, platform: resolvedPlatform };
}

/**
 * GH #105 / B154: pure helper. Decide which final error string to surface
 * after `retries` failed connection attempts. The previous unconditional
 * "Failed to connect after 5 attempts." was misleading when every attempt
 * actually connected at the WebSocket layer and only the Runtime.evaluate
 * pre-flight probe timed out — that means the JS thread is paused (almost
 * always because the app is backgrounded by the Agent Device Runner
 * foregrounding itself), not that Metro is unreachable.
 *
 * Pure & exported so unit tests can pin the message shape without spinning
 * a real WebSocket.
 */
export function formatConnectFailureMessage(
  retries: number,
  attempts: { handshakeOk: boolean; probeTimedOut: boolean }[],
  bundleHint: string | null,
  lastErrorMessage: string | null,
): string {
  const allHandshakesSucceeded = attempts.length > 0 && attempts.every((a) => a.handshakeOk);
  const anyProbeTimeout = attempts.some((a) => a.probeTimedOut);
  if (allHandshakesSucceeded && anyProbeTimeout) {
    const bid = bundleHint ?? '<bundleId>';
    return (
      `CDP probe timeout after ${retries} attempts: WebSocket handshake succeeded but Runtime.evaluate('1+1') consistently timed out — JS thread paused. ` +
      `The target app is most likely backgrounded. ` +
      `Recovery: call cdp_restart with hardReset=true (kills the fast-runner, terminates+relaunches ${bid}, reconnects — no /reload-plugins required). ` +
      `Or manually: xcrun simctl terminate booted ${bid} && xcrun simctl launch booted ${bid} (iOS), or restart the app from the launcher (Android).`
    );
  }
  const hint = lastErrorMessage?.includes('1006')
    ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
    : '';
  return `Failed to connect after ${retries} attempts.${hint}`;
}

async function connectToTarget(
  ctx: ConnectContext,
  target: HermesTarget,
  retries = 5,
  intent: ConnectIntent = 'default',
): Promise<void> {
  let lastError: Error | null = null;
  // GH #105 / B154: track per-attempt outcome (handshake ok vs probe timeout).
  // Fed into formatConnectFailureMessage at the end.
  const attempts: { handshakeOk: boolean; probeTimedOut: boolean }[] = [];
  for (let i = 0; i < retries; i++) {
    if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) {
      throw new Error('Client disposed or preempted during connection');
    }
    let handshakeOk = false;
    let probeTimedOut = false;
    try {
      // M1b: ride the multiplexer when _proxyUrl is set (from CDPClient.startProxy).
      // Falls back to the target's direct webSocketDebuggerUrl when no proxy is active.
      const proxyUrl = ctx.getProxyUrl();
      const url = proxyUrl ?? target.webSocketDebuggerUrl;
      if (proxyUrl) {
        logger.info('CDP', `Routing via multiplexer proxy: ${proxyUrl}`);
      }
      await connectWs(ctx, url);
      handshakeOk = true;
      // D594: Early stale-target detection — quick probe before full setup
      try {
        await ctx.sendWithTimeout(
          'Runtime.evaluate',
          {
            expression: '1+1',
            returnByValue: true,
          },
          CDP_TIMEOUT_FAST,
        );
      } catch {
        probeTimedOut = true;
        throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
      }
      ctx.setConnectedTarget(target);
      // M11: stamp connection time so cdp_console_log / cdp_network_log can reason
      // about "how long have we been connected with nothing happening?"
      ctx.setConnectedAt(ctx.now());
      // GH #184: for a status-scoped connect, bounded-probe React reachability
      // BEFORE the up-to-30s waitForReact inside setup(). A non-Hermes target
      // that can't reach React within the budget is a stale C++ connection the
      // Dev Client picker leaves advertised — abort fast with a typed error
      // instead of hanging. Hermes targets are skipped (legit slow builds).
      if (shouldRunPickerProbe(intent, target)) {
        const reachable = await probeReactReachable(
          (expr) => ctx.evaluate(expr),
          PICKER_PROBE_BUDGET_MS,
        );
        if (!reachable) throw new PickerBlockingBundleError(target);
      }
      await ctx.setup();
      return;
    } catch (err) {
      // GH #184: the picker-blocking abort is deterministic, not transient —
      // don't burn the retry budget on it; clean up and surface it immediately.
      if (err instanceof PickerBlockingBundleError) {
        closeAndResetWs(ctx);
        ctx.setConnectedTarget(null);
        ctx.setState('disconnected');
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      attempts.push({ handshakeOk, probeTimedOut });
      closeAndResetWs(ctx);
      if (lastError.message.includes('refused')) {
        ctx.setState('disconnected');
        throw new Error('CDP connection refused. Is Metro running and the app loaded?');
      }
      if (i < retries - 1) await sleep(2000);
    }
  }
  ctx.setState('disconnected');
  throw new Error(
    formatConnectFailureMessage(
      retries,
      attempts,
      target.description ?? null,
      lastError?.message ?? null,
    ),
  );
}

function connectWs(ctx: ConnectContext, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      handshakeTimeout: 5000,
      maxPayload: 100 * 1024 * 1024,
      headers: { Origin: metroOrigin(url) },
    });
    let settled = false;
    // Backstop: handshakeTimeout should emit 'error', but if the socket ever
    // wedges without firing open/error/close it would leak with its listeners.
    // Terminate it after a grace window so it can't linger.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      reject(new Error('WebSocket connect timed out'));
    }, 7000);

    ws.on('open', () => {
      settled = true;
      clearTimeout(guard);
      ctx.setWs(ws);
      ctx.setState('connected');
      resolve();
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(guard);
        try {
          ws.terminate();
        } catch {
          /* already closing */
        }
        reject(err);
      } else {
        console.error('CDP WebSocket error:', err instanceof Error ? err.message : err);
      }
    });

    ws.on('message', (data) => {
      ctx.handleMessage(data);
    });

    ws.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(guard);
        reject(new Error(`WebSocket closed before connecting: ${code}`));
        return;
      }
      if (ctx.getWs() === ws) {
        ctx.rejectAllPending(new Error(`WebSocket closed: ${code}`));
        ctx.handleClose(code);
      }
    });
  });
}

function closeAndResetWs(ctx: ConnectContext): void {
  const ws = ctx.getWs();
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ctx.setWs(null);
  }
}
