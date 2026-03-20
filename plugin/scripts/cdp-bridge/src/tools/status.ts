import type { CDPClient } from '../cdp-client.js';
import type { StatusResult } from '../types.js';
import { okResult, failResult, warnResult } from '../utils.js';

const STATUS_PROBE_EXPRESSION = `
(function() {
  var result = { appInfo: null, errorCount: 0, fiberTree: false, hasRedBox: false };
  var agent = globalThis.__RN_AGENT;
  if (!agent) return JSON.stringify(result);
  try { result.appInfo = JSON.parse(agent.getAppInfo()); } catch(e) {}
  try { result.errorCount = JSON.parse(agent.getErrors()).length; } catch(e) {}
  try { result.fiberTree = agent.isReady(); } catch(e) {}
  try { result.hasRedBox = JSON.parse(agent.getTree({maxDepth:1})).warning === 'APP_HAS_REDBOX'; } catch(e) {}
  return JSON.stringify(result);
})()
`;

export function createStatusHandler(
  getClient: () => CDPClient,
  setClient: (c: CDPClient) => void,
  createClient: (port: number) => CDPClient,
) {
  return async (args: { metroPort?: number; platform?: string }) => {
    try {
      let client = getClient();

      if (args.metroPort && args.metroPort !== client.metroPort) {
        await client.disconnect();
        client = createClient(args.metroPort);
        setClient(client);
      }

      if (!client.isConnected) {
        await client.autoConnect(args.metroPort, args.platform);
      } else if (args.platform) {
        // Already connected — check if the current target matches the requested platform
        const currentTarget = client.connectedTarget;
        const haystack = `${currentTarget?.title ?? ''} ${currentTarget?.description ?? ''}`.toLowerCase();
        if (!haystack.includes(args.platform.toLowerCase())) {
          await client.disconnect();
          client = createClient(client.metroPort);
          setClient(client);
          await client.autoConnect(args.metroPort, args.platform);
        }
      }

      let appInfo: Record<string, unknown> | null = null;
      let errorCount = 0;
      let fiberTree = false;
      let hasRedBox = false;

      if (client.helpersInjected) {
        const probeResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
        if (probeResult.value && typeof probeResult.value === 'string') {
          try {
            const probe = JSON.parse(probeResult.value) as {
              appInfo: Record<string, unknown> | null;
              errorCount: number;
              fiberTree: boolean;
              hasRedBox: boolean;
            };
            appInfo = probe.appInfo;
            errorCount = probe.errorCount;
            fiberTree = probe.fiberTree;
            hasRedBox = probe.hasRedBox;
          } catch {
            // Probe failed, use defaults
          }
        }
      }

      const status: StatusResult = {
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
          platform: (appInfo?.platform as string) ?? null,
          dev: (appInfo?.__DEV__ as boolean) ?? null,
          hermes: (appInfo?.hermes as boolean) ?? null,
          rnVersion: appInfo?.rnVersion ? JSON.stringify(appInfo.rnVersion) : null,
          dimensions: (appInfo?.dimensions as { width: number; height: number }) ?? null,
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
      };

      let autoRecoveredMessage: string | undefined;

      if (status.app.dev === false) {
        // Auto-recovery: softReconnect to find the correct JS context (D306)
        let devRecovered = false;
        try {
          await client.softReconnect();
          if (client.helpersInjected) {
            const retryResult = await client.evaluate(STATUS_PROBE_EXPRESSION);
            if (retryResult.value && typeof retryResult.value === 'string') {
              try {
                const retryProbe = JSON.parse(retryResult.value) as {
                  appInfo: Record<string, unknown> | null;
                  errorCount: number;
                  fiberTree: boolean;
                  hasRedBox: boolean;
                };
                if (retryProbe.appInfo?.__DEV__ === true) {
                  status.app.dev = true;
                  status.app.platform = (retryProbe.appInfo?.platform as string) ?? null;
                  status.app.hermes = (retryProbe.appInfo?.hermes as boolean) ?? null;
                  status.app.rnVersion = retryProbe.appInfo?.rnVersion ? JSON.stringify(retryProbe.appInfo.rnVersion) : null;
                  status.app.dimensions = (retryProbe.appInfo?.dimensions as { width: number; height: number }) ?? null;
                  status.app.hasRedBox = retryProbe.hasRedBox;
                  status.app.errorCount = retryProbe.errorCount;
                  status.app.isPaused = client.isPaused;
                  status.cdp.device = client.connectedTarget?.title ?? null;
                  status.cdp.pageId = client.connectedTarget?.id ?? null;
                  status.capabilities.fiberTree = retryProbe.fiberTree;
                  devRecovered = true;
                  autoRecoveredMessage = 'Reconnected to correct JS context';
                }
              } catch {
                // Probe parse failed, fall through to warning
              }
            }
          }
        } catch {
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
          if (status.app.isPaused) {
            return warnResult(status, 'Debugger is still paused after auto-recovery. Try cdp_reload(full=true).');
          }
        } catch {
          return warnResult(status, 'Debugger is paused. Auto-recovery failed. Try cdp_reload(full=true).');
        }
      }

      return okResult(status, autoRecoveredMessage ? { meta: { autoRecovered: autoRecoveredMessage } } : undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult(message);
    }
  };
}
