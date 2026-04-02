import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { NavGraph, NavGraphMeta, NavNavigator, NavScreen, RawNavTopology, RawNavigator, RawRoute } from './types.js';

const GRAPH_FILENAME = '.rn-nav-graph.yaml';

export function findProjectRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function getProjectSlug(projectRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as { name?: string };
    if (pkg.name && typeof pkg.name === 'string') return pkg.name;
  } catch { /* fall through */ }
  return projectRoot.split('/').pop() ?? 'unknown';
}

export function getGraphPath(projectRoot: string): string {
  return join(projectRoot, GRAPH_FILENAME);
}

export function readGraph(projectRoot: string): NavGraph | null {
  try {
    const filePath = getGraphPath(projectRoot);
    if (!existsSync(filePath)) return null;
    const raw = yamlParse(readFileSync(filePath, 'utf-8')) as { nav_graph?: NavGraph } | null;
    if (!raw || !raw.nav_graph) return null;
    return raw.nav_graph;
  } catch {
    return null;
  }
}

export function writeGraph(projectRoot: string, graph: NavGraph): string {
  const filePath = getGraphPath(projectRoot);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const yaml = yamlStringify({ nav_graph: graph }, { lineWidth: 120 });
  writeFileSync(tmpPath, yaml, 'utf-8');
  renameSync(tmpPath, filePath);
  return filePath;
}

function buildScreen(raw: RawRoute, isActive: boolean): NavScreen {
  const screen: NavScreen = {
    name: raw.name,
    is_active: isActive,
    reliability_score: raw.is_visited ? 100 : 50,
    visit_count: raw.is_visited ? 1 : 0,
  };
  if (raw.path) screen.path = raw.path;
  if (raw.params_schema && raw.params_schema.length > 0) {
    screen.params_template = `{ ${raw.params_schema.join(', ')} }`;
  }
  if (raw.is_initial) screen.initial = true;
  if (raw.is_modal) screen.is_modal = true;
  if (raw.is_visited) screen.last_seen = new Date().toISOString();
  return screen;
}

function buildNavigator(raw: RawNavigator, activeScreenName: string | null): NavNavigator {
  const screens = raw.routes.map(r =>
    buildScreen(r, r.name === activeScreenName),
  );
  return {
    id: raw.id,
    kind: raw.kind,
    screens,
    active_screen: activeScreenName,
    parent_screen: raw.parent_screen ?? undefined,
    is_visited: raw.is_visited,
    source: raw.source,
  };
}

function collectAllScreens(navigators: NavNavigator[]): string[] {
  const set = new Set<string>();
  for (const nav of navigators) {
    for (const screen of nav.screens) {
      set.add(screen.name);
    }
  }
  return [...set].sort();
}

function computeCoverage(navigators: NavNavigator[]): number {
  let visited = 0;
  let total = 0;
  for (const nav of navigators) {
    for (const screen of nav.screens) {
      total++;
      if (screen.visit_count > 0) visited++;
    }
  }
  return total === 0 ? 0 : Math.round((visited / total) * 100);
}

export function buildGraph(raw: RawNavTopology, projectRoot: string): NavGraph {
  const navigators: NavNavigator[] = [];

  for (const rawNav of raw.navigators) {
    navigators.push(buildNavigator(rawNav, rawNav.active_route_name ?? null));
  }

  const allScreens = collectAllScreens(navigators);
  const now = new Date().toISOString();

  const meta: NavGraphMeta = {
    schema_version: 1,
    project_slug: getProjectSlug(projectRoot),
    nav_library: raw.library,
    rn_version: raw.rn_version,
    expo_sdk: raw.expo_sdk,
    created_at: now,
    last_scanned_at: now,
    scan_count: 1,
    containers_found: raw.containers_found,
    coverage: computeCoverage(navigators),
  };

  return { meta, navigators, all_screens: allScreens };
}

export interface MergeResult {
  graph: NavGraph;
  new_routes: string[];
  removed_routes: string[];
}

export function mergeGraph(existing: NavGraph, raw: RawNavTopology, projectRoot: string): MergeResult {
  const fresh = buildGraph(raw, projectRoot);

  const existingScreenMap = new Map<string, NavScreen>();
  for (const nav of existing.navigators) {
    for (const screen of nav.screens) {
      existingScreenMap.set(`${nav.id}::${screen.name}`, screen);
    }
  }

  for (const nav of fresh.navigators) {
    for (const screen of nav.screens) {
      const key = `${nav.id}::${screen.name}`;
      const prev = existingScreenMap.get(key);
      if (prev) {
        screen.reliability_score = screen.is_active
          ? Math.min(prev.reliability_score + 5, 100)
          : Math.max(prev.reliability_score, screen.reliability_score);
        screen.visit_count = prev.visit_count + (screen.is_active ? 1 : 0);
        screen.last_seen = screen.is_active ? new Date().toISOString() : prev.last_seen;
      }
    }
  }

  const freshScreenNames = new Set(fresh.all_screens);
  const existingScreenNames = new Set(existing.all_screens);
  const newRoutes = fresh.all_screens.filter(s => !existingScreenNames.has(s));
  const removedRoutes = existing.all_screens.filter(s => !freshScreenNames.has(s));

  fresh.meta.created_at = existing.meta.created_at;
  fresh.meta.scan_count = existing.meta.scan_count + 1;

  return { graph: fresh, new_routes: newRoutes, removed_routes: removedRoutes };
}
