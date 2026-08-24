import { normalizeSteps, replayFlow, ReplayDispatchError, } from '../domain/cdp-flow-replay.js';
// __RN_AGENT.getTree() wraps the node tree under a top-level `.tree` key —
// `{ tree: <node> | { matches: [...] }, totalNodes, rootsSeeded }` — and the
// interactive digest under `.interactive`. collectTestIds descends through all
// of those container shapes so it works on the real handler payload, not only
// on a bare node. (Boundary bug fix: treeFor used to hand the wrapper straight
// to isExactPresent, which then saw zero testIDs and the fallback never fired.)
export function collectTestIds(node, acc = new Set()) {
    if (!node || typeof node !== 'object')
        return acc;
    const n = node;
    if (typeof n.testID === 'string')
        acc.add(n.testID);
    if (typeof n.nativeID === 'string')
        acc.add(n.nativeID);
    if (n.tree)
        collectTestIds(n.tree, acc);
    const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
    if (Array.isArray(kids))
        for (const c of kids)
            collectTestIds(c, acc);
    return acc;
}
export function isExactPresent(treeJson, selector) {
    return collectTestIds(treeJson).has(selector);
}
// Unwrap getTree's `{ tree: <node>|{matches} }` envelope to the node(s) the
// dispatch helpers walk. Returns the bare node for a single match, the
// `{ matches: [...] }` wrapper for multiple, or the input unchanged when it is
// already a node. Used at the treeFor boundary (index.ts).
export function unwrapTree(data) {
    if (!data || typeof data !== 'object')
        return null;
    const d = data;
    return 'tree' in d ? d.tree : d;
}
function countExactMatches(treeJson, id) {
    let matches = 0;
    const root = treeJson && typeof treeJson === 'object' && 'tree' in treeJson
        ? treeJson.tree
        : treeJson;
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object')
            continue;
        const record = node;
        if (record.testID === id || record.nativeID === id)
            matches++;
        const children = record.children ?? record.nodes ?? record.matches;
        if (Array.isArray(children))
            stack.push(...children);
    }
    return matches;
}
function nodeProps(treeJson, id) {
    // find the node whose testID === id or nativeID === id and return its props bag if exposed
    const stack = [treeJson];
    while (stack.length) {
        const n = stack.pop();
        if (n && typeof n === 'object') {
            if (n.testID === id || n.nativeID === id)
                return n.props ?? n;
            if (n.tree)
                stack.push(n.tree);
            const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
            if (Array.isArray(kids))
                stack.push(...kids);
        }
    }
    return null;
}
function isDisabled(props) {
    if (!props)
        return false;
    const a11y = props.accessibilityState;
    return props.disabled === true || a11y?.disabled === true || props.pointerEvents === 'none';
}
export async function runCdpReplayCommands(commands, params, deps, opts = {}) {
    return replayFlow(normalizeSteps(commands, params), buildCdpDispatch(deps), {
        signal: opts.signal,
    });
}
export function buildCdpDispatch(deps) {
    return {
        async press(id) {
            const tree = await deps.treeFor(id);
            const treeMatches = countExactMatches(tree, id);
            if (treeMatches === 0)
                throw new ReplayDispatchError('TESTID_NOT_FOUND', `testID "${id}" not present`);
            const frontmost = await deps.frontmostFor?.(id);
            const matches = frontmost ? (frontmost.matchCount ?? 1) : treeMatches;
            if (matches > 1)
                throw new ReplayDispatchError('AMBIGUOUS_TESTID', `testID "${id}" resolves to ${matches} mounted elements`, { matchCount: matches });
            if (frontmost && !frontmost.visible)
                throw new ReplayDispatchError('ASSERTION_FAILED', frontmost.reason ?? `testID "${id}" is mounted but not frontmost`);
            if (isDisabled(nodeProps(tree, id)))
                throw new ReplayDispatchError('INTERACTION_NOT_ACTUATED', `testID "${id}" is disabled/non-interactable`);
            await deps.pressByTestId(id);
        },
        async type(id, text) {
            await deps.typeByTestId(id, text);
        },
        async visibility(id) {
            const tree = await deps.treeFor(id);
            const treeMatches = countExactMatches(tree, id);
            if (treeMatches === 0)
                return {
                    visible: false,
                    code: 'TESTID_NOT_FOUND',
                    reason: `testID "${id}" not present in the React tree`,
                };
            const frontmost = await deps.frontmostFor?.(id);
            const matches = frontmost ? (frontmost.matchCount ?? 1) : treeMatches;
            if (matches > 1)
                return {
                    visible: false,
                    code: 'AMBIGUOUS_TESTID',
                    reason: `testID "${id}" resolves to ${matches} mounted elements`,
                };
            if (frontmost && !frontmost.visible)
                return {
                    visible: false,
                    code: 'ASSERTION_FAILED',
                    reason: frontmost.reason ?? `testID "${id}" is mounted but not frontmost`,
                };
            return { visible: true };
        },
        async launch(stopApp) {
            await deps.launchApp(stopApp);
        },
        async settle() {
            await deps.settle();
        },
    };
}
