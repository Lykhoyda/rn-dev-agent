import { textResult, errorResult, withConnection } from '../utils.js';
export function createErrorLogHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.clear) {
            const clearResult = await client.evaluate('__RN_AGENT.clearErrors()');
            if (clearResult.error) {
                return errorResult(`Failed to clear errors: ${clearResult.error}`);
            }
            return textResult(JSON.stringify({ cleared: true }));
        }
        const result = await client.evaluate('__RN_AGENT.getErrors()');
        if (result.error) {
            return errorResult(`Error log error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return errorResult('Unexpected response from getErrors — expected JSON string');
        }
        const parsed = JSON.parse(result.value);
        if (!Array.isArray(parsed)) {
            return errorResult('Unexpected response from getErrors — expected array');
        }
        if (parsed.length === 0) {
            return textResult(JSON.stringify({
                errors: [],
                count: 0,
                hint: 'No JS errors captured. If the app crashed, the error may be native — check: adb logcat -b crash (Android) or xcrun simctl spawn booted log stream (iOS)',
            }));
        }
        return textResult(JSON.stringify({ errors: parsed, count: parsed.length }));
    });
}
