import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  runNative,
  getActiveSession,
  clearActiveSession,
  getCachedScreenRect,
  getAdbSerial,
  cacheSnapshot,
  getCachedSnapshot,
  isSnapshotCacheValid,
} from '../agent-device-wrapper.js';
import {
  isFastRunnerAvailable,
  fastSwipe,
  stopFastRunner,
  adoptPersistedFastRunnerState,
} from '../runners/rn-fast-runner-client.js';
import { stopAndroidRunner } from '../runners/rn-android-runner-client.js';
import {
  surfaceKeyboardGuard,
  healKeyboardOccludedTap,
  type KeyboardAutoHealDeps,
} from '../runners/keyboard-guard.js';
import { resolveBundleId } from '../project-config.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, createStepTimer } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak } from './runner-leak-recovery.js';
import type { RecoveryTier } from './runner-leak-recovery.js';
import { reopenSessionForRecovery } from './device-session.js';
import type { FlatNode } from '../fast-runner-ref-map.js';
import type { CDPClient } from '../cdp-client.js';
import { getCachedMetadata, isRefMapFresh, lookupRef, refCenter } from '../fast-runner-ref-map.js';
import {
  resolveJsTestId,
  attemptJsFill,
  settleRead,
  classifyFillVerification,
  decideNativeRetype,
  type FillVerifyOutcome,
} from './fill-verify.js';

const execFile = promisify(execFileCb);

export interface SnapshotNode {
  ref: string;
  label?: string;
  identifier?: string;
  type?: string;
  hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface FindCandidate {
  ref: string;
  label?: string;
  testID?: string;
  type?: string;
  hittable?: boolean;
  position?: { x: number; y: number };
}

function candidateFromNode(n: SnapshotNode): FindCandidate {
  return {
    ref: n.ref,
    label: n.label,
    testID: n.identifier,
    type: n.type,
    hittable: n.hittable,
    position: n.rect ? { x: n.rect.x, y: n.rect.y } : undefined,
  };
}

// GH #59 #4: when device_find returns AMBIGUOUS_MATCH, the agent has to
// pick a candidate by index. Without ranking, the order is arbitrary —
// in the reporter's iOS share-sheet case, "Copy" matched 5 candidates
// (ScrollView, Cell, Other, Other, StaticText) and the actual tap target
// was the Cell, which sat in position 1 by luck. We rank candidates so
// the most likely tap target sits at index 0.
//
// Ranking signals (highest weight first):
//   1. Element-type priority for tap intent: Button/Cell/Switch >
//      Other/Link > StaticText/Image > ScrollView. Containers like
//      ScrollView are usually parents of the real tap target.
//   2. hittable as the same-type tiebreak only (#519 review): since #395,
//      iOS hittable means "enabled AND center-on-screen" — NOT "directly
//      tappable". An inert on-screen StaticText is legitimately hittable,
//      so a type-dominating hittable bonus would steer taps to body text
//      over a real control half-scrolled off-screen.
//   3. Dedupe by visual rect — when two elements share the same bounds
//      (e.g. a Cell wrapping a StaticText), keep only the higher-scored
//      one. The user wants ONE candidate per unique screen position.
//
// Pure helper exported for unit testing.
const TYPE_PRIORITY_FOR_TAP: Record<string, number> = {
  Button: 100,
  Cell: 95,
  Switch: 90,
  Link: 80,
  Other: 60,
  StaticText: 30,
  Image: 25,
  ScrollView: 10,
};

function typePriority(type: string | undefined): number {
  if (!type) return 50;
  return TYPE_PRIORITY_FOR_TAP[type] ?? 50;
}

function rectKey(rect: SnapshotNode['rect']): string | null {
  if (!rect) return null;
  return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

export function rankSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const withScore = nodes.map((node, originalIndex) => ({
    node,
    originalIndex,
    score: typePriority(node.type) * 10 + (node.hittable === true ? 1 : 0),
  }));

  withScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const seenRects = new Set<string>();
  const ranked: SnapshotNode[] = [];
  for (const s of withScore) {
    const key = rectKey(s.node.rect);
    if (key !== null) {
      if (seenRects.has(key)) continue;
      seenRects.add(key);
    }
    ranked.push(s.node);
  }
  return ranked;
}

function parseSnapshotEnvelope(result: ToolResult): SnapshotNode[] | null {
  if (result.isError) return null;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: SnapshotNode[] };
    };
    if (!envelope.ok || !envelope.data?.nodes) return null;
    return envelope.data.nodes;
  } catch {
    return null;
  }
}

export type SnapshotFetchResult =
  | { ok: true; nodes: SnapshotNode[]; recoveredTier?: RecoveryTier }
  | { ok: false; reason: 'fetch-failed' }
  | { ok: false; reason: 'empty-capture' }
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

export async function fetchSnapshotNodes(allowCache = false): Promise<SnapshotFetchResult> {
  // GH #321 (live-sim speedup): serve device_find from the snapshot we already
  // captured when it's still a faithful picture of the screen (clean + fresh),
  // skipping a redundant runner round-trip. isSnapshotCacheValid() is false the
  // moment any mutating verb runs, so we never target against a stale screen.
  if (allowCache) {
    const platform = getActiveSession()?.platform;
    if (platform && isSnapshotCacheValid(platform)) {
      const cached = getCachedSnapshot(platform);
      if (cached) return { ok: true, nodes: cached.nodes };
    }
  }

  const first = await runNative(['snapshot', '-i']);
  const initialNodes = parseSnapshotEnvelope(first);
  if (initialNodes === null) return { ok: false, reason: 'fetch-failed' };
  // GH #409: a zero-node capture cannot support any "element absent" verdict —
  // it is indistinguishable from a degraded walk. Interactive consumers fail
  // closed instead of concluding "nothing on screen".
  if (initialNodes.length === 0) return { ok: false, reason: 'empty-capture' };

  if (!isAgentDeviceRunnerSentinel(initialNodes)) {
    const platform = getActiveSession()?.platform;
    if (platform) cacheSnapshot(platform, initialNodes);
    return { ok: true, nodes: initialNodes };
  }

  const session = getActiveSession();
  const recovery = await recoverFromRunnerLeak(
    { platform: session?.platform, appId: session?.appId, sessionName: session?.name },
    {
      closeSession: async () => {
        clearActiveSession();
        stopFastRunner(session?.deviceId);
        await stopAndroidRunner(session?.deviceId);
        return okResult({ closed: true });
      },
      openSession: ({ appId, platform, attachOnly }) =>
        reopenSessionForRecovery(appId, platform, attachOnly),
      resnapshot: () => runNative(['snapshot', '-i']),
      parseNodes: parseSnapshotEnvelope,
    },
  );

  if (!recovery.recovered) {
    return { ok: false, reason: 'runner-leak-unrecovered', recoveryReason: recovery.reason };
  }

  const recoveredNodes = parseSnapshotEnvelope(recovery.result);
  if (recoveredNodes === null) return { ok: false, reason: 'fetch-failed' };
  if (recoveredNodes.length === 0) return { ok: false, reason: 'empty-capture' };

  const platform = getActiveSession()?.platform;
  if (platform) cacheSnapshot(platform, recoveredNodes);
  return { ok: true, nodes: recoveredNodes, recoveredTier: recovery.tier };
}

// GH #409: refusal for a zero-node capture — asserting NOT_FOUND on it would
// present a degraded capture as a legitimately empty screen.
function emptyCaptureFailResult(query?: string): ToolResult {
  return failResult(
    `Snapshot returned zero nodes — cannot distinguish an empty screen from a degraded capture` +
      (query !== undefined ? `; not asserting "${query}" is absent` : '') +
      `. Confirm the screen with device_screenshot or cdp_component_tree, then retry.`,
    { code: 'SNAPSHOT_DEGRADED', ...(query !== undefined ? { query } : {}) },
  );
}

export type FindCandidatesResult =
  | { ok: true; candidates: FindCandidate[]; recoveredTier?: RecoveryTier }
  | { ok: false; reason: 'fetch-failed' }
  | { ok: false; reason: 'empty-capture' }
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

