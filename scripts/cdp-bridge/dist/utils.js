import { hasActiveSession } from './agent-device-wrapper.js';
import { handleDevClientPicker } from './tools/dev-client-picker.js';
export function okResult(data, opts) {
    const envelope = { ok: true, data };
    if (opts?.truncated)
        envelope.truncated = true;
    if (opts?.meta)
        envelope.meta = opts.meta;
    return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
}
export function failResult(error, meta) {
    const envelope = { ok: false, error };
    if (meta)
        envelope.meta = meta;
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
                        // Reconnection in progress — wait up to 15s for it to complete
                        const deadline = Date.now() + 15_000;
                        while (!client.isConnected && Date.now() < deadline) {
                            await new Promise(r => setTimeout(r, 500));
                        }
                        if (!client.isConnected) {
                            return failResult('Reconnection timed out. Call cdp_status to retry.');
                        }
                    }
                    else {
                        return failResult(`Auto-connect failed: ${msg}. If Metro was restarted, wait a moment then call cdp_status to reconnect.`);
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
                        const extDeadline = Date.now() + 15_000;
                        while (!client.helpersInjected && Date.now() < extDeadline) {
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                    if (!client.helpersInjected) {
                        return failResult('Connected but helpers not injected. App may still be loading — retry in a few seconds.');
                    }
                }
            }
            // D502: Proactive freshness check — helpers flag may be true but globals gone
            // after bridgeless navigation. Cheaper than failing + softReconnect (D490).
            if (requireHelpers && client.helpersInjected) {
                try {
                    let probeTimer;
                    const vCheck = await Promise.race([
                        client.evaluate('typeof globalThis.__RN_AGENT === "object" && globalThis.__RN_AGENT.__v'),
                        new Promise((res) => { probeTimer = setTimeout(() => res({ error: 'timeout' }), 2000); }),
                    ]);
                    if (probeTimer)
                        clearTimeout(probeTimer);
                    if (vCheck.error || typeof vCheck.value !== 'number') {
                        console.error('CDP: helpers stale (globals missing), re-injecting...');
                        const reinjected = await client.reinjectHelpers();
                        if (!reinjected) {
                            return failResult('Helpers became stale and re-injection failed. Try cdp_reload.');
                        }
                    }
                }
                catch {
                    // Probe failed — let handler attempt proceed and use existing error paths
                }
            }
            const result = await handler(args, client);
            // B63 fix: detect stale-target indicators in failResult responses.
            // Most handlers return failResult instead of throwing on evaluate errors,
            // so the stale-target probe (Path B below) never fires. Check the result
            // for known stale indicators and retry with softReconnect if detected.
            if (requireHelpers && result.isError && client.isConnected) {
                const text = result.content?.[0]?.text ?? '';
                const staleIndicators = ['__RN_AGENT', 'not defined', 'not found', 'not available', 'is not a function', 'Cannot read prop'];
                const looksStale = staleIndicators.some(s => text.includes(s));
                if (looksStale) {
                    try {
                        let staleProbeTimer;
                        const probe = await Promise.race([
                            client.evaluate('typeof globalThis.__RN_AGENT === "object" && globalThis.__RN_AGENT.__v'),
                            new Promise((res) => { staleProbeTimer = setTimeout(() => res({ error: 'timeout' }), 2000); }),
                        ]);
                        if (staleProbeTimer)
                            clearTimeout(staleProbeTimer);
                        if (probe.error || typeof probe.value !== 'number') {
                            console.error('CDP: B63 stale handler result detected, re-injecting helpers...');
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
                    catch {
                        // Probe failed — return original result
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
                const retryDeadline = Date.now() + 15_000;
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
            // Path B (B58 fix): Stale-target probe — WS is open but JS context may be dead
            if (client.isConnected) {
                try {
                    let staleTimer;
                    let probe = await Promise.race([
                        client.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true'),
                        new Promise((res) => { staleTimer = setTimeout(() => res({ error: 'probe timeout' }), 2000); }),
                    ]);
                    if (staleTimer)
                        clearTimeout(staleTimer);
                    let isStale = probe.error !== undefined || probe.value !== true;
                    // D526: Retry once to avoid false positives from GC pauses / transient blocks
                    if (isStale && probe.error === 'probe timeout') {
                        await new Promise(r => setTimeout(r, 500));
                        let retryTimer;
                        probe = await Promise.race([
                            client.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true'),
                            new Promise((res) => { retryTimer = setTimeout(() => res({ error: 'probe timeout' }), 3000); }),
                        ]);
                        if (retryTimer)
                            clearTimeout(retryTimer);
                        isStale = probe.error !== undefined || probe.value !== true;
                    }
                    if (isStale) {
                        console.error('CDP: stale target detected (confirmed after retry), re-discovering...');
                        try {
                            await client.softReconnect();
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
                                    return failResult(`Retry after stale-target recovery failed: ${retryMsg}`, { originalError: message });
                                }
                            }
                            return failResult('Stale target recovery: reconnected but helpers not injected.', { originalError: message });
                        }
                        catch (reconnErr) {
                            const reconnMsg = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
                            return failResult(`Stale target recovery failed: ${reconnMsg}`, { originalError: message });
                        }
                    }
                }
                catch {
                    // Probe threw or timed out — WS went away between isConnected check and evaluate; fall through with original error
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
