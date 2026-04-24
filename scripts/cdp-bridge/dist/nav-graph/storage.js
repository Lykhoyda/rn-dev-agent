import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
const GRAPH_FILENAME = '.rn-nav-graph.yaml';
function isRnProject(dir) {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath))
        return false;
    try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        return !!(deps['react-native'] || deps['expo']);
    }
    catch {
        return false;
    }
}
// B134: scan one directory for an RN project, recursing up to maxDepth into
// subdirectories. Used as the last resort when the standard cwd + walk-up cascade
// fails — handles the plugin-repo ↔ sibling-workspace/test-app layout where cwd
// is the plugin repo but the RN project lives as a sibling's child (common when
// Claude Code is launched from a plugin directory without --plugin-dir override).
//
// Traversal is **breadth-first with sorted entries**:
// - All direct children at each level are checked before any recursion, so a
//   direct-sibling RN project always wins over a grandchild RN project of
//   another sibling (per review finding — prevents "aaa-unrelated/demo-rn/"
//   beating "zzz-real-rn/" when both exist as siblings).
// - `entries.sort()` makes the pick deterministic across filesystems whose
//   readdirSync ordering differs (APFS sorts, ext4 doesn't). When multiple RN
//   projects exist, alphabetical order is a stable default.
function scanForRnProject(rootDir, maxDepth) {
    if (maxDepth < 0)
        return null;
    let entries;
    try {
        entries = readdirSync(rootDir);
    }
    catch {
        return null;
    }
    entries.sort();
    // Pass 1 at this level: check all direct children for an RN project.
    const subdirs = [];
    for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules')
            continue;
        const full = join(rootDir, name);
        try {
            const stat = lstatSync(full);
            if (!(stat.isDirectory() || stat.isSymbolicLink()))
                continue;
        }
        catch {
            continue;
        }
        if (isRnProject(full))
            return full;
        subdirs.push(full);
    }
    // Pass 2 at this level: recurse into non-matching subdirs (breadth-first).
    if (maxDepth > 0) {
        for (const dir of subdirs) {
            const deeper = scanForRnProject(dir, maxDepth - 1);
            if (deeper)
                return deeper;
        }
    }
    return null;
}
// B144: collect ALL RN projects reachable from rootDir up to maxDepth. Same
// breadth-first traversal as scanForRnProject but does not short-circuit —
// used by the bundleId-aware path in findProjectRoot which needs every
// candidate to pick the matching one.
function collectRnProjects(rootDir, maxDepth, out) {
    if (maxDepth < 0)
        return;
    let entries;
    try {
        entries = readdirSync(rootDir);
    }
    catch {
        return;
    }
    entries.sort();
    const subdirs = [];
    for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules')
            continue;
        const full = join(rootDir, name);
        try {
            const stat = lstatSync(full);
            if (!(stat.isDirectory() || stat.isSymbolicLink()))
                continue;
        }
        catch {
            continue;
        }
        if (isRnProject(full)) {
            out.push(full);
        }
        else {
            subdirs.push(full);
        }
    }
    if (maxDepth > 0) {
        for (const dir of subdirs)
            collectRnProjects(dir, maxDepth - 1, out);
    }
}
// B144: extract the declared bundleId from a project's app.json. Covers the
// two common Expo/RN shapes: expo.ios.bundleIdentifier (iOS) and
// expo.android.package (Android). Returns the iOS bundleIdentifier when both
// are present (matches the platform Metro typically reports as the Hermes
// target's description). Bare RN apps with native Xcode configs aren't
// covered — parsing pbxproj is fragile and those apps won't gain
// bundleId-matching. They gracefully fall back to the current alphabetical
// sibling pick.
export function readProjectBundleId(projectRoot) {
    const appJsonPath = join(projectRoot, 'app.json');
    if (!existsSync(appJsonPath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(appJsonPath, 'utf-8'));
        const iosId = raw.expo?.ios?.bundleIdentifier ?? raw.ios?.bundleIdentifier;
        const androidId = raw.expo?.android?.package ?? raw.android?.package;
        if (typeof iosId === 'string' && iosId.length > 0)
            return iosId;
        if (typeof androidId === 'string' && androidId.length > 0)
            return androidId;
        return null;
    }
    catch {
        return null;
    }
}
export function findProjectRoot(opts = {}) {
    const targetBundleId = opts.bundleId;
    // B144 Codex #1 (conf ≥80): RN_PROJECT_ROOT is user-explicit config and
    // MUST be absolute priority. Return immediately when it points at an RN
    // project, regardless of bundleId. Bundle disambiguation only applies
    // to heuristic sources (CLAUDE_USER_CWD, cwd, sibling scans). If env and
    // the requested bundleId conflict, the user-explicit env wins — if the
    // user wants a different app, they should update env or unset it.
    const envRoot = process.env.RN_PROJECT_ROOT;
    if (envRoot && isRnProject(envRoot))
        return envRoot;
    // Cascade 1: non-env starts + walk-up. If bundleId is provided and any
    // cascade hit matches it, return immediately. Otherwise remember the
    // first hit as a fallback for when no sibling matches either.
    let walkupHit = null;
    const starts = [
        process.env.CLAUDE_USER_CWD,
        process.cwd(),
    ].filter(Boolean);
    for (const start of starts) {
        if (isRnProject(start)) {
            if (targetBundleId && readProjectBundleId(start) === targetBundleId)
                return start;
            walkupHit = walkupHit ?? start;
            continue;
        }
        let dir = start;
        for (let i = 0; i < 10; i++) {
            if (isRnProject(dir)) {
                if (targetBundleId && readProjectBundleId(dir) === targetBundleId)
                    return dir;
                walkupHit = walkupHit ?? dir;
                break;
            }
            const parent = join(dir, '..');
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    if (!targetBundleId && walkupHit)
        return walkupHit;
    // Cascade 2: scan cwd subdirs and sibling + grandchildren. If bundleId
    // is provided, collect all candidates and prefer the match. Otherwise
    // stop at the first hit (legacy behavior).
    const cwd = process.cwd();
    const parentOfCwd = join(cwd, '..');
    if (targetBundleId) {
        const all = [];
        collectRnProjects(cwd, 0, all);
        if (parentOfCwd !== cwd)
            collectRnProjects(parentOfCwd, 1, all);
        for (const candidate of all) {
            if (readProjectBundleId(candidate) === targetBundleId)
                return candidate;
        }
        // No match — fall back to first candidate from cascade 1 or 2.
        if (walkupHit)
            return walkupHit;
        return all[0] ?? null;
    }
    // Legacy path (no bundleId): preserve current behavior exactly.
    const cwdScan = scanForRnProject(cwd, 0);
    if (cwdScan)
        return cwdScan;
    if (parentOfCwd !== cwd) {
        const siblingScan = scanForRnProject(parentOfCwd, 1);
        if (siblingScan)
            return siblingScan;
    }
    return null;
}
function getProjectSlug(projectRoot) {
    try {
        const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
        if (pkg.name && typeof pkg.name === 'string')
            return pkg.name;
    }
    catch { /* fall through */ }
    return projectRoot.split('/').pop() ?? 'unknown';
}
export function getGraphPath(projectRoot) {
    return join(projectRoot, GRAPH_FILENAME);
}
export function readGraph(projectRoot) {
    try {
        const filePath = getGraphPath(projectRoot);
        if (!existsSync(filePath))
            return null;
        const raw = yamlParse(readFileSync(filePath, 'utf-8'));
        if (!raw || !raw.nav_graph)
            return null;
        hydrateStrikesFromGraph(raw.nav_graph);
        return raw.nav_graph;
    }
    catch {
        return null;
    }
}
export function writeGraph(projectRoot, graph) {
    const filePath = getGraphPath(projectRoot);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const yaml = yamlStringify({ nav_graph: graph }, { lineWidth: 120 });
    writeFileSync(tmpPath, yaml, 'utf-8');
    renameSync(tmpPath, filePath);
    return filePath;
}
function buildScreen(raw, isActive) {
    const screen = {
        name: raw.name,
        is_active: isActive,
        reliability_score: raw.is_visited ? 100 : 50,
        visit_count: raw.is_visited ? 1 : 0,
    };
    if (raw.path)
        screen.path = raw.path;
    if (raw.params_schema && raw.params_schema.length > 0) {
        screen.params_template = `{ ${raw.params_schema.join(', ')} }`;
    }
    if (raw.is_initial)
        screen.initial = true;
    if (raw.is_modal)
        screen.is_modal = true;
    if (raw.is_visited)
        screen.last_seen = new Date().toISOString();
    return screen;
}
function buildNavigator(raw, activeScreenName) {
    const screens = raw.routes.map(r => buildScreen(r, r.name === activeScreenName));
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
function collectAllScreens(navigators) {
    const set = new Set();
    for (const nav of navigators) {
        for (const screen of nav.screens) {
            set.add(screen.name);
        }
    }
    return [...set].sort();
}
function computeCoverage(navigators) {
    let visited = 0;
    let total = 0;
    for (const nav of navigators) {
        for (const screen of nav.screens) {
            total++;
            if (screen.visit_count > 0)
                visited++;
        }
    }
    return total === 0 ? 0 : Math.round((visited / total) * 100);
}
export function buildGraph(raw, projectRoot, commitHash) {
    const navigators = [];
    for (const rawNav of raw.navigators) {
        navigators.push(buildNavigator(rawNav, rawNav.active_route_name ?? null));
    }
    const allScreens = collectAllScreens(navigators);
    const now = new Date().toISOString();
    const meta = {
        schema_version: 1,
        project_slug: getProjectSlug(projectRoot),
        nav_library: raw.library,
        rn_version: raw.rn_version,
        expo_sdk: raw.expo_sdk,
        created_at: now,
        last_scanned_at: now,
        scanned_at_commit: commitHash,
        scan_count: 1,
        containers_found: raw.containers_found,
        coverage: computeCoverage(navigators),
    };
    return { meta, navigators, all_screens: allScreens };
}
export function mergeGraph(existing, raw, projectRoot) {
    const fresh = buildGraph(raw, projectRoot);
    const existingScreenMap = new Map();
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
                if (prev.action_records)
                    screen.action_records = prev.action_records;
                if (prev.avg_load_ms)
                    screen.avg_load_ms = prev.avg_load_ms;
            }
        }
    }
    const freshScreenNames = new Set(fresh.all_screens);
    const existingScreenNames = new Set(existing.all_screens);
    const newRoutes = fresh.all_screens.filter(s => !existingScreenNames.has(s));
    const removedRoutes = existing.all_screens.filter(s => !freshScreenNames.has(s));
    fresh.meta.created_at = existing.meta.created_at;
    fresh.meta.scan_count = existing.meta.scan_count + 1;
    if (!fresh.meta.scanned_at_commit && existing.meta.scanned_at_commit) {
        fresh.meta.scanned_at_commit = existing.meta.scanned_at_commit;
    }
    return { graph: fresh, new_routes: newRoutes, removed_routes: removedRoutes };
}
// --- Phase C: Runtime Learning ---
const MAX_ACTION_RECORDS = 20;
const STRIKE_COOLDOWN_MS = 5 * 60 * 1000;
const STRIKE_THRESHOLD = 2;
const RELIABILITY_SUCCESS_DELTA = 5;
const RELIABILITY_FAILURE_DELTA = -15;
const strikeMap = new Map();
let strikesHydrated = false;
function strikeKey(screen, method) {
    return `${screen}::${method}`;
}
export function hydrateStrikesFromGraph(graph) {
    if (strikesHydrated)
        return;
    strikesHydrated = true;
    for (const nav of graph.navigators) {
        for (const screen of nav.screens) {
            if (!screen.action_records || screen.action_records.length === 0)
                continue;
            const byMethod = new Map();
            for (const rec of screen.action_records) {
                const arr = byMethod.get(rec.method) ?? [];
                arr.push(rec);
                byMethod.set(rec.method, arr);
            }
            for (const [method, records] of byMethod) {
                const sorted = records.sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
                let consecutive = 0;
                for (const rec of sorted) {
                    if (!rec.success)
                        consecutive++;
                    else
                        break;
                }
                if (consecutive >= STRIKE_THRESHOLD) {
                    const lastFailure = sorted[0].recorded_at;
                    const coolUntil = new Date(new Date(lastFailure).getTime() + STRIKE_COOLDOWN_MS).toISOString();
                    strikeMap.set(strikeKey(screen.name, method), {
                        screen: screen.name,
                        method,
                        consecutive_failures: consecutive,
                        last_failure_at: lastFailure,
                        cooled_until: coolUntil,
                    });
                }
            }
        }
    }
}
export function isMethodCooledDown(screen, method) {
    const entry = strikeMap.get(strikeKey(screen, method));
    if (!entry || !entry.cooled_until)
        return false;
    return Date.now() < new Date(entry.cooled_until).getTime();
}
export function getStrikeStatus(screen, method) {
    return strikeMap.get(strikeKey(screen, method)) ?? null;
}
function updateStrike(screen, method, success) {
    const key = strikeKey(screen, method);
    const existing = strikeMap.get(key);
    if (success) {
        strikeMap.delete(key);
        return { screen, method, consecutive_failures: 0, last_failure_at: '' };
    }
    const now = new Date().toISOString();
    if (existing) {
        if (existing.cooled_until && Date.now() >= new Date(existing.cooled_until).getTime()) {
            existing.consecutive_failures = 0;
            existing.cooled_until = undefined;
        }
        existing.consecutive_failures++;
        existing.last_failure_at = now;
        if (existing.consecutive_failures >= STRIKE_THRESHOLD && !existing.cooled_until) {
            existing.cooled_until = new Date(Date.now() + STRIKE_COOLDOWN_MS).toISOString();
        }
        return existing;
    }
    const entry = {
        screen,
        method,
        consecutive_failures: 1,
        last_failure_at: now,
    };
    strikeMap.set(key, entry);
    return entry;
}
export function recordNavigation(projectRoot, input) {
    const graph = readGraph(projectRoot);
    if (!graph)
        return null;
    let targetScreen = null;
    for (const nav of graph.navigators) {
        const found = nav.screens.find(s => s.name === input.screen);
        if (found) {
            targetScreen = found;
            break;
        }
    }
    if (!targetScreen)
        return null;
    const now = new Date().toISOString();
    const record = {
        method: input.method,
        success: input.success,
        latency_ms: input.latency_ms ?? 0,
        recorded_at: now,
    };
    if (!targetScreen.action_records)
        targetScreen.action_records = [];
    targetScreen.action_records.push(record);
    if (targetScreen.action_records.length > MAX_ACTION_RECORDS) {
        targetScreen.action_records = targetScreen.action_records.slice(-MAX_ACTION_RECORDS);
    }
    if (input.success) {
        targetScreen.reliability_score = Math.min(targetScreen.reliability_score + RELIABILITY_SUCCESS_DELTA, 100);
        targetScreen.visit_count++;
        targetScreen.last_seen = now;
    }
    else {
        targetScreen.reliability_score = Math.max(targetScreen.reliability_score + RELIABILITY_FAILURE_DELTA, 0);
    }
    const successRecords = (targetScreen.action_records ?? []).filter(r => r.success && r.latency_ms > 0);
    targetScreen.avg_load_ms = successRecords.length > 0
        ? Math.round(successRecords.reduce((sum, r) => sum + r.latency_ms, 0) / successRecords.length)
        : undefined;
    const strike = updateStrike(input.screen, input.method, input.success);
    try {
        writeGraph(projectRoot, graph);
    }
    catch { /* best effort */ }
    return {
        screen: input.screen,
        method: input.method,
        success: input.success,
        new_reliability_score: targetScreen.reliability_score,
        new_visit_count: targetScreen.visit_count,
        strike_status: strike.consecutive_failures > 0
            ? {
                consecutive_failures: strike.consecutive_failures,
                cooled_down: !!strike.cooled_until && Date.now() < new Date(strike.cooled_until).getTime(),
                cooled_until: strike.cooled_until,
            }
            : undefined,
    };
}