export async function fetchFindCandidates(
  query: string,
  exact = false,
  allowCache = false,
): Promise<FindCandidatesResult> {
  const snap = await fetchSnapshotNodes(allowCache);
  if (!snap.ok) return snap;

  const needle = query.toLowerCase();
  const matched = snap.nodes.filter((n) => {
    const label = n.label ?? '';
    const id = n.identifier ?? '';
    if (exact) return label === query || id === query;
    return label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
  });
  // GH #59 #4: rank before slicing so the truncation never drops the
  // most-likely tap target. Without this, a query that matches 12
  // elements (10 ScrollViews + 2 Cells) could lose both Cells to the
  // 10-element cap.
  const ranked = rankSnapshotNodes(matched);
  const candidates = ranked.slice(0, 10).map(candidateFromNode);
  return { ok: true, candidates, recoveredTier: snap.recoveredTier };
}

function runnerLeakFailResult(query: string | undefined, recoveryReason?: string): ToolResult {
  const queryHint = query ? ` (while resolving "${query}")` : '';
  return failResult(
    `device_find/snapshot returned AgentDeviceRunner's own UI tree instead of the target app${queryHint} (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.`,
    {
      code: 'RUNNER_LEAK',
      recoveryReason,
      hint: 'Manually close + reopen the session with device_snapshot action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). The recovery may have killed the JS context — re-establish CDP via cdp_connect before reading state. Upstream: Callstack/agent-device, see B119/GH#35.',
    },
  );
}

export async function pressCandidate(
  candidate: FindCandidate,
  action?: string,
  getClient?: () => CDPClient,
): Promise<ToolResult> {
  const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
  if (action === 'click') {
    const tap = async (): Promise<ToolResult> =>
      surfaceKeyboardGuard(await runNative(['press', ref]));
    const first = await tap();
    return first.isError && getClient
      ? healKeyboardOccludedTap(first, keyboardHealDeps(getClient, tap))
      : first;
  }
  return okResult({ ref: candidate.ref, label: candidate.label, testID: candidate.testID });
}

// B119: when an underlying snapshot triggered runner-leak recovery, surface
// that side-effect on the wrapping result so callers (LLM agents) know the
// app may have been relaunched and CDP/state may have been invalidated.
function tagPressIfRecovered(result: ToolResult, tier?: RecoveryTier): ToolResult {
  if (!tier || result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: unknown;
      meta?: Record<string, unknown>;
    };
    envelope.meta = { ...envelope.meta, recovered: 'agent-device-runner-leak', recoveryTier: tier };
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch {
    return result;
  }
}

// --- Find ---

interface FindArgs {
  text: string;
  action?: string;
  exact?: boolean;
  index?: number;
}

export function createDeviceFindHandler(
  getClient?: () => CDPClient,
): (args: FindArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // Fast path when caller already knows they want exact or a specific index:
    // go straight to a snapshot-based client-side match so we never roll the dice
    // on agent-device's fuzzy matcher returning AMBIGUOUS_MATCH.
    if (args.exact === true || args.index !== undefined) {
      const find = await fetchFindCandidates(args.text, args.exact === true, true);
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.reason === 'empty-capture') {
          return emptyCaptureFailResult(args.text);
        }
        // Snapshot failed and caller has strict requirements — do NOT fall through
        // to the fuzzy agent-device path because it cannot honor exact/index. Fail
        // cleanly so the caller knows exact/index semantics aren't reachable.
        return failResult(
          `Snapshot unavailable — cannot resolve ${args.exact ? 'exact' : 'index-based'} match for "${args.text}". Retry after device_snapshot action=open/snapshot.`,
          { code: 'SNAPSHOT_UNAVAILABLE', query: args.text },
        );
      }
      const { candidates, recoveredTier } = find;
      if (candidates.length === 0) {
        return failResult(`No element matches "${args.text}" (exact=${args.exact === true})`, {
          code: 'NOT_FOUND',
          query: args.text,
        });
      }
      if (args.index !== undefined) {
        if (args.index < 0 || args.index >= candidates.length) {
          return failResult(
            `index ${args.index} out of range (got ${candidates.length} candidates)`,
            { code: 'INDEX_OUT_OF_RANGE', count: candidates.length, candidates },
          );
        }
        return tagPressIfRecovered(
          await pressCandidate(candidates[args.index], args.action, getClient),
          recoveredTier,
        );
      }
      // exact=true, no index: require single match
      if (candidates.length === 1) {
        return tagPressIfRecovered(
          await pressCandidate(candidates[0], args.action, getClient),
          recoveredTier,
        );
      }
      return failResult(
        `AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`,
        {
          code: 'AMBIGUOUS_MATCH',
          query: args.text,
          candidates,
          hint: 'Add index: N to pick one.',
        },
      );
    }

    // GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: route
    // non-exact text finds through the snapshot-based orchestrator on iOS
    // always and on Android (default-on; opt-out via RN_ANDROID_RUNNER=0).
    // The legacy CLI path would respawn the upstream agent-device daemon,
    // which fights our in-tree runner for focus / UIAutomator. Using
    // runNative + fetchFindCandidates keeps us on the platform-aware
    // short-circuit.
    const activeSession = getActiveSession();
    const usesInTreeRunner =
      activeSession?.platform === 'ios' ||
      (activeSession?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');
    if (usesInTreeRunner) {
      const find = await fetchFindCandidates(args.text, false, true);
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.reason === 'empty-capture') {
          return emptyCaptureFailResult(args.text);
        }
        return failResult(`Snapshot unavailable — cannot resolve "${args.text}"`, {
          code: 'SNAPSHOT_UNAVAILABLE',
          query: args.text,
        });
      }
      const { candidates, recoveredTier } = find;
      // Surface recoveredTier on every outcome (not just the single-match press)
      // so callers can tell the app was relaunched mid-find even on NOT_FOUND /
      // AMBIGUOUS.
      const recoveredMeta = recoveredTier ? { recoveredTier } : {};
      if (candidates.length === 0) {
        return failResult(`No element matches "${args.text}"`, {
          code: 'NOT_FOUND',
          query: args.text,
          ...recoveredMeta,
        });
      }
      if (candidates.length === 1) {
        return tagPressIfRecovered(
          await pressCandidate(candidates[0], args.action, getClient),
          recoveredTier,
        );
      }
      return failResult(
        `AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements. Use device_press with one of these refs, or retry with index: N.`,
        {
          code: 'AMBIGUOUS_MATCH',
          query: args.text,
          candidates,
          ...recoveredMeta,
          hint: 'Pick the correct ref (prefer one with hittable=true) and call device_press(ref="...") directly, or call device_find again with index: N.',
        },
      );
    }

    return failResult(
      `device_find requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${(activeSession as { platform?: string } | null)?.platform ?? 'none'}.`,
      {
        code: 'IN_TREE_RUNNER_REQUIRED',
        platform: (activeSession as { platform?: string } | null)?.platform ?? null,
      },
    );
  });
}

// GH #60 Bug 7: agent-device + Maestro emit a few different timeout strings
// ("daemon timeout", "Daemon error: daemon timeout", "request timed out")
// depending on tier. Match the patterns broadly enough to catch all of them
// without snagging unrelated timeouts (e.g. CDP evaluate timeouts inside
// other tools have different shapes that don't reach this path).
export function isDaemonTimeoutError(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('daemon timeout') ||
    t.includes('daemon error: daemon') ||
    /\bdaemon\b.*\btimed?\s?out\b/.test(t)
  );
}

// B122: helper to resolve a Pressable-wrapping ref to its inner TextInput ref.
// Common RN design-system pattern: outer Pressable with testID `${name}-pressable`
// imperatively focuses an inner TextInput whose testID is `${name}`. When
// device_fill targets the Pressable directly, the focus hasn't propagated to
// the TextInput by the time we probe — primary fill fails with "no focused
// text input to clear". Re-resolving to the inner TextInput's ref and re-tapping
// directly forces native focus into the right element.
//
// Heuristic — both must hold:
//   1. The ref's node has identifier ending in `-pressable`.
//   2. There is a sibling/descendant node whose identifier === stripped(identifier)
//      AND whose type is one of TextField, SecureTextField, or TextView.
//
// Returns the resolved ref (with leading `@`) or null if no match.
const TEXT_INPUT_TYPES = new Set(['TextField', 'SecureTextField', 'TextView', 'EditText']);
const PRESSABLE_SUFFIX = '-pressable';

