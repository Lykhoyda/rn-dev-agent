import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { okResult, failResult } from '../utils.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { resolveBundleIdStrict } from '../project-config.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { probeAppInstalled, buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
const defaultExecFile = promisify(execFileCb);
/**
 * Module-scoped last-known bundle id, keyed by platform (GH #262 / #194 BUG 2).
 *
 * After a first `hardReset=true` call, a NEW CDPClient is set whose
 * `connectedTarget` is `null` until `autoConnect` succeeds. If autoConnect
 * fails (Hermes hasn't re-registered within our window), a second
 * `hardReset=true` would read `null` as bundleId and degrade to a soft reset.
 * Cache the bundleId at module scope so subsequent calls keep working.
 *
 * Keyed by platform because a single bridge process can switch platform
 * between connects, and a cross-platform cache hit would feed an Android
 * package to iOS simctl (then misreport APP_NOT_INSTALLED).
 */
const lastSeenBundleIds = new Map();
/** Strict iOS simulator UDID shape (matches `xcrun simctl list` output). */
const SIMULATOR_UDID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
/**
 * GH #262: `session.deviceId` is persisted, untrusted state that reaches
 * `xcrun simctl` argv. Accept only the literal `'booted'` or a strict UDID;
 * anything else falls back to `'booted'` rather than shelling out with it.
 */
function safeSimctlTarget(deviceId) {
    if (deviceId === 'booted')
        return 'booted';
    if (deviceId && SIMULATOR_UDID_RE.test(deviceId))
        return deviceId;
    return 'booted';
}
/**
 * Module-scoped in-flight guard (Codex review finding #2, conf 82).
 *
 * Two overlapping `cdp_restart hardReset=true` calls would both fire
 * `simctl terminate + launch` and race on `setClient`. The second
 * `launch` can land while the first `autoConnect` is mid-handshake,
 * re-wedging Hermes. Easy to trigger if the first appears hung —
 * exactly the wedge symptom.
 *
 * If a restart is already in flight, the second caller returns early.
 */
let inflightRestart = null;
/**
 * Test-only: reset module state between tests. The lastSeenBundleIds
 * cache and inflight guard would otherwise leak across test files.
 */
export function _resetRestartHandlerStateForTest() {
    lastSeenBundleIds.clear();
    inflightRestart = null;
}
/**
 * cdp_restart — in-process soft state reset (B76/D644) with optional
 * hard-reset escalation (GH #105 follow-up).
 *
 * Soft reset (default): Disconnects the current CDPClient (clears WebSocket,
 * ring buffers, background poll, reconnect state), creates a fresh
 * instance, and attempts to reconnect.
 *
 * Hard reset (hardReset=true): in addition, kills the fast-runner xcodebuild
 * process and terminates+relaunches the test-app via simctl before the soft
 * reset. Recovers from the "JS thread paused + agent-device runner steals
 * focus" wedge that previously required the user to manually run
 * `/reload-plugins` + `xcrun simctl terminate + launch`.
 *
 * The MCP server process is NOT restarted in either mode — for new dist/
 * code after npm run build, the caller must still quit + relaunch Claude
 * Code.
 */
export function createRestartHandler(getClient, setClient, createClient, deps = {}) {
    const execFile = deps.execFile ?? defaultExecFile;
    const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const resolveBundleIdStrictFn = deps.resolveBundleIdStrict ?? resolveBundleIdStrict;
    const getSessionFn = deps.getSession ?? getActiveSession;
    const probeAppInstalledFn = deps.probeAppInstalled ?? probeAppInstalled;
    const snapshotHintFn = deps.snapshotHint ?? snapshotHintForBundleId;
    const resetDetachedBudgetFn = deps.resetDetachedBudget ?? resetDetachedRecoveryCounter;
    async function doRestart(args) {
        try {
            logger.info('MCP', `cdp_restart: in-process state reset requested (hardReset=${!!args.hardReset})`);
            const oldClient = getClient();
            const preservedPort = oldClient.metroPort;
            // Capture the bundle id BEFORE we disconnect — the connectedTarget
            // is cleared on disconnect, and we need it to issue simctl commands.
            const observedBundleId = oldClient.connectedTarget?.description ?? null;
            const targetPlatform = (oldClient.connectedTarget?.platform ??
                args.platform ??
                'ios').toLowerCase();
            // The cache write must happen on every restart (incl. soft) so a later
            // hardReset still has a bundleId after autoConnect clears connectedTarget.
            if (observedBundleId)
                lastSeenBundleIds.set(targetPlatform, observedBundleId);
            const hardResetSteps = [];
            let bundleId = null;
            // Session lookup, the bundleId resolution chain, and UDID targeting only
            // matter for the hardReset simctl path — a soft reset must do zero
            // session/app.json I/O and must never fail on bundleId state.
            if (args.hardReset) {
                const session = getSessionFn();
                const sessionMatches = !!session && (session.platform ?? 'ios') === targetPlatform;
                // Resolution priority (GH #262 / #194 BUG 2): explicit arg > current
                // connectedTarget > active-session appId > cache > STRICT app.json.
                // The open device session is current user intent; the cache is
                // connect-time state that can be stale after switching apps in the
                // same bridge process — so the session outranks the cache. A fresh
                // bridge process has no cache, so without the fallbacks hardReset
                // silently degraded to a soft reset. STRICT: an Android package must
                // never be fed to iOS simctl.
                bundleId =
                    args.bundleId ??
                        observedBundleId ??
                        (sessionMatches ? (session?.appId ?? null) : null) ??
                        lastSeenBundleIds.get(targetPlatform) ??
                        resolveBundleIdStrictFn(targetPlatform);
                // simctl targets the session's simulator when one is open — 'booted' is
                // ambiguous with multiple booted sims. deviceId is persisted/untrusted,
                // so validate before it reaches argv (invalid → 'booted').
                const targetUdid = safeSimctlTarget(sessionMatches ? session?.deviceId : undefined);
                // Phase 134.2 precedent (see device-session.ts): never let an
                // unvalidated string reach `xcrun simctl terminate/launch` argv. An
                // explicit bad arg fails fast; a bad value resolved from cache/config
                // is dropped (treated as no-bundleId) rather than shelling out with it.
                if (bundleId !== null && !isValidBundleId(bundleId)) {
                    if (args.bundleId !== undefined) {
                        return failResult(`cdp_restart: invalid bundleId argument "${String(args.bundleId).slice(0, 80)}" — expected reverse-DNS app id like com.example.app`, 'INVALID_BUNDLE_ID');
                    }
                    hardResetSteps.push('skip-simctl:invalid-bundleId-from-cache-or-config');
                    bundleId = null;
                }
                // Step 1: kill the fast-runner xcodebuild process. This is the
                // agent-device XCTest test rig — if it's foreground, iOS treats
                // the test-app as backgrounded and pauses its JS thread.
                try {
                    stopFastRunner(sessionMatches ? session?.deviceId : undefined);
                    hardResetSteps.push('stopFastRunner:ok');
                }
                catch (err) {
                    hardResetSteps.push(`stopFastRunner:warn(${err instanceof Error ? err.message : err})`);
                }
                // Step 2-3: terminate + launch the target app. iOS only — the
                // android branch is a follow-up.
                if (bundleId && targetPlatform === 'ios') {
                    try {
                        await execFile('xcrun', ['simctl', 'terminate', targetUdid, bundleId], {
                            timeout: 5000,
                        });
                        hardResetSteps.push(`simctl terminate ${bundleId}:ok`);
                    }
                    catch (err) {
                        // Non-fatal: app may already be dead. Log + continue.
                        hardResetSteps.push(`simctl terminate:warn(${err instanceof Error ? err.message : err})`);
                    }
                    try {
                        await execFile('xcrun', ['simctl', 'launch', targetUdid, bundleId], { timeout: 8000 });
                        hardResetSteps.push(`simctl launch ${bundleId}:ok`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        // GH #262: distinguish "launch hiccup" from "bundle not installed" —
                        // the latter needs install advice, not the soft-reset retry below.
                        // Probe verdict null = unknown → keep the raw error (fail open).
                        if ((await probeAppInstalledFn(targetUdid, bundleId)) === false) {
                            let hint = null;
                            try {
                                hint = snapshotHintFn(bundleId);
                            }
                            catch {
                                /* best-effort */
                            }
                            const advice = buildNotInstalledAdvice(targetUdid, bundleId, hint);
                            // Record the step BEFORE returning so hardResetSteps in meta stays
                            // complete, then return a typed failure: a confirmed-missing bundle
                            // is the primary error, not a buried step the caller has to fish
                            // out. The soft reset below cannot help — nothing connects to a
                            // missing app — so we skip it and leave the existing client.
                            hardResetSteps.push(`simctl launch:err(APP_NOT_INSTALLED — ${advice})`);
                            return failResult(advice, 'APP_NOT_INSTALLED', { hardResetSteps });
                        }
                        else {
                            // Fatal-ish: if launch fails, the soft reset below will likely
                            // fail too. Still continue — caller sees the launch error in
                            // hardResetSteps and the connectError from the autoConnect.
                            hardResetSteps.push(`simctl launch:err(${msg})`);
                        }
                    }
                    // Step 4: give Hermes time to re-register on Metro before we try
                    // to connect. Empirically 2-3s is enough on iPhone 16 Pro sim.
                    await sleep(3000);
                }
                else if (!bundleId) {
                    hardResetSteps.push('skip-simctl:no-bundleId-on-connectedTarget-or-cache');
                }
                else {
                    hardResetSteps.push(`skip-simctl:platform=${targetPlatform}-not-yet-supported`);
                }
            }
            // Soft reset path (unchanged from B76/D644).
            try {
                await oldClient.disconnect();
            }
            catch (err) {
                logger.warn('MCP', `cdp_restart: old client disconnect failed (non-fatal): ${err instanceof Error ? err.message : err}`);
            }
            const newClient = createClient(args.metroPort ?? preservedPort);
            setClient(newClient);
            let connected = false;
            let connectError;
            try {
                await newClient.autoConnect(args.metroPort, args.platform);
                connected = newClient.isConnected;
                // Refresh the cache from the freshly-connected target so a
                // subsequent recovery cycle keeps a valid bundleId. (Codex #1.)
                const postConnectBundle = newClient.connectedTarget?.description;
                if (postConnectBundle) {
                    const postConnectPlatform = (newClient.connectedTarget?.platform ??
                        args.platform ??
                        'ios').toLowerCase();
                    lastSeenBundleIds.set(postConnectPlatform, postConnectBundle);
                }
            }
            catch (err) {
                connectError = err instanceof Error ? err.message : String(err);
                logger.warn('MCP', `cdp_restart: autoConnect failed (best-effort): ${connectError}`);
            }
            // GH #262: a successful manual hard reset is a working recovery — clear
            // the detached-recovery budget so the auto-recovery path gets a fresh
            // attempt allowance after the user fixes the wedge by hand.
            if (args.hardReset && connected)
                resetDetachedBudgetFn();
            return okResult({
                restarted: true,
                connected,
                port: newClient.metroPort,
                hardReset: !!args.hardReset,
                ...(args.hardReset ? { hardResetSteps } : {}),
                ...(bundleId ? { bundleId } : {}),
                ...(connectError ? { connectError } : {}),
            });
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
    }
    return async (args) => {
        // Codex finding #2 (conf 82): concurrent-restart guard. If a restart
        // is already in flight, return early rather than racing on setClient
        // + simctl side effects. The second caller sees a clear "already
        // running" envelope and can retry after the first completes.
        if (inflightRestart) {
            return okResult({
                restarted: false,
                reason: 'restart-in-progress',
                hint: 'A cdp_restart is already running; await its completion and call again only if it failed.',
            });
        }
        inflightRestart = doRestart(args).finally(() => {
            inflightRestart = null;
        });
        return inflightRestart;
    };
}
