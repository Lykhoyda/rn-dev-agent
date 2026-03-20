import type { CDPClient } from '../cdp-client.js';
import type { ErrorEntry } from '../types.js';
import { okResult, failResult, withConnection } from '../utils.js';
import { symbolicateErrors } from '../symbolicate.js';

export function createErrorLogHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { clear: boolean }, client) => {
    if (args.clear) {
      const clearExpr = client.bridgeDetected ? '__RN_DEV_BRIDGE__.clearErrors()' : '__RN_AGENT.clearErrors()';
      const clearResult = await client.evaluate(clearExpr);
      if (clearResult.error) {
        return failResult(`Failed to clear errors: ${clearResult.error}`);
      }
      return okResult({ cleared: true });
    }

    const getExpr = client.bridgeDetected ? '__RN_DEV_BRIDGE__.getErrors()' : '__RN_AGENT.getErrors()';
    const result = await client.evaluate(getExpr);

    if (result.error) {
      return failResult(`Error log error: ${result.error}`);
    }

    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from getErrors — expected JSON string');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value);
    } catch {
      return failResult(`Failed to parse error log response: ${result.value.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed)) {
      return failResult('Unexpected response from getErrors — expected array');
    }

    if (parsed.length === 0) {
      return okResult(
        { errors: [], count: 0 },
        { meta: { hint: 'No JS errors captured. If the app crashed, the error may be native — check: adb logcat -b crash (Android) or xcrun simctl spawn booted log stream (iOS)' } },
      );
    }

    const symbolicated = await symbolicateErrors(parsed as ErrorEntry[], client.metroPort);
    return okResult({ errors: symbolicated, count: symbolicated.length });
  });
}