export function findInputForPressable(
  nodes: SnapshotNode[] | null,
  pressableRef: string,
): string | null {
  if (!nodes) return null;
  const cleanRef = pressableRef.replace(/^@/, '');
  const pressableNode = nodes.find((n) => n.ref === cleanRef);
  if (!pressableNode?.identifier?.endsWith(PRESSABLE_SUFFIX)) return null;
  const baseId = pressableNode.identifier.slice(0, -PRESSABLE_SUFFIX.length);
  if (!baseId) return null;
  const inputNode = nodes.find(
    (n) => n.identifier === baseId && n.type !== undefined && TEXT_INPUT_TYPES.has(n.type),
  );
  return inputNode ? `@${inputNode.ref}` : null;
}

// --- Press (enhanced with doubleTap, count, holdMs, waitForFocusMs) ---

interface PressArgs {
  ref?: string;
  x?: number;
  y?: number;
  doubleTap?: boolean;
  count?: number;
  holdMs?: number;
  waitForFocusMs?: number;
  settleTimeoutMs?: number;
  retryIfNoChange?: boolean;
}

// Story 04 (#385): thread a caller-supplied settle budget into runNative.
function settleOpts(args: { settleTimeoutMs?: number }): {
  settle?: { timeoutMs: number };
} {
  return args.settleTimeoutMs !== undefined ? { settle: { timeoutMs: args.settleTimeoutMs } } : {};
}

// Story 05 (#386): thread caller-supplied settle and retryIfNoChange into runNative opts.
function interactOpts(args: { settleTimeoutMs?: number; retryIfNoChange?: boolean }): {
  settle?: { timeoutMs: number };
  retryIfNoChange?: boolean;
} {
  return {
    ...settleOpts(args),
    ...(args.retryIfNoChange !== undefined ? { retryIfNoChange: args.retryIfNoChange } : {}),
  };
}

// #379: build the KEYBOARD_OCCLUDED auto-heal deps. JS-first per D1250 —
// dismiss via the injected helper (deterministic, no gestures), refresh the
// snapshot because targets relayout when the keyboard lifts (measured live:
// wizard-next-btn moved y=790→571), then retry the raw tap exactly once.
// Opportunistic: no CDP → null deps → the refusal surfaces unchanged.
function keyboardHealDeps(
  getClient: () => CDPClient,
  retryTap: () => Promise<ToolResult>,
): KeyboardAutoHealDeps | null {
  const client = cdpClientOrNull(getClient);
  if (!client) return null;
  return {
    dismissViaJs: async () => {
      const r = await client.evaluate('__RN_AGENT.dismissKeyboard()');
      if (typeof r.value !== 'string') return false;
      try {
        const parsed = JSON.parse(r.value) as { dismissed?: boolean } | null;
        return parsed?.dismissed === true;
      } catch {
        return false;
      }
    },
    refreshSnapshot: () => runNative(['snapshot']),
    retryTap,
  };
}

export function createDevicePressHandler(
  getClient: () => CDPClient,
): (args: PressArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    const hasCoordinates = args.x !== undefined && args.y !== undefined;
    if (hasRef === hasCoordinates) {
      return failResult(
        'Provide exactly one press target: ref, or both x and y coordinates',
        'INVALID_ARGUMENT',
      );
    }
    const target = hasRef ? (args.ref!.startsWith('@') ? args.ref! : `@${args.ref!}`) : undefined;
    const cliArgs = hasRef ? ['press', target!] : ['press', String(args.x!), String(args.y!)];
    if (args.doubleTap) cliArgs.push('--double-tap');
    if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
    if (args.holdMs && args.holdMs > 0) cliArgs.push('--hold-ms', String(args.holdMs));
    const tap = async (): Promise<ToolResult> =>
      surfaceKeyboardGuard(await runNative(cliArgs, interactOpts(args)));
    let result = await tap();
    if (result.isError) {
      result = await healKeyboardOccludedTap(result, keyboardHealDeps(getClient, tap));
    }
    if (!result.isError && args.waitForFocusMs && args.waitForFocusMs > 0) {
      await new Promise((r) => setTimeout(r, args.waitForFocusMs));
    }
    return result;
  });
}

// --- Long Press ---

interface LongPressArgs {
  ref?: string;
  x?: number;
  y?: number;
  durationMs?: number;
  retryIfNoChange?: boolean;
}

export function createDeviceLongPressHandler(
  getClient: () => CDPClient,
): (args: LongPressArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    let cliArgs: string[];
    if (args.ref) {
      const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
      cliArgs = ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
    } else if (args.x != null && args.y != null) {
      cliArgs = ['longpress', String(args.x), String(args.y)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
    } else {
      return failResult('Provide either ref or x+y coordinates');
    }
    const tap = async (): Promise<ToolResult> =>
      surfaceKeyboardGuard(await runNative(cliArgs, interactOpts(args)));
    const result = await tap();
    if (result.isError) {
      return healKeyboardOccludedTap(result, keyboardHealDeps(getClient, tap));
    }
    return result;
  });
}

// --- Fill (with Android workaround) ---

interface FillArgs {
  ref: string;
  text: string;
  /**
   * B122: how long to wait between the pre-tap and the fill probe. Defaults to
   * 150ms (FOCUS_DELAY_MS). Bump to 500-1000ms when filling a Pressable-wrapped
   * TextInput on slow keyboard animations — gives RN's native focus dispatch
   * time to land before the probe.
   */
  waitForKeyboardMs?: number;
  /** #191: explicit testID for the JS-first path; resolved from ref's cached identifier when omitted. */
  testID?: string;
  /** Story 04 (#385): per-call settle budget override in ms. */
  settleTimeoutMs?: number;
}

// Story 10 (#391): this helper (and the chunked `adb shell input text` path it
// serves) survives ONLY in device_fill's last-resort tier — see
// docs/stories/10-text-input-reliability.md. The transport cannot represent
// emoji/IME-composed text; the runner's ACTION_SET_TEXT is the primary.
//
// Splits a chunk into segments where no segment, after space→%s encoding,
// will contain a user-literal %s. Android's `input text` interprets %s as
// space — the ONLY special sequence it recognizes (empirically verified:
// %%, %p, %n, %d, %t, %S, lone %, trailing % all pass through literally).
// There is no escape mechanism (no %% → %, no \%s). The fix (B97) is to
// ensure % and s from user text never appear adjacent in the same `input
// text` call: send % alone, then s... in the next call.
export function splitChunkAroundPercentS(chunk: string): string[] {
  const parts = chunk.split('%s');
  if (parts.length === 1) return [chunk];
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      segments.push('%');
      const rest = 's' + parts[i];
      if (rest.length > 0) segments.push(rest);
    } else if (parts[i].length > 0) {
      segments.push(parts[i]);
    }
  }
  return segments;
}

