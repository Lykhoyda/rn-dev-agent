import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, getActiveSession, getCachedScreenRect, getAdbSerial, cacheSnapshot } from '../agent-device-wrapper.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';

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

async function fetchSnapshotNodes(): Promise<SnapshotNode[] | null> {
  try {
    const snapshotResult = await runAgentDevice(['snapshot', '-i']);
    if (snapshotResult.isError) return null;
    const envelope = JSON.parse(snapshotResult.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: SnapshotNode[] };
    };
    if (!envelope.ok || !envelope.data?.nodes) return null;
    const nodes = envelope.data.nodes;
    const platform = getActiveSession()?.platform;
    if (platform) cacheSnapshot(platform, nodes);
    return nodes;
  } catch {
    return null;
  }
}

async function fetchFindCandidates(query: string, exact: boolean): Promise<FindCandidate[] | null> {
  const nodes = await fetchSnapshotNodes();
  if (!nodes) return null;
  const needle = query.toLowerCase();
  return nodes
    .filter((n) => {
      const label = n.label ?? '';
      const id = n.identifier ?? '';
      if (exact) return label === query || id === query;
      return label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
    })
    .slice(0, 10)
    .map(candidateFromNode);
}

async function pressCandidate(candidate: FindCandidate, action?: string): Promise<ToolResult> {
  const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
  if (action === 'click') {
    return runAgentDevice(['press', ref]);
  }
  return okResult({ ref: candidate.ref, label: candidate.label, testID: candidate.testID });
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
      const candidates = await fetchFindCandidates(args.text, args.exact === true);
      if (candidates === null) {
        // Snapshot failed and caller has strict requirements — do NOT fall through
        // to the fuzzy agent-device path because it cannot honor exact/index. Fail
        // cleanly so the caller knows exact/index semantics aren't reachable.
        return failResult(
          `Snapshot unavailable — cannot resolve ${args.exact ? 'exact' : 'index-based'} match for "${args.text}". Retry after device_snapshot action=open/snapshot.`,
          { code: 'SNAPSHOT_UNAVAILABLE', query: args.text },
        );
      }
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
        return pressCandidate(candidates[args.index], args.action);
      }
      // exact=true, no index: require single match
      if (candidates.length === 1) {
        return pressCandidate(candidates[0], args.action);
      }
      return failResult(
        `AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`,
        { code: 'AMBIGUOUS_MATCH', query: args.text, candidates, hint: 'Add index: N to pick one.' },
      );
    }

    const cliArgs = ['find', args.text];
    if (args.action) cliArgs.push(args.action);
    const result = await runAgentDevice(cliArgs);

    // B92 fix: On AMBIGUOUS_MATCH, fetch a snapshot and return disambiguation candidates.
    if (result.isError) {
      const text = result.content?.[0]?.text ?? '';
      if (text.includes('AMBIGUOUS_MATCH') || (text.includes('matched') && text.includes('elements'))) {
        const candidates = await fetchFindCandidates(args.text, false);
        if (candidates) {
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
    }
    return result;
  });
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

export function createDeviceFillHandler(): (args: FillArgs) => Promise<ToolResult> {
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

    // G6: Always tap before fill so keyboard focus lands on this @ref, even in sequential
    // press+fill+press+fill flows where the previous call left focus on a different field.
    const preTap = await runAgentDevice(['press', ref]);
    if (preTap.isError) {
      // If we can't even tap the element, fall straight through to fill — it may still
      // work via the fast-runner coordinate path, and we want its error message, not ours.
    } else {
      await sleep(FOCUS_DELAY_MS);
    }

    const primary = await runAgentDevice(['fill', ref, args.text]);
    if (!primary.isError) {
      return primary;
    }

    // G4: Fallback chain for "no focused text input to clear" and similar focus errors.
    if (!isNoFocusedInputError(primary)) {
      return primary;
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

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.x1 != null && args.y1 != null && args.x2 != null && args.y2 != null) {
      const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runAgentDevice(cliArgs);
    }
    if (args.direction) {
      // B-Tier3 fix: Use real swipe gesture (not scroll) for direction-based swipes.
      // The previous delegation to `scroll` produced smooth list scrolls that don't
      // trigger gesture handlers (pull-to-refresh, swipe-to-delete).
      const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
      const coords = computeSwipeFromDirection(args.direction, screen);
      const duration = args.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
      const cliArgs = ['swipe', String(coords.x1), String(coords.y1), String(coords.x2), String(coords.y2), String(duration)];
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runAgentDevice(cliArgs);
    }
    return Promise.resolve(failResult('Provide either direction or x1,y1,x2,y2 coordinates'));
  });
}

// --- Scroll ---

interface ScrollArgs {
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
}

export function createDeviceScrollHandler(): (args: ScrollArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['scroll', args.direction];
    if (args.amount != null) cliArgs.push(String(args.amount));
    return runAgentDevice(cliArgs);
  });
}

// --- Scroll Into View ---

interface ScrollIntoViewArgs {
  text?: string;
  ref?: string;
}

export function createDeviceScrollIntoViewHandler(): (args: ScrollIntoViewArgs) => Promise<ToolResult> {
  return withSession((args) => {
    if (args.ref) {
      const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
      return runAgentDevice(['scrollintoview', ref]);
    }
    if (args.text) {
      return runAgentDevice(['scrollintoview', args.text]);
    }
    return Promise.resolve(failResult('Provide either text or ref to scroll into view'));
  });
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
    const nodes = await fetchSnapshotNodes();
    if (!nodes) {
      return failResult(
        'Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.',
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }

    for (const label of NEXT_KEY_LABELS) {
      const match = nodes.find((n) => n.label === label);
      if (!match) continue;
      const pressResult = await runAgentDevice(['press', `@${match.ref}`]);
      if (pressResult.isError) continue; // Match found but tap failed — try next label
      try {
        const envelope = JSON.parse(pressResult.content[0].text) as { ok: true; data: unknown };
        return okResult(envelope.data, { meta: { keyUsed: label, ref: match.ref } });
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
