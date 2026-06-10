import { HELPERS_VERSION, INJECTED_HELPERS, NETWORK_CB_BUFFERED_SCRIPT, NETWORK_HOOK_SCRIPT, REACT_READY_PROBE_JS } from '../injected-helpers.js';
import { logger } from '../logger.js';
import { setActiveFlag, sleep } from './state.js';
import { CDP_TIMEOUT_FAST, timeoutForMethod } from './timeout-config.js';
export const REACT_READY_TIMEOUT_MS = 30_000;
export const REACT_READY_POLL_MS = 500;
export async function performSetup(opts) {
    const { send, evaluate, port, connectedTarget, networkManager, getDeviceKey, setupEventHandlers, clearScripts, clearEventHandlers } = opts;
    logger.debug('CDP', 'Running setup: Runtime.enable, Debugger.enable...');
    await send('Runtime.enable', undefined, timeoutForMethod('Runtime.enable'));
    await send('Debugger.enable', undefined, timeoutForMethod('Debugger.enable'));
    let networkMode;
    try {
        await send('Network.enable', undefined, timeoutForMethod('Network.enable'));
        networkMode = 'cdp';
    }
    catch {
        networkMode = 'none';
    }
    let logDomainEnabled;
    try {
        await send('Log.enable', undefined, timeoutForMethod('Log.enable'));
        logDomainEnabled = true;
    }
    catch {
        logDomainEnabled = false;
    }
    const [profilerProbe, heapProbe] = await Promise.allSettled([
        send('Profiler.enable', undefined, CDP_TIMEOUT_FAST)
            .then(() => send('Profiler.disable', undefined, CDP_TIMEOUT_FAST))
            .then(() => true),
        send('HeapProfiler.enable', undefined, CDP_TIMEOUT_FAST)
            .then(() => send('HeapProfiler.disable', undefined, CDP_TIMEOUT_FAST))
            .then(() => true),
    ]);
    const profilerAvailable = profilerProbe.status === 'fulfilled' && profilerProbe.value === true;
    const heapProfilerAvailable = heapProbe.status === 'fulfilled' && heapProbe.value === true;
    clearEventHandlers();
    clearScripts();
    setupEventHandlers();
    await waitForReact(evaluate, REACT_READY_TIMEOUT_MS);
    const helperResult = await evaluate(INJECTED_HELPERS);
    if (helperResult.error) {
        console.error('CDP: failed to inject helpers:', helperResult.error);
        return { networkMode, helpersInjected: false, logDomainEnabled, profilerAvailable, heapProfilerAvailable };
    }
    const verify = await evaluate('typeof globalThis.__RN_AGENT === "object"');
    if (verify.value !== true) {
        console.error('CDP: helper injection succeeded but __RN_AGENT not found');
        return { networkMode, helpersInjected: false, logDomainEnabled, profilerAvailable, heapProfilerAvailable };
    }
    // Test seam: force the hook fallback on RN >= 0.83 so the buffered
    // transport can be live-verified without an old-RN app. Also disable the
    // Network domain so CDP events don't double-feed the buffer during seam
    // testing, making live verification vacuous.
    if (process.env.RN_FORCE_NETWORK_HOOK === '1') {
        networkMode = 'none';
        try {
            await send('Network.disable', undefined, CDP_TIMEOUT_FAST);
        }
        catch { /* best-effort */ }
    }
    logger.info('CDP', `Helpers injected (v${HELPERS_VERSION}), network mode: ${networkMode}`);
    setActiveFlag(port, connectedTarget);
    // D626 (B1 fix): Probe whether Network.enable actually delivers events.
    // GH #59 #9: a single 500ms probe is too tight after platform switches /
    // reload — the fresh JS context needs time to flush the probe fetch through
    // its CDP event channel. Retry once at a longer interval before declaring
    // RN<0.83. Total worst-case wait for legitimate fallback: 500ms + 1500ms.
    if (networkMode === 'cdp') {
        networkMode = await probeNetworkDomain({ evaluate, port, networkManager, getDeviceKey });
    }
    if (networkMode === 'none') {
        const hookResult = await evaluate(NETWORK_HOOK_SCRIPT);
        if (hookResult.error) {
            console.error('CDP: failed to inject network hooks:', hookResult.error);
        }
        else {
            await evaluate(NETWORK_CB_BUFFERED_SCRIPT);
            networkMode = 'hook';
        }
    }
    return { networkMode, helpersInjected: true, logDomainEnabled, profilerAvailable, heapProfilerAvailable };
}
/**
 * GH #59 #9: probe whether Network.enable actually delivers events on the
 * current Hermes context. RN >= 0.83 (Bridgeless) accepts Network.enable AND
 * fires events; older runtimes accept the call but no events flow. The probe
 * fires a localhost fetch and watches the per-device buffer for growth.
 *
 * Two attempts at increasing timeouts (500ms, 1500ms). One-shot 500ms was
 * the original D626 implementation but produced false negatives after
 * platform switches and reloads where the fresh context needs longer to
 * flush the probe fetch through CDP. Total worst-case latency for legitimate
 * RN<0.83 fallback: ~2 seconds (was 500ms).
 *
 * Returns the post-probe network mode: 'cdp' if events fired, 'none'
 * otherwise (caller will then try hook injection).
 */