// Builds the argv tail for a single `input text` call. The chunk MUST NOT
// contain a user-literal %s — use splitChunkAroundPercentS first.
// Wraps in a single-quoted shell string because `adb shell <argv...>` joins
// argv with spaces and sends to the Android remote shell as a raw command
// line (it does NOT per-argument-escape). Single-quote wrapping prevents
// shell metacharacter expansion ($, `, &, |, <, >, etc.); embedded single
// quotes are escaped via the POSIX `'\''` dance.
export function buildAdbInputTextArgv(chunk: string): string[] {
  const escaped = chunk.replace(/ /g, '%s').replace(/'/g, "'\\''");
  return ['shell', 'input', 'text', `'${escaped}'`];
}

const ANDROID_INPUT_CHUNK_SIZE = 10;

// Story 10 (#391, codex P2): `adb shell input text` only round-trips printable
// ASCII — non-ASCII can be silently mangled while adb still exits 0, turning a
// corrupted fill into a reported success. The adb tier is gated on this.
export function isAdbInputTextSafe(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(text);
}

async function androidClipboardFill(text: string): Promise<ToolResult> {
  try {
    const serial = getAdbSerial();
    for (let i = 0; i < text.length; i += ANDROID_INPUT_CHUNK_SIZE) {
      const chunk = text.slice(i, i + ANDROID_INPUT_CHUNK_SIZE);
      const segments = splitChunkAroundPercentS(chunk);
      for (const seg of segments) {
        const argvTail = buildAdbInputTextArgv(seg);
        await execFile('adb', [...serial, ...argvTail], { timeout: 10000 });
      }
    }
    return okResult({ filled: true, method: 'adb-chunked-input', length: text.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return failResult(`Android text input failed: ${msg}`);
  }
}

function isAndroidSession(): boolean {
  const session = getActiveSession();
  if (session?.platform === 'android') return true;
  if (session?.platform) return false;
  return !!process.env.ANDROID_SERIAL;
}

const FOCUS_DELAY_MS = 150;

// #385: explicit waitForKeyboardMs always wins (B122 Pressable-wrapped
// inputs); a pre-tap whose envelope carries meta.settle already waited for UI
// stability, so the fixed 150ms is only the settle-less fallback.
export function focusDelayAfterPreTap(
  preTapEnvelopeText: string | undefined,
  waitForKeyboardMs: number | undefined,
): number {
  if (waitForKeyboardMs !== undefined) return waitForKeyboardMs;
  if (preTapEnvelopeText) {
    try {
      const envelope = JSON.parse(preTapEnvelopeText) as { meta?: { settle?: unknown } };
      if (envelope.meta?.settle !== undefined) return 0;
    } catch {
      /* fall through to legacy delay */
    }
  }
  return FOCUS_DELAY_MS;
}
const NO_FOCUSED_INPUT_RE = /no focused text input|no focused element|element is not focused/i;

function isNoFocusedInputError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  return NO_FOCUSED_INPUT_RE.test(text);
}

// Story 10 (#391): the Android runner's focused field ignored ACTION_SET_TEXT
// (and any applicable keyevent fallback). Focus itself is healthy, so the
// pressable-resolution / re-tap tiers would be wasted work — descend straight
// to the platform last resorts.
function isSetTextRejectedError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  try {
    const envelope = JSON.parse(text) as { code?: string };
    return envelope.code === 'SET_TEXT_REJECTED';
  } catch {
    return false;
  }
}

export type FillPrimaryDescent = 'return-primary' | 'refocus-ladder' | 'reject-ladder';

// Story 10 (#391): pure descent decision for the primary native fill outcome —
// the ladder's arbiter, kept extractable so ordering stays unit-tested.
export function classifyFillPrimaryError(primary: ToolResult): FillPrimaryDescent {
  if (!primary.isError) return 'return-primary';
  if (isSetTextRejectedError(primary)) return 'reject-ladder';
  if (isNoFocusedInputError(primary)) return 'refocus-ladder';
  return 'return-primary';
}

// Story 10 (#391): typing telemetry the iOS runner attaches to its `type`
// response (two-burst recipe + keyboard-presence wait). Surfaced as
// meta.typing when device_fill re-wraps the runner envelope.
export function extractTypingMeta(
  result: ToolResult,
): { burst?: boolean; keyboardWaitMs?: number } | null {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      data?: { typingBurst?: boolean; keyboardWaitMs?: number };
    };
    const data = envelope.data;
    if (!data || (data.typingBurst === undefined && data.keyboardWaitMs === undefined)) return null;
    return {
      ...(data.typingBurst !== undefined ? { burst: data.typingBurst } : {}),
      ...(data.keyboardWaitMs !== undefined ? { keyboardWaitMs: data.keyboardWaitMs } : {}),
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractSettleMeta(result: ToolResult): { settle?: unknown; settleMs?: number } {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      meta?: { settle?: unknown; timings_ms?: { settle?: number } };
    };
    const out: { settle?: unknown; settleMs?: number } = {};
    if (envelope.meta?.settle !== undefined) out.settle = envelope.meta.settle;
    if (typeof envelope.meta?.timings_ms?.settle === 'number') {
      out.settleMs = envelope.meta.timings_ms.settle;
    }
    return out;
  } catch {
    return {};
  }
}

function cdpClientOrNull(getClient: () => CDPClient): CDPClient | null {
  try {
    const c = getClient();
    return c && c.isConnected ? c : null;
  } catch {
    return null;
  }
}
function jsVerifyMeta(outcome: FillVerifyOutcome): 'exact' | 'transformed' | 'unverifiable' {
  return outcome === 'verified-exact'
    ? 'exact'
    : outcome === 'verified-transformed'
      ? 'transformed'
      : 'unverifiable';
}

// Multi-review "H3" guard: a cached identifier may only seed the JS-first
// testID resolution when the ref is BOTH map-fresh AND present in the
// CURRENT snapshot generation. Pre-#386 signature retention, getCachedMetadata
// returned null for any ref not in the latest snapshot, so `isRefMapFresh()`
// alone was sufficient. Since 4ff56662, metadataMap retains signatures for ref
// ids absent from the newest snapshot (to heal stale taps by identity), so
// getCachedMetadata can return an OLD-generation identifier even when the map
// is otherwise fresh. lookupRef reads refMap, which IS still cleared every
// generation, so `lookupRef(ref) !== null` proves the ref exists in the
// CURRENT generation — restoring H3 (a testID reused across screens, e.g.
// 'input-email' on both Login and Signup, can no longer resolve to a
// retained-but-stale generation's identifier).
export function resolveCachedIdentifier(ref: string): string | undefined {
  const bareRef = ref.replace(/^@/, '');
  if (!isRefMapFresh() || lookupRef(bareRef) === null) return undefined;
  return getCachedMetadata(bareRef)?.identifier;
}

async function maestroFillFallback(
  ref: string,
  text: string,
  platform: 'ios' | 'android',
  clearFirst = false,
): Promise<ToolResult> {
  const escapedRef = yamlEscape(ref.replace(/^@/, ''));
  const escapedText = yamlEscape(text);
  // When reached from the #191 verify-escalation, the field already holds the
  // corrupted text, so inputText alone would append. eraseText first so the
  // fallback can actually recover (multi-review M3).
  const clearStep = clearFirst ? '\n- eraseText' : '';
  const yaml = `- tapOn:\n    id: "${escapedRef}"${clearStep}\n- inputText: "${escapedText}"`;
  const result = await runMaestroInline(yaml, {
    platform,
    slug: 'fill-fallback',
    timeoutMs: 30_000,
  });
  if (result.passed) {
    return okResult(
      { filled: true, method: 'maestro', length: text.length },
      { meta: { fallbackUsed: 'maestro' } },
    );
  }
  return failResult(
    `device_fill fell through all fallbacks. Last error: ${result.error ?? result.output.slice(0, 200)}`,
    {
      code: 'FILL_FAILED',
      tried: ['primary', 'retap', platform === 'android' ? 'adb' : 'maestro'],
    },
  );
}

const MAX_NATIVE_RETYPE = 2;

// `settleAnchor` is the value the read polls AWAY from (to detect a debounced
// flush); `stabilityPrior` is the prior *attempt*'s settled value, fed to the
// stability rule. They differ on attempt 0: a fresh fill has an anchor (its
// post-fill value) but NO stability prior — seeding the prior from the anchor
// would let a stable char-drop ("hel") classify as 'transformed' and skip the
// retype, defeating the #191 fix (multi-review L4). So attempt 0 passes prior=null.
async function nativeSettle(
  client: CDPClient | null,
  testID: string | null,
  text: string,
  settleAnchor: string | null,
  stabilityPrior: string | null,
): Promise<{ outcome: FillVerifyOutcome; value: string | null }> {
  if (!client || !testID) return { outcome: 'unverifiable', value: null };
  const settled = await settleRead(
    { evaluate: (e) => client.evaluate(e) },
    testID,
    text,
    settleAnchor,
  );
  return {
    outcome: classifyFillVerification({
      text,
      valueAfter: settled.value,
      priorValueAfter: stabilityPrior,
      controlled: settled.controlled,
    }),
    value: settled.value,
  };
}

function exactTypeReadback(
  client: CDPClient | null,
  testID: string | null,
): ((expected: string) => Promise<{ matches: boolean; actual?: string | null }>) | undefined {
  if (!client || !testID) return undefined;
  return async (expected) => {
    const result = await client.evaluate(`__RN_AGENT.readInputValue(${JSON.stringify(testID)})`);
    if (typeof result.value !== 'string') return { matches: false };
    try {
      const parsed = JSON.parse(result.value) as { value?: unknown };
      const actual = typeof parsed.value === 'string' ? parsed.value : null;
      return { matches: actual === expected, actual };
    } catch {
      return { matches: false };
    }
  };
}

