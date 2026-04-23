import { okResult, failResult, warnResult, withConnection } from '../utils.js';
import { launchAndNavigate } from './startup-replay.js';
import { findProjectRoot, readGraph, writeGraph, buildGraph, mergeGraph, getGraphPath, recordNavigation, } from '../nav-graph/storage.js';
import { findRouteInGraph, listAllRoutes, getNavigatorSubtree, buildNavigationPlan, } from '../nav-graph/query.js';
import { checkStaleness, getHeadCommit, getPlaybook, buildSelfHealAdvice, } from '../nav-graph/self-heal.js';
/**
 * B126: derive PascalCase aliases for any UPPER_SNAKE_CASE route names. Lets
 * agents cross-reference the runtime route name (what RN navigation accepts)
 * with the app's TypeScript ScreenName enum keys (typically PascalCase).
 *
 * Heuristic: only convert names that look like all-caps snake_case (`/^[A-Z][A-Z0-9_]*$/`)
 * AND have at least one underscore (single-word UPPER_CASE has no PascalCase
 * benefit). Returns an empty object when no conversions apply.
 *
 * Pure helper — exported for unit testing.
 */
export function buildScreenNameAliases(screens) {
    const out = {};
    for (const name of screens) {
        if (typeof name !== 'string')
            continue;
        if (!/^[A-Z][A-Z0-9_]*$/.test(name))
            continue;
        if (!name.includes('_'))
            continue;
        const pascal = name.split('_')
            .filter((part) => part.length > 0)
            .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
            .join('');
        if (pascal && pascal !== name)
            out[name] = pascal;
    }
    return out;
}
/**
 * B115 (D640): build the JS arg string for __NAV_REF__.navigate() when the plan
 * contains a switch_tab step.
 *
 * Case 1: user requested the tab itself (tab name === target screen name).
 *   Emit `ref.navigate('TasksTab', params?)` — flat call, just focuses the tab.
 *   The old shape `ref.navigate('TasksTab', { screen: 'TasksTab' })` was
 *   self-referential and left React Navigation stuck (arrived=false).
 *
 * Case 2: user requested a screen INSIDE a tab (tab name !== target screen name).
 *   Emit `ref.navigate('TasksTab', { screen: 'TaskDetail', params })` — nested
 *   dispatch lands on the inner screen.
 *
 * Exported for unit testing — pure string-builder.
 */
