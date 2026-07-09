import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runNative, setActiveSession, clearActiveSession, getActiveSession, ensureFastRunner, ensureRunnerForCommand, attachMetaNote, cacheSnapshot, getAdbSerial, } from '../agent-device-wrapper.js';
import { consumePendingFastRunnerArtifactNote, stopFastRunner, } from '../runners/rn-fast-runner-client.js';
import { stopAndroidRunner, resolveAndroidSerial, startAndroidRunner, consumePendingAndroidUpgradeNote, } from '../runners/rn-android-runner-client.js';
import { resolveIosUdid } from './device-screenshot-raw.js';
import { markCdpStale } from '../cdp/recovery.js';
import { detectAndroidExternalRunner, detectIosExternalRunner, foreignRunnerNotice, } from '../runners/external-runner-detect.js';
import { ensureSingleRunner } from '../runners/ensure-single-runner.js';
import { suppressIOSAutocorrect } from '../runners/suppress-ios-autocorrect.js';
import { resetWedgeRecoveryCounter } from '../cdp/recover-wedge.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { resolveBundleId } from '../project-config.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { logger } from '../logger.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak, } from './runner-leak-recovery.js';
import { DeviceLock } from '../lifecycle/device-lock.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { closeDeviceSession } from './device-session-close.js';
const execFile = promisify(execFileCb);
const HEARTBEAT_MS = 30_000;
let activeDeviceLock = null;
let heartbeatTimer = null;
function acquireDeviceLockForSession(platform, deviceId, appId) {
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
export function releaseDeviceLockForSession() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (activeDeviceLock) {
        activeDeviceLock.release();
        activeDeviceLock = null;
    }
}
export function deviceBusyMessage(deviceId, holder) {
    const label = holder.platform === 'android' ? 'Emulator/device' : 'Simulator';
    return (`${label} ${deviceId} is already owned by another rn-dev-agent bridge ` +
        `(PID ${holder.pid}, project ${holder.projectRoot}` +
        `${holder.appId ? `, app ${holder.appId}` : ''}). ` +
        `Close that session or target a different simulator.`);
}
/**
 * B112 (D641): check whether a given bundleId is currently running on the
 * booted device. iOS uses `xcrun simctl spawn booted launchctl list`;
 * Android uses `adb shell pidof <pkg>`. Exported for unit tests via the
 * optional probe injection.
 */
