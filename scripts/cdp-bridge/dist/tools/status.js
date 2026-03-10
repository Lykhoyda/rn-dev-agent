import { textResult, errorResult } from '../utils.js';
const STATUS_PROBE_EXPRESSION = `
(function() {
  var result = { appInfo: null, errorCount: 0, fiberTree: false, hasRedBox: false };
  var agent = globalThis.__RN_AGENT;
  if (!agent) return JSON.stringify(result);
  try { result.appInfo = JSON.parse(agent.getAppInfo()); } catch(e) {}
  try { result.errorCount = JSON.parse(agent.getErrors()).length; } catch(e) {}
  try { result.fiberTree = agent.isReady(); } catch(e) {}
  try { result.hasRedBox = JSON.parse(agent.getTree(1)).warning === 'APP_HAS_REDBOX'; } catch(e) {}
  return JSON.stringify(result);
})()
`;
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
                await client.autoConnect(args.metroPort);
            }
            let appInfo = null;
            let errorCount = 0;
            let fiberTree = false;
            let hasRedBox = false;
            if (client.helpersInjected) {
                const probeResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
                if (probeResult.value && typeof probeResult.value === 'string') {
                    try {
                        const probe = JSON.parse(probeResult.value);
                        appInfo = probe.appInfo;
                        errorCount = probe.errorCount;
                        fiberTree = probe.fiberTree;
                        hasRedBox = probe.hasRedBox;
                    }
                    catch {
                        // Probe failed, use defaults
                    }
                }
            }
            const status = {
                metro: {
                    running: true,
                    port: client.metroPort,
                },
                cdp: {
                    connected: client.isConnected,
                    device: client.connectedTarget?.title ?? null,
                    pageId: client.connectedTarget?.id ?? null,
                },
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
                },
            };
            return textResult(JSON.stringify(status, null, 2));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult(message);
        }
    };
}