export function buildTabNavigateArgs(tabName, targetScreen, paramsArgJs) {
    if (tabName === targetScreen) {
        return `${JSON.stringify(tabName)}, ${paramsArgJs}`;
    }
    return `${JSON.stringify(tabName)}, { screen: ${JSON.stringify(targetScreen)}, params: ${paramsArgJs} }`;
}
export function createNavGraphHandler(getClient) {
    const scanHandler = withConnection(getClient, async (args, client) => {
        const bundleId = getClient().connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
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
                        pascal_case_aliases: buildScreenNameAliases(existing.all_screens),
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
        const commitHash = getHeadCommit(projectRoot) ?? undefined;
        if (existing) {
            const merged = mergeGraph(existing, raw, projectRoot);
            graph = merged.graph;
            newRoutes = merged.new_routes;
            removedRoutes = merged.removed_routes;
            if (commitHash)
                graph.meta.scanned_at_commit = commitHash;
        }
        else {
            graph = buildGraph(raw, projectRoot, commitHash);
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
                pascal_case_aliases: buildScreenNameAliases(graph.all_screens),
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
            pascal_case_aliases: buildScreenNameAliases(graph.all_screens),
        };
        return okResult(scanResult);
    });
    const readHandler = async (args) => {
        const bundleId = getClient().connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
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
        const bundleId = getClient().connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
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
    const recordHandler = async (args) => {
        if (!args.screen)
            return failResult('screen is required for action="record".');
        if (!args.method)
            return failResult('method is required for action="record" (programmatic, deep_link, or ui_interaction).');
        if (args.success === undefined)
            return failResult('success is required for action="record" (true or false).');
        const bundleId = getClient().connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
        if (!projectRoot)
            return failResult('Cannot find project root.');
        const result = recordNavigation(projectRoot, {
            screen: args.screen,
            method: args.method,
            success: args.success,
            latency_ms: args.latency_ms,
        });
        if (!result) {
            return failResult(`Screen "${args.screen}" not found in graph. Run action="scan" first.`);
        }
        return okResult(result);
    };
    const stalenessHandler = async () => {
        const bundleId = getClient().connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
        if (!projectRoot)
            return failResult('Cannot find project root.');
        const result = checkStaleness(projectRoot);
        return result.stale
            ? warnResult(result, result.reason ?? 'Graph may be stale')
            : okResult(result);
    };
    const playbookHandler = async (args) => {
        const entries = getPlaybook(args.platform ?? undefined);
        return okResult({ entries, platform: args.platform ?? 'all', count: entries.length });
    };
    const healHandler = async (args) => {
        if (!args.screen)
            return failResult('screen is required for action="heal".');
        if (!args.method)
            return failResult('method is required for action="heal".');
        const platform = args.platform ?? null;
        const advice = buildSelfHealAdvice(args.screen, args.method, platform);
        return okResult(advice);
    };
    const goHandler = withConnection(getClient, async (args, client) => {
        if (!args.screen)
            return failResult('screen is required for action="go".');
        const startTime = Date.now();
        const result = {
            arrived: false,
            screen: args.screen,
            from: null,
            method_used: 'none',
            steps_executed: 0,
            latency_ms: 0,
            nav_state_after: null,
            graph_scanned: false,
        };
        const bundleId = client.connectedTarget?.description ?? null;
        const projectRoot = findProjectRoot(bundleId ? { bundleId } : undefined);
        // 1. Staleness check + auto-rescan
        if (projectRoot) {
            const staleness = checkStaleness(projectRoot);
            result.staleness = staleness;
            if (staleness.recommendation === 'rescan_required' || staleness.recommendation === 'rescan_recommended' || !readGraph(projectRoot)) {
                try {
                    const expr = client.bridgeDetected
                        ? '__RN_DEV_BRIDGE__.getNavGraph ? __RN_DEV_BRIDGE__.getNavGraph() : __RN_AGENT.getNavGraph()'
                        : '__RN_AGENT.getNavGraph()';
                    const scanResult = await client.evaluate(expr);
                    if (scanResult.value && typeof scanResult.value === 'string') {
                        const raw = JSON.parse(scanResult.value);
                        if (!raw.error && raw.navigators?.length > 0) {
                            const existing = readGraph(projectRoot);
                            const commitHash = getHeadCommit(projectRoot) ?? undefined;
                            if (existing) {
                                const merged = mergeGraph(existing, raw, projectRoot);
                                if (commitHash)
                                    merged.graph.meta.scanned_at_commit = commitHash;
                                writeGraph(projectRoot, merged.graph);
                            }
                            else {
                                writeGraph(projectRoot, buildGraph(raw, projectRoot, commitHash));
                            }
                            result.graph_scanned = true;
                        }
                    }
                }
                catch { /* scan failed, continue with cached graph */ }
            }
        }
        // 2. Playbook tips
        if (args.platform) {
            result.playbook_tips = getPlaybook(args.platform);
        }
        // 3. Build plan — fetch LIVE nav state first (B-Tier3 fix)
        // The cached graph's is_active flags may be stale vs runtime. Use the actual
        // current screen from __RN_AGENT.getNavState() as the "from" for plan building.
        let liveFromScreen = args.from ?? undefined;
        if (!liveFromScreen) {
            try {
                const navStateResult = await client.evaluate('__RN_AGENT.getNavState()');
                if (typeof navStateResult.value === 'string') {
                    const liveState = JSON.parse(navStateResult.value);
                    const getDeepestRoute = (s) => {
                        if (!s)
                            return null;
                        if (s.nested)
                            return getDeepestRoute(s.nested);
                        return s.routeName ?? null;
                    };
                    const live = getDeepestRoute(liveState);
                    if (live)
                        liveFromScreen = live;
                }
            }
            catch { /* fall back to cached graph */ }
        }
        if (projectRoot) {
            const graph = readGraph(projectRoot);
            if (graph) {
                result.plan = buildNavigationPlan(graph, args.screen, liveFromScreen) ?? undefined;
                result.from = result.plan?.from ?? liveFromScreen ?? null;
            }
        }
        // 4. Execute navigation — single CDP evaluate call
        // If the plan has a tab switch step, use direct tab+screen navigation (avoids the
        // fallback-navigate bug where unvisited tabs haven't mounted their nested navigators).
        const planTabStep = result.plan?.steps?.find(s => s.action === 'switch_tab');
        const paramsArg = args.params ? JSON.stringify(args.params) : 'undefined';
        const tabNavArgsJs = planTabStep
            ? buildTabNavigateArgs(planTabStep.target_screen, args.screen, paramsArg)
            : '';
        const navExpr = planTabStep
            ? `
      (function() {
        var start = Date.now();
        var ref = globalThis.__NAV_REF__;
        if (!ref) return JSON.stringify({ error: '__NAV_REF__ not available', latency_ms: 0 });
        try {
          ref.navigate(${tabNavArgsJs});
        } catch(e) {
          return JSON.stringify({ error: 'Tab navigate failed: ' + e.message, latency_ms: Date.now() - start });
        }
        var stateResult = __RN_AGENT.getNavState();
        var state = JSON.parse(stateResult);
        function getDeepestRoute(s) {
          if (!s) return null;
          if (s.nested) return getDeepestRoute(s.nested);
          return s.routeName || null;
        }
        function collectAllRoutes(s, acc) {
          if (!s) return acc;
          if (s.routeName) acc.push(s.routeName);
          if (s.nested) collectAllRoutes(s.nested, acc);
          return acc;
        }
        var currentScreen = getDeepestRoute(state);
        var allRoutes = collectAllRoutes(state, []);
        var target = ${JSON.stringify(args.screen)};
        var deepestMatches = currentScreen === target;
        var anywhereMatches = allRoutes.indexOf(target) >= 0;
        var arrived = deepestMatches || anywhereMatches;
        return JSON.stringify({
          arrived: arrived,
          current_screen: currentScreen,
          arrived_via: deepestMatches ? 'deepest-route' : (anywhereMatches ? 'parent-of-current' : null),
          all_routes: allRoutes,
          method: 'plan-tab-navigate',
          path: [${JSON.stringify(planTabStep.target_screen)}, ${JSON.stringify(args.screen)}],
          latency_ms: Date.now() - start,
          nav_state: state
        });
      })()
      `
            : `
      (function() {
        var start = Date.now();
        var navResult = __RN_AGENT.navigateTo(${JSON.stringify(args.screen)}, ${paramsArg});
        var parsed = JSON.parse(navResult);
        if (parsed.__agent_error) return JSON.stringify({ error: parsed.__agent_error, latency_ms: Date.now() - start });

        var stateResult = __RN_AGENT.getNavState();
        var state = JSON.parse(stateResult);

        function getDeepestRoute(s) {
          if (!s) return null;
          if (s.nested) return getDeepestRoute(s.nested);
          return s.routeName || null;
        }
        // B124: collect ALL route names down the nested chain. This lets us
        // detect "navigation succeeded but landed under a modal pushed on top
        // of the target" — the target is in the route tree, just not the leaf.
        // Without this, reliability_score drops 50→35 on successful navigations
        // whenever a stacked modal happens to be open.
        function collectAllRoutes(s, acc) {
          if (!s) return acc;
          if (s.routeName) acc.push(s.routeName);
          if (s.nested) collectAllRoutes(s.nested, acc);
          return acc;
        }
        var currentScreen = getDeepestRoute(state);
        var allRoutes = collectAllRoutes(state, []);
        var target = ${JSON.stringify(args.screen)};
        var deepestMatches = currentScreen === target;
        var anywhereMatches = allRoutes.indexOf(target) >= 0;
        var arrived = deepestMatches || anywhereMatches;

        return JSON.stringify({
          arrived: arrived,
          current_screen: currentScreen,
          arrived_via: deepestMatches ? 'deepest-route' : (anywhereMatches ? 'parent-of-current' : null),
          all_routes: allRoutes,
          method: parsed.method,
          path: parsed.path,
          latency_ms: Date.now() - start,
          nav_state: state
        });
      })()
    `;
        const navResult = await client.evaluate(navExpr);
        if (navResult.error) {
            result.error = navResult.error;
            result.method_used = 'programmatic_failed';
            // 5. Auto-heal on failure
            result.heal_advice = buildSelfHealAdvice(args.screen, 'programmatic', args.platform ?? null);
            if (projectRoot) {
                recordNavigation(projectRoot, { screen: args.screen, method: 'programmatic', success: false });
            }
            result.latency_ms = Date.now() - startTime;
            return warnResult(result, `Navigation failed: ${navResult.error}. See heal_advice for recovery steps.`);
        }
        if (typeof navResult.value === 'string') {
            try {
                const parsed = JSON.parse(navResult.value);
                if (parsed.error) {
                    result.error = parsed.error;
                    result.method_used = 'programmatic_failed';
                    result.heal_advice = buildSelfHealAdvice(args.screen, 'programmatic', args.platform ?? null);
                    if (projectRoot) {
                        recordNavigation(projectRoot, { screen: args.screen, method: 'programmatic', success: false });
                    }
                    result.latency_ms = Date.now() - startTime;
                    return warnResult(result, `Navigation failed: ${parsed.error}. See heal_advice.`);
                }
                result.arrived = parsed.arrived ?? false;
                result.method_used = parsed.method ?? 'unknown';
                result.steps_executed = parsed.path?.length ?? 1;
                result.nav_state_after = parsed.nav_state;
                result.latency_ms = Date.now() - startTime;
                // B124: surface arrived_via so callers and the experience engine can
                // distinguish a strict deepest-route match from a "navigated but
                // covered by a stacked modal" success. Only the latter needs the
                // explicit hint that the visible UI may not yet reflect the target.
                if (parsed.arrived_via) {
                    result.arrived_via = parsed.arrived_via;
                }
                if (parsed.all_routes) {
                    result.all_routes = parsed.all_routes;
                }
                // 6. Record outcome
                if (projectRoot) {
                    recordNavigation(projectRoot, {
                        screen: args.screen,
                        method: 'programmatic',
                        success: result.arrived,
                        latency_ms: parsed.latency_ms,
                    });
                }
                if (!result.arrived) {
                    result.heal_advice = buildSelfHealAdvice(args.screen, 'programmatic', args.platform ?? null);
                    return warnResult(result, `Navigated but landed on "${parsed.current_screen}" instead of "${args.screen}". See heal_advice.`);
                }
                return okResult(result);
            }
            catch {
                result.error = 'Failed to parse navigation result';
                result.latency_ms = Date.now() - startTime;
                return failResult(result.error);
            }
        }
        result.error = 'Unexpected response from navigateTo';
        result.latency_ms = Date.now() - startTime;
        return failResult(result.error);
    });
    const goWithStartupReplay = async (args) => {
        const result = await goHandler(args);
        if (!args.screen)
            return result;
        const envelope = JSON.parse(result.content[0].text);
        const isNavRefMissing = (envelope.ok && envelope.meta?.warning?.includes('__NAV_REF__'))
            || (envelope.ok && envelope.meta?.warning?.includes('Navigation failed'))
            || (envelope.data && !envelope.data.arrived && envelope.data.method_used === 'programmatic_failed');
        if (!isNavRefMissing)
            return result;
        const client = getClient();
        try {
            const replayResult = await launchAndNavigate(client, args.screen, args.params, {
                platform: args.platform,
            });
            if (replayResult.arrived) {
                const goResult = {
                    arrived: true,
                    screen: args.screen,
                    from: null,
                    method_used: 'startup_replay',
                    steps_executed: 1,
                    latency_ms: replayResult.latency_ms,
                    nav_state_after: null,
                    graph_scanned: false,
                    startup_replay: {
                        picker_dismissed: replayResult.picker_dismissed,
                        reconnect_attempts: replayResult.reconnect_attempts,
                    },
                };
                const replayBundleId = client.connectedTarget?.description ?? null;
                const projectRoot = findProjectRoot(replayBundleId ? { bundleId: replayBundleId } : undefined);
                if (projectRoot) {
                    recordNavigation(projectRoot, { screen: args.screen, method: 'programmatic', success: true, latency_ms: replayResult.latency_ms });
                }
                return warnResult(goResult, `Programmatic navigation failed — recovered via startup replay (${replayResult.latency_ms}ms).`);
            }
            return warnResult({ ...envelope.data, startup_replay_attempted: true, startup_replay_error: replayResult.error }, `Navigation failed. Startup replay also failed: ${replayResult.error}`);
        }
        catch {
            return result;
        }
    };
    return async (args) => {
        if (args.action === 'go')
            return goWithStartupReplay(args);
        if (args.action === 'scan')
            return scanHandler(args);
        if (args.action === 'navigate')
            return navigateHandler(args);
        if (args.action === 'record')
            return recordHandler(args);
        if (args.action === 'staleness')
            return stalenessHandler();
        if (args.action === 'playbook')
            return playbookHandler(args);
        if (args.action === 'heal')
            return healHandler(args);
        return readHandler(args);
    };
}
