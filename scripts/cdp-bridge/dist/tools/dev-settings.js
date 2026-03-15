import { okResult, failResult, warnResult, withConnection } from '../utils.js';
const RESOLVE_DEV_SETTINGS = `(function() {
  if (typeof __turboModuleProxy === 'function') try { var ds = __turboModuleProxy("DevSettings"); if (ds) return ds; } catch(e) {}
  if (typeof globalThis.nativeModuleProxy !== 'undefined') try { var ds2 = globalThis.nativeModuleProxy.DevSettings; if (ds2) return ds2; } catch(e) {}
  if (typeof globalThis.__fbBatchedBridge !== 'undefined') try { var ds3 = globalThis.__fbBatchedBridge.getCallableModule("DevSettings"); if (ds3) return ds3; } catch(e) {}
  try { return require("react-native").DevSettings; } catch(e) {}
  return null;
})()`;
const ACTION_EXPRESSIONS = {
    reload: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds || !ds.reload) throw new Error("DevSettings not available"); ds.reload(); return "ok"; })()`,
    toggleInspector: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds || !ds.toggleElementInspector) throw new Error("DevSettings not available"); ds.toggleElementInspector(); return "ok"; })()`,
    togglePerfMonitor: `(function() { var ds = ${RESOLVE_DEV_SETTINGS}; if (!ds) throw new Error("DevSettings not available"); if (ds.togglePerformanceMonitor) { ds.togglePerformanceMonitor(); } else if (ds.togglePerfMonitor) { ds.togglePerfMonitor(); } else { return "no_method_available"; } return "ok"; })()`,
    dismissRedBox: `(function() {
    try { var ds = (typeof __turboModuleProxy === 'function') ? __turboModuleProxy("DevSettings") : null; if (ds && typeof ds.dismissRedbox === 'function') { ds.dismissRedbox(); return "ok"; } } catch(e0) {}
    try { var ds2 = require("react-native").DevSettings; if (ds2 && typeof ds2.dismissRedbox === 'function') { ds2.dismissRedbox(); return "ok"; } } catch(e0b) {}
    try { require("react-native/Libraries/LogBox/Data/LogBoxData").clear(); return "ok"; } catch(e1) {}
    try { var gd = globalThis.__logBoxData; if (gd && typeof gd.clear === 'function') { gd.clear(); return "ok"; } } catch(e2) {}
    try { var LB = require("react-native").LogBox; if (LB && typeof LB.ignoreAllLogs === 'function') { LB.ignoreAllLogs(true); LB.ignoreAllLogs(false); return "ok"; } } catch(e3) {}
    return "no_method_available";
  })()`,
};
export function createDevSettingsHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const expression = ACTION_EXPRESSIONS[args.action];
        try {
            const result = await client.evaluate(expression);
            if (result.error) {
                return failResult(`Dev settings error: ${result.error}`);
            }
            if (result.value === 'no_method_available') {
                return warnResult({ action: args.action, executed: false }, `${args.action} not available — all fallback approaches failed.`);
            }
        }
        catch (evalErr) {
            const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
            const isDisconnect = msg.includes('WebSocket closed') || msg.includes('WebSocket not connected');
            if (args.action === 'reload' && isDisconnect) {
                return okResult({ action: args.action, executed: true }, { meta: { note: 'Connection will close — use cdp_status to reconnect.' } });
            }
            throw evalErr;
        }
        return okResult({ action: args.action, executed: true });
    });
}
