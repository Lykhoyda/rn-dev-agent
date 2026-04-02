import { okResult, failResult, warnResult, withConnection } from '../utils.js';
import { findProjectRoot, readGraph, writeGraph, buildGraph, mergeGraph, getGraphPath, } from '../nav-graph/storage.js';
import { findRouteInGraph, listAllRoutes, getNavigatorSubtree, buildNavigationPlan, } from '../nav-graph/query.js';
export function createNavGraphHandler(getClient) {
    const scanHandler = withConnection(getClient, async (args, client) => {
        const projectRoot = findProjectRoot();
        if (!projectRoot) {
            return failResult('Cannot find project root (no package.json found). Run from inside a React Native project.');
        }
        if (!args.force) {
            const existing = readGraph(projectRoot);
            if (existing) {
                const lastScan = new Date(existing.meta.last_scanned_at).getTime();
                const fiveMinAgo = Date.now() - 5 * 60 * 1000;
                if (lastScan > fiveMinAgo) {
                    return warnResult({
                        graph: existing,
                        file_path: getGraphPath(projectRoot),
                        navigators_found: existing.navigators.length,
                        routes_found: existing.all_screens.length,
                        new_routes: [],
                        removed_routes: [],
                        is_first_scan: false,
                        coverage: existing.meta.coverage,
                        cached: true,
                    }, 'Graph was scanned less than 5 minutes ago. Use force=true to re-scan.');
                }
            }
        }
        const expr = client.bridgeDetected
            ? '__RN_DEV_BRIDGE__.getNavGraph ? __RN_DEV_BRIDGE__.getNavGraph() : __RN_AGENT.getNavGraph()'
            : '__RN_AGENT.getNavGraph()';
        const result = await client.evaluate(expr);
        if (result.error) {
            if (String(result.error).includes('is not a function') || String(result.error).includes('undefined')) {
                return failResult('Nav graph requires helpers v10. Call cdp_reload to reinject updated helpers, then retry.');
            }
            return failResult(`Nav graph extraction error: ${result.error}`);
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from getNavGraph — expected JSON string');
        }
        let raw;
        try {
            const parsed = JSON.parse(result.value);
            if (parsed.error)
                return failResult(`Nav graph error: ${parsed.error}`);
            raw = parsed;
        }
        catch {
            return failResult('Failed to parse nav graph response');
        }
        if (!raw.navigators || raw.navigators.length === 0) {
            return failResult('Nav graph extraction returned no navigators. The app may not have rendered any navigation yet.');
        }
        const existing = readGraph(projectRoot);
        let graph;
        let newRoutes = [];
        let removedRoutes = [];
        const isFirstScan = !existing;
        if (existing) {
            const merged = mergeGraph(existing, raw, projectRoot);
            graph = merged.graph;
            newRoutes = merged.new_routes;
            removedRoutes = merged.removed_routes;
        }
        else {
            graph = buildGraph(raw, projectRoot);
        }
        let filePath = null;
        try {
            filePath = writeGraph(projectRoot, graph);
        }
        catch (writeErr) {
            return warnResult({
                graph,
                file_path: null,
                navigators_found: raw.navigators.length,
                routes_found: graph.all_screens.length,
                new_routes: newRoutes,
                removed_routes: removedRoutes,
                is_first_scan: isFirstScan,
                coverage: graph.meta.coverage,
            }, `Graph extracted but save failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
        }
        const scanResult = {
            graph,
            file_path: filePath,
            navigators_found: raw.navigators.length,
            routes_found: graph.all_screens.length,
            new_routes: newRoutes,
            removed_routes: removedRoutes,
            is_first_scan: isFirstScan,
            coverage: graph.meta.coverage,
        };
        return okResult(scanResult);
    });
    const readHandler = async (args) => {
        const projectRoot = findProjectRoot();
        if (!projectRoot) {
            return failResult('Cannot find project root (no package.json found).');
        }
        const graph = readGraph(projectRoot);
        if (!graph) {
            return failResult('No nav graph found. Call cdp_nav_graph with action="scan" first to extract the navigation topology.');
        }
        const lastScan = new Date(graph.meta.last_scanned_at).getTime();
        const stale = Date.now() - lastScan > 24 * 60 * 60 * 1000;
        if (args.screen) {
            const location = findRouteInGraph(graph, args.screen);
            if (!location) {
                return failResult(`Screen "${args.screen}" not found in navigation graph. Known screens: ${graph.all_screens.join(', ')}`);
            }
            const result = { ...location, stale, file_path: getGraphPath(projectRoot) };
            return stale
                ? warnResult(result, 'Graph is over 24h old. Consider re-scanning with action="scan".')
                : okResult(result);
        }
        if (args.navigator_id) {
            const subtree = getNavigatorSubtree(graph, args.navigator_id);
            if (subtree.length === 0) {
                return failResult(`Navigator "${args.navigator_id}" not found. Known navigators: ${graph.navigators.map(n => n.id).join(', ')}`);
            }
            const result = { navigators: subtree, stale, file_path: getGraphPath(projectRoot) };
            return stale
                ? warnResult(result, 'Graph is over 24h old. Consider re-scanning with action="scan".')
                : okResult(result);
        }
        const routes = listAllRoutes(graph);
        const result = { graph, routes_summary: routes, stale, file_path: getGraphPath(projectRoot) };
        return stale
            ? warnResult(result, 'Graph is over 24h old. Consider re-scanning with action="scan".')
            : okResult(result);
    };
    const navigateHandler = async (args) => {
        if (!args.screen) {
            return failResult('screen parameter is required for action="navigate".');
        }
        const projectRoot = findProjectRoot();
        if (!projectRoot) {
            return failResult('Cannot find project root (no package.json found).');
        }
        const graph = readGraph(projectRoot);
        if (!graph) {
            return failResult('No nav graph found. Call cdp_nav_graph with action="scan" first.');
        }
        const plan = buildNavigationPlan(graph, args.screen, args.from ?? undefined);
        if (!plan) {
            return failResult(`Cannot plan navigation to "${args.screen}". Screen not found in graph. Known screens: ${graph.all_screens.join(', ')}`);
        }
        if (plan.total_steps === 0) {
            return okResult({
                plan,
                message: `Already on "${args.screen}" — no navigation needed.`,
            });
        }
        return okResult({
            plan,
            message: `Navigation plan: ${plan.total_steps} step(s) to reach "${args.screen}" from "${plan.from ?? 'unknown'}". `
                + `Reliability: ${plan.estimated_reliability}%. `
                + (plan.deep_link_available ? `Deep link available: ${plan.deep_link_path}. ` : '')
                + (plan.prerequisites.length > 0 ? `Prerequisites: ${plan.prerequisites.map(p => p.description).join('; ')}. ` : '')
                + 'Execute each step using cdp_navigate or device_find/device_press.',
            execution_hint: plan.preferred_method === 'programmatic'
                ? plan.steps
                    .filter(s => s.method === 'programmatic')
                    .map(s => `cdp_navigate(screen="${s.target_screen}")`)
                : [`Open deep link: ${plan.deep_link_path}`],
        });
    };
    return async (args) => {
        if (args.action === 'scan')
            return scanHandler(args);
        if (args.action === 'navigate')
            return navigateHandler(args);
        return readHandler(args);
    };
}
