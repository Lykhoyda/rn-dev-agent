export function collectTestIds(node, acc = new Set()) {
    if (!node || typeof node !== 'object')
        return acc;
    const n = node;
    if (typeof n.testID === 'string')
        acc.add(n.testID);
    if (typeof n.nativeID === 'string')
        acc.add(n.nativeID);
    const kids = n.children ?? n.interactive ?? n.nodes;
    if (Array.isArray(kids))
        for (const c of kids)
            collectTestIds(c, acc);
    return acc;
}
export function isExactPresent(treeJson, selector) {
    return collectTestIds(treeJson).has(selector);
}
function nodeProps(treeJson, id) {
    // find the node whose testID === id and return its props bag if exposed
    const stack = [treeJson];
    while (stack.length) {
        const n = stack.pop();
        if (n && typeof n === 'object') {
            if (n.testID === id)
                return n.props ?? n;
            const kids = n.children ?? n.interactive ?? n.nodes;
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
export function buildCdpDispatch(deps) {
    return {
        async press(id) {
            const tree = await deps.treeFor(id);
            if (!isExactPresent(tree, id))
                throw new Error(`testID "${id}" not present`);
            if (isDisabled(nodeProps(tree, id)))
                throw new Error(`testID "${id}" is disabled/non-interactable`);
            await deps.pressByTestId(id);
        },
        async type(id, text) {
            await deps.typeByTestId(id, text);
        },
        async isVisible(id) {
            return isExactPresent(await deps.treeFor(id), id);
        },
        async launch(stopApp) {
            await deps.launchApp(stopApp);
        },
        async settle() {
            await deps.settle();
        },
    };
}
