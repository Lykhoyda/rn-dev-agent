import {
  normalizeSteps,
  replayFlow,
  ReplayDispatchError,
  type ReplayResult,
} from '../domain/cdp-flow-replay.js';
import type { ReplayDispatch } from '../domain/cdp-flow-replay.js';

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
  frontmostFor?(id: string): Promise<{
    visible: boolean;
    reason?: string;
    matchCount?: number;
    code?: string;
  }>;
  launchApp(stopApp: boolean): Promise<void>;
  settle(timeoutMs: number): Promise<void>;
}

function countExactMatches(treeJson: unknown, id: string): number {
  let matches = 0;
  const root =
    treeJson && typeof treeJson === 'object' && 'tree' in treeJson
      ? (treeJson as Record<string, unknown>).tree
      : treeJson;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    if (record.testID === id || record.nativeID === id) matches++;
    const children = record.children ?? record.nodes ?? record.matches;
    if (Array.isArray(children)) stack.push(...children);
  }
  return matches;
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

export async function runCdpReplayCommands(
  commands: unknown[],
  params: Record<string, string>,
  deps: CdpReplayDeps,
  opts: { signal?: AbortSignal; initialFocusId?: string } = {},
): Promise<ReplayResult> {
  return replayFlow(normalizeSteps(commands, params), buildCdpDispatch(deps), {
    signal: opts.signal,
    initialFocusId: opts.initialFocusId,
  });
}

export function buildCdpDispatch(deps: CdpReplayDeps): ReplayDispatch {
  const assertExactInteractable = async (id: string): Promise<void> => {
    const tree = await deps.treeFor(id);
    const treeMatches = countExactMatches(tree, id);
    if (treeMatches === 0)
      throw new ReplayDispatchError('TESTID_NOT_FOUND', `testID "${id}" not present`, {
        failedSelector: id,
      });
    const frontmost = await deps.frontmostFor?.(id);
    const matches = frontmost ? (frontmost.matchCount ?? 1) : treeMatches;
    if (matches > 1)
      throw new ReplayDispatchError(
        'AMBIGUOUS_TESTID',
        `testID "${id}" resolves to ${matches} mounted elements`,
        { matchCount: matches },
      );
    if (frontmost && !frontmost.visible)
      throw new ReplayDispatchError(
        frontmost.code ?? 'ASSERTION_FAILED',
        frontmost.reason ?? `testID "${id}" is mounted but not frontmost`,
      );
    if (isDisabled(nodeProps(tree, id)))
      throw new ReplayDispatchError(
        'INTERACTION_NOT_ACTUATED',
        `testID "${id}" is disabled/non-interactable`,
      );
  };

  return {
    async press(id) {
      await assertExactInteractable(id);
      await deps.pressByTestId(id);
    },
    async type(id, text) {
      await assertExactInteractable(id);
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
          meta: { failedSelector: id },
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
          ...(frontmost.code ? { code: frontmost.code } : {}),
          reason: frontmost.reason ?? `testID "${id}" is mounted but not frontmost`,
        };
      return { visible: true };
    },
    async launch(stopApp) {
      await deps.launchApp(stopApp);
    },
    async settle(timeoutMs) {
      await deps.settle(timeoutMs);
    },
  };
}
