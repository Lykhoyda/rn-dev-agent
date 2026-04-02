import { isMethodCooledDown } from './storage.js';
export function findRouteInGraph(graph, routeName) {
    const candidates = [];
    for (const nav of graph.navigators) {
        const screen = nav.screens.find(s => s.name === routeName);
        if (screen)
            candidates.push({ nav, screen });
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => b.screen.reliability_score - a.screen.reliability_score);
    const best = candidates[0];
    const path = buildNavigatorPath(graph, best.nav.id);
    path.push(routeName);
    return {
        navigator_id: best.nav.id,
        navigator_kind: best.nav.kind,
        screen: best.screen,
        path,
    };
}
function buildNavigatorPath(graph, navigatorId) {
    const path = [];
    let currentId = navigatorId;
    const visited = new Set();
    while (currentId) {
        if (visited.has(currentId))
            break;
        visited.add(currentId);
        const nav = graph.navigators.find(n => n.id === currentId);
        if (!nav)
            break;
        if (nav.parent_screen) {
            path.unshift(nav.parent_screen);
            const parentNav = graph.navigators.find(n => n.screens.some(s => s.name === nav.parent_screen));
            currentId = parentNav?.id;
        }
        else {
            break;
        }
    }
    return path;
}
export function listAllRoutes(graph) {
    const results = [];
    for (const nav of graph.navigators) {
        for (const screen of nav.screens) {
            results.push({
                navigator_id: nav.id,
                navigator_kind: nav.kind,
                route: screen,
            });
        }
    }
    return results;
}
export function getNavigatorSubtree(graph, rootId) {
    const result = [];
    const root = graph.navigators.find(n => n.id === rootId);
    if (!root)
        return result;
    const seen = new Set([root.id]);
    result.push(root);
    const queue = root.screens.map(s => s.name);
    while (queue.length > 0) {
        const screenName = queue.shift();
        const childNavs = graph.navigators.filter(n => n.parent_screen === screenName);
        for (const child of childNavs) {
            if (seen.has(child.id))
                continue;
            seen.add(child.id);
            result.push(child);
            queue.push(...child.screens.map(s => s.name));
        }
    }
    return result;
}
// --- Phase B: Navigation Planning ---
const AUTH_SCREEN_PATTERNS = /\b(login|signin|sign.?in|welcome|register|signup|sign.?up|auth|landing|onboarding)\b/i;
function findNavigatorForScreen(graph, screenName) {
    return graph.navigators.find(n => n.screens.some(s => s.name === screenName)) ?? null;
}
function getActiveScreenChain(graph) {
    const chain = [];
    let nav = graph.navigators.find(n => !n.parent_screen);
    if (!nav)
        return chain;
    const visited = new Set();
    while (nav && !visited.has(nav.id)) {
        visited.add(nav.id);
        if (nav.active_screen) {
            chain.push(nav.active_screen);
            nav = graph.navigators.find(n => n.parent_screen === nav.active_screen);
        }
        else {
            break;
        }
    }
    return chain;
}
function actionForKind(kind) {
    switch (kind) {
        case 'tab': return 'switch_tab';
        case 'drawer': return 'open_drawer';
        case 'stack':
        case 'native-stack': return 'navigate';
        default: return 'navigate';
    }
}
function computeStepReliability(screen, kind) {
    const base = screen.reliability_score;
    if (kind === 'tab')
        return Math.min(base + 10, 100);
    if (kind === 'stack' || kind === 'native-stack')
        return base;
    return Math.max(base - 5, 0);
}
function detectPrerequisites(graph, targetScreen) {
    const prereqs = [];
    const location = findRouteInGraph(graph, targetScreen);
    if (!location)
        return prereqs;
    for (const screenInPath of location.path) {
        if (AUTH_SCREEN_PATTERNS.test(screenInPath)) {
            prereqs.push({
                type: 'auth',
                description: `Path passes through auth screen "${screenInPath}" — login may be required`,
                check_tool: 'cdp_navigation_state',
            });
            break;
        }
    }
    const screen = location.screen;
    if (screen.params_template && screen.params_template.includes('permission')) {
        prereqs.push({
            type: 'permission',
            description: `Screen "${targetScreen}" may require permissions (params: ${screen.params_template})`,
            check_tool: 'device_permission',
            check_args: { action: 'query' },
        });
    }
    return prereqs;
}
export function buildNavigationPlan(graph, targetScreen, fromScreen) {
    const targetLocation = findRouteInGraph(graph, targetScreen);
    if (!targetLocation)
        return null;
    const activeChain = getActiveScreenChain(graph);
    const currentScreen = fromScreen ?? activeChain[activeChain.length - 1] ?? null;
    const targetDeepLink = targetLocation.screen.path;
    if (currentScreen === targetScreen) {
        return {
            from: currentScreen,
            to: targetScreen,
            steps: [],
            total_steps: 0,
            estimated_reliability: 100,
            prerequisites: [],
            preferred_method: 'programmatic',
            deep_link_available: !!targetDeepLink,
            deep_link_path: targetDeepLink,
        };
    }
    const targetNav = findNavigatorForScreen(graph, targetScreen);
    if (!targetNav)
        return null;
    const steps = [];
    const targetPath = targetLocation.path;
    const currentLocation = currentScreen ? findRouteInGraph(graph, currentScreen) : null;
    const currentPath = currentLocation?.path ?? [];
    let commonPrefixLen = 0;
    for (let i = 0; i < Math.min(currentPath.length, targetPath.length); i++) {
        if (currentPath[i] === targetPath[i])
            commonPrefixLen = i + 1;
        else
            break;
    }
    const screensToNavigate = targetPath.slice(commonPrefixLen);
    for (const screenName of screensToNavigate) {
        const nav = findNavigatorForScreen(graph, screenName);
        if (!nav)
            continue;
        const screen = nav.screens.find(s => s.name === screenName);
        if (!screen)
            continue;
        steps.push({
            action: actionForKind(nav.kind),
            target_screen: screenName,
            navigator_id: nav.id,
            navigator_kind: nav.kind,
            method: 'programmatic',
            note: screen.params_template
                ? `Navigate to "${screenName}" (requires params: ${screen.params_template})`
                : nav.kind === 'tab'
                    ? `Switch to "${screenName}" tab`
                    : nav.kind === 'drawer'
                        ? `Open drawer, select "${screenName}"`
                        : `Navigate to "${screenName}"`,
        });
    }
    if (steps.length === 0 || screensToNavigate[screensToNavigate.length - 1] !== targetScreen) {
        steps.push({
            action: actionForKind(targetNav.kind),
            target_screen: targetScreen,
            navigator_id: targetNav.id,
            navigator_kind: targetNav.kind,
            method: 'programmatic',
            note: `Navigate to "${targetScreen}"`,
        });
    }
    const deepLinkAvailable = !!targetDeepLink;
    if (deepLinkAvailable && steps.length > 1) {
        steps.unshift({
            action: 'deep_link',
            target_screen: targetScreen,
            navigator_id: targetNav.id,
            navigator_kind: targetNav.kind,
            method: 'deep_link',
            deep_link_path: targetLocation.screen.path,
            note: `Alternative: deep link to "${targetLocation.screen.path}" (may trigger Dev Client picker)`,
        });
    }
    for (const step of steps) {
        if (isMethodCooledDown(step.target_screen, step.method)) {
            step.note = `[COOLED DOWN] ${step.note ?? ''} — method failed 2+ times recently, consider alternative`;
        }
    }
    let reliability = 100;
    const programmaticSteps = steps.filter(s => s.method === 'programmatic');
    for (const step of programmaticSteps) {
        const nav = graph.navigators.find(n => n.id === step.navigator_id);
        const screen = nav?.screens.find(s => s.name === step.target_screen);
        if (screen && nav) {
            reliability = Math.min(reliability, computeStepReliability(screen, nav.kind));
        }
    }
    const hasCooledProgrammatic = programmaticSteps.some(s => isMethodCooledDown(s.target_screen, s.method));
    const prerequisites = detectPrerequisites(graph, targetScreen);
    let preferredMethod = deepLinkAvailable && programmaticSteps.length >= 2
        ? 'deep_link'
        : 'programmatic';
    if (hasCooledProgrammatic) {
        if (deepLinkAvailable && !isMethodCooledDown(targetScreen, 'deep_link')) {
            preferredMethod = 'deep_link';
        }
        else if (!isMethodCooledDown(targetScreen, 'ui_interaction')) {
            preferredMethod = 'ui_interaction';
        }
    }
    return {
        from: currentScreen,
        to: targetScreen,
        steps,
        total_steps: programmaticSteps.length,
        estimated_reliability: reliability,
        prerequisites,
        preferred_method: preferredMethod,
        deep_link_available: deepLinkAvailable,
        deep_link_path: targetDeepLink,
    };
}
