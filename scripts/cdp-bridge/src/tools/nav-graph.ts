import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, warnResult, withConnection } from '../utils.js';
import type { RawNavTopology, NavGraphScanResult, NavGraph, NavMethod } from '../nav-graph/types.js';
import {
  findProjectRoot,
  readGraph,
  writeGraph,
  buildGraph,
  mergeGraph,
  getGraphPath,
  recordNavigation,
} from '../nav-graph/storage.js';
import type { MergeResult } from '../nav-graph/storage.js';
import {
  findRouteInGraph,
  listAllRoutes,
  getNavigatorSubtree,
  buildNavigationPlan,
} from '../nav-graph/query.js';
import {
  checkStaleness,
  getHeadCommit,
  getPlaybook,
  buildSelfHealAdvice,
} from '../nav-graph/self-heal.js';

interface NavGraphArgs {
  action: 'scan' | 'read' | 'navigate' | 'record' | 'staleness' | 'playbook' | 'heal';
  navigator_id?: string;
  screen?: string;
  force?: boolean;
  from?: string;
  method?: NavMethod;
  success?: boolean;
  latency_ms?: number;
  platform?: 'ios' | 'android';
}

export function createNavGraphHandler(getClient: () => CDPClient) {
  const scanHandler = withConnection(getClient, async (args: NavGraphArgs, client) => {
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
          return warnResult(
            {
              graph: existing,
              file_path: getGraphPath(projectRoot),
              navigators_found: existing.navigators.length,
              routes_found: existing.all_screens.length,
              new_routes: [],
              removed_routes: [],
              is_first_scan: false,
              coverage: existing.meta.coverage,
              cached: true,
            } satisfies NavGraphScanResult & { cached: boolean },
            'Graph was scanned less than 5 minutes ago. Use force=true to re-scan.',
          );
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

    let raw: RawNavTopology;
    try {
      const parsed = JSON.parse(result.value) as RawNavTopology & { error?: string };
      if (parsed.error) return failResult(`Nav graph error: ${parsed.error}`);
      raw = parsed;
    } catch {
      return failResult('Failed to parse nav graph response');
    }

    if (!raw.navigators || raw.navigators.length === 0) {
      return failResult('Nav graph extraction returned no navigators. The app may not have rendered any navigation yet.');
    }

    const existing = readGraph(projectRoot);
    let graph: NavGraph;
    let newRoutes: string[] = [];
    let removedRoutes: string[] = [];
    const isFirstScan = !existing;

    const commitHash = getHeadCommit(projectRoot) ?? undefined;

    if (existing) {
      const merged: MergeResult = mergeGraph(existing, raw, projectRoot);
      graph = merged.graph;
      newRoutes = merged.new_routes;
      removedRoutes = merged.removed_routes;
      if (commitHash) graph.meta.scanned_at_commit = commitHash;
    } else {
      graph = buildGraph(raw, projectRoot, commitHash);
    }

    let filePath: string | null = null;
    try {
      filePath = writeGraph(projectRoot, graph);
    } catch (writeErr) {
      return warnResult(
        {
          graph,
          file_path: null,
          navigators_found: raw.navigators.length,
          routes_found: graph.all_screens.length,
          new_routes: newRoutes,
          removed_routes: removedRoutes,
          is_first_scan: isFirstScan,
          coverage: graph.meta.coverage,
        } satisfies NavGraphScanResult,
        `Graph extracted but save failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      );
    }

    const scanResult: NavGraphScanResult = {
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

  const readHandler = async (args: NavGraphArgs) => {
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

  const navigateHandler = async (args: NavGraphArgs) => {
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
      return failResult(
        `Cannot plan navigation to "${args.screen}". Screen not found in graph. Known screens: ${graph.all_screens.join(', ')}`,
      );
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

  const recordHandler = async (args: NavGraphArgs) => {
    if (!args.screen) return failResult('screen is required for action="record".');
    if (!args.method) return failResult('method is required for action="record" (programmatic, deep_link, or ui_interaction).');
    if (args.success === undefined) return failResult('success is required for action="record" (true or false).');

    const projectRoot = findProjectRoot();
    if (!projectRoot) return failResult('Cannot find project root.');

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
    const projectRoot = findProjectRoot();
    if (!projectRoot) return failResult('Cannot find project root.');
    const result = checkStaleness(projectRoot);
    return result.stale
      ? warnResult(result, result.reason ?? 'Graph may be stale')
      : okResult(result);
  };

  const playbookHandler = async (args: NavGraphArgs) => {
    const entries = getPlaybook(args.platform ?? undefined);
    return okResult({ entries, platform: args.platform ?? 'all', count: entries.length });
  };

  const healHandler = async (args: NavGraphArgs) => {
    if (!args.screen) return failResult('screen is required for action="heal".');
    if (!args.method) return failResult('method is required for action="heal".');
    const platform = args.platform ?? null;
    const advice = buildSelfHealAdvice(args.screen, args.method, platform);
    return okResult(advice);
  };

  return async (args: NavGraphArgs) => {
    if (args.action === 'scan') return scanHandler(args);
    if (args.action === 'navigate') return navigateHandler(args);
    if (args.action === 'record') return recordHandler(args);
    if (args.action === 'staleness') return stalenessHandler();
    if (args.action === 'playbook') return playbookHandler(args);
    if (args.action === 'heal') return healHandler(args);
    return readHandler(args);
  };
}
