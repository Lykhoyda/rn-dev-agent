import { hasActiveSession } from './agent-device-wrapper.js';
import { handleDevClientPicker } from './tools/dev-client-picker.js';
import { probeFreshness, recoverFromStaleTarget } from './cdp/recovery.js';
// S1 (D631): cache the freshness probe for up to 2s per (client, generation).
// Eliminates a CDP round-trip on back-to-back tool calls while still invalidating
// on reconnect (connectionGeneration bumps) and on any failure (cache is never set).
const FRESHNESS_CACHE_MS = 2000;
const freshnessCache = new WeakMap();
function isFreshnessCached(client) {
    const entry = freshnessCache.get(client);
    if (!entry)
        return false;
    if (entry.generation !== client.connectionGeneration)
        return false;
    return Date.now() < entry.expiresAt;
}
function rememberFreshness(client) {
    freshnessCache.set(client, {
        generation: client.connectionGeneration,
        expiresAt: Date.now() + FRESHNESS_CACHE_MS,
    });
}
function forgetFreshness(client) {
    freshnessCache.delete(client);
}
export function okResult(data, opts) {
    const envelope = { ok: true, data };
    if (opts?.truncated)
        envelope.truncated = true;
    if (opts?.meta)
        envelope.meta = opts.meta;
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}
export function failResult(error, metaOrCode, maybeMeta) {
    const envelope = { ok: false, error };
    if (typeof metaOrCode === 'string') {
        envelope.code = metaOrCode;
        if (maybeMeta)
            envelope.meta = maybeMeta;
    }
    else if (metaOrCode) {
        envelope.meta = metaOrCode;
    }
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true };
}
export function warnResult(data, warning, meta) {
    const envelope = { ok: true, data, meta: { ...meta, warning } };
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}
export function withConnection(getClient, handler, options = {}) {
    const { requireHelpers = true } = options;
    return async (args) => {
        const client = getClient();
        try {
            if (!client.isConnected) {
                try {
                    await client.autoConnect();
                }
                catch (connectErr) {
                    const msg = connectErr instanceof Error ? connectErr.message : String(connectErr);
                    if (msg.includes('Already connecting')) {
                        // Reconnection in progress — wait up to 30s for it to complete (B89)
                        const deadline = Date.now() + 30_000;
                        while (!client.isConnected && Date.now() < deadline) {
                            await new Promise(r => setTimeout(r, 500));
                        }
                        if (!client.isConnected) {
                            return failResult('Reconnection timed out. Call cdp_status to retry.', 'RECONNECT_TIMEOUT');
                        }
                    }
                    else {
                        return failResult(`Auto-connect failed: ${msg}. If Metro was restarted, wait a moment then call cdp_status to reconnect.`, 'NOT_CONNECTED');
                    }
                }
            }
            if (requireHelpers && !client.helpersInjected) {
                const helperDeadline = Date.now() + 5_000;
                while (!client.helpersInjected && Date.now() < helperDeadline) {
                    await new Promise(r => setTimeout(r, 300));
                }
                // D503: If helpers still not ready, Dev Client picker may be blocking React
                if (!client.helpersInjected) {
                    const pickerResult = await handleDevClientPicker();
                    if (pickerResult?.dismissed) {
                        console.error('CDP: Dev Client picker dismissed, waiting for helpers...');
                        const extDeadline = Date.now() + 30_000;
                        while (!client.helpersInjected && Date.now() < extDeadline) {
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                    if (!client.helpersInjected) {
                        return failResult('Connected but helpers not injected. App may still be loading — retry in a few seconds.', 'HELPERS_NOT_INJECTED');
                    }
                }
            }
            // D502: Proactive freshness check (D631/S1 caches result for 2s per generation).
            // D633: delegated to cdp/recovery.probeFreshness.
            if (requireHelpers && client.helpersInjected && !isFreshnessCached(client)) {
                const probe = await probeFreshness(client);
                if (probe.probed && !probe.fresh) {
                    console.error('CDP: helpers stale (globals missing), re-injecting...');
                    forgetFreshness(client);
                    const reinjected = await client.reinjectHelpers();
                    if (!reinjected) {
                        return failResult('Helpers became stale and re-injection failed. Try cdp_reload.', 'HELPERS_STALE');
                    }
                    rememberFreshness(client);
                }
                else if (probe.fresh) {
                    rememberFreshness(client);
                }
                else {
                    forgetFreshness(client);
                }
            }
            const result = await handler(args, client);
            // B63 (D634): after a handler failure, re-probe freshness. If globals are gone,
            // re-inject and retry. Uses the __RN_AGENT.__v probe as the primary signal
            // instead of error-message string matching.
            if (requireHelpers && result.isError && client.isConnected) {
                const probe = await probeFreshness(client);
                if (probe.probed && !probe.fresh) {
                    console.error('CDP: stale handler result detected (version probe failed), re-injecting helpers...');
                    forgetFreshness(client);
                    const reinjected = await client.reinjectHelpers();
                    if (reinjected) {
                        try {
                            return await handler(args, client);
                        }
                        catch {
                            // Retry failed — return original result
                        }
                    }
                }
            }
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const isDisconnect = message.includes('WebSocket closed') || message.includes('WebSocket not connected');
            if (isDisconnect) {
                // Path A: Clean disconnect — wait for auto-reconnect, then retry once
                const retryDeadline = Date.now() + 30_000;
                while (!client.isConnected && Date.now() < retryDeadline) {
                    await new Promise(r => setTimeout(r, 500));
                }
                if (client.isConnected) {
                    if (requireHelpers && !client.helpersInjected) {
                        const hd = Date.now() + 5_000;
                        while (!client.helpersInjected && Date.now() < hd) {
                            await new Promise(r => setTimeout(r, 300));
                        }
                    }
                    if (!requireHelpers || client.helpersInjected) {
                        try {
                            return await handler(args, client);
                        }
                        catch (retryErr) {
                            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                            return failResult(`Retry after reconnect failed: ${retryMsg}`);
                        }
                    }
                }
                return failResult('Connection lost during operation and reconnect timed out. Metro may be restarting — call cdp_status to retry connection, or check: curl localhost:8081/status');
            }
            // Path B (B58 fix): stale-target recovery delegated to cdp/recovery.ts (D633).
            if (client.isConnected) {
                forgetFreshness(client);
                const recovery = await recoverFromStaleTarget(client);
                if (recovery.recovered) {
                    console.error('CDP: stale target detected (confirmed after retry), re-discovering...');
                    if (requireHelpers && !client.helpersInjected) {
                        const hd = Date.now() + 5_000;
                        while (!client.helpersInjected && Date.now() < hd) {
                            await new Promise(r => setTimeout(r, 300));
                        }
                    }
                    if (!requireHelpers || client.helpersInjected) {
                        try {
                            return await handler(args, client);
                        }
                        catch (retryErr) {
                            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                            return failResult(`Retry after stale-target recovery failed: ${retryMsg}`, 'STALE_TARGET', { originalError: message });
                        }
                    }
                    return failResult('Stale target recovery: reconnected but helpers not injected.', 'HELPERS_NOT_INJECTED', { originalError: message });
                }
                if (recovery.reason === 'reconnect-failed') {
                    return failResult(`Stale target recovery failed: ${recovery.error}`, 'STALE_TARGET', { originalError: message });
                }
            }
            return failResult(message);
        }
    };
}
export function withSession(handler) {
    return async (args) => {
        if (!hasActiveSession()) {
            return failResult('No device session open. Call device_snapshot with action="open" and provide appId and platform first.', { hint: 'device_snapshot action=open starts a session. All device_press/device_fill/device_find/device_swipe/device_back tools require an open session.' });
        }
        return handler(args);
    };
}
