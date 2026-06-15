import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runAgentDevice,
  setActiveSession,
  clearActiveSession,
  getActiveSession,
  ensureFastRunner,
  cacheSnapshot,
  getAdbSerial,
} from '../agent-device-wrapper.js';
import { stopFastRunner } from '../runners/rn-fast-runner-client.js';
import { markCdpStale } from '../cdp/recovery.js';
import { detectAndroidExternalRunner, detectIosExternalRunner, foreignRunnerNotice } from '../runners/external-runner-detect.js';
import { ensureSingleRunner } from '../runners/ensure-single-runner.js';
import { suppressIOSAutocorrect } from '../runners/suppress-ios-autocorrect.js';
import { resetWedgeRecoveryCounter } from '../cdp/recover-wedge.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { resolveBundleId } from '../project-config.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { logger } from '../logger.js';
import {
  isAgentDeviceRunnerSentinel,
  recoverFromRunnerLeak,
  type RunnerLeakNode,
} from './runner-leak-recovery.js';
import { DeviceLock } from '../lifecycle/device-lock.js';
import type { DeviceLockResult, DeviceLockBody } from '../lifecycle/device-lock.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { closeDeviceSession } from './device-session-close.js';

const execFile = promisify(execFileCb);

const HEARTBEAT_MS = 30_000;
let activeDeviceLock: DeviceLock | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function acquireDeviceLockForSession(platform: 'ios' | 'android', deviceId: string, appId: string): DeviceLockResult {
  // Single-owner: drop any prior lock + heartbeat first (release is null-safe)
  // so a re-open can't leak a timer or orphan a lock. (#202 review — blocker.)
  releaseDeviceLockForSession();
  const lock = new DeviceLock({ platform, deviceId, appId });
  const result = lock.acquire();
  // Only manage a heartbeat for a REAL exclusive lock — a degraded (fs-error)
  // acquire is unmanaged, so there is nothing to refresh or release.
  if (result.status === 'acquired' && !result.degraded) {
    activeDeviceLock = lock;
    heartbeatTimer = setInterval(() => lock.touch(), HEARTBEAT_MS);
    // Don't keep the event loop alive solely for the heartbeat (mirrors bgPoll).
    heartbeatTimer.unref();
  }
  return result;
}

export function releaseDeviceLockForSession(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (activeDeviceLock) { activeDeviceLock.release(); activeDeviceLock = null; }
}

export function deviceBusyMessage(deviceId: string, holder: DeviceLockBody): string {
  return (
    `Simulator ${deviceId} is already owned by another rn-dev-agent bridge ` +
    `(PID ${holder.pid}, project ${holder.projectRoot}` +
    `${holder.appId ? `, app ${holder.appId}` : ''}). ` +
    `Close that session or target a different simulator.`
  );
}

type SnapshotAction = 'open' | 'close' | 'snapshot';

interface SnapshotArgs {
  action: SnapshotAction;
  appId?: string;
  platform?: string;
  sessionName?: string;
  /**
   * B112 (D641): when true, skip launching the app — create a session that
   * attaches to the already-running process. Requires the app to be running;
   * returns an error if it isn't. Prevents the unwanted relaunch + bundle-race
   * cascade observed during Phase 88 Round 1.
   */
  attachOnly?: boolean;
}

/**
 * B112 (D641): check whether a given bundleId is currently running on the
 * booted device. iOS uses `xcrun simctl spawn booted launchctl list`;
 * Android uses `adb shell pidof <pkg>`. Exported for unit tests via the
 * optional probe injection.
 */
export async function isAppRunning(
  platform: string | undefined,
  bundleId: string,
  probes?: {
    ios?: (bundleId: string) => Promise<boolean>;
    android?: (bundleId: string) => Promise<boolean>;
  },
): Promise<boolean> {
  const p = (platform ?? 'ios').toLowerCase();
  if (p === 'android') {
    return (probes?.android ?? defaultAndroidProbe)(bundleId);
  }
  return (probes?.ios ?? defaultIOSProbe)(bundleId);
}

async function defaultIOSProbe(bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      'xcrun',
      ['simctl', 'spawn', 'booted', 'launchctl', 'list'],
      { timeout: 5000, encoding: 'utf8' },
    );
    // launchctl list outputs lines like "<pid>  <status>  UIKitApplication:<bundleId>[...]"
    return stdout.includes(`UIKitApplication:${bundleId}`);
  } catch {
    return false;
  }
}

