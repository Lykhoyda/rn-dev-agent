import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, failResult, warnResult, withConnection } from '../utils.js';
import { autoDismissDevMenuMeta } from './expo-dev-menu.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
const defaultExecFile = promisify(execFileCb);
let sessionReloadCount = 0;
export function getSessionReloadCount() {
    return sessionReloadCount;
}
const SOFT_RECONNECT_DEADLINE_MS = 30_000;
const SOFT_RECONNECT_ATTEMPTS = 5;
const FORCE_FALLBACK_TIMEOUT_MS = 10_000;
const DISCONNECT_TIMEOUT_MS = 2_000;
export function captureClientState(client) {
    const target = client.connectedTarget;
    return {
        port: client.metroPort,
        platform: target?.platform,
        bundleId: target?.description ?? undefined,
        proxyWasActive: client.proxyDesired,
    };
}
async function raceWithTimeout(promise, timeoutMs, errorLabel) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${errorLabel} timeout (${timeoutMs}ms)`)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export async function forceReconnect(oldClient, setClient, createClient, captured) {
    const swallow = () => undefined;
    const disconnectPromise = oldClient.disconnect().catch(swallow);
    await raceWithTimeout(disconnectPromise, DISCONNECT_TIMEOUT_MS, 'disconnect').catch(swallow);
    const newClient = createClient(captured.port);
    setClient(newClient);
    const filters = {
        platform: captured.platform,
        bundleId: captured.bundleId,
    };
    try {
        await raceWithTimeout(newClient.autoConnect(captured.port, filters), FORCE_FALLBACK_TIMEOUT_MS, 'force_reconnect');
    }
    catch (err) {
        newClient.disconnect().catch(swallow);
        setClient(createClient(captured.port));
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const finalPlatform = newClient.connectedTarget?.platform ?? null;
    const platformMatched = !captured.platform || captured.platform === finalPlatform;
    return { ok: true, platformMatched, finalPlatform };
}
/**
 * GH #523 sub-1: recovery escalation after soft reconnect fails.
 *
 * A non-component module edit makes Metro full-rebuild: the old Hermes
 * target dies and no new target registers inside the reconnect window, so
 * reload used to end at RECONNECT_TIMEOUT and the agent had to run the
 * terminate+launch sequence by hand (~8 tool calls, observed 2× per heavy
 * session in #523). This chains it automatically:
 *
 *   force_reconnect → (iOS + known bundleId) simctl terminate + launch →
 *   force_reconnect again.
 *
 * The bundle ID and device come only from the fenced authority target.
 */
export async function recoverAfterFailedReconnect(getClient, setClient, createClient, captured, deps = {}, authorityTarget) {
    const execFile = deps.execFile ?? defaultExecFile;
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const first = await forceReconnect(getClient(), setClient, createClient, captured);
    if (first.ok) {
        return {
            ok: true,
            via: 'force_reconnect',
            relaunchSteps: [],
            platformMatched: first.platformMatched,
            finalPlatform: first.finalPlatform,
        };
    }
    const steps = [];
    const bundleId = authorityTarget?.appId && isValidBundleId(authorityTarget.appId) ? authorityTarget.appId : null;
    const deviceId = authorityTarget?.deviceId;
    if (!bundleId || !deviceId) {
        steps.push('skip-relaunch:no-exact-authority-target');
        return { ok: false, via: null, reason: first.reason, relaunchSteps: steps };
    }
    const platform = captured.platform ?? 'ios';
    try {
        if (platform === 'ios') {
            await execFile('xcrun', ['simctl', 'terminate', deviceId, bundleId], {
                timeout: 5000,
            });
            steps.push(`simctl terminate ${bundleId}:ok`);
        }
        else {
            await execFile('adb', ['-s', deviceId, 'shell', 'am', 'force-stop', bundleId], {
                timeout: 5000,
            });
            steps.push(`adb force-stop ${bundleId}:ok`);
        }
    }
    catch (err) {
        steps.push(`terminate:warn(${err instanceof Error ? err.message : err})`);
    }
    try {
        if (platform === 'ios') {
            await execFile('xcrun', ['simctl', 'launch', deviceId, bundleId], {
                timeout: 8000,
            });
            steps.push(`simctl launch ${bundleId}:ok`);
        }
        else {
            await execFile('adb', [
                '-s',
                deviceId,
                'shell',
                'monkey',
                '--pct-syskeys',
                '0',
                '-p',
                bundleId,
                '-c',
                'android.intent.category.LAUNCHER',
                '1',
            ], { timeout: 8000 });
            steps.push(`adb launch ${bundleId}:ok`);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push(`launch:err(${msg})`);
        return {
            ok: false,
            via: null,
            reason: `${first.reason ?? 'force_reconnect failed'}; relaunch failed: ${msg}`,
            relaunchSteps: steps,
        };
    }
    // Give Hermes time to re-register on Metro (same budget as cdp_restart).
    await sleep(3000);
    const second = await forceReconnect(getClient(), setClient, createClient, captured);
    if (second.ok) {
        return {
            ok: true,
            via: 'terminate_launch',
            relaunchSteps: steps,
            platformMatched: second.platformMatched,
            finalPlatform: second.finalPlatform,
        };
    }
    return {
        ok: false,
        via: null,
        reason: `force_reconnect after relaunch failed: ${second.reason}`,
        relaunchSteps: steps,
    };
}
export function createReloadHandler(getClient, setClient, createClient, deps = {}) {
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    return withConnection(getClient, async (args, client) => {
        try {
            const result = await client.evaluate('(function() {' +
                '  var ds = null;' +
                '  if (typeof __turboModuleProxy === "function") try { ds = __turboModuleProxy("DevSettings"); } catch(e) {}' +
                '  if (!ds && typeof globalThis.nativeModuleProxy !== "undefined") try { ds = globalThis.nativeModuleProxy.DevSettings; } catch(e) {}' +
                '  if (!ds && typeof globalThis.__fbBatchedBridge !== "undefined") try { ds = globalThis.__fbBatchedBridge.getCallableModule("DevSettings"); } catch(e) {}' +
                '  if (ds && typeof ds.reload === "function") { ds.reload(); return "devSettings"; }' +
                '  if (typeof globalThis.location !== "undefined" && typeof globalThis.location.reload === "function") { globalThis.location.reload(); return "location"; }' +
                '  throw new Error("DevSettings not available — use Maestro or simctl to restart the app");' +
                '})()');
            if (result.error) {
                return failResult(`Reload failed: ${result.error}`);
            }
        }
        catch (evalErr) {
            const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
            const isExpectedDisconnect = msg.includes('WebSocket closed') ||
                msg.includes('WebSocket not connected') ||
                msg.includes('timeout');
            if (!isExpectedDisconnect) {
                return failResult(`Reload failed unexpectedly: ${msg}`);
            }
        }
        const wsDownDeadline = Date.now() + 3_000;
        while (client.isConnected && Date.now() < wsDownDeadline) {
            await sleep(200);
        }
        let reconnected = false;
        let lastReconnErr = '';
        let softAttemptsRun = 0;
        const reconnectDeadline = Date.now() + SOFT_RECONNECT_DEADLINE_MS;
        for (let attempt = 0; attempt < SOFT_RECONNECT_ATTEMPTS; attempt++) {
            if (Date.now() > reconnectDeadline) {
                lastReconnErr = `Reconnect deadline exceeded (${SOFT_RECONNECT_DEADLINE_MS / 1000}s)`;
                break;
            }
            softAttemptsRun = attempt + 1;
            let reconnTimer;
            try {
                await Promise.race([
                    client.softReconnect(),
                    new Promise((_, reject) => {
                        reconnTimer = setTimeout(() => reject(new Error('softReconnect timeout')), Math.max(reconnectDeadline - Date.now(), 2000));
                    }),
                ]);
                reconnected = true;
                break;
            }
            catch (reconnErr) {
                lastReconnErr = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
                if (attempt < SOFT_RECONNECT_ATTEMPTS - 1) {
                    await sleep(2000 + attempt * 1000);
                }
            }
            finally {
                if (reconnTimer)
                    clearTimeout(reconnTimer);
            }
        }
        let forceMeta = {};
        if (!reconnected) {
            const captured = captureClientState(getClient());
            // GH #523 sub-1: force_reconnect, escalating into an automatic simctl
            // terminate+launch when even that finds no target.
            const recovery = await recoverAfterFailedReconnect(getClient, setClient, createClient, captured, deps, args.deviceId && args.appId ? { deviceId: args.deviceId, appId: args.appId } : undefined);
            if (recovery.ok) {
                reconnected = true;
                client = getClient();
                const notes = [];
                if (captured.proxyWasActive) {
                    notes.push('DevTools detached — run cdp_open_devtools to re-attach.');
                }
                notes.push('Network/console buffers reset for new target.');
                if (recovery.via === 'terminate_launch') {
                    notes.push('App was terminated + relaunched via simctl to recover the dead target.');
                }
                forceMeta = {
                    recovered_via: recovery.via,
                    proxy_was_active: captured.proxyWasActive,
                    note: notes.join(' '),
                    ...(recovery.relaunchSteps.length > 0
                        ? { relaunch_steps: recovery.relaunchSteps }
                        : {}),
                };
                if (!recovery.platformMatched) {
                    forceMeta.warning = `Recovered onto ${recovery.finalPlatform ?? 'unknown'} but pre-reload session was on ${captured.platform ?? 'unknown'}. Run cdp_connect platform: "${captured.platform}" force: true to re-bind.`;
                }
            }
            else {
                return failResult(`Reload triggered but exact-target re-discovery failed after ${softAttemptsRun} soft attempts: ${lastReconnErr}; fenced recovery also failed: ${recovery.reason}`, 'RECONNECT_TIMEOUT', {
                    reloaded: true,
                    reconnected: false,
                    force_reconnect_attempted: true,
                    relaunch_steps: recovery.relaunchSteps,
                    proxy_was_active: captured.proxyWasActive,
                });
            }
        }
        const helperDeadline = Date.now() + 12_000;
        while (!client.helpersInjected && Date.now() < helperDeadline) {
            await sleep(400);
        }
        if (!client.isConnected) {
            return failResult('Reload triggered but the exact-target connection dropped after re-discovery.', 'RECONNECT_TIMEOUT', {
                reloaded: true,
                reconnected: false,
                ...forceMeta,
            });
        }
        if (!client.helpersInjected) {
            const injected = await client.reinjectHelpers(10_000);
            if (!injected) {
                return warnResult({ reloaded: true, type: 'full', reconnected: true }, 'Reload succeeded but helper injection failed. App may still be loading — retry cdp_status.', forceMeta);
            }
        }
        const devMenuMeta = await autoDismissDevMenuMeta(client);
        const mergedMeta = { ...forceMeta, ...devMenuMeta };
        sessionReloadCount++;
        return okResult({ reloaded: true, type: 'full', reconnected: true }, Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : undefined);
    });
}
