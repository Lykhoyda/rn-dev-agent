import { okResult, failResult, warnResult, withConnection } from '../utils.js';
export function createInteractHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (!args.testID && !args.accessibilityLabel) {
            return failResult('Either testID or accessibilityLabel is required');
        }
        if (args.action === 'typeText' && args.text === undefined) {
            return failResult('text parameter is required for typeText action');
        }
        if (args.action === 'setFieldValue') {
            if (args.name === undefined || args.name.length === 0) {
                return failResult('name parameter is required for setFieldValue action — the React Hook Form field name');
            }
            if (args.value === undefined) {
                return failResult('value parameter is required for setFieldValue action');
            }
        }
        const opts = { action: args.action };
        if (args.testID !== undefined)
            opts.testID = args.testID;
        if (args.accessibilityLabel !== undefined)
            opts.accessibilityLabel = args.accessibilityLabel;
        if (args.text !== undefined)
            opts.text = args.text;
        if (args.scrollX !== undefined)
            opts.scrollX = args.scrollX;
        if (args.scrollY !== undefined)
            opts.scrollY = args.scrollY;
        opts.animated = args.animated;
        if (args.name !== undefined)
            opts.name = args.name;
        if (args.value !== undefined)
            opts.value = args.value;
        if (args.shouldValidate !== undefined)
            opts.shouldValidate = args.shouldValidate;
        if (args.shouldDirty !== undefined)
            opts.shouldDirty = args.shouldDirty;
        const result = await client.evaluate(`__RN_AGENT.interact(${JSON.stringify(opts)})`);
        if (result.error) {
            return failResult(`Interact error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from interact — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Interact returned non-JSON: ${result.value.slice(0, 200)}`);
        }
        if (parsed.error) {
            return failResult(`Interact failed: ${parsed.error}`, parsed.hint ? { hint: parsed.hint } : undefined);
        }
        if (parsed.action_executed && parsed.handler_error) {
            return warnResult(parsed, `Action executed but handler threw: ${parsed.handler_error}`);
        }
        return okResult(parsed);
    });
}
