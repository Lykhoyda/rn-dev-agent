import { okResult, warnResult, withConnection } from '../utils.js';
import { runAgentDevice, hasActiveSession } from '../agent-device-wrapper.js';
import { captureAndResizeScreenshot } from './device-list.js';
import { annotateMutationAbsence } from '../verification/mutation-absence.js';
import { loadVerificationConfig, getCachedProjectRoot } from '../verification/config.js';
export function createProofStepHandler(getClient, deps = {}) {
    const hasSession = deps.hasSession ?? hasActiveSession;
    const captureScreenshot = deps.captureScreenshot ?? captureAndResizeScreenshot;
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
        else if (args.verifyText && !hasActiveSession()) {
            // Requested a text verification but no device session is open — surface it
            // as a failure rather than leaving result.verified undefined (which reads
            // as "not failed" to callers).
            result.verified = false;
            result.verifyDetail = `Cannot verify text "${args.verifyText}" — no active device session`;
            errors.push(result.verifyDetail);
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
                // CDP-002: a successful helper envelope can still mean "no match" —
                // check for null tree, empty matches, and parse failures explicitly
                // rather than treating "no __agent_error" as proof the element exists.
                try {
                    const parsed = JSON.parse(treeResult.value);
                    const matches = parsed && Array.isArray(parsed.matches) ? parsed.matches : null;
                    const treeNode = parsed ? parsed.tree : null;
                    const hasMatch = (matches !== null && matches.length > 0)
                        || (treeNode !== null && treeNode !== undefined);
                    if (parsed && parsed.__agent_error) {
                        result.verified = false;
                        result.verifyDetail = `testID "${args.verifyTestID}" not found: ${parsed.__agent_error}`;
                        errors.push(result.verifyDetail);
                    }
                    else if (!hasMatch) {
                        result.verified = false;
                        result.verifyDetail = `testID "${args.verifyTestID}" not found (helper returned no matches)`;
                        errors.push(result.verifyDetail);
                    }
                    else {
                        result.verified = true;
                        result.verifyDetail = `testID "${args.verifyTestID}" found`;
                    }
                }
                catch {
                    result.verified = false;
                    result.verifyDetail = `testID "${args.verifyTestID}" — failed to parse helper response`;
                    errors.push(result.verifyDetail);
                }
            }
        }
        // Step 4: Screenshot — B121: route through resize wrapper so per-phase
        // proof captures pay the B120 budget (default maxWidth=800) instead of
        // emitting native-resolution images that bloat proof bundles.
        if (hasSession()) {
            const ssResult = await captureScreenshot({ path: args.screenshotPath });
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
        // CDP-005: previously the warn-vs-ok decision used a confused boolean
        // (errors && !verified && verifyText) || verifyTestID — which meant a
        // missing screenshot or no-active-session was silently reported as
        // ok:true. Now we explicitly fire warn for either failure mode:
        //   1. verification was requested AND failed (verified === false)
        //   2. ANY error was accumulated (screenshot failure, missing session,
        //      navigation error) regardless of verification args
        const verifyRequested = !!(args.verifyText || args.verifyTestID);
        const verifyFailed = verifyRequested && result.verified === false;
        const hasFailure = verifyFailed || errors.length > 0;
        // GH #91: derive a screen-name signal from whichever input is freshest.
        // Prefer the screen we navigated to (driving signal), then the verified
        // testID (success-shape testIDs like "AddPolicySuccessSheet" trigger too),
        // then the verified text. null allowed — annotateMutationAbsence handles it.
        const screenName = args.screen ?? args.verifyTestID ?? args.verifyText ?? null;
        const cfg = loadVerificationConfig(getCachedProjectRoot());
        const ctx = {
            client,
            screenName,
            source: 'proof_step',
            successShapes: cfg.successShapes,
            mutationMethods: cfg.mutationMethods,
        };
        if (hasFailure) {
            return annotateMutationAbsence(warnResult(result, errors.join('; ') || 'proof_step verification failed'), ctx);
        }
        return annotateMutationAbsence(okResult(result), ctx);
    });
}