export async function isAppRunning(platform, bundleId, probes) {
    const p = (platform ?? 'ios').toLowerCase();
    if (p === 'android') {
        return (probes?.android ?? defaultAndroidProbe)(bundleId);
    }
    return (probes?.ios ?? defaultIOSProbe)(bundleId);
}
async function defaultIOSProbe(bundleId) {
    try {
        const { stdout } = await execFile('xcrun', ['simctl', 'spawn', 'booted', 'launchctl', 'list'], {
            timeout: 5000,
            encoding: 'utf8',
        });
        // launchctl list outputs lines like "<pid>  <status>  UIKitApplication:<bundleId>[...]"
        return stdout.includes(`UIKitApplication:${bundleId}`);
    }
    catch {
        return false;
    }
}
async function defaultAndroidProbe(bundleId) {
    try {
        const { stdout } = await execFile('adb', ['shell', 'pidof', bundleId], {
            timeout: 3000,
            encoding: 'utf8',
        });
        return stdout.trim().length > 0;
    }
    catch {
        return false;
    }
}
export function createDeviceSnapshotHandler() {
    return async (args) => {
        const action = args.action ?? 'snapshot';
        if (action === 'open') {
            let appId = args.appId;
            let autoDetected = false;
            if (!appId) {
                const platform = args.platform ?? 'ios';
                appId = resolveBundleId(platform) ?? undefined;
                if (!appId) {
                    return failResult('appId is required for action=open (e.g. "com.example.app"). ' +
                        'Could not auto-detect from app.json — provide appId explicitly.');
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
                return failResult(`Invalid appId "${String(appId).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`, 'INVALID_APPID');
            }
            // Refuse Expo Go — the in-tree device runner needs a Dev Client or
            // standalone build and cannot drive Expo Go.
            const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
            if (EXPO_GO_BUNDLES.includes(appId)) {
                return failResult('Expo Go is not supported — the in-tree device runner needs a Dev Client or standalone build. ' +
                    'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) + device_screenshot instead.', {
                    hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.',
                });
            }
            const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;
            // A device_snapshot action=open with `platform` OMITTED still opens an
            // iOS session, so normalize here and gate the iOS-only lock on this rather
            // than checking raw args.platform directly (which would silently skip the lock when omitted).
            const platform = (args.platform ?? 'ios').toLowerCase();
            const lockPlatform = platform === 'android' ? 'android' : 'ios';
            // GH#202 Phase 2 Task 4: resolve device id NATIVELY (no agent-device).
            const deviceId = lockPlatform === 'android'
                ? await resolveAndroidSerial(args.deviceId)
                : await resolveIosUdid(args.deviceId);
            if (!deviceId) {
                return failResult(`No booted ${platform} device found (or multiple booted — pass deviceId explicitly).`, 'NOT_CONNECTED');
            }
            // GH#202 Phase 1.5 / Task 4: acquire the lock BEFORE any side-effect.
            // On conflict, nothing has been launched yet — no teardown needed.
            const lockResult = acquireDeviceLockForSession(lockPlatform, deviceId, appId);
            if (lockResult.status === 'conflict') {
                return failResult(deviceBusyMessage(deviceId, lockResult.holder), {
                    code: 'DEVICE_BUSY',
                    holder: lockResult.holder,
                });
            }
            if (lockResult.degraded) {
                logger.warn('rn-device', `Device-ownership lock unavailable (fs error) for ${deviceId} — ` +
                    `cross-bridge contention protection is off this session.`);
            }
            // B112 (D641): attachOnly mode — skip the app launch when the user knows
            // the app is already running. Avoids the unconditional relaunch that
            // invalidates CDP sessions and can race Metro bundle loading.
            if (args.attachOnly) {
                const running = await isAppRunning(platform, appId);
                if (!running) {
                    releaseDeviceLockForSession();
                    return failResult(`attachOnly=true but ${appId} is not running on ${platform}. Launch it manually or drop attachOnly.`, 'NOT_CONNECTED');
                }
            }
            // Ensure runner + launch. Any failure releases the lock before returning.
            // GH #383: the transparent-upgrade note must surface on EVERY entry path,
            // not just runNative — capture it here and attach to the open result.
            let upgradeNote;
            try {
                if (lockPlatform === 'ios') {
                    // ensureRunnerForCommand re-probes liveness and returns a clean
                    // {ok:false,message} when the XCUITest rig can't come up (ensureFastRunner
                    // swallows its own start error), so `open` surfaces RN_FAST_RUNNER_DOWN
                    // here instead of falsely reporting success against an un-prebuilt rig.
                    // GH #383: propagate its typed code (RUNNER_PROTOCOL_MISMATCH) when set.
                    // GH #418: open is the only entry allowed to invalidate a stale
                    // runner artifact and pay the cold rebuild (mid-flow refuses fast).
                    const ready = await ensureRunnerForCommand(deviceId, appId, {
                        allowArtifactRebuild: true,
                    });
                    if (!ready.ok) {
                        // GH #382: a failed start may have left a pending artifact note —
                        // discard it so it never leaks onto a later successful result.
                        consumePendingFastRunnerArtifactNote();
                        releaseDeviceLockForSession();
                        return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN');
                    }
                    // GH #382: an upgrade note wins; otherwise surface the artifact note
                    // (e.g. "downloaded prebuilt runner (~4 MB)").
                    upgradeNote = ready.note ?? consumePendingFastRunnerArtifactNote();
                    // A bare simctl launch foregrounds a running PID without relaunch —
                    // safe whether or not attachOnly; ignore errors (app may be frontmost).
                    await execFile('xcrun', ['simctl', 'launch', deviceId, appId], {
                        timeout: 10_000,
                        encoding: 'utf8',
                    }).catch(() => {
                        /* already frontmost is OK */
                    });
                }
                else {
                    // GH #418: open may invalidate stale runner APKs + Gradle-rebuild.
                    await startAndroidRunner(deviceId, appId, undefined, { allowArtifactRebuild: true });
                    upgradeNote = consumePendingAndroidUpgradeNote();
                    if (!args.attachOnly) {
                        await execFile('adb', [
                            '-s',
                            deviceId,
                            'shell',
                            'monkey',
                            '-p',
                            appId,
                            '-c',
                            'android.intent.category.LAUNCHER',
                            '1',
                        ], { timeout: 10_000, encoding: 'utf8' });
                    }
                }
            }
            catch (err) {
                releaseDeviceLockForSession();
                // GH #383: startAndroidRunner may have set a pending upgrade note (reap
                // on protocol mismatch) before throwing for an unrelated reason (adb
                // forward race, exit-before-ready, spawn error). Discard it here so it
                // doesn't leak onto the next successful Android result.
                consumePendingAndroidUpgradeNote();
                const msg = err instanceof Error ? err.message : String(err);
                // GH #418: even the open-path rebuild couldn't produce a runner with
                // the required commands — the checkout itself is suspect.
                if (msg.startsWith('RUNNER_COMMANDS_STALE')) {
                    return failResult(msg, 'RUNNER_COMMANDS_STALE');
                }
                // GH #383: a protocol mismatch that survived the reap+reinstall is a
                // distinct, actionable failure — surface it, not the generic runner-down.
                if (msg.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
                    return failResult(msg, 'RUNNER_PROTOCOL_MISMATCH');
                }
                const code = lockPlatform === 'ios' ? 'RN_FAST_RUNNER_DOWN' : 'RN_ANDROID_RUNNER_DOWN';
                return failResult(`Failed to start device runner: ${msg}`, code);
            }
            // Set session LAST — only after lock + runner + launch all succeeded.
            setActiveSession({
                name: sessionName,
                platform,
                deviceId,
                openedAt: new Date().toISOString(),
                appId,
            });
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
                    for (const w of r.warnings)
                        logger.warn('rn-device', w);
                }
                catch (err) {
                    logger.warn('rn-device', `ensureSingleRunner failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            // Task 9 of Android-MVP: warn on competing Android UIAutomator /
            // agent-device processes that would contend for input + focus with
            // our rn-android-runner. Fires by default (Task 11 flipped the
            // runner default-on); opt-out via RN_ANDROID_RUNNER=0.
            if (platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0') {
                detectAndroidExternalRunner(undefined, getAdbSerial())
                    .then((warning) => {
                    if (!warning)
                        return;
                    logger.warn('rn-device', warning.message);
                    for (const line of warning.processLines) {
                        logger.warn('rn-device', `  ${line.trim()}`);
                    }
                })
                    .catch(() => {
                    /* non-fatal */
                });
            }
            if (platform === 'ios') {
                // #191 prong 3 — best-effort predictive-keyboard suppression. Gated on
                // iOS+udid only (NOT the kill-legacy opt-out — orthogonal concern).
                // Fire-and-forget: a hung simctl must never stall session-open (up to
                // 3×5s timeouts), and the result is consumed only for warning logs.
                suppressIOSAutocorrect(deviceId)
                    .then((sup) => {
                    if (sup.warnings.length)
                        logger.info('rn-device', `suppressIOSAutocorrect: ${sup.warnings.join('; ')}`);
                })
                    .catch(() => {
                    /* fail-open: never block session-open on keyboard prefs */
                });
            }
            // GH#202 Phase 3: proactive foreign-runner heads-up (informational only).
            // Skip when opted out, or when WE hold the flow lease (a detected maestro
            // driver is then our own L3 run — external opens are already refused
            // BUSY_FLOW_ACTIVE upstream; this guard covers composite/internal callers).
            // UDID-scoped + best-effort: the detector never throws (can't fail the
            // open); its ≤2s latency is surfaced in meta.timings_ms.
            let foreign = null;
            let foreignDetectMs;
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
            const data = { ok: true, sessionName, platform, deviceId, appId };
            let result;
            if (autoDetected || foreign) {
                const warning = [
                    autoDetected ? `appId auto-detected from app.json: ${appId}` : null,
                    foreign ? foreign.warning : null,
                ]
                    .filter(Boolean)
                    .join('; ');
                const meta = { ...(foreign ? foreign.meta : {}) };
                if (foreignDetectMs !== undefined)
                    meta.timings_ms = { foreignDetect: foreignDetectMs };
                result = warnResult(data, warning, meta);
            }
            else {
                result = okResult(data);
            }
            return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
        }
        if (action === 'close') {
            return closeDeviceSession({
                hasActiveSession: () => getActiveSession() !== null,
                closeUnderlyingSession: async () => okResult({ closed: true }),
                clearActiveSession,
                stopFastRunner,
                stopAndroidRunner,
                releaseDeviceLock: releaseDeviceLockForSession,
                getDeviceId: () => getActiveSession()?.deviceId,
            });
        }
        // action === 'snapshot'
        if (!getActiveSession()) {
            return failResult('No device session open. Call device_snapshot with action="open" first.', {
                hint: 'Provide appId and platform to start a session.',
            });
        }
        const result = await rawSnapshot();
        const nodes = parseSnapshotNodes(result);
        if (!result.isError && nodes && isAgentDeviceRunnerSentinel(nodes)) {
            const session = getActiveSession();
            const recovery = await recoverFromRunnerLeak({ platform: session?.platform, appId: session?.appId, sessionName: session?.name }, {
                // B130 (D659): the recovery close must also clear the local session
                // state (activeSession → null, ref-map → empty, fast-runner stopped)
                // so the post-recovery re-snapshot goes through the daemon/CLI path
                // that populates ref refs, NOT the fast-runner path which returns
                // a tree-shaped result lacking @eN refs. Without this, `device_fill`
                // after recovery fails with "No snapshot in session" because the
                // ref-map is stale (from pre-recovery) OR non-existent (after fresh
                // session open), and fast-runner serves the (ref-less) snapshot.
                closeSession: async () => {
                    clearActiveSession(); // also clears refMap via its side-effect
                    stopFastRunner(session?.deviceId);
                    await stopAndroidRunner(session?.deviceId);
                    return okResult({ closed: true });
                },
                openSession: ({ appId, platform, attachOnly }) => reopenSessionForRecovery(appId, platform, attachOnly),
                resnapshot: () => rawSnapshot(),
                parseNodes: parseSnapshotNodes,
                // GH #186: non-destructive reacquire tried before the destructive
                // close/relaunch tiers. Only when we have the full iOS context
                // (appId + deviceId) needed to re-foreground the app and restart the
                // fast-runner; otherwise omitted so recovery falls back to the
                // existing tiers.
                reacquire: session?.platform === 'ios' && session?.appId && session?.deviceId
                    ? () => reacquireIosTargetApp(session.appId, session.deviceId)
                    : undefined,
            });
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
export function runnerLeakFailureMessage(reason, session) {
    if (reason === 'no-session-context' && session && !session.appId) {
        return "device_snapshot returned AgentDeviceRunner's own UI tree, but auto-recovery cannot run because the active session has no stored appId. This usually means the session was opened by a plugin version from before B119 / GH #35 landed.";
    }
    return "device_snapshot returned AgentDeviceRunner's own UI tree instead of the target app (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.";
}
export function runnerLeakFailureHint(reason, session) {
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
async function reacquireIosTargetApp(appId, deviceId) {
    try {
        stopFastRunner(deviceId);
    }
    catch {
        /* best-effort — may already be dead */
    }
    try {
        await execFile('xcrun', ['simctl', 'launch', 'booted', appId], {
            timeout: 5000,
            encoding: 'utf8',
        });
    }
    catch {
        /* best-effort — the sentinel re-check covers a failed foreground */
    }
    try {
        await ensureFastRunner(deviceId, appId);
    }
    catch {
        /* non-fatal — re-snapshot will surface a still-broken runner */
    }
    return okResult({ reacquired: true, appId });
}
async function rawSnapshot() {
    return runNative(['snapshot', '-i']);
}
function parseSnapshotNodes(result) {
    if (result.isError)
        return null;
    try {
        const envelope = JSON.parse(result.content[0].text);
        if (!envelope.ok || !envelope.data?.nodes)
            return null;
        return envelope.data.nodes;
    }
    catch {
        return null;
    }
}
function cacheSnapshotIfPossible(result) {
    if (result.isError)
        return;
    try {
        const envelope = JSON.parse(result.content[0].text);
        const platform = getActiveSession()?.platform;
        if (platform && envelope.ok && envelope.data?.nodes) {
            cacheSnapshot(platform, envelope.data.nodes);
        }
    }
    catch {
        /* best-effort cache */
    }
}
function wrapWithMeta(result, meta) {
    if (result.isError)
        return result;
    try {
        const envelope = JSON.parse(result.content[0].text);
        envelope.meta = { ...envelope.meta, ...meta };
        return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    }
    catch {
        return result;
    }
}
export async function reopenSessionForRecovery(appId, platform, attachOnly) {
    // Always mint a fresh recovery name (Gemini G3): reusing the original
    // session name risks silently re-attaching to the corrupted session.
    const recoveryName = `rn-agent-recovery-${Date.now()}`;
    // Delegate to the native open path (Phase 2 Task 4): resolve device → acquire
    // lock → ensure runner → launch → set session. The recovery closeSession
    // intentionally left our device lock held; the native open re-acquires it
    // cleanly (acquireDeviceLockForSession releases any prior same-process lock
    // first), so there is no self-DEVICE_BUSY. This replaces the old
    // agent-device `open` RPC + envelope/UDID_RE parse.
    return createDeviceSnapshotHandler()({
        action: 'open',
        appId,
        platform: platform,
        attachOnly,
        sessionName: recoveryName,
    });
}
