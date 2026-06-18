import { okResult, failResult, warnResult, withConnection } from '../utils.js';
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
export function createReloadHandler(getClient, setClient, createClient) {
    return withConnection(getClient, async (_args, client) => {
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
            await new Promise((r) => setTimeout(r, 200));
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
                    await new Promise((r) => setTimeout(r, 2000 + attempt * 1000));
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
            const forceResult = await forceReconnect(getClient(), setClient, createClient, captured);
            if (forceResult.ok) {
                reconnected = true;
                client = getClient();
                const notes = [];
                if (captured.proxyWasActive) {
                    notes.push('DevTools detached — run cdp_open_devtools to re-attach.');
                }
                notes.push('Network/console buffers reset for new target.');
                forceMeta = {
                    recovered_via: 'force_reconnect',
                    proxy_was_active: captured.proxyWasActive,
                    note: notes.join(' '),
                };
                if (!forceResult.platformMatched) {
                    forceMeta.warning = `Recovered onto ${forceResult.finalPlatform ?? 'unknown'} but pre-reload session was on ${captured.platform ?? 'unknown'}. Run cdp_connect platform: "${captured.platform}" force: true to re-bind.`;
                }
            }
            else {
                return okResult({ reloaded: true, type: 'full', reconnected: false }, {
                    meta: {
                        warning: `Reload triggered but re-discovery failed after ${softAttemptsRun} soft attempts: ${lastReconnErr}; force_reconnect also failed (10s budget): ${forceResult.reason}`,
                        force_reconnect_attempted: true,
                        proxy_was_active: captured.proxyWasActive,
                    },
                });
            }
        }
        const helperDeadline = Date.now() + 12_000;
        while (!client.helpersInjected && Date.now() < helperDeadline) {
            await new Promise((r) => setTimeout(r, 400));
        }
        if (!client.isConnected) {
            return okResult({ reloaded: true, type: 'full', reconnected: false }, {
                meta: {
                    warning: 'Reload triggered but connection dropped after re-discovery.',
                    ...forceMeta,
                },
            });
        }
        if (!client.helpersInjected) {
            const injected = await client.reinjectHelpers(10_000);
            if (!injected) {
                return warnResult({ reloaded: true, type: 'full', reconnected: true }, 'Reload succeeded but helper injection failed. App may still be loading — retry cdp_status.', forceMeta);
            }
        }
        sessionReloadCount++;
        return okResult({ reloaded: true, type: 'full', reconnected: true }, Object.keys(forceMeta).length > 0 ? { meta: forceMeta } : undefined);
    });
}