async function readValueBefore(
  client: CDPClient | null,
  testID: string | null,
): Promise<string | null> {
  if (!client || !testID) return null;
  const settled = await settleRead(
    { evaluate: (e) => client.evaluate(e) },
    testID,
    ' __rn_never__',
    null,
  );
  return settled.value;
}

export function createDeviceFillHandler(
  getClient: () => CDPClient,
): (args: FillArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const androidSession = isAndroidSession();

    // Codex P2 round-3 (#564): @eN snapshot refs are runner-ephemeral, not app
    // testIDs — Maestro's `tapOn: id:` can only match the element's REAL
    // identifier. Resolve it whenever the ref map still knows it; otherwise
    // pass the ref through unchanged (pre-existing behavior for bare refs).
    const maestroTargetRef = () => resolveCachedIdentifier(ref) ?? ref;

    // Story 10 (#391): the historical Android unsafe-char/length short-circuit
    // to chunked adb is gone. It predated the in-tree runner ("the Android path
    // is already a fallback for agent-device fill") — but agent-device was
    // eradicated, `fill` always reaches rn-android-runner, and its
    // ACTION_SET_TEXT primary is atomic and full-Unicode. Routing emoji/long
    // text to `adb input text` first was routing it to the ONE tier that
    // cannot represent it. Chunked adb survives only as Fallback 2 below.

    // #191 prong 1 — JS-first dispatch. Opportunistic: CDP connected AND ref→testID.
    // resolveCachedIdentifier gates on BOTH ref-map freshness AND current-generation
    // presence (multi-review H3, restored post-#386 signature retention — see its
    // doc comment) so a stale/retained-but-absent ref can't map @eN to a reused
    // testID on a since-navigated screen. Explicit args.testID is caller-asserted
    // and stays ungated. Never returns the field's value (could be a password) — the
    // `verify` classification conveys success without echoing the text (multi-review BLOCKER).
    const client = cdpClientOrNull(getClient);
    const cachedIdentifier = resolveCachedIdentifier(ref);
    const jsTestId = client
      ? resolveJsTestId(ref, { explicitTestId: args.testID, cachedIdentifier })
      : null;
    if (client && jsTestId) {
      const tJs = Date.now();
      const js = await attemptJsFill({ evaluate: (e) => client.evaluate(e) }, jsTestId, args.text);
      if (js.handled && js.outcome && js.outcome !== 'corrupted') {
        return okResult(
          { filled: true, method: 'js-onChangeText', length: args.text.length },
          {
            meta: {
              textEntryPath: 'js',
              verify: jsVerifyMeta(js.outcome),
              handler: js.handler,
              timings_ms: { jsType: Date.now() - tJs },
            },
          },
        );
      }
      // Fall-through (no handler, or JS fired but corrupted). If a handler DID fire on a
      // controlled input, clear the value it set via onChangeText('') so the native
      // re-type below doesn't double-apply onto debounced/partial JS text (multi-review H2).
      if (js.handled && js.controlled) {
        try {
          await client.evaluate(
            '__RN_AGENT.interact(' +
              JSON.stringify({ action: 'typeText', testID: jsTestId, text: '' }) +
              ')',
          );
        } catch {
          /* best-effort clear */
        }
      }
    }

    // #385: resolve the target's coords ONCE. The pre-tap's settle re-snapshots
    // and rebuilds the @ref map (post-keyboard screen), so a later @ref
    // re-resolution inside this call could target a different element.
    const pinned = isRefMapFresh() ? refCenter(ref) : null;
    const pinArgs = pinned ? ['--at-x', String(pinned.x), '--at-y', String(pinned.y)] : [];

    // G6: Always tap before fill so keyboard focus lands on this @ref, even in sequential
    // press+fill+press+fill flows where the previous call left focus on a different field.
    const preTap = pinned
      ? await runNative(['press', String(pinned.x), String(pinned.y)], settleOpts(args))
      : await runNative(['press', ref], settleOpts(args));
    if (preTap.isError) {
      // If we can't even tap the element, fall straight through to fill — it may still
      // work via the fast-runner coordinate path, and we want its error message, not ours.
    } else {
      const delay = focusDelayAfterPreTap(preTap.content?.[0]?.text, args.waitForKeyboardMs);
      if (delay > 0) await sleep(delay);
    }

    const primary = await runNative(['fill', ref, args.text, ...pinArgs], {
      ...settleOpts(args),
      verifyTypeReadback: exactTypeReadback(client, jsTestId),
    });
    if (!primary.isError) {
      // #191 prong 2/3 — native read-back verification + corrective clear/retype.
      // iOS-only: the corrective retype needs the runner's --clear-first, which the
      // Android agent-device path does not honor — a retype there would APPEND and
      // make corruption worse (multi-review H1). Android keeps the legacy result.
      if (client && jsTestId && !androidSession) {
        const tNative = Date.now();
        // #385: the verified-native path re-wraps the result — carry the
        // primary fill's settle telemetry forward instead of dropping it.
        const primarySettle = extractSettleMeta(primary);
        // Story 10 (#391): same for the runner's typing telemetry.
        const primaryTyping = extractTypingMeta(primary);
        let settleAnchor = await readValueBefore(client, jsTestId);
        let stabilityPrior: string | null = null;
        for (let attempt = 0; attempt <= MAX_NATIVE_RETYPE; attempt++) {
          const { outcome, value } = await nativeSettle(
            client,
            jsTestId,
            args.text,
            settleAnchor,
            stabilityPrior,
          );
          const decision = decideNativeRetype(outcome, attempt, MAX_NATIVE_RETYPE);
          if (decision.action === 'accept') {
            return okResult(
              { filled: true, method: 'native', length: args.text.length },
              {
                meta: {
                  textEntryPath: attempt === 0 ? 'native' : 'native-retype',
                  verify: jsVerifyMeta(outcome),
                  retypes: attempt,
                  ...(primaryTyping ? { typing: primaryTyping } : {}),
                  ...(primarySettle.settle !== undefined ? { settle: primarySettle.settle } : {}),
                  timings_ms: {
                    nativeType: Date.now() - tNative,
                    ...(primarySettle.settleMs !== undefined
                      ? { settle: primarySettle.settleMs }
                      : {}),
                  },
                },
              },
            );
          }
          if (decision.action === 'escalate') break;
          settleAnchor = value;
          stabilityPrior = value;
          // #385: retypes skip settle — the nativeSettle CDP read-back that
          // follows is their stability check; a UI-settle here only adds latency.
          await runNative(
            [
              'fill',
              ref,
              args.text,
              ...pinArgs,
              '--clear-first',
              '--delay-ms',
              String(decision.delayMs),
            ],
            { settle: { enabled: false } },
          );
        }
        const maestro = await maestroFillFallback(maestroTargetRef(), args.text, 'ios', true);
        if (!maestro.isError) {
          const { outcome } = await nativeSettle(client, jsTestId, args.text, null, null);
          if (outcome !== 'corrupted') {
            return okResult(
              { filled: true, method: 'maestro', length: args.text.length },
              {
                meta: {
                  textEntryPath: 'maestro',
                  verify: jsVerifyMeta(outcome),
                  timings_ms: { nativeType: Date.now() - tNative },
                },
              },
            );
          }
        }
        return failResult(
          'Text entry could not be verified after retype + maestro fallback',
          'TEXT_ENTRY_UNVERIFIED',
          {
            expectedLength: args.text.length,
            pathsTried: ['js', 'native', 'native-retype', 'maestro'],
          },
        );
      }
      return primary;
    }

    // G4 + Story 10 (#391): descend only for focus errors (refocus ladder) or
    // a runner-rejected set (reject ladder — skips the refocus tiers below,
    // since focus was healthy). Everything else surfaces as-is.
    const descent = classifyFillPrimaryError(primary);
    if (descent === 'return-primary') {
      return primary;
    }

    if (descent === 'refocus-ladder') {
      // B122: Pressable→TextInput resolution. Common RN design-system pattern is
      // an outer Pressable (testID `${name}-pressable`) that imperatively focuses
      // an inner TextInput (testID `${name}`). The Pressable absorbs the tap and
      // the focus dispatches asynchronously, so by the time we probe, focus
      // hasn't propagated. Resolve to the inner ref and tap THAT directly — much
      // more reliable than waiting + retapping the wrapper.
      const snap = await fetchSnapshotNodes();
      if (snap.ok) {
        const resolvedRef = findInputForPressable(snap.nodes, ref);
        if (resolvedRef && resolvedRef !== ref) {
          // #385: same pin-once guard as the primary path — the inner tap's settle
          // re-snapshots and renumbers the positional map, so the fill must not
          // re-resolve resolvedRef afterwards (fetchSnapshotNodes above just
          // refreshed the map, so the pin resolves against the current screen).
          const innerPin = isRefMapFresh() ? refCenter(resolvedRef) : null;
          const innerPinArgs = innerPin
            ? ['--at-x', String(innerPin.x), '--at-y', String(innerPin.y)]
            : [];
          const innerTap = innerPin
            ? await runNative(['press', String(innerPin.x), String(innerPin.y)], settleOpts(args))
            : await runNative(['press', resolvedRef], settleOpts(args));
          if (!innerTap.isError) {
            const delay = focusDelayAfterPreTap(
              innerTap.content?.[0]?.text,
              args.waitForKeyboardMs,
            );
            if (delay > 0) await sleep(delay);
            const resolved = await runNative(['fill', resolvedRef, args.text, ...innerPinArgs], {
              ...settleOpts(args),
              verifyTypeReadback: exactTypeReadback(
                client,
                resolveCachedIdentifier(resolvedRef) ?? null,
              ),
            });
            if (!resolved.isError) {
              try {
                const envelope = JSON.parse(resolved.content[0].text) as {
                  ok: true;
                  data: unknown;
                  meta?: Record<string, unknown>;
                };
                return okResult(envelope.data, {
                  meta: { ...envelope.meta, fallbackUsed: 'pressable-resolution', resolvedRef },
                });
              } catch {
                return resolved;
              }
            }
            // Codex P2 round-3 (#564): this refocus retry can be the FIRST fill
            // that reaches a focused field — if IT comes back SET_TEXT_REJECTED,
            // hand over to the reject ladder (clear-first Maestro), never the
            // append-prone adb tier below. Target the INNER input this branch
            // just filled, not the outer Pressable wrapper.
            if (classifyFillPrimaryError(resolved) === 'reject-ladder') {
              return maestroFillFallback(
                resolveCachedIdentifier(resolvedRef) ?? resolvedRef,
                args.text,
                'android',
                true,
              );
            }
          }
        }
      }

      // Fallback 1: coordinate re-tap + retry fill. Re-tap gives the UI another chance
      // to propagate focus from a wrapping Pressable to the inner TextInput.
      const retryTap = await runNative(['press', ref]);
      if (!retryTap.isError) {
        await sleep(300);
        const retry = await runNative(['fill', ref, args.text], {
          verifyTypeReadback: exactTypeReadback(client, jsTestId),
        });
        if (!retry.isError) {
          // Re-wrap the okResult to attach the fallback marker.
          try {
            const envelope = JSON.parse(retry.content[0].text) as { ok: true; data: unknown };
            return okResult(envelope.data, { meta: { fallbackUsed: 'retap' } });
          } catch {
            return retry;
          }
        }
        // Codex P2 round-3 (#564): same reclassification as the resolved-ref
        // fill above — a rejected retry means focus is fine but the field
        // ignores sets; descend to the clear-first Maestro tier.
        if (classifyFillPrimaryError(retry) === 'reject-ladder') {
          return maestroFillFallback(maestroTargetRef(), args.text, 'android', true);
        }
      }
    }

    // Codex P2 round-2 (#564): the reject ladder never touches adb. The runner
    // already proved setText AND keyevents don't land — `adb shell input text`
    // is the same keyevent injection, minus pacing and focus control, and it
    // inserts at the cursor (AOSP Input.java), so on a field still holding its
    // old value it would append and report success. Go straight to Maestro
    // with clearFirst so eraseText removes the stale value before inputText.
    if (descent === 'reject-ladder') {
      return maestroFillFallback(maestroTargetRef(), args.text, 'android', true);
    }

    // Fallback 2: platform-specific last resort. Story 10 (#391): chunked adb
    // is the deliberate LAST native tier — its `input text` transport cannot
    // represent emoji/IME-composed text, so it only runs after the runner's
    // setText/keyevent tiers (and any refocus re-taps) have failed, and only
    // for text it can actually represent (codex P2: adb can exit 0 after
    // mangling non-ASCII, which would mask the honest Maestro tier below).
    if (androidSession && isAdbInputTextSafe(args.text)) {
      const adbResult = await androidClipboardFill(args.text);
      if (!adbResult.isError) {
        try {
          const envelope = JSON.parse(adbResult.content[0].text) as { ok: true; data: unknown };
          return okResult(envelope.data, { meta: { fallbackUsed: 'adb' } });
        } catch {
          return adbResult;
        }
      }
    }

    // Fallback 3: Maestro inputText (iOS, or Android if adb fallback also failed).
    const platform: 'ios' | 'android' = androidSession ? 'android' : 'ios';
    return maestroFillFallback(maestroTargetRef(), args.text, platform);
  });
}

