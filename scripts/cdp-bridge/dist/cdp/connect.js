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
    for (const candidate of sorted) {
        try {
            await connectToTarget(ctx, candidate);
            const devCheck = await ctx.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true');
            if (devCheck.value === true) {
                connectedTarget = candidate;
                break;
            }
            console.error(`CDP: target ${candidate.id} (${candidate.title}) has __DEV__=${devCheck.value}, skipping`);
            if (sorted.indexOf(candidate) < sorted.length - 1) {
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
            if (sorted.indexOf(candidate) < sorted.length - 1)
                continue;
            throw err;
        }
    }
    const generation = ctx.incrementConnectionGeneration();
    logger.info('CDP', `Connected to target ${connectedTarget.id} (${connectedTarget.title}) on port ${metroPort}, generation=${generation}`);
    const msg = `Connected to ${connectedTarget.title} on port ${metroPort}`;
    return selectionWarning ? `${msg}. WARNING: ${selectionWarning}` : msg;
}
async function connectToTarget(ctx, target, retries = 5) {
    let lastError = null;
    for (let i = 0; i < retries; i++) {
        if (ctx.isDisposed() || ctx.isSoftReconnectRequested()) {
            throw new Error('Client disposed or preempted during connection');
        }
        try {
            await connectWs(ctx, target.webSocketDebuggerUrl);
            // D594: Early stale-target detection — quick probe before full setup
            try {
                await ctx.sendWithTimeout('Runtime.evaluate', {
                    expression: '1+1',
                    returnByValue: true,
                }, CDP_TIMEOUT_FAST);
            }
            catch {
                throw new Error('Target failed pre-flight probe (1+1) — likely a dead JS context');
            }
            ctx.setConnectedTarget(target);
            await ctx.setup();
            return;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
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
    const hint = lastError?.message.includes('1006')
        ? ' Another debugger may be connected — close React Native DevTools, Flipper, or Chrome DevTools.'
        : '';
    throw new Error(`Failed to connect after ${retries} attempts.${hint}`);
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
