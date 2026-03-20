import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, warnResult, withConnection } from '../utils.js';

export function createReloadHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (_args: { full: boolean }, client) => {
    // Step 1: Trigger reload — expected to disconnect the WS
    try {
      const result = await client.evaluate(
        '(function() {' +
        '  var ds = null;' +
        '  if (typeof __turboModuleProxy === "function") try { ds = __turboModuleProxy("DevSettings"); } catch(e) {}' +
        '  if (!ds && typeof globalThis.nativeModuleProxy !== "undefined") try { ds = globalThis.nativeModuleProxy.DevSettings; } catch(e) {}' +
        '  if (!ds && typeof globalThis.__fbBatchedBridge !== "undefined") try { ds = globalThis.__fbBatchedBridge.getCallableModule("DevSettings"); } catch(e) {}' +
        '  if (ds && typeof ds.reload === "function") { ds.reload(); return "devSettings"; }' +
        '  if (typeof globalThis.location !== "undefined" && typeof globalThis.location.reload === "function") { globalThis.location.reload(); return "location"; }' +
        '  throw new Error("DevSettings not available — use Maestro or simctl to restart the app");' +
        '})()'
      );
      if (result.error) {
        return failResult(`Reload failed: ${result.error}`);
      }
    } catch (evalErr) {
      const msg = evalErr instanceof Error ? evalErr.message : String(evalErr);
      const isExpectedDisconnect =
        msg.includes('WebSocket closed') ||
        msg.includes('WebSocket not connected') ||
        msg.includes('timeout');
      if (!isExpectedDisconnect) {
        return failResult(`Reload failed unexpectedly: ${msg}`);
      }
    }

    // Step 2: Wait for WS to close (normal mode) or settle (Bridgeless: WS stays open)
    const wsDownDeadline = Date.now() + 3_000;
    while (client.isConnected && Date.now() < wsDownDeadline) {
      await new Promise(r => setTimeout(r, 200));
    }

    // Step 3 (B61 fix): Always do full target re-discovery after reload.
    // Retry up to 3 times — new Hermes target may not be registered with Metro immediately.
    let reconnected = false;
    let lastReconnErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await client.softReconnect();
        reconnected = true;
        break;
      } catch (reconnErr) {
        lastReconnErr = reconnErr instanceof Error ? reconnErr.message : String(reconnErr);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (!reconnected) {
      return okResult(
        { reloaded: true, type: 'full', reconnected: false },
        { meta: { warning: `Reload triggered but re-discovery failed after 3 attempts: ${lastReconnErr}` } },
      );
    }

    // Step 4: Wait for helpers injection (up to 12s)
    const helperDeadline = Date.now() + 12_000;
    while (!client.helpersInjected && Date.now() < helperDeadline) {
      await new Promise(r => setTimeout(r, 400));
    }

    if (!client.isConnected) {
      return okResult(
        { reloaded: true, type: 'full', reconnected: false },
        { meta: { warning: 'Reload triggered but connection dropped after re-discovery.' } },
      );
    }

    if (!client.helpersInjected) {
      const injected = await client.reinjectHelpers();
      if (!injected) {
        return warnResult(
          { reloaded: true, type: 'full', reconnected: true },
          'Reload succeeded but helper injection failed. App may still be loading — retry cdp_status.',
        );
      }
    }

    return okResult({ reloaded: true, type: 'full', reconnected: true });
  });
}
