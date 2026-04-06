import { okResult, warnResult, withConnection } from '../utils.js';
import { runAgentDevice, hasActiveSession } from '../agent-device-wrapper.js';
export function createProofStepHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        const result = {
            screenshotPath: '',
        };
        const errors = [];
        // Step 1: Navigate (optional)
        if (args.screen) {
            const paramsArg = args.params ? JSON.stringify(args.params) : 'undefined';
            const navExpr = `__RN_AGENT.navigateTo(${JSON.stringify(args.screen)}, ${paramsArg})`;
            const navResult = await client.evaluate(navExpr);
            if (navResult.error) {
                errors.push(`Navigation failed: ${navResult.error}`);
            }
            else if (typeof navResult.value === 'string') {
                try {
                    const parsed = JSON.parse(navResult.value);
                    if (parsed.__agent_error) {
                        errors.push(`Navigation error: ${parsed.__agent_error}`);
                    }
                    else {
                        result.navigated = true;
                        result.navigationMethod = parsed.method;
                    }
                }
                catch {
                    result.navigated = true;
                }
            }
        }
        // Step 2: Wait for settlement
        const waitMs = args.waitMs ?? 1500;
        if (waitMs > 0) {
            await new Promise(r => setTimeout(r, waitMs));
        }
        // Step 3: Verify element (optional)
        if (args.verifyText && hasActiveSession()) {
            const findResult = await runAgentDevice(['find', args.verifyText]);
            if (findResult.isError) {
                result.verified = false;
                result.verifyDetail = `Text "${args.verifyText}" not found on screen`;
                errors.push(result.verifyDetail);
            }
            else {
                result.verified = true;
                result.verifyDetail = `Found "${args.verifyText}"`;
            }
        }
        else if (args.verifyTestID) {
            const treeExpr = `__RN_AGENT.getTree({ testID: ${JSON.stringify(args.verifyTestID)}, maxDepth: 3 })`;
            const treeResult = await client.evaluate(treeExpr);
            if (treeResult.error || typeof treeResult.value !== 'string') {
                result.verified = false;
                result.verifyDetail = `testID "${args.verifyTestID}" not found`;
                errors.push(result.verifyDetail);
            }
            else {
                try {
                    const tree = JSON.parse(treeResult.value);
                    result.verified = !tree.__agent_error;
                    result.verifyDetail = tree.__agent_error
                        ? `testID "${args.verifyTestID}" not found: ${tree.__agent_error}`
                        : `testID "${args.verifyTestID}" found`;
                }
                catch {
                    result.verified = true;
                    result.verifyDetail = `testID "${args.verifyTestID}" response received`;
                }
            }
        }
        // Step 4: Screenshot
        if (hasActiveSession()) {
            const ssArgs = ['screenshot'];
            if (args.screenshotPath)
                ssArgs.push(args.screenshotPath);
            const ssResult = await runAgentDevice(ssArgs);
            if (ssResult.isError) {
                errors.push('Screenshot failed');
            }
            else {
                const text = ssResult.content[0]?.text ?? '';
                const pathMatch = text.match(/\/[^\s"]+\.(jpg|jpeg|png)/i);
                result.screenshotPath = pathMatch ? pathMatch[0] : text.trim();
            }
        }
        else {
            errors.push('No device session — screenshot skipped');
        }
        if (args.label)
            result.label = args.label;
        if (errors.length > 0)
            result.errors = errors;
        const hasFailure = errors.length > 0 && !result.verified && args.verifyText || args.verifyTestID;
        if (hasFailure && result.verified === false) {
            return warnResult(result, errors.join('; '));
        }
        return okResult(result);
    });
}
