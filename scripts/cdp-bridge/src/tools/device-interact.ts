import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, getActiveSession, getCachedScreenRect, getAdbSerial, cacheSnapshot } from '../agent-device-wrapper.js';
import { isFastRunnerAvailable, fastSwipe } from '../runners/rn-fast-runner-client.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, createStepTimer } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak } from './runner-leak-recovery.js';
import type { RecoveryTier } from './runner-leak-recovery.js';
import { reopenSessionForRecovery } from './device-session.js';
import type { FlatNode } from '../fast-runner-ref-map.js';
import type { CDPClient } from '../cdp-client.js';
import { getCachedMetadata } from '../fast-runner-ref-map.js';
import { resolveJsTestId, attemptJsFill, type FillVerifyOutcome } from './fill-verify.js';

const execFile = promisify(execFileCb);

const ANDROID_UNSAFE_CHARS = /[+@#$%^&*(){}|\\<>~`[\]?*]/;
const ANDROID_FILL_MAX_SAFE_LEN = 30;

interface SnapshotNode {
  ref: string;
  label?: string;
  identifier?: string;
  type?: string;
  hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

interface FindCandidate {
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
//   1. hittable: true beats hittable: false (XCUITest's hittable flag
//      means "directly tappable" — the most reliable tap-intent signal).
//   2. Element-type priority for tap intent: Button/Cell/Switch >
//      Other/Link > StaticText/Image > ScrollView. Containers like
//      ScrollView are usually parents of the real tap target.
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
    score: (node.hittable === true ? 1000 : 0) + typePriority(node.type),
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
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

async function fetchSnapshotNodes(): Promise<SnapshotFetchResult> {
  const first = await runAgentDevice(['snapshot', '-i']);
  const initialNodes = parseSnapshotEnvelope(first);
  if (initialNodes === null) return { ok: false, reason: 'fetch-failed' };

  if (!isAgentDeviceRunnerSentinel(initialNodes)) {
    const platform = getActiveSession()?.platform;
    if (platform) cacheSnapshot(platform, initialNodes);
    return { ok: true, nodes: initialNodes };
  }

  const session = getActiveSession();
  const recovery = await recoverFromRunnerLeak(
    { platform: session?.platform, appId: session?.appId, sessionName: session?.name },
    {
      closeSession: () => runAgentDevice(['close']),
      openSession: ({ appId, platform, attachOnly }) =>
        reopenSessionForRecovery(appId, platform, attachOnly),
      resnapshot: () => runAgentDevice(['snapshot', '-i']),
      parseNodes: parseSnapshotEnvelope,
    },
  );

  if (!recovery.recovered) {
    return { ok: false, reason: 'runner-leak-unrecovered', recoveryReason: recovery.reason };
  }

  const recoveredNodes = parseSnapshotEnvelope(recovery.result);
  if (recoveredNodes === null) return { ok: false, reason: 'fetch-failed' };

  const platform = getActiveSession()?.platform;
  if (platform) cacheSnapshot(platform, recoveredNodes);
  return { ok: true, nodes: recoveredNodes, recoveredTier: recovery.tier };
}

export type FindCandidatesResult =
  | { ok: true; candidates: FindCandidate[]; recoveredTier?: RecoveryTier }
  | { ok: false; reason: 'fetch-failed' }
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

async function fetchFindCandidates(query: string, exact: boolean): Promise<FindCandidatesResult> {
  const snap = await fetchSnapshotNodes();
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

async function pressCandidate(candidate: FindCandidate, action?: string): Promise<ToolResult> {
  const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
  if (action === 'click') {
    return runAgentDevice(['press', ref]);
  }
  return okResult({ ref: candidate.ref, label: candidate.label, testID: candidate.testID });
}

// B119: when an underlying snapshot triggered runner-leak recovery, surface
// that side-effect on the wrapping result so callers (LLM agents) know the
// app may have been relaunched and CDP/state may have been invalidated.
function tagPressIfRecovered(result: ToolResult, tier?: RecoveryTier): ToolResult {
  if (!tier || result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as { ok?: boolean; data?: unknown; meta?: Record<string, unknown> };
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

export function createDeviceFindHandler(): (args: FindArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // Fast path when caller already knows they want exact or a specific index:
    // go straight to a snapshot-based client-side match so we never roll the dice
    // on agent-device's fuzzy matcher returning AMBIGUOUS_MATCH.
    if (args.exact === true || args.index !== undefined) {
      const find = await fetchFindCandidates(args.text, args.exact === true);
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
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
        return failResult(
          `No element matches "${args.text}" (exact=${args.exact === true})`,
          { code: 'NOT_FOUND', query: args.text },
        );
      }
      if (args.index !== undefined) {
        if (args.index < 0 || args.index >= candidates.length) {
          return failResult(
            `index ${args.index} out of range (got ${candidates.length} candidates)`,
            { code: 'INDEX_OUT_OF_RANGE', count: candidates.length, candidates },
          );
        }
        return tagPressIfRecovered(await pressCandidate(candidates[args.index], args.action), recoveredTier);
      }
      // exact=true, no index: require single match
      if (candidates.length === 1) {
        return tagPressIfRecovered(await pressCandidate(candidates[0], args.action), recoveredTier);
      }
      return failResult(
        `AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`,
        { code: 'AMBIGUOUS_MATCH', query: args.text, candidates, hint: 'Add index: N to pick one.' },
      );
    }

    // GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: route
    // non-exact text finds through the snapshot-based orchestrator on iOS
    // always and on Android (default-on; opt-out via RN_ANDROID_RUNNER=0).
    // The legacy CLI path would respawn the upstream agent-device daemon,
    // which fights our in-tree runner for focus / UIAutomator. Using
    // runAgentDevice + fetchFindCandidates keeps us on the platform-aware
    // short-circuit.
    const activeSession = getActiveSession();
    const usesInTreeRunner =
      activeSession?.platform === 'ios' ||
      (activeSession?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');
    if (usesInTreeRunner) {
      const find = await fetchFindCandidates(args.text, false);
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        return failResult(
          `Snapshot unavailable — cannot resolve "${args.text}"`,
          { code: 'SNAPSHOT_UNAVAILABLE', query: args.text },
        );
      }
      const { candidates, recoveredTier } = find;
      // Surface recoveredTier on every outcome (not just the single-match press)
      // so callers can tell the app was relaunched mid-find even on NOT_FOUND /
      // AMBIGUOUS.
      const recoveredMeta = recoveredTier ? { recoveredTier } : {};
      if (candidates.length === 0) {
        return failResult(`No element matches "${args.text}"`, { code: 'NOT_FOUND', query: args.text, ...recoveredMeta });
      }
      if (candidates.length === 1) {
        return tagPressIfRecovered(await pressCandidate(candidates[0], args.action), recoveredTier);
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

    const cliArgs = ['find', args.text];
    if (args.action) cliArgs.push(args.action);
    const result = await runAgentDevice(cliArgs);

    // B92 fix: On AMBIGUOUS_MATCH, fetch a snapshot and return disambiguation candidates.
    if (result.isError) {
      const text = result.content?.[0]?.text ?? '';
      if (text.includes('AMBIGUOUS_MATCH') || (text.includes('matched') && text.includes('elements'))) {
        const find = await fetchFindCandidates(args.text, false);
        if (!find.ok && find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.ok) {
          const candidates = find.candidates;
          return failResult(
            `AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements. Use device_press with one of these refs, or retry with index: N.`,
            {
              code: 'AMBIGUOUS_MATCH',
              query: args.text,
              candidates,
              hint: 'Pick the correct ref (prefer one with hittable=true) and call device_press(ref="...") directly, or call device_find again with index: N.',
            },
          );
        }
      }

      // GH #60 Bug 7: Maestro/agent-device daemon timeouts leave callers
      // staring at "Daemon error: daemon timeout" with no obvious recovery.
      // Try the snapshot-based fuzzy path as a self-recovery before giving up
      // — it routes through agent-device's daemon-less snapshot tier (or its
      // CLI fallback) and delivers a usable result without the user needing
      // to know the workaround.
      if (isDaemonTimeoutError(text)) {
        const find = await fetchFindCandidates(args.text, false);
        if (!find.ok && find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.ok) {
          const candidates = find.candidates;
          if (candidates.length === 0) {
            return failResult(
              `No element matches "${args.text}". Original daemon timeout: ${truncate(text, 200)}`,
              {
                code: 'NOT_FOUND',
                query: args.text,
                recovered_via: 'snapshot_fallback_after_daemon_timeout',
                hint: 'agent-device daemon timed out; recovered via snapshot but found no matches. Try cdp_interact with a testID instead.',
              },
            );
          }
          if (candidates.length === 1) {
            const pressed = tagPressIfRecovered(
              await pressCandidate(candidates[0], args.action),
              find.recoveredTier,
            );
            return mergeMeta(pressed, {
              recovered_via: 'snapshot_fallback_after_daemon_timeout',
              note: 'agent-device daemon timed out; recovered via snapshot-based match. If this repeats, restart the daemon (`agent-device daemon restart`) or use cdp_interact for testID-based interactions.',
            });
          }
          return failResult(
            `AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements (recovered via snapshot after daemon timeout).`,
            {
              code: 'AMBIGUOUS_MATCH',
              query: args.text,
              candidates,
              recovered_via: 'snapshot_fallback_after_daemon_timeout',
              hint: 'Pass index: N or use device_press(ref="...") directly. The snapshot fallback succeeded, but the daemon itself remains unhealthy — consider restarting it.',
            },
          );
        }
        // Snapshot fallback also failed — surface both error sources.
        return failResult(
          `agent-device daemon timed out AND snapshot fallback failed. Original: ${truncate(text, 200)}`,
          {
            code: 'DAEMON_TIMEOUT',
            query: args.text,
            hint: 'Restart the daemon (`agent-device daemon restart`) and retry, or fall back to cdp_interact with a testID.',
          },
        );
      }
    }
    return result;
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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function mergeMeta(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  if (result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: unknown;
      meta?: Record<string, unknown>;
    };
    envelope.meta = { ...envelope.meta, ...extra };
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch {
    return result;
  }
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
  ref: string;
  doubleTap?: boolean;
  count?: number;
  holdMs?: number;
  waitForFocusMs?: number;
}

export function createDevicePressHandler(): (args: PressArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const cliArgs = ['press', ref];
    if (args.doubleTap) cliArgs.push('--double-tap');
    if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
    if (args.holdMs && args.holdMs > 0) cliArgs.push('--hold-ms', String(args.holdMs));
    const result = await runAgentDevice(cliArgs);
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
}

export function createDeviceLongPressHandler(): (args: LongPressArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.ref) {
      const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
      const cliArgs = ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
      return runAgentDevice(cliArgs);
    }
    if (args.x != null && args.y != null) {
      const cliArgs = ['longpress', String(args.x), String(args.y)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      return runAgentDevice(cliArgs);
    }
    return Promise.resolve(failResult('Provide either ref or x+y coordinates'));
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
}

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
  const escaped = chunk
    .replace(/ /g, '%s')
    .replace(/'/g, "'\\''");
  return ['shell', 'input', 'text', `'${escaped}'`];
}

const ANDROID_INPUT_CHUNK_SIZE = 10;

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
const NO_FOCUSED_INPUT_RE = /no focused text input|no focused element|element is not focused/i;

function isNoFocusedInputError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  return NO_FOCUSED_INPUT_RE.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  return outcome === 'verified-exact' ? 'exact' : outcome === 'verified-transformed' ? 'transformed' : 'unverifiable';
}

async function maestroFillFallback(ref: string, text: string, platform: 'ios' | 'android'): Promise<ToolResult> {
  const escapedRef = yamlEscape(ref.replace(/^@/, ''));
  const escapedText = yamlEscape(text);
  const yaml = `- tapOn:\n    id: "${escapedRef}"\n- inputText: "${escapedText}"`;
  const result = await runMaestroInline(yaml, { platform, slug: 'fill-fallback', timeoutMs: 30_000 });
  if (result.passed) {
    return okResult({ filled: true, method: 'maestro', length: text.length }, { meta: { fallbackUsed: 'maestro' } });
  }
  return failResult(
    `device_fill fell through all fallbacks. Last error: ${result.error ?? result.output.slice(0, 200)}`,
    { code: 'FILL_FAILED', tried: ['primary', 'retap', platform === 'android' ? 'adb' : 'maestro'] },
  );
}

export function createDeviceFillHandler(getClient: () => CDPClient): (args: FillArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
    const androidSession = isAndroidSession();
    const needsAndroidWorkaround = androidSession && (
      args.text.length > ANDROID_FILL_MAX_SAFE_LEN ||
      ANDROID_UNSAFE_CHARS.test(args.text)
    );

    // Android workaround path: press + chunked adb input. Short-circuits — no fallback
    // chain needed because the Android path is already a fallback for agent-device fill.
    if (needsAndroidWorkaround) {
      const pressResult = await runAgentDevice(['press', ref]);
      if (pressResult.isError) return pressResult;
      await sleep(300);
      return androidClipboardFill(args.text);
    }

    // #191 prong 1 — JS-first dispatch. Opportunistic: CDP connected AND ref→testID.
    const client = cdpClientOrNull(getClient);
    const cachedIdentifier = getCachedMetadata(ref.replace(/^@/, ''))?.identifier;
    const jsTestId = client ? resolveJsTestId(ref, { explicitTestId: args.testID, cachedIdentifier }) : null;
    if (client && jsTestId) {
      const tJs = Date.now();
      const js = await attemptJsFill({ evaluate: (e) => client.evaluate(e) }, jsTestId, args.text);
      if (js.handled && js.outcome && js.outcome !== 'corrupted') {
        return okResult(
          { filled: true, method: 'js-onChangeText', length: args.text.length, value: js.valueAfter ?? null },
          { meta: { textEntryPath: 'js', verify: jsVerifyMeta(js.outcome), handler: js.handler,
                    timings_ms: { jsType: Date.now() - tJs } } },
        );
      }
    }

    const focusWaitMs = args.waitForKeyboardMs ?? FOCUS_DELAY_MS;

    // G6: Always tap before fill so keyboard focus lands on this @ref, even in sequential
    // press+fill+press+fill flows where the previous call left focus on a different field.
    const preTap = await runAgentDevice(['press', ref]);
    if (preTap.isError) {
      // If we can't even tap the element, fall straight through to fill — it may still
      // work via the fast-runner coordinate path, and we want its error message, not ours.
    } else {
      await sleep(focusWaitMs);
    }

    const primary = await runAgentDevice(['fill', ref, args.text]);
    if (!primary.isError) {
      return primary;
    }

    // G4: Fallback chain for "no focused text input to clear" and similar focus errors.
    if (!isNoFocusedInputError(primary)) {
      return primary;
    }

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
        const innerTap = await runAgentDevice(['press', resolvedRef]);
        if (!innerTap.isError) {
          await sleep(focusWaitMs);
          const resolved = await runAgentDevice(['fill', resolvedRef, args.text]);
          if (!resolved.isError) {
            try {
              const envelope = JSON.parse(resolved.content[0].text) as { ok: true; data: unknown };
              return okResult(envelope.data, { meta: { fallbackUsed: 'pressable-resolution', resolvedRef } });
            } catch {
              return resolved;
            }
          }
        }
      }
    }

    // Fallback 1: coordinate re-tap + retry fill. Re-tap gives the UI another chance
    // to propagate focus from a wrapping Pressable to the inner TextInput.
    const retryTap = await runAgentDevice(['press', ref]);
    if (!retryTap.isError) {
      await sleep(300);
      const retry = await runAgentDevice(['fill', ref, args.text]);
      if (!retry.isError) {
        // Re-wrap the okResult to attach the fallback marker.
        try {
          const envelope = JSON.parse(retry.content[0].text) as { ok: true; data: unknown };
          return okResult(envelope.data, { meta: { fallbackUsed: 'retap' } });
        } catch {
          return retry;
        }
      }
    }

    // Fallback 2: platform-specific last resort.
    if (androidSession) {
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
    return maestroFillFallback(ref, args.text, platform);
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
    case 'down': return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy };
    // "swipe up" means finger moves from bottom to top
    case 'up': return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy };
    case 'left': return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy };
    case 'right': return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy };
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
  return ['swipe', String(coords.x1), String(coords.y1), String(coords.x2), String(coords.y2), String(duration)];
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
    case 'down': return { x1: cx, y1: cy + Math.round(dy / 2), x2: cx, y2: cy - Math.round(dy / 2) };
    case 'up': return { x1: cx, y1: cy - Math.round(dy / 2), x2: cx, y2: cy + Math.round(dy / 2) };
    case 'left': return { x1: cx + Math.round(dx / 2), y1: cy, x2: cx - Math.round(dx / 2), y2: cy };
    case 'right': return { x1: cx - Math.round(dx / 2), y1: cy, x2: cx + Math.round(dx / 2), y2: cy };
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
  return ['scroll', String(coords.x1), String(coords.y1), String(coords.x2), String(coords.y2), String(duration)];
}

export function exactModeRejectionMessage(reason: 'fast-runner-unavailable' | 'count-pattern-incompatible'): string {
  if (reason === 'count-pattern-incompatible') {
    return 'exact: true is incompatible with count/pattern (those route through agent-device daemon which enforces safe-normalized timing). Drop count/pattern or drop exact.';
  }
  return 'exact: true requires fast-runner (iOS only, session must be open). Fast-runner unavailable — open a device session via device_snapshot action=open, then retry.';
}

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // B106 fix: use fast-runner's HID-level synthesis to bypass XCTest
    // `waitForIdle` hangs on Reanimated-driven screens. Only applies when
    // fast-runner is available (iOS) and count/pattern are not used (those
    // are daemon-specific features — fall back to agent-device for them).
    const canUseFastRunner = isFastRunnerAvailable() && !args.count && !args.pattern;

    // B123: exact: true requires fast-runner. Fail loud if unavailable instead
    // of silently degrading to a 60ms-capped daemon swipe.
    if (args.exact === true) {
      if (args.count || args.pattern) {
        return failResult(
          exactModeRejectionMessage('count-pattern-incompatible'),
          { code: 'EXACT_INCOMPATIBLE', hint: 'count and pattern only work via agent-device daemon, which enforces safe-normalized timing. Drop one to proceed.' },
        );
      }
      if (!isFastRunnerAvailable()) {
        return failResult(
          exactModeRejectionMessage('fast-runner-unavailable'),
          { code: 'EXACT_REQUIRES_FAST_RUNNER', hint: 'fast-runner is the only path that respects user-supplied durationMs verbatim. Open a device session first.' },
        );
      }
    }

    if (args.x1 != null && args.y1 != null && args.x2 != null && args.y2 != null) {
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(args.x1, args.y1, args.x2, args.y2, args.durationMs);
          if (resp.ok) {
            return okResult({ x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs, method: 'fast-runner' });
          }
          if (args.exact === true) {
            return failResult('fast-runner swipe call failed and exact: true forbids daemon fallback', { code: 'EXACT_FAST_RUNNER_FAILED' });
          }
        } catch (err) {
          if (args.exact === true) {
            return failResult(`fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`, { code: 'EXACT_FAST_RUNNER_FAILED' });
          }
          /* fall through */
        }
      }
      const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runAgentDevice(cliArgs);
    }
    if (args.direction) {
      // B-Tier3 fix: Use real swipe gesture (not scroll) for direction-based swipes.
      const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
      const coords = computeSwipeFromDirection(args.direction, screen);
      const duration = args.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(coords.x1, coords.y1, coords.x2, coords.y2, duration);
          if (resp.ok) {
            return okResult({ direction: args.direction, durationMs: duration, method: 'fast-runner', ...coords });
          }
          if (args.exact === true) {
            return failResult('fast-runner swipe call failed and exact: true forbids daemon fallback', { code: 'EXACT_FAST_RUNNER_FAILED' });
          }
        } catch (err) {
          if (args.exact === true) {
            return failResult(`fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`, { code: 'EXACT_FAST_RUNNER_FAILED' });
          }
          /* fall through */
        }
      }
      const cliArgs = ['swipe', String(coords.x1), String(coords.y1), String(coords.x2), String(coords.y2), String(duration)];
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runAgentDevice(cliArgs);
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
    if (isFastRunnerAvailable()) {
      try {
        const resp = await fastSwipe(x1, y1, x2, y2, DEFAULT_SWIPE_DURATION_MS);
        if (resp.ok) {
          return okResult({ direction: args.direction, amount: args.amount ?? 0.5, method: 'fast-runner', x1, y1, x2, y2 });
        }
        // Fall through to daemon on fast-runner failure
      } catch {
        // Fall through to daemon on fast-runner error
      }
    }
    // Daemon / Android fallthrough: dispatch the COORDINATE form. The arg
    // builders throw on the raw direction form, so this previously crashed on
    // Android (always) and on the iOS fast-runner fallback.
    return runAgentDevice(buildDirectionalScrollCliArgs(args.direction, args.amount));
  });
}