// --- Swipe (coordinate-based with direction shortcut) ---

interface SwipeArgs {
  direction?: 'up' | 'down' | 'left' | 'right';
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  count?: number;
  pattern?: 'one-way' | 'ping-pong';
  /**
   * B123: when true, REQUIRE fast-runner. The agent-device daemon caps swipe
   * duration at ~60ms via `safe-normalized` mode, which causes momentum
   * overshoot on UIDatePicker wheels and similar momentum-sensitive UIs.
   * Fast-runner uses the raw user-supplied duration with no clamp.
   * Fails with EXACT_REQUIRES_FAST_RUNNER when fast-runner unavailable
   * instead of silently degrading to a 60ms-capped daemon swipe.
   */
  exact?: boolean;
}

// Default screen dimensions for common devices — used when screen rect cache is empty.
// Covers iPhone 17 Pro / 15 Pro / 14 Pro Max and similar Android 1080x2400 phones.
const DEFAULT_SCREEN = { width: 402, height: 874 };
const SWIPE_FRACTION = 0.4;
const DEFAULT_SWIPE_DURATION_MS = 300;

function computeSwipeFromDirection(
  direction: 'up' | 'down' | 'left' | 'right',
  screen: { width: number; height: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const dy = Math.round(screen.height * SWIPE_FRACTION);
  const dx = Math.round(screen.width * SWIPE_FRACTION);
  switch (direction) {
    // "swipe down" means finger moves from top to bottom (pull-to-refresh gesture)
    case 'down':
      return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy };
    // "swipe up" means finger moves from bottom to top
    case 'up':
      return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy };
    case 'left':
      return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy };
    case 'right':
      return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy };
  }
}

// Shared by the standalone swipe handler and device_batch so a batched
// "swipe" performs a real swipe gesture (not a scroll) and honors duration.
export function buildDirectionalSwipeCliArgs(
  direction: 'up' | 'down' | 'left' | 'right',
  durationMs?: number,
): string[] {
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const coords = computeSwipeFromDirection(direction, screen);
  const duration = durationMs ?? DEFAULT_SWIPE_DURATION_MS;
  return [
    'swipe',
    String(coords.x1),
    String(coords.y1),
    String(coords.x2),
    String(coords.y2),
    String(duration),
  ];
}