async function defaultAndroidProbe(bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFile('adb', ['shell', 'pidof', bundleId], {
      timeout: 3000,
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function createDeviceSnapshotHandler(): (args: SnapshotArgs) => Promise<ToolResult> {
  return async (args) => {
    const action = args.action ?? 'snapshot';

    if (action === 'open') {
      let appId = args.appId;
      let autoDetected = false;

      if (!appId) {
        const platform = args.platform ?? 'ios';
        appId = resolveBundleId(platform) ?? undefined;
        if (!appId) {
          return failResult(
            'appId is required for action=open (e.g. "com.example.app"). ' +
            'Could not auto-detect from app.json — provide appId explicitly.',
          );
        }
        autoDetected = true;
      }

      // Phase 134.2 (deepsec HIGH): when attachOnly=true on Android,
      // `appId` reaches `adb shell pidof <appId>`, where the remote shell
      // re-interprets argv. Validate against the strict bundle-ID regex
      // before any adb invocation. Expo Go bundles (`host.exp.Exponent`)
      // satisfy the regex so the EXPO_GO_BUNDLES check below still fires
      // correctly.
      if (!isValidBundleId(appId)) {
        return failResult(
          `Invalid appId "${String(appId).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`,
          'INVALID_APPID',
        );
      }

      // Warn when targeting Expo Go — agent-device steals focus from Expo Go (B71)
      const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
      if (EXPO_GO_BUNDLES.includes(appId)) {
        return failResult(
          'agent-device is incompatible with Expo Go — it steals foreground focus (B71). ' +
          'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) and xcrun simctl for screenshots instead.',
          { hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.' },
        );
      }

      const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;

      // A device_snapshot action=open with `platform` OMITTED still opens an
      // iOS session, so normalize here and gate the iOS-only lock on this rather
      // than checking raw args.platform directly (which would silently skip the lock when omitted).
      const platform = (args.platform ?? 'ios').toLowerCase();

      // B112 (D641): attachOnly mode — skip the app launch when the user knows
      // the app is already running. Avoids the unconditional relaunch that
      // invalidates CDP sessions and can race Metro bundle loading.
      let cliArgs: string[];
      if (args.attachOnly) {
        const running = await isAppRunning(args.platform, appId);
        if (!running) {
          return failResult(
            `attachOnly=true but ${appId} is not running on ${args.platform ?? 'ios'}. Launch it manually (e.g. xcrun simctl launch / adb monkey) or drop attachOnly to let the session opener launch it.`,
            'NOT_CONNECTED',
          );
        }
        cliArgs = ['open', '--session', sessionName];
      } else {
        cliArgs = ['open', appId, '--session', sessionName];
      }
      if (args.platform) cliArgs.push('--platform', args.platform);

      const result = await runAgentDevice(cliArgs, { skipSession: true });

      if (!result.isError) {
        let deviceId: string | undefined;
        try {
          const envelope = JSON.parse(result.content[0].text);
          const data = envelope?.data;
          // agent-device `open` response shape (v0.8.0):
          //   data.id = device UDID (top-level)
          //   data.device_udid = UDID (duplicate)
          //   data.device = device NAME (string, e.g. "iPhone 17 Pro") — NOT an object
          //   data.deviceId = legacy field (older agent-device)
          // B107 fix: also read data.id / data.device_udid / (data.device.id when object).
          const rawId = data?.deviceId
            ?? data?.device_udid
            ?? data?.id
            ?? (typeof data?.device === 'object' ? data?.device?.id : undefined);
          const UDID_RE = /^[0-9A-Fa-f-]{25,}$/;
          deviceId = typeof rawId === 'string' && UDID_RE.test(rawId) ? rawId : undefined;
        } catch { /* best-effort */ }
        setActiveSession({
          name: sessionName,
          platform,
          deviceId,
          openedAt: new Date().toISOString(),
          appId,
        });

        // GH#202 Phase 1.5: claim exclusive ownership of THIS simulator across
        // bridge processes. The UDID is only known now (post-open). On conflict
        // another project's bridge owns the sim — tear our just-opened session
        // back down and refuse, rather than fight for foreground.
        if (platform === 'ios' && deviceId) {
          const lockResult = acquireDeviceLockForSession('ios', deviceId, appId);
          if (lockResult.status === 'conflict') {
            // Close FIRST — runAgentDevice derives `--session` from the active
            // session, so clearing before closing would close the wrong (or no)
            // session and leak the one we just opened (#202 review — blocker).
            await runAgentDevice(['close']).catch(() => { /* best-effort teardown */ });
            clearActiveSession();
            stopFastRunner();
            const h = lockResult.holder;
            return failResult(
              deviceBusyMessage(deviceId, h),
              { code: 'DEVICE_BUSY', holder: h },
            );
          }
          if (lockResult.degraded) {
            logger.warn(
              'rn-device',
              `Device-ownership lock unavailable (fs error) for ${deviceId} — ` +
              `cross-bridge contention protection is off this session.`,
            );
          }
        }

        // GH#202 Phase 2b: a genuinely-succeeded open is a fresh session — clear
        // the wedge-recovery budget. Placed AFTER the device-lock conflict
        // early-return so a refused DEVICE_BUSY open does NOT reset it.
        resetWedgeRecoveryCounter();
        resetDetachedRecoveryCounter(); // GH #208 (RC3): fresh session clears the auto-relaunch budget too

        // GH#202 Phase 1: enforce a single iOS interaction runner. The UDID is
        // known here (device-open), so scope-kill any stale AgentDeviceRunner
        // targeting THIS simulator and clear orphaned daemon lock files.
        // Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
        if (process.env.RN_DEVICE_KILL_LEGACY !== '0' && platform === 'ios' && deviceId) {
          // Await: the stale-runner kill (SIGTERM → 500ms grace → SIGKILL) must
          // finish BEFORE the session is usable, or the first device_* command
          // races it and a stale AgentDeviceRunner can still steal focus —
          // which is exactly the single-runner guarantee #202 promises. The
          // added latency lands on an already-slow session-open, not per-command.
          try {
            const r = await ensureSingleRunner({ udid: deviceId });
            if (r.killedPids.length) {
              logger.info('rn-device', `ensureSingleRunner: killed stale runner PID(s) ${r.killedPids.join(', ')} on ${deviceId}`);
            }
            if (r.removedFiles.length) {
              logger.info('rn-device', `ensureSingleRunner: removed ${r.removedFiles.join(', ')}`);
            }
            if (r.removedApps.length) {
              logger.info('rn-device', `ensureSingleRunner: uninstalled legacy runner app(s) ${r.removedApps.join(', ')} from ${deviceId}`);
            }
            for (const w of r.warnings) logger.warn('rn-device', w);
          } catch (err) {
            logger.warn('rn-device', `ensureSingleRunner failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Task 9 of Android-MVP: warn on competing Android UIAutomator /
        // agent-device processes that would contend for input + focus with
        // our rn-android-runner. Fires by default (Task 11 flipped the
        // runner default-on); opt-out via RN_ANDROID_RUNNER=0.
        if (args.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0') {
          detectAndroidExternalRunner(undefined, getAdbSerial())
            .then((warning) => {
              if (!warning) return;
              logger.warn('rn-device', warning.message);
              for (const line of warning.processLines) {
                logger.warn('rn-device', `  ${line.trim()}`);
              }
            })
            .catch(() => { /* non-fatal */ });
        }

        if (platform === 'ios' && deviceId) {
          ensureFastRunner(deviceId, appId).catch(() => { /* non-fatal */ });
          // #191 prong 3 — best-effort predictive-keyboard suppression. Gated on
          // iOS+udid only (NOT the kill-legacy opt-out — orthogonal concern).
          // Fire-and-forget: a hung simctl must never stall session-open (up to
          // 3×5s timeouts), and the result is consumed only for warning logs.
          suppressIOSAutocorrect(deviceId)
            .then((sup) => {
              if (sup.warnings.length) logger.info('rn-device', `suppressIOSAutocorrect: ${sup.warnings.join('; ')}`);
            })
            .catch(() => { /* fail-open: never block session-open on keyboard prefs */ });
        }

        // GH#202 Phase 3: proactive foreign-runner heads-up (informational only).
        // Skip when opted out, or when WE hold the flow lease (a detected maestro
        // driver is then our own L3 run — external opens are already refused
        // BUSY_FLOW_ACTIVE upstream; this guard covers composite/internal callers).
        // UDID-scoped + best-effort: the detector never throws (can't fail the
        // open); its ≤2s latency is surfaced in meta.timings_ms.
        let foreign: ReturnType<typeof foreignRunnerNotice> = null;
        let foreignDetectMs: number | undefined;
        if (platform === 'ios' && process.env.RN_IOS_FOREIGN_WARN !== '0') {
          const flowHeld = arbiter.snapshot.flowLeaseHeldBy !== null;
          if (!flowHeld) {
            const t0 = Date.now();
            const detection = await detectIosExternalRunner(undefined, deviceId);
            foreignDetectMs = Date.now() - t0;
            foreign = foreignRunnerNotice(detection, false);
          }
          if (foreign) {
            logger.warn('rn-device', foreign.warning);
            for (const line of foreign.meta.foreignRunner.processLines) {
              logger.warn('rn-device', `  ${line}`);
            }
          }
        }

        if (autoDetected || foreign) {
          const data = JSON.parse(result.content[0].text).data;
          const warning = [
            autoDetected ? `appId auto-detected from app.json: ${appId}` : null,
            foreign ? foreign.warning : null,
          ].filter(Boolean).join('; ');
          const meta: Record<string, unknown> = { ...(foreign ? foreign.meta : {}) };
          if (foreignDetectMs !== undefined) meta.timings_ms = { foreignDetect: foreignDetectMs };
          return warnResult(data, warning, meta);
        }
      }

      return result;
    }

    if (action === 'close') {
      return closeDeviceSession({
        hasActiveSession: () => getActiveSession() !== null,
        closeUnderlyingSession: () => runAgentDevice(['close']),
        clearActiveSession,
        stopFastRunner,
        releaseDeviceLock: releaseDeviceLockForSession,
      });
    }

    // action === 'snapshot'
    if (!getActiveSession()) {
      return failResult(
        'No device session open. Call device_snapshot with action="open" first.',
        { hint: 'Provide appId and platform to start a session.' },
      );
    }

    const result = await rawSnapshot();
    const nodes = parseSnapshotNodes(result);

    if (!result.isError && nodes && isAgentDeviceRunnerSentinel(nodes)) {
      const session = getActiveSession();
      const recovery = await recoverFromRunnerLeak(
        { platform: session?.platform, appId: session?.appId, sessionName: session?.name },
        {
          // B130 (D659): the recovery close must also clear the local session
          // state (activeSession → null, ref-map → empty, fast-runner stopped)
          // so the post-recovery re-snapshot goes through the daemon/CLI path
          // that populates ref refs, NOT the fast-runner path which returns
          // a tree-shaped result lacking @eN refs. Without this, `device_fill`
          // after recovery fails with "No snapshot in session" because the
          // ref-map is stale (from pre-recovery) OR non-existent (after fresh
          // session open), and fast-runner serves the (ref-less) snapshot.
          closeSession: async () => {
            const closeResult = await runAgentDevice(['close']);
            clearActiveSession(); // also clears refMap via its side-effect
            stopFastRunner();
            return closeResult;
          },
          openSession: ({ appId, platform, attachOnly }) =>
            reopenSessionForRecovery(appId, platform, attachOnly),
          resnapshot: () => rawSnapshot(),
          parseNodes: parseSnapshotNodes,
          // GH #186: non-destructive reacquire tried before the destructive
          // close/relaunch tiers. Only when we have the full iOS context
          // (appId + deviceId) needed to re-foreground the app and restart the
          // fast-runner; otherwise omitted so recovery falls back to the
          // existing tiers.
          reacquire: (session?.platform === 'ios' && session?.appId && session?.deviceId)
            ? () => reacquireIosTargetApp(session.appId!, session.deviceId!)
            : undefined,
        },
      );

      if (recovery.recovered) {
        cacheSnapshotIfPossible(recovery.result);
        // GH #186: the recovery re-foregrounded/relaunched the app, which can
        // leave the CDP target pinned to a now-stale context. Flag it so the
        // next cdp_* call re-pins proactively (fast) instead of hitting the
        // ~47s STALE_TARGET timeout that prompted this issue.
        markCdpStale();
        return wrapWithMeta(recovery.result, {
          recovered: 'agent-device-runner-leak',
          recoveryTier: recovery.tier,
        });
      }

      return failResult(runnerLeakFailureMessage(recovery.reason, session), {
        code: 'RUNNER_LEAK',
        recoveryReason: recovery.reason,
        hint: runnerLeakFailureHint(recovery.reason, session),
      });
    }

    cacheSnapshotIfPossible(result);
    return result;
  };
}

export function runnerLeakFailureMessage(
  reason: string | undefined,
  session: { appId?: string } | null,
): string {
  if (reason === 'no-session-context' && session && !session.appId) {
    return 'device_snapshot returned AgentDeviceRunner\'s own UI tree, but auto-recovery cannot run because the active session has no stored appId. This usually means the session was opened by a plugin version from before B119 / GH #35 landed.';
  }
  return 'device_snapshot returned AgentDeviceRunner\'s own UI tree instead of the target app (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.';
}

export function runnerLeakFailureHint(
  reason: string | undefined,
  session: { appId?: string } | null,
): string {
  if (reason === 'no-session-context' && session && !session.appId) {
    return 'Run device_snapshot action=close, then action=open appId=<your.bundle.id> platform=ios to start a session that supports auto-recovery.';
  }
  return 'Manually close + reopen the session with action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). Upstream: Callstack/agent-device, see B119/GH#35.';
}

/**
 * GH #186: non-destructive reacquire of the iOS target app after a runner-leak
 * sentinel. Both the daemon-leak and a maestro-eviction (a foreign XCUITest
 * session stealing focus) surface as the same sentinel, so rather than closing
 * the session + relaunching (~44s, drops JS/CDP state) we: stop the
 * (possibly evicted) fast-runner so it can't compete for focus, re-foreground
 * the TARGET app via simctl (displacing the foreign session), then restart the
 * fast-runner bound to the app. The caller (recoverFromRunnerLeak) re-snapshots
 * and only falls through to the destructive tiers if the sentinel persists.
 * Mirrors repair-action.ts:bringTargetAppToForeground, kept local here to keep
 * the dependency surface tight (same rationale as that copy).
 */
async function reacquireIosTargetApp(appId: string, deviceId: string): Promise<ToolResult> {
  try { stopFastRunner(); } catch { /* best-effort — may already be dead */ }
  try {
    await execFile('xcrun', ['simctl', 'launch', 'booted', appId], { timeout: 5000, encoding: 'utf8' });
  } catch { /* best-effort — the sentinel re-check covers a failed foreground */ }
  try {
    await ensureFastRunner(deviceId, appId);
  } catch { /* non-fatal — re-snapshot will surface a still-broken runner */ }
  return okResult({ reacquired: true, appId });
}

async function rawSnapshot(): Promise<ToolResult> {
  return runAgentDevice(['snapshot', '-i']);
}

function parseSnapshotNodes(result: ToolResult): RunnerLeakNode[] | null {
  if (result.isError) return null;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: RunnerLeakNode[] };
    };
    if (!envelope.ok || !envelope.data?.nodes) return null;
    return envelope.data.nodes;
  } catch {
    return null;
  }
}

function cacheSnapshotIfPossible(result: ToolResult): void {
  if (result.isError) return;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: { ref: string; label?: string; identifier?: string; type?: string; hittable?: boolean }[] };
    };
    const platform = getActiveSession()?.platform;
    if (platform && envelope.ok && envelope.data?.nodes) {
      cacheSnapshot(platform, envelope.data.nodes);
    }
  } catch { /* best-effort cache */ }
}

function wrapWithMeta(result: ToolResult, meta: Record<string, unknown>): ToolResult {
  if (result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as { ok?: boolean; data?: unknown; meta?: Record<string, unknown> };
    envelope.meta = { ...envelope.meta, ...meta };
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch {
    return result;
  }
}

export async function reopenSessionForRecovery(
  appId: string,
  platform: string,
  attachOnly: boolean,
): Promise<ToolResult> {
  // Always mint a fresh recovery name (Gemini G3): reusing the original
  // session name risks the daemon either rejecting as "already exists" or
  // silently re-attaching to the corrupted session, defeating the rebuild.
  const recoveryName = `rn-agent-recovery-${Date.now()}`;

  let cliArgs: string[];
  if (attachOnly) {
    // attachOnly only makes sense if the target app is already running.
    // Otherwise there's nothing to attach to and we should let the caller
    // escalate (typically to the full-relaunch tier).
    const running = await isAppRunning(platform, appId);
    if (!running) {
      return failResult(
        `attachOnly recovery aborted: ${appId} is not running on ${platform}.`,
        { code: 'NOT_CONNECTED', recoveryAbort: true },
      );
    }
    cliArgs = ['open', '--session', recoveryName, '--platform', platform];
  } else {
    cliArgs = ['open', appId, '--session', recoveryName, '--platform', platform];
  }

  const result = await runAgentDevice(cliArgs, { skipSession: true });
  if (result.isError) return result;

  let deviceId: string | undefined;
  try {
    const envelope = JSON.parse(result.content[0].text);
    const data = envelope?.data;
    const rawId = data?.deviceId
      ?? data?.device_udid
      ?? data?.id
      ?? (typeof data?.device === 'object' ? data?.device?.id : undefined);
    const UDID_RE = /^[0-9A-Fa-f-]{25,}$/;
    deviceId = typeof rawId === 'string' && UDID_RE.test(rawId) ? rawId : undefined;
  } catch { /* best-effort */ }

  setActiveSession({
    name: recoveryName,
    platform,
    deviceId,
    openedAt: new Date().toISOString(),
    appId,
  });
  return result;
}