// --- Scroll Into View ---

interface ScrollIntoViewArgs {
  text?: string;
  ref?: string;
}

export function createDeviceScrollIntoViewHandler(): (args: ScrollIntoViewArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    if (!args.ref && !args.text) {
      return failResult('Provide either text or ref to scroll into view');
    }
    // GH #105 iOS-MVP follow-up: the Swift runner has no `scrollintoview`
    // command; this is TS-orchestrated on iOS (snapshot → find → swipe loop).
    // Task 8 of the Android MVP plan extends the same orchestrator to
    // Android (default-on; opt-out via RN_ANDROID_RUNNER=0) — the snapshot
    // + swipe verbs route through the platform-aware short-circuit in
    // runAgentDevice so this function is platform-neutral. The in-tree
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
 * viewport → swipe up to MAX_ITERATIONS times. Uses runAgentDevice for both
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
    const snapRes = await runAgentDevice(['snapshot', '-i']);
    timer.mark('snapshot');
    if (snapRes.isError) {
      return failResult(
        `scrollintoview: snapshot failed at iteration ${i}: ${snapRes.content?.[0]?.text ?? 'unknown'}`,
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }
    let nodes: FlatNode[] = [];
    try {
      const envelope = JSON.parse(snapRes.content?.[0]?.text ?? '{}') as { data?: { nodes?: FlatNode[] } };
      nodes = envelope.data?.nodes ?? [];
    } catch {
      return failResult(`scrollintoview: failed to parse snapshot envelope at iteration ${i}`);
    }
    const target = args.ref
      ? nodes.find((n) => n.ref === (args.ref!.startsWith('@') ? args.ref : `@${args.ref!}`)) ?? null
      : findInLatestSnapshot(nodes, args.text!);
    if (!target) {
      // Element not in snapshot at all; can't decide direction. Probably needs
      // initial scroll. Default to swiping up (down-direction-of-content) once
      // and retry — common case is reaching a below-fold element.
      if (i === 0) {
        const fallbackDir = decideScrollDirection({ x: 0, y: screen.height * 2, width: 1, height: 1 }, screenRect);
        const coords = computeSwipeFromDirection(fallbackDir ?? 'down', screen);
        await runAgentDevice([
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
    const swipeResp = await runAgentDevice([
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
    return runAgentDevice(cliArgs);
  });
}

// --- Back ---

export function createDeviceBackHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return withSession(() => runAgentDevice(['back']));
}

// --- Focus Next (keyboard Next/Return button) ---

// Label priority order: "Go" and "Done" first because they are less likely to
// appear on in-app navigation buttons than "Next", reducing false-positive taps
// on wizard/form navigation buttons. Callers with a visible in-app "Next" button
// should use device_press on the next input @ref directly instead of this tool.
const NEXT_KEY_LABELS = ['Go', 'Done', 'Return', 'Next'];

export function createDeviceFocusNextHandler(): (args: Record<string, never>) => Promise<ToolResult> {
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
      return failResult(
        'Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.',
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }

    const { nodes, recoveredTier } = snap;
    for (const label of NEXT_KEY_LABELS) {
      const match = nodes.find((n) => n.label === label);
      if (!match) continue;
      const pressResult = await runAgentDevice(['press', `@${match.ref}`]);
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

interface ViewportRect { x: number; y: number; width: number; height: number }

/** Element fully or partially intersects the screen rect. */
export function isInViewport(element: ViewportRect, screen: ViewportRect): boolean {
  const elRight = element.x + element.width;
  const elBottom = element.y + element.height;
  const screenRight = screen.x + screen.width;
  const screenBottom = screen.y + screen.height;
  return (
    element.x < screenRight &&
    elRight > screen.x &&
    element.y < screenBottom &&
    elBottom > screen.y
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