// Scroll direction → finger gesture is INVERTED vs swipe ("scroll down" = content
// moves up = finger moves up) and scaled by `amount` (0..1). Centred half-spans
// keep the gesture inside the viewport.
function computeScrollFromDirection(
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number,
  screen: { width: number; height: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const dy = Math.round(screen.height * SWIPE_FRACTION * amount);
  const dx = Math.round(screen.width * SWIPE_FRACTION * amount);
  switch (direction) {
    case 'down':
      return { x1: cx, y1: cy + Math.round(dy / 2), x2: cx, y2: cy - Math.round(dy / 2) };
    case 'up':
      return { x1: cx, y1: cy - Math.round(dy / 2), x2: cx, y2: cy + Math.round(dy / 2) };
    case 'left':
      return { x1: cx + Math.round(dx / 2), y1: cy, x2: cx - Math.round(dx / 2), y2: cy };
    case 'right':
      return { x1: cx - Math.round(dx / 2), y1: cy, x2: cx + Math.round(dx / 2), y2: cy };
  }
}

// Shared by the standalone scroll handler's daemon fallthrough and device_batch
// so a "scroll" step always dispatches the COORDINATE form. The arg builders
// (buildRunIOSArgs / buildRunAndroidArgs) map scroll → a 4-coordinate drag and
// throw on the direction form — so the raw ['scroll', direction] shape that used
// to be dispatched here crashed on Android (always) and on the iOS fast-runner
// fallback path.
export function buildDirectionalScrollCliArgs(
  direction: 'up' | 'down' | 'left' | 'right',
  amount?: number,
  durationMs?: number,
): string[] {
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const clamped = Math.min(Math.max(amount ?? 0.5, 0), 1);
  const coords = computeScrollFromDirection(direction, clamped, screen);
  const duration = durationMs ?? DEFAULT_SWIPE_DURATION_MS;
  return [
    'scroll',
    String(coords.x1),
    String(coords.y1),
    String(coords.x2),
    String(coords.y2),
    String(duration),
  ];
}

export function exactModeRejectionMessage(
  reason: 'fast-runner-unavailable' | 'count-pattern-incompatible',
): string {
  if (reason === 'count-pattern-incompatible') {
    return 'exact: true is incompatible with count/pattern (those route through agent-device daemon which enforces safe-normalized timing). Drop count/pattern or drop exact.';
  }
  return 'exact: true requires fast-runner (iOS only, session must be open). Fast-runner unavailable — open a device session via device_snapshot action=open, then retry.';
}

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // GH #383: a respawned worker starts with empty in-memory runner state, so
    // adopt the persisted per-device file before the isFastRunnerAvailable()
    // gates below (else they false-report "unavailable" after a respawn).
    adoptPersistedFastRunnerState(getActiveSession()?.deviceId);
    // B106 fix: use fast-runner's HID-level synthesis to bypass XCTest
    // `waitForIdle` hangs on Reanimated-driven screens. Only applies when
    // fast-runner is available (iOS) and count/pattern are not used (those
    // are daemon-specific features — fall back to agent-device for them).
    const canUseFastRunner = isFastRunnerAvailable() && !args.count && !args.pattern;

    // B123: exact: true requires fast-runner. Fail loud if unavailable instead
    // of silently degrading to a 60ms-capped daemon swipe.
    if (args.exact === true) {
      if (args.count || args.pattern) {
        return failResult(exactModeRejectionMessage('count-pattern-incompatible'), {
          code: 'EXACT_INCOMPATIBLE',
          hint: 'count and pattern only work via agent-device daemon, which enforces safe-normalized timing. Drop one to proceed.',
        });
      }
      if (!isFastRunnerAvailable()) {
        return failResult(exactModeRejectionMessage('fast-runner-unavailable'), {
          code: 'EXACT_REQUIRES_FAST_RUNNER',
          hint: 'fast-runner is the only path that respects user-supplied durationMs verbatim. Open a device session first.',
        });
      }
    }

    if (args.x1 != null && args.y1 != null && args.x2 != null && args.y2 != null) {
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(
            args.x1,
            args.y1,
            args.x2,
            args.y2,
            args.durationMs,
            getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined,
          );
          if (resp.ok) {
            return okResult({
              x1: args.x1,
              y1: args.y1,
              x2: args.x2,
              y2: args.y2,
              durationMs: args.durationMs,
              method: 'fast-runner',
            });
          }
          if (args.exact === true) {
            return failResult(
              'fast-runner swipe call failed and exact: true forbids daemon fallback',
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
        } catch (err) {
          if (args.exact === true) {
            return failResult(
              `fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`,
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
          /* fall through */
        }
      }
      const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runNative(cliArgs);
    }
    if (args.direction) {
      // B-Tier3 fix: Use real swipe gesture (not scroll) for direction-based swipes.
      const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
      const coords = computeSwipeFromDirection(args.direction, screen);
      const duration = args.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(
            coords.x1,
            coords.y1,
            coords.x2,
            coords.y2,
            duration,
            getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined,
          );
          if (resp.ok) {
            return okResult({
              direction: args.direction,
              durationMs: duration,
              method: 'fast-runner',
              ...coords,
            });
          }
          if (args.exact === true) {
            return failResult(
              'fast-runner swipe call failed and exact: true forbids daemon fallback',
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
        } catch (err) {
          if (args.exact === true) {
            return failResult(
              `fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`,
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
          /* fall through */
        }
      }
      const cliArgs = [
        'swipe',
        String(coords.x1),
        String(coords.y1),
        String(coords.x2),
        String(coords.y2),
        String(duration),
      ];
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runNative(cliArgs);
    }
    return failResult('Provide either direction or x1,y1,x2,y2 coordinates');
  });
}

// --- Scroll ---

interface ScrollArgs {
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export function createDeviceScrollHandler(): (args: ScrollArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // B106 fix: Route iOS scroll through fast-runner's direct HID synthesis
    // when available. The agent-device daemon path uses XCTest's high-level
    // gesture API which calls `waitForIdle` after the drag — this hangs
    // indefinitely on screens driven by Reanimated `useAnimatedScrollHandler`
    // because the UI thread is never "idle" between scroll events. Fast-runner
    // uses `RunnerDaemonProxy.synthesize(eventRecord)` which is raw HID event
    // injection and returns as soon as events are delivered.
    const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
    const amount = Math.min(Math.max(args.amount ?? 0.5, 0), 1);
    const { x1, y1, x2, y2 } = computeScrollFromDirection(args.direction, amount, screen);
    // GH #383: adopt persisted per-device state so a respawned worker sees a
    // live runner before this fast-path gate.
    adoptPersistedFastRunnerState(getActiveSession()?.deviceId);
    if (isFastRunnerAvailable()) {
      try {
        const resp = await fastSwipe(
          x1,
          y1,
          x2,
          y2,
          DEFAULT_SWIPE_DURATION_MS,
          getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined,
        );
        if (resp.ok) {
          return okResult({
            direction: args.direction,
            amount: args.amount ?? 0.5,
            method: 'fast-runner',
            x1,
            y1,
            x2,
            y2,
          });
        }
        // Fall through to daemon on fast-runner failure
      } catch {
        // Fall through to daemon on fast-runner error
      }
    }
    // Daemon / Android fallthrough: dispatch the COORDINATE form. The arg
    // builders throw on the raw direction form, so this previously crashed on
    // Android (always) and on the iOS fast-runner fallback.
    return runNative(buildDirectionalScrollCliArgs(args.direction, args.amount));
  });
}

// --- Scroll Into View ---

interface ScrollIntoViewArgs {
  text?: string;
  ref?: string;
}

export function createDeviceScrollIntoViewHandler(): (
  args: ScrollIntoViewArgs,
) => Promise<ToolResult> {
  return withSession(async (args) => {
    if (!args.ref && !args.text) {
      return failResult('Provide either text or ref to scroll into view');
    }
    // GH #105 iOS-MVP follow-up: the Swift runner has no `scrollintoview`
    // command; this is TS-orchestrated on iOS (snapshot → find → swipe loop).
    // Task 8 of the Android MVP plan extends the same orchestrator to
    // Android (default-on; opt-out via RN_ANDROID_RUNNER=0) — the snapshot
    // + swipe verbs route through the platform-aware short-circuit in
    // runNative so this function is platform-neutral. The in-tree
    // runners are the only execution targets for scrollintoview now; the
    // upstream agent-device CLI never owned a stable scrollintoview verb
    // and routing through it re-spawns the legacy runner that fights us
    // for focus / UIAutomator.
    const session = getActiveSession();
    const usesInTreeRunner =
      session?.platform === 'ios' ||
      (session?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');

    if (usesInTreeRunner) {
      return scrollIntoViewWithRunner(args);
    }
    return failResult(
      `device_scrollintoview requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${session?.platform ?? 'none'}.`,
      { code: 'IN_TREE_RUNNER_REQUIRED', platform: session?.platform ?? null },
    );
  });
}

/**
 * GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: platform-neutral
 * TS orchestrator for device_scrollintoview. Loops snapshot → find → check
 * viewport → swipe up to MAX_ITERATIONS times. Uses runNative for both
 * the `snapshot` and `swipe` verbs so the in-tree iOS short-circuit
 * (rn-fast-runner) and the Android short-circuit (rn-android-runner, env-gated)
 * both apply transparently — no daemon, no upstream agent-device runner.
 */
async function scrollIntoViewWithRunner(args: ScrollIntoViewArgs): Promise<ToolResult> {
  const MAX_ITERATIONS = 12;
  const timer = createStepTimer();
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const screenRect: ViewportRect = { x: 0, y: 0, width: screen.width, height: screen.height };
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const snapRes = await runNative(['snapshot', '-i']);
    timer.mark('snapshot');
    if (snapRes.isError) {
      return failResult(
        `scrollintoview: snapshot failed at iteration ${i}: ${snapRes.content?.[0]?.text ?? 'unknown'}`,
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }
    let nodes: FlatNode[] = [];
    try {
      const envelope = JSON.parse(snapRes.content?.[0]?.text ?? '{}') as {
        data?: { nodes?: FlatNode[] };
      };
      nodes = envelope.data?.nodes ?? [];
    } catch {
      return failResult(`scrollintoview: failed to parse snapshot envelope at iteration ${i}`);
    }
    const target = args.ref
      ? (nodes.find((n) => n.ref === (args.ref!.startsWith('@') ? args.ref : `@${args.ref!}`)) ??
        null)
      : findInLatestSnapshot(nodes, args.text!);
    if (!target) {
      // Element not in snapshot at all; can't decide direction. Probably needs
      // initial scroll. Default to swiping up (down-direction-of-content) once
      // and retry — common case is reaching a below-fold element.
      if (i === 0) {
        const fallbackDir = decideScrollDirection(
          { x: 0, y: screen.height * 2, width: 1, height: 1 },
          screenRect,
        );
        const coords = computeSwipeFromDirection(fallbackDir ?? 'down', screen);
        await runNative([
          'swipe',
          String(coords.x1),
          String(coords.y1),
          String(coords.x2),
          String(coords.y2),
          String(DEFAULT_SWIPE_DURATION_MS),
        ]);
        continue;
      }
      return failResult(
        `scrollintoview: element "${args.ref ?? args.text}" not found after ${i} swipe iteration(s)`,
        { code: 'NOT_FOUND', iterations: i },
      );
    }
    if (!target.rect) {
      return failResult(`scrollintoview: target has no rect — cannot decide direction`);
    }
    const direction = decideScrollDirection(target.rect, screenRect);
    if (direction === null) {
      return okResult(
        {
          ref: target.ref,
          rect: target.rect,
          iterations: i,
          method: 'runner-orchestrator',
        },
        { meta: { timings_ms: timer.timings() } },
      );
    }
    const coords = computeSwipeFromDirection(direction, screen);
    const swipeResp = await runNative([
      'swipe',
      String(coords.x1),
      String(coords.y1),
      String(coords.x2),
      String(coords.y2),
      String(DEFAULT_SWIPE_DURATION_MS),
    ]);
    timer.mark('swipe');
    if (swipeResp.isError) {
      return failResult(
        `scrollintoview: swipe failed at iteration ${i}: ${swipeResp.content?.[0]?.text ?? 'unknown'}`,
      );
    }
  }
  return failResult(
    `scrollintoview: target "${args.ref ?? args.text}" did not enter viewport after ${MAX_ITERATIONS} swipe iterations`,
    { code: 'SCROLL_EXHAUSTED', iterations: MAX_ITERATIONS },
  );
}

// --- Pinch ---

interface PinchArgs {
  scale: number;
  x?: number;
  y?: number;
}

export function createDevicePinchHandler(): (args: PinchArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['pinch', String(args.scale)];
    if (args.x != null && args.y != null) {
      cliArgs.push(String(args.x), String(args.y));
    }
    return runNative(cliArgs);
  });
}

