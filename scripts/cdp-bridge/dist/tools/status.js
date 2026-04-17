import { okResult, failResult, warnResult } from '../utils.js';
import { handleDevClientPicker } from './dev-client-picker.js';
import { getSessionReloadCount } from './reload.js';
const STATUS_PROBE_EXPRESSION = `
(function() {
  var result = { appInfo: null, errorCount: 0, fiberTree: false, hasRedBox: false, helpersLoaded: false };
  var agent = globalThis.__RN_AGENT;
  if (!agent) return JSON.stringify(result);
  result.helpersLoaded = true;
  try { result.appInfo = JSON.parse(agent.getAppInfo()); } catch(e) {}
  try { result.errorCount = JSON.parse(agent.getErrors()).length; } catch(e) {}
  try { result.fiberTree = agent.isReady(); } catch(e) {}
  try { result.hasRedBox = JSON.parse(agent.getTree({maxDepth:1})).warning === 'APP_HAS_REDBOX'; } catch(e) {}
  return JSON.stringify(result);
})()
`;
async function buildStatusResult(client) {
    let appInfo = null;
    let errorCount = 0;
    let fiberTree = false;
    let hasRedBox = false;
    if (client.helpersInjected) {
        const probeResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
        if (probeResult.value && typeof probeResult.value === 'string') {
            try {
                const probe = JSON.parse(probeResult.value);
                if (probe.helpersLoaded) {
                    appInfo = probe.appInfo;
                    errorCount = probe.errorCount;
                    fiberTree = probe.fiberTree;
                    hasRedBox = probe.hasRedBox;
                }
            }
            catch { /* probe failed */ }
        }
    }
    return {
        metro: { running: true, port: client.metroPort },
        cdp: { connected: client.isConnected, device: client.connectedTarget?.title ?? null, pageId: client.connectedTarget?.id ?? null, platform: client.connectedTarget?.platform ?? null, bundleId: client.connectedTarget?.description ?? null },
        app: {
            platform: appInfo?.platform ?? null,
            dev: appInfo?.__DEV__ ?? null,
            hermes: appInfo?.hermes ?? null,
            rnVersion: appInfo?.rnVersion ? JSON.stringify(appInfo.rnVersion) : null,
            dimensions: appInfo?.dimensions ?? null,
            hasRedBox,
            isPaused: client.isPaused,
            errorCount,
        },
        capabilities: {
            networkDomain: client.networkMode === 'cdp',
            fiberTree,
            networkFallback: client.networkMode === 'hook',
            bridgeDetected: client.bridgeDetected,
            bridgeVersion: client.bridgeVersion,
        },
        domains: {
            runtime: client.isConnected,
            debugger: client.isConnected,
            network: client.networkMode === 'cdp',
            log: client.logDomainEnabled,
            profiler: client.profilerAvailable,
            heapProfiler: client.heapProfilerAvailable,
        },
        reconnect: client.reconnectState,
    };
}
export function createStatusHandler(getClient, setClient, createClient) {
    return async (args) => {
        try {
            let client = getClient();
            if (args.metroPort && args.metroPort !== client.metroPort) {
                await client.disconnect();
                client = createClient(args.metroPort);
                setClient(client);
            }
            if (!client.isConnected) {
                await client.autoConnect(args.metroPort, args.platform);
            }
            else if (args.platform) {
                // GH #21: Already connected — check if the current target matches the requested platform
                const currentTarget = client.connectedTarget;
                const requestedPlatform = args.platform.toLowerCase();
                const currentPlatform = currentTarget?.platform?.toLowerCase();
                const titleMatch = `${currentTarget?.title ?? ''} ${currentTarget?.description ?? ''}`.toLowerCase().includes(requestedPlatform);
                if (currentPlatform !== requestedPlatform && !titleMatch) {
                    await client.disconnect();
                    client = createClient(client.metroPort);
                    setClient(client);
                    await client.autoConnect(args.metroPort, args.platform);
                }
            }
            const status = await buildStatusResult(client);
            let autoRecoveredMessage;
            if (status.app.dev === false) {
                // Auto-recovery: softReconnect to find the correct JS context (D306)
                let devRecovered = false;
                try {
                    await client.softReconnect();
                    if (client.helpersInjected) {
                        const retryResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
                        if (retryResult.value && typeof retryResult.value === 'string') {
                            try {
                                const retryProbe = JSON.parse(retryResult.value);
                                if (retryProbe.appInfo?.__DEV__ === true) {
                                    status.app.dev = true;
                                    status.app.platform = retryProbe.appInfo?.platform ?? null;
                                    status.app.hermes = retryProbe.appInfo?.hermes ?? null;
                                    status.app.rnVersion = retryProbe.appInfo?.rnVersion ? JSON.stringify(retryProbe.appInfo.rnVersion) : null;
                                    status.app.dimensions = retryProbe.appInfo?.dimensions ?? null;
                                    status.app.hasRedBox = retryProbe.hasRedBox;
                                    status.app.errorCount = retryProbe.errorCount;
                                    status.app.isPaused = client.isPaused;
                                    status.cdp.device = client.connectedTarget?.title ?? null;
                                    status.cdp.pageId = client.connectedTarget?.id ?? null;
                                    status.cdp.bundleId = client.connectedTarget?.description ?? null;
                                    status.capabilities.fiberTree = retryProbe.fiberTree;
                                    devRecovered = true;
                                    autoRecoveredMessage = 'Reconnected to correct JS context';
                                }
                            }
                            catch {
                                // Probe parse failed, fall through to warning
                            }
                        }
                    }
                }
                catch {
                    // Recovery failed, fall through to warning
                }
                if (!devRecovered) {
                    return warnResult(status, 'Connected to a JS context where __DEV__ is false. This may not be the app\'s main context. Try cdp_reload(full=true) or restart Metro.');
                }
            }
            if (status.app.isPaused) {
                // Auto-recovery: resume paused debugger (D306)
                try {
                    await client.softReconnect();
                    status.app.isPaused = client.isPaused;
                    status.cdp.device = client.connectedTarget?.title ?? null;
                    status.cdp.pageId = client.connectedTarget?.id ?? null;
                    status.cdp.bundleId = client.connectedTarget?.description ?? null;
                    if (status.app.isPaused) {
                        return warnResult(status, 'Debugger is still paused after auto-recovery. Try cdp_reload(full=true).');
                    }
                }
                catch {
                    return warnResult(status, 'Debugger is paused. Auto-recovery failed. Try cdp_reload(full=true).');
                }
            }
            const reloadCount = getSessionReloadCount();
            if (reloadCount >= 5) {
                return warnResult(status, `${reloadCount} full reloads in this session. NativeWind stylesheet may be corrupted — if the screen appears blank, restart Metro and relaunch the app.`);
            }
            // B114 (D642): suspicion hint. When we're CDP-connected but the app didn't
            // inject helpers and has no JS errors to show, the visible app state
            // (RedBox, blank screen, native-module-missing) is INVISIBLE to our tools
            // because __RN_AGENT never loaded. Point the agent at cdp_native_errors.
            if (status.cdp.connected
                && !client.helpersInjected
                && !status.app.hasRedBox
                && status.app.errorCount === 0) {
                return warnResult(status, 'CDP connected but app helpers not injected and no JS errors captured. The app may have crashed natively before __RN_AGENT loaded (e.g. missing native module, failed bundle fetch). Call cdp_native_errors to inspect the platform log.');
            }
            return okResult(status, autoRecoveredMessage ? { meta: { autoRecovered: autoRecoveredMessage } } : undefined);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // If connection failed, check if the Dev Client picker is blocking
            try {
                const pickerResult = await handleDevClientPicker();
                if (pickerResult?.dismissed) {
                    // Picker was dismissed — retry connection automatically
                    try {
                        let retryClient = getClient();
                        if (!retryClient.isConnected) {
                            await retryClient.autoConnect(args.metroPort, args.platform);
                        }
                        // If retry succeeds, run the full status handler again
                        if (retryClient.isConnected) {
                            // Re-invoke ourselves (the outer function) for a clean status
                            return warnResult(await buildStatusResult(retryClient), `Dev Client picker was blocking — auto-dismissed (${pickerResult.reason}). Connection recovered.`);
                        }
                    }
                    catch { /* retry failed — fall through */ }
                    return failResult(`${message}. Dev Client picker was dismissed but reconnection failed. Try cdp_status again.`);
                }
                if (pickerResult && !pickerResult.dismissed && pickerResult.reason.includes('could not find')) {
                    return failResult(`${message}. ${pickerResult.reason}`);
                }
            }
            catch { /* picker check failed, return original error */ }
            return failResult(message);
        }
    };
}
