import { parse as yamlParse } from 'yaml';
import {
  normalizeSteps,
  replayFlow,
  firstTestId,
  type ReplayResult,
} from '../domain/cdp-flow-replay.js';
import type { ReplayDispatch } from '../domain/cdp-flow-replay.js';

export function firstReplayTestId(bodyYaml: string, params: Record<string, string>): string | null {
  try {
    const parsed = yamlParse(bodyYaml) as unknown[];
    if (!Array.isArray(parsed)) return null;
    return firstTestId(normalizeSteps(parsed, params));
  } catch {
    return null;
  }
}

// __RN_AGENT.getTree() wraps the node tree under a top-level `.tree` key —
// `{ tree: <node> | { matches: [...] }, totalNodes, rootsSeeded }` — and the
// interactive digest under `.interactive`. collectTestIds descends through all
// of those container shapes so it works on the real handler payload, not only
// on a bare node. (Boundary bug fix: treeFor used to hand the wrapper straight
// to isExactPresent, which then saw zero testIDs and the fallback never fired.)
export function collectTestIds(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== 'object') return acc;
  const n = node as Record<string, unknown>;
  if (typeof n.testID === 'string') acc.add(n.testID);
  if (typeof n.nativeID === 'string') acc.add(n.nativeID);
  if (n.tree) collectTestIds(n.tree, acc);
  const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
  if (Array.isArray(kids)) for (const c of kids) collectTestIds(c, acc);
  return acc;
}

export function isExactPresent(treeJson: unknown, selector: string): boolean {
  return collectTestIds(treeJson).has(selector);
}

// Unwrap getTree's `{ tree: <node>|{matches} }` envelope to the node(s) the
// dispatch helpers walk. Returns the bare node for a single match, the
// `{ matches: [...] }` wrapper for multiple, or the input unchanged when it is
// already a node. Used at the treeFor boundary (index.ts).
export function unwrapTree(data: unknown): unknown {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return 'tree' in d ? d.tree : d;
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
  // find the node whose testID === id or nativeID === id and return its props bag if exposed
  const stack: unknown[] = [treeJson];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | null;
    if (n && typeof n === 'object') {
      if (n.testID === id || n.nativeID === id) return (n.props as Record<string, unknown>) ?? n;
      if (n.tree) stack.push(n.tree);
      const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
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

export async function runCdpReplay(
  bodyYaml: string,
  params: Record<string, string>,
  deps: CdpReplayDeps,
): Promise<ReplayResult> {
  const parsed = yamlParse(bodyYaml) as unknown[];
  const steps = normalizeSteps(parsed, params);
  return replayFlow(steps, buildCdpDispatch(deps));
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