// --- Back ---

export function createDeviceBackHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return withSession(() => runNative(['back']));
}

// --- Focus Next (keyboard Next/Return button) ---

// Label priority order: "Go" and "Done" first because they are less likely to
// appear on in-app navigation buttons than "Next", reducing false-positive taps
// on wizard/form navigation buttons. Callers with a visible in-app "Next" button
// should use device_press on the next input @ref directly instead of this tool.
const NEXT_KEY_LABELS = ['Go', 'Done', 'Return', 'Next'];

export function createDeviceFocusNextHandler(): (
  args: Record<string, never>,
) => Promise<ToolResult> {
  return withSession(async () => {
    // Single snapshot + local scan beats iterating agent-device find calls.
    // Benchmark data: 4 serial finds = 10-22s on no-keyboard case; single
    // snapshot = 3-5s on the same case. Also more reliable — one accessibility
    // query races keyboard animations less than four sequential queries.
    const snap = await fetchSnapshotNodes();
    if (!snap.ok) {
      if (snap.reason === 'runner-leak-unrecovered') {
        return runnerLeakFailResult(undefined, snap.recoveryReason);
      }
      if (snap.reason === 'empty-capture') {
        return emptyCaptureFailResult();
      }
      return failResult(
        'Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.',
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }

    const { nodes, recoveredTier } = snap;
    for (const label of NEXT_KEY_LABELS) {
      const match = nodes.find((n) => n.label === label);
      if (!match) continue;
      const pressResult = await runNative(['press', `@${match.ref}`]);
      if (pressResult.isError) continue; // Match found but tap failed — try next label
      try {
        const envelope = JSON.parse(pressResult.content[0].text) as { ok: true; data: unknown };
        const meta: Record<string, unknown> = { keyUsed: label, ref: match.ref };
        if (recoveredTier) {
          meta.recovered = 'agent-device-runner-leak';
          meta.recoveryTier = recoveredTier;
        }
        return okResult(envelope.data, { meta });
      } catch {
        return pressResult;
      }
    }

    return failResult(
      `No keyboard ${NEXT_KEY_LABELS.join('/')} key visible in the accessibility tree. Tried: ${NEXT_KEY_LABELS.join(', ')}`,
      {
        code: 'KEYBOARD_NEXT_NOT_FOUND',
        hint: 'Keyboard may be dismissed, or the field may be the last in the form. If an in-app "Next" button is visible, prefer device_press on the next input @ref directly.',
      },
    );
  });
}

// --- TS-side orchestrators for `find` and `scrollintoview` (GH #105 / rn-device iOS-MVP) ---
//
// These pure helpers replace what the external CLI tier used to do on iOS.
// The runner (rn-fast-runner) exposes raw `tap` / `swipe` / `snapshot` but not
// `find` or `scrollintoview` — we own that orchestration here. See spec §3.4.

/**
 * GH #105 / rn-device iOS-MVP: TypeScript implementation of `find`.
 * Used by device_find. Replaces external CLI's `find` command.
 *
 * Matches against (in priority order): exact label, exact identifier,
 * substring label, substring identifier. Returns the first match by
 * traversal order from the snapshot (depth-first).
 */
export function findInLatestSnapshot(
  nodes: FlatNode[],
  query: string,
  opts: { exact?: boolean } = {},
): FlatNode | null {
  const exact = opts.exact ?? false;
  for (const n of nodes) {
    if (n.label === query || n.identifier === query) return n;
  }
  if (exact) return null;
  for (const n of nodes) {
    if (n.label?.includes(query) || n.identifier?.includes(query)) return n;
  }
  return null;
}

interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Element fully or partially intersects the screen rect. */
export function isInViewport(element: ViewportRect, screen: ViewportRect): boolean {
  const elRight = element.x + element.width;
  const elBottom = element.y + element.height;
  const screenRight = screen.x + screen.width;
  const screenBottom = screen.y + screen.height;
  return (
    element.x < screenRight && elRight > screen.x && element.y < screenBottom && elBottom > screen.y
  );
}

/** Choose a swipe direction that should bring `element` into the screen. Returns null when already visible. */
export function decideScrollDirection(
  element: ViewportRect,
  screen: ViewportRect,
): 'up' | 'down' | 'left' | 'right' | null {
  if (isInViewport(element, screen)) return null;
  if (element.y >= screen.y + screen.height) return 'up';
  if (element.y + element.height <= screen.y) return 'down';
  if (element.x >= screen.x + screen.width) return 'left';
  if (element.x + element.width <= screen.x) return 'right';
  return null;
}
