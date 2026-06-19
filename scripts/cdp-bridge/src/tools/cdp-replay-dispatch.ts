import type { ReplayDispatch } from '../domain/cdp-flow-replay.js';

export function collectTestIds(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return acc;
  const n = node as Record<string, unknown>;
  if (typeof n.testID === 'string') acc.add(n.testID);
  if (typeof n.nativeID === 'string') acc.add(n.nativeID);
  const kids = n.children ?? n.interactive ?? n.nodes;
  if (Array.isArray(kids)) for (const c of kids) collectTestIds(c, acc);
  return acc;
}

export function isExactPresent(treeJson: unknown, selector: string): boolean {
  return collectTestIds(treeJson).has(selector);
}

export interface CdpReplayDeps {
  pressByTestId(id: string): Promise<void>;
  typeByTestId(id: string, text: string): Promise<void>;
  // returns the parsed getTree JSON filtered to `id`, or null on failure
  treeFor(id: string): Promise<unknown | null>;
  launchApp(stopApp: boolean): Promise<void>;
  settle(): Promise<void>;
}

function nodeProps(treeJson: unknown, id: string): Record<string, unknown> | null {
  // find the node whose testID === id and return its props bag if exposed
  const stack: unknown[] = [treeJson];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | null;
    if (n && typeof n === 'object') {
      if (n.testID === id) return (n.props as Record<string, unknown>) ?? n;
      const kids = n.children ?? n.interactive ?? n.nodes;
      if (Array.isArray(kids)) stack.push(...kids);
    }
  }
  return null;
}

function isDisabled(props: Record<string, unknown> | null): boolean {
  if (!props) return false;
  const a11y = props.accessibilityState as { disabled?: boolean } | undefined;
  return props.disabled === true || a11y?.disabled === true || props.pointerEvents === 'none';
}

export function buildCdpDispatch(deps: CdpReplayDeps): ReplayDispatch {
  return {
    async press(id) {
      const tree = await deps.treeFor(id);
      if (!isExactPresent(tree, id)) throw new Error(`testID "${id}" not present`);
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
