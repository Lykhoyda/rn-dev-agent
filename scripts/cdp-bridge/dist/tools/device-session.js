import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, setActiveSession, clearActiveSession, getActiveSession, ensureFastRunner, cacheSnapshot, } from '../agent-device-wrapper.js';
import { stopFastRunner } from '../fast-runner-session.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { resolveBundleId } from '../project-config.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak, } from './runner-leak-recovery.js';
const execFile = promisify(execFileCb);
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
        const { stdout } = await execFile('xcrun', ['simctl', 'spawn', 'booted', 'launchctl', 'list'], { timeout: 5000, encoding: 'utf8' });
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
            // Warn when targeting Expo Go — agent-device steals focus from Expo Go (B71)
            const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
            if (EXPO_GO_BUNDLES.includes(appId)) {
                return failResult('agent-device is incompatible with Expo Go — it steals foreground focus (B71). ' +
                    'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) and xcrun simctl for screenshots instead.', { hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.' });
            }
            const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;
            // B112 (D641): attachOnly mode — skip the app launch when the user knows
            // the app is already running. Avoids the unconditional relaunch that
            // invalidates CDP sessions and can race Metro bundle loading.
            let cliArgs;
            if (args.attachOnly) {
                const running = await isAppRunning(args.platform, appId);
                if (!running) {
                    return failResult(`attachOnly=true but ${appId} is not running on ${args.platform ?? 'ios'}. Launch it manually (e.g. xcrun simctl launch / adb monkey) or drop attachOnly to let the session opener launch it.`, 'NOT_CONNECTED');
                }
                cliArgs = ['open', '--session', sessionName];
            }
            else {
                cliArgs = ['open', appId, '--session', sessionName];
            }
            if (args.platform)
                cliArgs.push('--platform', args.platform);
            const result = await runAgentDevice(cliArgs, { skipSession: true });
            if (!result.isError) {
                let deviceId;
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
                }
                catch { /* best-effort */ }
                setActiveSession({
                    name: sessionName,
                    platform: args.platform,
                    deviceId,
                    openedAt: new Date().toISOString(),
                    appId,
                });
                if (args.platform === 'ios' && deviceId) {
                    ensureFastRunner(deviceId, appId).catch(() => { });
                }
                if (autoDetected) {
                    return warnResult(JSON.parse(result.content[0].text).data, `appId auto-detected from app.json: ${appId}`);
                }
            }
            return result;
        }
        if (action === 'close') {
            const session = getActiveSession();
            if (!session) {
                return okResult({ closed: true, message: 'No active session to close' });
            }
            const result = await runAgentDevice(['close']);
            if (!result.isError) {
                clearActiveSession();
                stopFastRunner();
            }
            return result;
        }
        // action === 'snapshot'
        if (!getActiveSession()) {
            return failResult('No device session open. Call device_snapshot with action="open" first.', { hint: 'Provide appId and platform to start a session.' });
        }
        const result = await rawSnapshot();
        const nodes = parseSnapshotNodes(result);
        if (!result.isError && nodes && isAgentDeviceRunnerSentinel(nodes)) {
            const session = getActiveSession();
            const recovery = await recoverFromRunnerLeak({ platform: session?.platform, appId: session?.appId, sessionName: session?.name }, {
                closeSession: () => runAgentDevice(['close']),
                openSession: ({ appId, platform, attachOnly }) => reopenSessionForRecovery(appId, platform, attachOnly),
                resnapshot: () => rawSnapshot(),
                parseNodes: parseSnapshotNodes,
            });
            if (recovery.recovered) {
                cacheSnapshotIfPossible(recovery.result);
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
        return 'device_snapshot returned AgentDeviceRunner\'s own UI tree, but auto-recovery cannot run because the active session has no stored appId. This usually means the session was opened by a plugin version from before B119 / GH #35 landed.';
    }
    return 'device_snapshot returned AgentDeviceRunner\'s own UI tree instead of the target app (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.';
}
export function runnerLeakFailureHint(reason, session) {
    if (reason === 'no-session-context' && session && !session.appId) {
        return 'Run device_snapshot action=close, then action=open appId=<your.bundle.id> platform=ios to start a session that supports auto-recovery.';
    }
    return 'Manually close + reopen the session with action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). Upstream: Callstack/agent-device, see B119/GH#35.';
}
async function rawSnapshot() {
    return runAgentDevice(['snapshot', '-i']);
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
    catch { /* best-effort cache */ }
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
    // session name risks the daemon either rejecting as "already exists" or
    // silently re-attaching to the corrupted session, defeating the rebuild.
    const recoveryName = `rn-agent-recovery-${Date.now()}`;
    let cliArgs;
    if (attachOnly) {
        // attachOnly only makes sense if the target app is already running.
        // Otherwise there's nothing to attach to and we should let the caller
        // escalate (typically to the full-relaunch tier).
        const running = await isAppRunning(platform, appId);
        if (!running) {
            return failResult(`attachOnly recovery aborted: ${appId} is not running on ${platform}.`, { code: 'NOT_CONNECTED', recoveryAbort: true });
        }
        cliArgs = ['open', '--session', recoveryName, '--platform', platform];
    }
    else {
        cliArgs = ['open', appId, '--session', recoveryName, '--platform', platform];
    }
    const result = await runAgentDevice(cliArgs, { skipSession: true });
    if (result.isError)
        return result;
    let deviceId;
    try {
        const envelope = JSON.parse(result.content[0].text);
        const data = envelope?.data;
        const rawId = data?.deviceId
            ?? data?.device_udid
            ?? data?.id
            ?? (typeof data?.device === 'object' ? data?.device?.id : undefined);
        const UDID_RE = /^[0-9A-Fa-f-]{25,}$/;
        deviceId = typeof rawId === 'string' && UDID_RE.test(rawId) ? rawId : undefined;
    }
    catch { /* best-effort */ }
    setActiveSession({
        name: recoveryName,
        platform,
        deviceId,
        openedAt: new Date().toISOString(),
        appId,
    });
    return result;
}
