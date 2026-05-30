import { okResult, failResult, withConnection } from '../utils.js';
import { annotateMutationAbsence } from '../verification/mutation-absence.js';
import { loadVerificationConfig, getCachedProjectRoot } from '../verification/config.js';
/**
 * GH #91: extract the topmost active route name from a getNavState() payload.
 * Both `routeName` (top-level convenience) and `routes[index].name` (full
 * stack form) are accepted — Expo Router and React Navigation produce slightly
 * different shapes via the helper.
 */
function extractActiveScreen(parsed) {
    const direct = parsed.routeName;
    if (typeof direct === 'string' && direct.length > 0)
        return direct;
    const routes = parsed.routes;
    if (Array.isArray(routes) && routes.length > 0) {
        const idx = typeof parsed.index === 'number' ? parsed.index : routes.length - 1;
        const active = routes[Math.max(0, Math.min(idx, routes.length - 1))];
        const name = active?.name;
        if (typeof name === 'string')
            return name;
        const path = active?.path;
        if (typeof path === 'string')
            return path;
    }
    return null;
}
export function createNavigationStateHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        const result = await client.evaluate(client.helperExpr('getNavState()'));
        if (result.error) {
            return failResult(`Navigation state error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getNavState — expected JSON string');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`getNavState returned non-JSON output: ${result.value.slice(0, 200)}`);
        }
        if (parsed.error) {
            return failResult(`Navigation state error: ${parsed.error}`);
        }
        const cfg = loadVerificationConfig(getCachedProjectRoot());
        return annotateMutationAbsence(okResult(parsed), {
            client,
            screenName: extractActiveScreen(parsed),
            source: 'cdp_navigation_state',
            successShapes: cfg.successShapes,
            mutationMethods: cfg.mutationMethods,
        });
    });
}
