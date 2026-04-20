import { INJECTED_HELPERS, NETWORK_HOOK_SCRIPT } from '../injected-helpers.js';
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
    logger.info('CDP', `Helpers injected (v11), network mode: ${networkMode}`);
    setActiveFlag(port, connectedTarget);
    // D626 (B1 fix): Probe whether Network.enable actually delivers events.
    if (networkMode === 'cdp') {
        const deviceKey = getDeviceKey();
        const bufSizeBefore = networkManager.size(deviceKey);
        await evaluate(`void fetch('http://localhost:${port}/status').catch(function(){})`);
        await new Promise(r => setTimeout(r, 500));
        if (networkManager.size(deviceKey) <= bufSizeBefore) {
            logger.info('CDP', 'Network.enable accepted but no events fired (RN < 0.83) — falling back to hooks');
            networkMode = 'none';
        }
    }
    if (networkMode === 'none') {
        const hookResult = await evaluate(NETWORK_HOOK_SCRIPT);
        if (hookResult.error) {
            console.error('CDP: failed to inject network hooks:', hookResult.error);
        }
        else {
            await evaluate(`
        globalThis.__RN_AGENT_NETWORK_CB__ = function(type, data) {
          console.log('__RN_NET__:' + type + ':' + JSON.stringify(data));
        };
      `);
            networkMode = 'hook';
        }
    }
    return { networkMode, helpersInjected: true, logDomainEnabled, profilerAvailable, heapProfilerAvailable };
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
export async function waitForReact(evaluate, timeout, pollInterval) {
    const effectiveTimeout = timeout ?? REACT_READY_TIMEOUT_MS;
    const effectivePoll = pollInterval ?? REACT_READY_POLL_MS;
    const start = Date.now();
    while (Date.now() - start < effectiveTimeout) {
        try {
            const result = await evaluate('typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && ' +
                '__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0');
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
