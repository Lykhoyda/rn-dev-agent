import { okResult, failResult, withConnection } from '../utils.js';
import { symbolicateErrors } from '../symbolicate.js';
const READ_ERRORS_EXPRESSION = `(function() {
  var startup = Array.isArray(globalThis.__RN_DEV_AGENT_BOOT_ERRORS__) ? globalThis.__RN_DEV_AGENT_BOOT_ERRORS__ : [];
  var helper = [];
  try {
    if (globalThis.__RN_AGENT) helper = JSON.parse(globalThis.__RN_AGENT.getErrors());
  } catch (error) {}
  return JSON.stringify(startup.concat(Array.isArray(helper) ? helper : []));
})()`;
const CLEAR_ERRORS_EXPRESSION = `(function() {
  if (Array.isArray(globalThis.__RN_DEV_AGENT_BOOT_ERRORS__)) globalThis.__RN_DEV_AGENT_BOOT_ERRORS__.length = 0;
  try {
    if (globalThis.__RN_AGENT) globalThis.__RN_AGENT.clearErrors();
  } catch (error) {}
  return 'cleared';
})()`;
export function createErrorLogHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.clear) {
            const clearResult = await client.evaluate(CLEAR_ERRORS_EXPRESSION);
            if (clearResult.error) {
                return failResult(`Failed to clear errors: ${clearResult.error}`);
            }
            return okResult({ cleared: true });
        }
        const result = await client.evaluate(READ_ERRORS_EXPRESSION);
        if (result.error) {
            return failResult(`Error log error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getErrors — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Failed to parse error log response: ${result.value.slice(0, 200)}`);
        }
        if (!Array.isArray(parsed)) {
            return failResult('Unexpected response from getErrors — expected array');
        }
        if (parsed.length === 0) {
            return okResult({ errors: [], count: 0 }, {
                meta: {
                    hint: 'No JS errors captured. If the app crashed, the error may be native — check: adb logcat -b crash (Android) or xcrun simctl spawn booted log stream (iOS)',
                },
            });
        }
        const symbolicated = await symbolicateErrors(parsed, client.metroPort);
        return okResult({ errors: symbolicated, count: symbolicated.length });
    }, { requireHelpers: false });
}