export async function probeNetworkDomain(opts) {
    const { evaluate, port, networkManager, getDeviceKey } = opts;
    const waits = opts.waits ?? [500, 1500];
    const deviceKey = getDeviceKey();
    for (let attempt = 0; attempt < waits.length; attempt++) {
        const bufSizeBefore = networkManager.size(deviceKey);
        await evaluate(`void fetch('http://localhost:${port}/status').catch(function(){})`);
        await new Promise(r => setTimeout(r, waits[attempt]));
        if (networkManager.size(deviceKey) > bufSizeBefore) {
            return 'cdp';
        }
    }
    logger.info('CDP', `Network.enable accepted but no events fired after ${waits.length} attempt(s) — falling back to hooks`);
    return 'none';
}
export async function reinjectHelpers(evaluate, waitTimeout) {
    await waitForReact(evaluate, waitTimeout ?? REACT_READY_TIMEOUT_MS);
    const helperResult = await evaluate(INJECTED_HELPERS);
    if (helperResult.error) {
        console.error('CDP: failed to re-inject helpers:', helperResult.error);
        return false;
    }
    const verify = await evaluate('typeof globalThis.__RN_AGENT === "object"');
    if (verify.value !== true) {
        return false;
    }
    return true;
}
/**
 * GH #184: bounded variant of waitForReact that RETURNS whether React became
 * reachable within `budgetMs` (vs waitForReact which always resolves void after
 * logging). Used by the status-scoped picker-blocking probe to decide fast,
 * before the full REACT_READY_TIMEOUT_MS wait in setup(), whether a non-Hermes
 * target is a stale (picker-blocked) connection.
 */
export async function probeReactReachable(evaluate, budgetMs, pollMs = REACT_READY_POLL_MS) {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
        try {
            const result = await evaluate(REACT_READY_PROBE_JS);
            if (result.value === true)
                return true;
        }
        catch {
            // not ready yet
        }
        await sleep(pollMs);
    }
    return false;
}
export async function waitForReact(evaluate, timeout, pollInterval) {
    const effectiveTimeout = timeout ?? REACT_READY_TIMEOUT_MS;
    const effectivePoll = pollInterval ?? REACT_READY_POLL_MS;
    const start = Date.now();
    while (Date.now() - start < effectiveTimeout) {
        try {
            const result = await evaluate(REACT_READY_PROBE_JS);
            if (result.value === true)
                return;
        }
        catch {
            // Not ready yet
        }
        await sleep(effectivePoll);
    }
    console.error(`CDP: React not ready after ${effectiveTimeout}ms — helpers will be injected anyway`);
}
