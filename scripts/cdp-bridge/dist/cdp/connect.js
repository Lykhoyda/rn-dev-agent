import WebSocket from 'ws';
import { logger } from '../logger.js';
import { resolveBundleId } from '../project-config.js';
import { discover } from './discovery.js';
import { sleep } from './state.js';
import { CDP_TIMEOUT_FAST } from './timeout-config.js';
export async function autoConnect(ctx, portHint, filters) {
    if (ctx.getState() === 'connecting' || ctx.isReconnecting()) {
        throw new Error('Already connecting to Metro...');
    }
    if (ctx.isDisposed()) {
        throw new Error('Client is disposed. Create a new CDPClient instance.');
    }
    const effective = { ...filters };
    if (!effective.platform) {
        const envPlatform = process.env.RN_PREFERRED_PLATFORM;
        if (envPlatform && envPlatform !== 'auto')
            effective.platform = envPlatform;
    }
    // B111 (D643): auto-populate preferredBundleId from project-config so the
    // smart auto-selection in selectTarget fires for callers that didn't pass
    // explicit filters. resolveBundleId returns null when no app.json — graceful no-op.
    if (!effective.preferredBundleId) {
        const resolved = resolveBundleId(effective.platform ?? 'ios');
        if (resolved)
            effective.preferredBundleId = resolved;
    }
    return discoverAndConnect(ctx, portHint, effective);
}
export async function discoverAndConnect(ctx, portHint, filters, 
// B111 (D643): injectable for unit tests — defaults to real discover. Production
// call sites pass nothing, so behavior is unchanged. Tests pass a stub.
discoverFn = discover) {
    if (ctx.isDisposed()) {
        throw new Error('Client is disposed. Create a new CDPClient instance.');
    }
    if (portHint)
        ctx.setPort(portHint);
    // B111 (D643/G7): preserve _connectFilters across softReconnect — only overwrite
    // when caller explicitly passes filters. softReconnect calls with filters=undefined
    // so the previously-set targetId/bundleId/preferredBundleId survive the reload.
    if (filters !== undefined)
        ctx.setConnectFilters(filters);
    ctx.setState('connecting');
    const mergedFilters = ctx.getConnectFilters();
    const filtersForDiscover = {
        platform: mergedFilters.platform,
        targetId: mergedFilters.targetId,
        bundleId: mergedFilters.bundleId,
        preferredBundleId: mergedFilters.preferredBundleId,
    };
    let result;
    try {
        result = await discoverFn(ctx.getPort(), filtersForDiscover);
    }
    catch (err) {
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
    let connectedTarget = null;
    for (let idx = 0; idx < sorted.length; idx++) {
        const candidate = sorted[idx];
        const isLast = idx === sorted.length - 1;
        try {
            await connectToTarget(ctx, candidate);
            const devCheck = await ctx.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
            if (devCheck.value === true) {
                connectedTarget = candidate;
                break;
            }
            console.error(`CDP: target ${candidate.id} (${candidate.title}) has __DEV__=${devCheck.value}, skipping`);
            if (!isLast) {
                closeAndResetWs(ctx);
                ctx.setState('disconnected');
                ctx.setHelpersInjected(false);
                ctx.setConnectedTarget(null);
                continue;
            }
            console.error('CDP: no target with __DEV__=true found, using last available target');
            connectedTarget = candidate;
        }
        catch (err) {
            if (!isLast)
                continue;
            throw err;
        }
    }
    const generation = ctx.incrementConnectionGeneration();
    logger.info('CDP', `Connected to target ${connectedTarget.id} (${connectedTarget.title}) on port ${metroPort}, generation=${generation}`);
    // GH #59 #5: persist the resolved platform into _connectFilters when the
    // caller didn't pin one explicitly. Without this, softReconnect after
    // cdp_reload has nothing to filter on and may pick the wrong simulator
    // (e.g. iOS user reloads, sortTargets returns Android first, reconnect
    // lands on Android). Explicit filters from the caller already survive
    // (B111/D643/G7); this closes the auto-detect gap.
    const stickyFilters = stickyPlatformFilters(ctx.getConnectFilters(), connectedTarget.platform);
    if (stickyFilters)
        ctx.setConnectFilters(stickyFilters);
    const msg = `Connected to ${connectedTarget.title} on port ${metroPort}`;
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
export function stickyPlatformFilters(current, resolvedPlatform) {
    if (current.platform)
        return null;
    if (!resolvedPlatform)
        return null;
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
export function formatConnectFailureMessage(retries, attempts, bundleHint, lastErrorMessage) {
    const allHandshakesSucceeded = attempts.length > 0 && attempts.every((a) => a.handshakeOk);
    const anyProbeTimeout = attempts.some((a) => a.probeTimedOut);
    if (allHandshakesSucceeded && anyProbeTimeout) {
        const bid = bundleHint ?? '<bundleId>';
        return (`CDP probe timeout after ${retries} attempts: WebSocket handshake succeeded but Runtime.evaluate('1+1') consistently timed out — JS thread paused. ` +
            `The target app is most likely backgrounded. ` +
            `Recovery: call cdp_restart with hardReset=true (kills the fast-runner, terminates+relaunches ${bid}, reconnects — no /reload-plugins required). ` +
            `Or manually: xcrun simctl terminate booted ${bid} && xcrun simctl launch booted ${bid} (iOS), or restart the app from the launcher (Android).`);
    }
    const hint = lastErrorMessage?.includes('1006')
        ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
        : '';
    return `Failed to connect after ${retries} attempts.${hint}`;
}
async function connectToTarget(ctx, target, retries = 5) {
    let lastError = null;
    // GH #105 / B154: track per-attempt outcome (handshake ok vs probe timeout).
    // Fed into formatConnectFailureMessage at the end.
    const attempts = [];
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
                await ctx.sendWithTimeout('Runtime.evaluate', {
                    expression: '1+1',
                    returnByValue: true,
                }, CDP_TIMEOUT_FAST);
            }
            catch {
                probeTimedOut = true;
                throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
            }
            ctx.setConnectedTarget(target);
            // M11: stamp connection time so cdp_console_log / cdp_network_log can reason
            // about "how long have we been connected with nothing happening?"
            ctx.setConnectedAt(ctx.now());
            await ctx.setup();
            return;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            attempts.push({ handshakeOk, probeTimedOut });
            closeAndResetWs(ctx);
            if (lastError.message.includes('refused')) {
                ctx.setState('disconnected');
                throw new Error('CDP connection refused. Is Metro running and the app loaded?');
            }
            if (i < retries - 1)
                await sleep(2000);
        }
    }
    ctx.setState('disconnected');
    throw new Error(formatConnectFailureMessage(retries, attempts, target.description ?? null, lastError?.message ?? null));
}
function connectWs(ctx, url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            handshakeTimeout: 5000,
            maxPayload: 100 * 1024 * 1024,
        });
        let settled = false;
        ws.on('open', () => {
            settled = true;
            ctx.setWs(ws);
            ctx.setState('connected');
            resolve();
        });
        ws.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
            else {
                console.error('CDP WebSocket error:', err instanceof Error ? err.message : err);
            }
        });
        ws.on('message', (data) => {
            ctx.handleMessage(data);
        });
        ws.on('close', (code) => {
            if (!settled) {
                settled = true;
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
function closeAndResetWs(ctx) {
    const ws = ctx.getWs();
    if (ws) {
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
        ctx.setWs(null);
    }
}
