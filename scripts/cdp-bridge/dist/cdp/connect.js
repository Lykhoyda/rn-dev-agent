import WebSocket from 'ws';
import { logger } from '../logger.js';
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
    return discoverAndConnect(ctx, portHint, effective);
}
export async function discoverAndConnect(ctx, portHint, filters) {
    if (ctx.isDisposed()) {
        throw new Error('Client is disposed. Create a new CDPClient instance.');
    }
    if (portHint)
        ctx.setPort(portHint);
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
        result = await discover(ctx.getPort(), filtersForDiscover);
    }
    catch (err) {
        ctx.setState('disconnected');
        throw err;
    }
    const { port: metroPort, targets: sorted, warning: platformFilterWarning } = result;
    ctx.setPort(metroPort);
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
    return platformFilterWarning ? `${msg}. WARNING: ${platformFilterWarning}` : msg;
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
