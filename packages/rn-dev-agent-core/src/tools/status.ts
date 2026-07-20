import type { CDPClient } from '../cdp-client.js';
import type { MetroCandidate, StatusResult } from '../types.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { handleDevClientPicker, isDevClientPickerShowing } from './dev-client-picker.js';
import { PickerBlockingBundleError } from '../cdp/connect.js';
import { getSessionReloadCount } from './reload.js';
import { supportsNativeMultiDebugger } from '../cdp/multiplexer.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { recoverWedge } from '../cdp/recover-wedge.js';
import { recoverDetached } from '../cdp/recover-detached.js';
import type { DetachedRecoveryResult, RecoverDetachedDeps } from '../cdp/recover-detached.js';
import { buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
import {
  AppDetachedError,
  TargetSelectionError,
  androidTargetMatchesKind,
  enumerateMetroCandidates,
} from '../cdp/discovery.js';
import { resolveBridgeProjectRoot, pathMatchesRoot } from '../cdp/metro-cwd.js';
import { getDeviceSessionHealth } from './device-session-health.js';
import { detectIosExternalRunner } from '../runners/external-runner-detect.js';
import { bridgeEnvState } from '../lifecycle/supervisor-core.js';
import { storeMode } from '../domain/action-state-store.js';
import { getEngineStatus } from '../domain/engine-pin.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import type { ConnectFilters } from '../cdp/connect.js';
import type { HermesTarget } from '../types.js';

export function sessionConnectFilters(
  session: ReturnType<typeof getActiveSession>,
): ConnectFilters | null {
  if (!session || (session.platform !== 'ios' && session.platform !== 'android')) return null;
  return {
    platform: session.platform,
    ...(session.appId ? { bundleId: session.appId } : {}),
    ...(session.platform === 'android' && session.deviceId
      ? { deviceKind: session.deviceId.startsWith('emulator-') ? 'emulator' : 'physical' }
      : {}),
  };
}

export function targetMatchesSession(
  target: HermesTarget | null,
  filters: ConnectFilters,
): boolean {
  if (!target) return false;
  if (
    filters.platform &&
    (target.platform !== filters.platform ||
      target.platformInference === 'defaulted' ||
      target.platformInference === 'ambiguous')
  )
    return false;
  if (filters.bundleId) {
    const description = (target.description ?? '').toLowerCase();
    const bundle = filters.bundleId.toLowerCase();
    const escaped = bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(^|[^A-Za-z0-9._-])${escaped}([^A-Za-z0-9._-]|$)`).test(description)) {
      return false;
    }
  }
  if (
    filters.deviceKind === 'physical' &&
    !androidTargetMatchesKind(target.deviceName, filters.deviceKind)
  ) {
    return false;
  }
  return true;
}

// M10 / Phase 110: narrow `appInfo.architecture` to the StatusResult union.
// Any unexpected value collapses to 'unknown' — defensive against future
// helper versions that might emit new tokens we don't recognize yet.
export function narrowArchitecture(raw: unknown): 'new' | 'old' | 'unknown' {
  return raw === 'new' || raw === 'old' ? raw : 'unknown';
}

/**
 * GH #303: flag when the connected Metro is serving a DIFFERENT worktree than
 * this session's project root — the silent "verifying the wrong bundle" trap.
 * Uses pathMatchesRoot so a monorepo app subdir / symlinked path is not flagged.
 * Fail-open: silent whenever either path is unresolved (never a false alarm).
 */
export function computeMetroMismatch(args: {
  servingCwd: string | null;
  projectRoot: string | undefined;
  port: number | null;
}): { mismatch: boolean; warning?: string } {
  const { servingCwd, projectRoot, port } = args;
  if (!servingCwd || !projectRoot || pathMatchesRoot(servingCwd, projectRoot)) {
    return { mismatch: false };
  }
  return {
    mismatch: true,
    warning:
      `Connected Metro on :${port} is serving ${servingCwd}, but this session's project root is ${projectRoot} ` +
      `— you may be verifying against a different worktree's bundle. Restart Metro in this worktree or pass metroPort.`,
  };
}

const STATUS_PROBE_EXPRESSION = `
(function() {
  var result = { appInfo: null, errorCount: 0, fiberTree: false, hasRedBox: false, helpersLoaded: false };
  var agent = globalThis.__RN_AGENT;
  if (!agent) return JSON.stringify(result);
  result.helpersLoaded = true;
  try { result.appInfo = JSON.parse(agent.getAppInfo()); } catch(e) {}
  try { result.errorCount = JSON.parse(agent.getErrors()).length; } catch(e) {}
  try { result.fiberTree = agent.isReady(); } catch(e) {}
  try { result.hasRedBox = JSON.parse(agent.getTree({maxDepth:1})).warning === 'APP_HAS_REDBOX'; } catch(e) {}
  return JSON.stringify(result);
})()
`;

async function buildStatusResult(client: CDPClient): Promise<StatusResult> {
  let appInfo: Record<string, unknown> | null = null;
  let errorCount = 0;
  let fiberTree = false;
  let hasRedBox = false;

  if (client.helpersInjected) {
    const probeResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
    if (probeResult.value && typeof probeResult.value === 'string') {
      try {
        const probe = JSON.parse(probeResult.value) as {
          appInfo: Record<string, unknown> | null;
          errorCount: number;
          fiberTree: boolean;
          hasRedBox: boolean;
          helpersLoaded: boolean;
        };
        if (probe.helpersLoaded) {
          appInfo = probe.appInfo;
          errorCount = probe.errorCount;
          fiberTree = probe.fiberTree;
          hasRedBox = probe.hasRedBox;
        }
      } catch {
        /* probe failed */
      }
    }
  }

  const metroEvents = client.metroEventsClient;

  const deviceSession = await getDeviceSessionHealth({
    detectForeign: async (udid) =>
      (await detectIosExternalRunner(undefined, udid)) ? { detected: true } : null,
  });

  // GH #397: replay-engine identity + version-vs-pin. Process-cached after the
  // first call; omitted entirely if detection throws (fail-open).
  let replayEngine: StatusResult['replayEngine'];
  try {
    replayEngine = await getEngineStatus();
  } catch {
    /* fail-open: omit */
  }

  // GH #303: worktree-disambiguation diagnostics — best-effort, fail-open.
  const projectRoot = resolveBridgeProjectRoot() ?? undefined;
  let candidates: MetroCandidate[] | undefined;
  let servingCwd: string | null | undefined;
  let metroTimings: { probe: number; cwd: number } | undefined;
  try {
    const enriched = await enumerateMetroCandidates(client.metroPort, projectRoot);
    servingCwd = enriched.servingCwd;
    candidates = enriched.candidates; // omitted by the fast path when ≤1 Metro is up
    metroTimings = enriched.timings_ms;
  } catch {
    /* fail-open: omit diagnostics */
  }

  return {
    metro: {
      running: true,
      port: client.metroPort,
      eventsConnected: metroEvents?.isConnected ?? false,
      lastBuild: metroEvents?.lastBuild ?? null,
      buildErrors: metroEvents?.buildErrors ?? 0,
      candidates,
      projectRoot,
      servingCwd,
      timings_ms: metroTimings,
    },
    cdp: {
      connected: client.isConnected,
      device: client.connectedTarget?.title ?? null,
      pageId: client.connectedTarget?.id ?? null,
      platform: client.connectedTarget?.platform ?? null,
      bundleId: client.connectedTarget?.description ?? null,
      affinityScope: (() => {
        const active = getActiveSession();
        if (!active) return 'best-available' as const;
        return active.platform === 'android'
          ? ('platform-bundle-device-kind' as const)
          : ('platform-bundle-class' as const);
      })(),
    },
    app: {
      platform: (appInfo?.platform as string) ?? null,
      dev: (appInfo?.__DEV__ as boolean) ?? null,
      hermes: (appInfo?.hermes as boolean) ?? null,
      rnVersion: appInfo?.rnVersion ? JSON.stringify(appInfo.rnVersion) : null,
      dimensions: (appInfo?.dimensions as { width: number; height: number }) ?? null,
      hasRedBox,
      isPaused: client.isPaused,
      errorCount,
      architecture: narrowArchitecture(appInfo?.architecture),
    },
    capabilities: {
      networkDomain: client.networkMode === 'cdp',
      fiberTree,
      networkFallback: client.networkMode === 'hook',
      bridgeDetected: client.bridgeDetected,
      bridgeVersion: client.bridgeVersion,
      supportsMultipleDebuggers: supportsNativeMultiDebugger(appInfo?.rnVersion),
      helpersInjected: client.helpersInjected,
    },
    domains: {
      runtime: client.isConnected,
      debugger: client.isConnected,
      network: client.networkMode === 'cdp',
      log: client.logDomainEnabled,
      profiler: client.profilerAvailable,
      heapProfiler: client.heapProfilerAvailable,
    },
    reconnect: client.reconnectState,
    autoConnect: client.autoConnectState,
    bridge: bridgeEnvState(process.env),
    deviceSession,
    actionStore: storeMode(projectRoot ?? ''),
    replayEngine,
    proxy: {
      active: client.isProxyActive,
      port: client.proxyMultiplexer?.port ?? null,
      url: client.proxyUrl,
      consumerCount: client.proxyMultiplexer?.consumerCount ?? 0,
    },
  };
}

export function createStatusHandler(
  getClient: () => CDPClient,
  setClient: (c: CDPClient) => void,
  createClient: (port: number) => CDPClient,
  deps: {
    recoverDetached?: (
      client: CDPClient,
      rdeps?: RecoverDetachedDeps,
    ) => Promise<DetachedRecoveryResult>;
  } = {},
) {
  const recoverDetachedFn = deps.recoverDetached ?? recoverDetached;
  return async (args: { metroPort?: number; platform?: string; resetArbiter?: boolean }) => {
    if (args?.resetArbiter) {
      const arbiterReset = arbiter.reset('manual via cdp_status');
      // Best-effort: still report normal status, annotated with what was cleared.
      try {
        const status = await buildStatusResult(getClient());
        return okResult({ ...status, arbiterReset });
      } catch {
        return okResult({ arbiterReset });
      }
    }
    try {
      let client = getClient();
      const session = getActiveSession();
      const sessionFilters = sessionConnectFilters(session);
      if (
        args.platform &&
        sessionFilters?.platform &&
        args.platform.toLowerCase() !== sessionFilters.platform
      ) {
        return failResult(
          `cdp_status requested ${args.platform}, but the active device session is ${sessionFilters.platform} (${session?.deviceId}). Refusing a cross-platform target; this guarantees platform+bundle class only and does not claim iOS UDID identity because Metro does not expose it. Close the session or request the same platform.`,
          'TARGET_SESSION_MISMATCH',
          { deviceSession: session },
        );
      }
      const connectFilters: ConnectFilters =
        sessionFilters ?? (args.platform ? { platform: args.platform.toLowerCase() } : {});
      const validateConnectedTarget = async (): Promise<void> => {
        if (targetMatchesSession(client.connectedTarget, connectFilters)) return;
        const wrong = client.connectedTarget;
        await client.disconnect();
        throw new TargetSelectionError(
          connectFilters.targetId ? 'TARGET_PLATFORM_CONFLICT' : 'PLATFORM_TARGET_NOT_FOUND',
          `Connected target failed post-connect affinity validation for platform=${connectFilters.platform ?? 'unspecified'} bundleId=${connectFilters.bundleId ?? 'unspecified'}. The socket was disconnected; run cdp_targets and relaunch the requested app.`,
          wrong ? [wrong] : [],
        );
      };

      if (args.metroPort && args.metroPort !== client.metroPort) {
        await client.disconnect();
        client = createClient(args.metroPort);
        setClient(client);
      }

      if (!client.isConnected) {
        // GH #136: probe the dev-client picker BEFORE autoConnect. When the
        // picker is up, the JS bundle hasn't loaded → no Metro target visible
        // to CDP → discovery polls until its 60s timeout. Dismissing the
        // picker first lets autoConnect see a real target on its first
        // attempt. Best-effort: any failure here falls through to the
        // existing catch-block picker check as a safety net.
        try {
          if (await isDevClientPickerShowing()) {
            await handleDevClientPicker();
          }
        } catch {
          /* fall through to autoConnect */
        }
        // GH #208 (RC1): when a reconnect storm is in flight, bare autoConnect
        // throws "Already connecting to Metro..." (connect.ts guard) and dead-ends
        // cdp_status — the one tool meant to diagnose+recover. Preempt the storm
        // via softReconnect (the existing 3s softReconnectRequested handshake) for
        // one fresh, real connection attempt instead of refusing.
        // GH #208 review (Codex/Gemini F1): softReconnect reuses the storm's
        // existing target/filters, so only preempt in place when the caller hasn't
        // pinned a different target. If they pinned an explicit platform, tear the
        // storm down first (mirrors the metroPort-change path above) so autoConnect
        // honors it instead of returning wrong-platform data.
        if (client.reconnectState.active && !args.platform && !sessionFilters) {
          await client.softReconnect();
        } else {
          if (client.reconnectState.active) {
            await client.disconnect();
            client = createClient(client.metroPort);
            setClient(client);
          }
          await client.autoConnect(args.metroPort, connectFilters, 'status');
          await validateConnectedTarget();
        }
      } else if (!targetMatchesSession(client.connectedTarget, connectFilters)) {
        // A live CDP socket is not sufficient evidence of affinity. Re-select
        // with hard platform/app/device-class filters instead of reporting an
        // emulator target alongside a physical-device session.
        await client.disconnect();
        client = createClient(client.metroPort);
        setClient(client);
        await client.autoConnect(args.metroPort, connectFilters, 'status');
        await validateConnectedTarget();
      } else {
        await validateConnectedTarget();
      }

      const status = await buildStatusResult(client);

      let autoRecoveredMessage: string | undefined;

      if (status.app.dev === false) {
        // Auto-recovery: softReconnect to find the correct JS context (D306)
        let devRecovered = false;
        try {
          await client.softReconnect();
          if (client.helpersInjected) {
            const retryResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
            if (retryResult.value && typeof retryResult.value === 'string') {
              try {
                const retryProbe = JSON.parse(retryResult.value) as {
                  appInfo: Record<string, unknown> | null;
                  errorCount: number;
                  fiberTree: boolean;
                  hasRedBox: boolean;
                };
                if (retryProbe.appInfo?.__DEV__ === true) {
                  status.app.dev = true;
                  status.app.platform = (retryProbe.appInfo?.platform as string) ?? null;
                  status.app.hermes = (retryProbe.appInfo?.hermes as boolean) ?? null;
                  status.app.rnVersion = retryProbe.appInfo?.rnVersion
                    ? JSON.stringify(retryProbe.appInfo.rnVersion)
                    : null;
                  status.app.dimensions =
                    (retryProbe.appInfo?.dimensions as { width: number; height: number }) ?? null;
                  status.app.hasRedBox = retryProbe.hasRedBox;
                  status.app.errorCount = retryProbe.errorCount;
                  status.app.isPaused = client.isPaused;
                  status.app.architecture = narrowArchitecture(retryProbe.appInfo?.architecture);
                  status.cdp.device = client.connectedTarget?.title ?? null;
                  status.cdp.pageId = client.connectedTarget?.id ?? null;
                  status.cdp.bundleId = client.connectedTarget?.description ?? null;
                  status.capabilities.fiberTree = retryProbe.fiberTree;
                  devRecovered = true;
                  autoRecoveredMessage = 'Reconnected to correct JS context';
                }
              } catch {
                // Probe parse failed, fall through to warning
              }
            }
          }
        } catch {
          // Recovery failed, fall through to warning
        }
        if (!devRecovered) {
          return warnResult(
            status,
            "Connected to a JS context where __DEV__ is false. This may not be the app's main context. Try cdp_reload(full=true) or restart Metro.",
          );
        }
      }

      if (status.app.isPaused) {
        // Auto-recovery: resume paused debugger (D306).
        try {
          await client.softReconnect();
          status.app.isPaused = client.isPaused;
          status.cdp.device = client.connectedTarget?.title ?? null;
          status.cdp.pageId = client.connectedTarget?.id ?? null;
          status.cdp.bundleId = client.connectedTarget?.description ?? null;
        } catch {
          // softReconnect failed — fall through to the wedge recovery below.
        }
        if (status.app.isPaused) {
          // GH#202 Phase 2b: the JS thread is suspended because the app lost
          // foreground. Bounded re-foreground recovery (max 3 consecutive per
          // session; SKIPPED while a Maestro flow holds the arbiter lease).
          const wedge = await recoverWedge(client);
          if (wedge.recovered) {
            status.app.isPaused = client.isPaused; // resumed
            status.cdp.device = client.connectedTarget?.title ?? null;
            status.cdp.pageId = client.connectedTarget?.id ?? null;
            status.cdp.bundleId = client.connectedTarget?.description ?? null;
          } else {
            const hint =
              wedge.reason === 'flow-active'
                ? 'A Maestro flow is running — skipped re-foreground recovery. Wait for the flow to finish, then retry.'
                : wedge.reason === 'budget-exhausted'
                  ? 'Wedge-recovery budget exhausted this session. Try cdp_restart(hardReset=true).'
                  : 'Re-foreground recovery did not clear the wedge. Try cdp_restart(hardReset=true).';
            return warnResult(status, `Debugger paused / app backgrounded. ${hint}`);
          }
        }
      }

      const reloadCount = getSessionReloadCount();
      if (reloadCount >= 5) {
        return warnResult(
          status,
          `${reloadCount} full reloads in this session. NativeWind stylesheet may be corrupted — if the screen appears blank, restart Metro and relaunch the app.`,
        );
      }

      // B114 (D642): suspicion hint. When we're CDP-connected but the app didn't
      // inject helpers and has no JS errors to show, the visible app state
      // (RedBox, blank screen, native-module-missing) is INVISIBLE to our tools
      // because __RN_AGENT never loaded. Point the agent at cdp_native_errors.
      if (
        status.cdp.connected &&
        !client.helpersInjected &&
        !status.app.hasRedBox &&
        status.app.errorCount === 0
      ) {
        return warnResult(
          status,
          'CDP connected but app helpers not injected and no JS errors captured. The app may have crashed natively before __RN_AGENT loaded (e.g. missing native module, failed bundle fetch). Call cdp_native_errors to inspect the platform log.',
        );
      }

      // GH #303: the connected Metro serves a different worktree than this session.
      const mismatch = computeMetroMismatch({
        servingCwd: status.metro.servingCwd ?? null,
        projectRoot: status.metro.projectRoot,
        port: status.metro.port,
      });
      if (mismatch.mismatch) {
        return warnResult(status, mismatch.warning!);
      }

      return okResult(
        status,
        autoRecoveredMessage ? { meta: { autoRecovered: autoRecoveredMessage } } : undefined,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Affinity refusals never fall into picker auto-repair: a picker/device
      // action could mask the wrong-platform causal boundary.
      if (err instanceof TargetSelectionError) {
        // Refusal must not wedge the session: disconnect() disposes the shared
        // client, so recreate it or every later call fails "Client is disposed".
        const stale = getClient();
        const stalePort = stale.metroPort;
        await stale.disconnect().catch(() => undefined);
        setClient(createClient(stalePort));
        return failResult(message, err.code, {
          candidates: err.candidates.map((target) => ({
            id: target.id,
            title: target.title,
            deviceName: target.deviceName ?? null,
            description: target.description ?? null,
            platform: target.platform ?? null,
            confidence: target.platformInference ?? 'probed',
          })),
          affinity: 'cross-platform-only; iOS UDID identity is unavailable from Metro',
        });
      }

      // GH #208 (RC3): Metro is up but the app detached (0 Hermes targets). Auto
      // cold-restart it (bounded, arbiter-aware, opt-out RN_AUTO_RELAUNCH_ON_DETACH=0),
      // then reconnect and return a fresh status. On failure, surface a legible
      // state (reconnect attempt count + escape hatch) rather than a misleading error.
      if (err instanceof AppDetachedError) {
        // GH #208 review (Codex F2): RC3 auto-relaunch is iOS-only and acts on the
        // active device session. If the caller explicitly pinned a non-iOS platform,
        // do NOT cold-restart the iOS session they didn't ask about — surface the
        // detached state instead.
        const callerPinnedNonIos = !!args.platform && args.platform.toLowerCase() !== 'ios';
        const recovery: DetachedRecoveryResult = callerPinnedNonIos
          ? { recovered: false, reason: 'unsupported-platform', attempt: 0 }
          : await recoverDetachedFn(getClient(), { snapshotHint: snapshotHintForBundleId });
        if (recovery.recovered) {
          // GH #208 review (Gemini F2): never let a post-reconnect status read throw
          // out of the catch — degrade to a minimal warn instead of crashing the tool.
          try {
            return warnResult(
              await buildStatusResult(getClient()),
              `App had detached (Metro up, 0 Hermes targets) — auto-relaunched and reconnected (attempt ${recovery.attempt}).`,
            );
          } catch {
            return warnResult(
              { recovered: true },
              `App had detached (Metro up, 0 Hermes targets) — auto-relaunched and reconnected (attempt ${recovery.attempt}), but reading the full status failed; retry cdp_status.`,
            );
          }
        }
        // GH #262: the bundle is CONFIRMED missing (e.g. simulator erased) —
        // the generic "relaunch manually / hardReset" hints below can never
        // work. Return the distinct code with install advice instead.
        if (recovery.reason === 'app-not-installed') {
          return failResult(
            `${message} ${buildNotInstalledAdvice(
              recovery.udid ?? 'booted',
              recovery.appId ?? 'the app',
              recovery.snapshotHint ?? null,
            )}`,
            'APP_NOT_INSTALLED',
            {
              reconnect: getClient().reconnectState,
              autoConnect: getClient().autoConnectState,
              bridge: bridgeEnvState(process.env),
              recovery,
            },
          );
        }
        const detachedHint =
          recovery.reason === 'flow-active'
            ? 'A Maestro flow is running — skipped auto-relaunch. Wait for the flow to finish, then retry cdp_status.'
            : recovery.reason === 'opted-out'
              ? 'Auto-relaunch is disabled (RN_AUTO_RELAUNCH_ON_DETACH=0). Relaunch the app manually, or call cdp_restart(hardReset=true).'
              : recovery.reason === 'budget-exhausted'
                ? 'Auto-relaunch budget exhausted this session. Relaunch the app manually, or call cdp_restart(hardReset=true).'
                : recovery.reason === 'no-session'
                  ? 'No active device session to relaunch from. Relaunch the app on the simulator, or call cdp_restart(hardReset=true).'
                  : recovery.reason === 'unsupported-platform'
                    ? 'Auto-relaunch is iOS-only here. Relaunch the app on the device, then retry cdp_status.'
                    : 'Auto-relaunch did not restore the app. Relaunch it manually, or call cdp_restart(hardReset=true).';
        const errSuffix = recovery.error ? ` (relaunch error: ${recovery.error})` : '';
        return failResult(`${message} ${detachedHint}${errSuffix}`, 'APP_DETACHED', {
          reconnect: getClient().reconnectState,
          autoConnect: getClient().autoConnectState,
          bridge: bridgeEnvState(process.env),
          recovery,
        });
      }

      // GH #184: the status-scoped connect aborted fast because React was
      // unreachable on a non-Hermes target (picker blocking the bundle, or it's
      // still building). The message is already actionable; still attempt the
      // best-effort auto-dismiss below (helps when a device session is open),
      // then surface it with a typed code instead of a generic failure.
      const pickerBlocking = err instanceof PickerBlockingBundleError;

      // If connection failed, check if the Dev Client picker is blocking
      try {
        const pickerResult = await handleDevClientPicker();
        if (pickerResult?.dismissed) {
          // Picker was dismissed — retry connection automatically
          try {
            let retryClient = getClient();
            if (!retryClient.isConnected) {
              const activeFilters = sessionConnectFilters(getActiveSession());
              const retryFilters: ConnectFilters =
                activeFilters ?? (args.platform ? { platform: args.platform.toLowerCase() } : {});
              await retryClient.autoConnect(args.metroPort, retryFilters, 'status');
              if (!targetMatchesSession(retryClient.connectedTarget, retryFilters)) {
                const wrong = retryClient.connectedTarget;
                const retryPort = retryClient.metroPort;
                await retryClient.disconnect();
                setClient(createClient(retryPort));
                return failResult(
                  'Picker dismissal connected a target that failed post-connect platform/session validation; the socket was disconnected.',
                  retryFilters.targetId ? 'TARGET_PLATFORM_CONFLICT' : 'PLATFORM_TARGET_NOT_FOUND',
                  { target: wrong, affinity: 'cross-platform-only; not iOS UDID identity' },
                );
              }
            }
            // If retry succeeds, run the full status handler again
            if (retryClient.isConnected) {
              // Re-invoke ourselves (the outer function) for a clean status
              return warnResult(
                await buildStatusResult(retryClient),
                `Dev Client picker was blocking — auto-dismissed (${pickerResult.reason}). Connection recovered.`,
              );
            }
          } catch {
            /* retry failed — fall through */
          }
          return failResult(
            `${message}. Dev Client picker was dismissed but reconnection failed. Try cdp_status again.`,
          );
        }
        if (
          pickerResult &&
          !pickerResult.dismissed &&
          pickerResult.reason.includes('could not find')
        ) {
          return failResult(`${message}. ${pickerResult.reason}`);
        }
      } catch {
        /* picker check failed, return original error */
      }

      // GH #208 (RC1): carry the reconnect attempt count so a connect failure
      // during a reconnect storm reads as "attempt N/30", not a dead end.
      return pickerBlocking
        ? failResult(message, 'PICKER_BLOCKING', {
            autoConnect: getClient().autoConnectState,
            bridge: bridgeEnvState(process.env),
          })
        : failResult(message, {
            reconnect: getClient().reconnectState,
            autoConnect: getClient().autoConnectState,
            bridge: bridgeEnvState(process.env),
          });
    }
  };
}
