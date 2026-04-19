import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentDevice, getActiveSession, getCachedScreenRect, getAdbSerial, cacheSnapshot } from '../agent-device-wrapper.js';
import { isFastRunnerAvailable, fastSwipe } from '../fast-runner-session.js';
import { withSession } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak } from './runner-leak-recovery.js';
import { reopenSessionForRecovery } from './device-session.js';
const execFile = promisify(execFileCb);
const ANDROID_UNSAFE_CHARS = /[+@#$%^&*(){}|\\<>~`[\]?*]/;
const ANDROID_FILL_MAX_SAFE_LEN = 30;
function candidateFromNode(n) {
    return {
        ref: n.ref,
        label: n.label,
        testID: n.identifier,
        type: n.type,
        hittable: n.hittable,
        position: n.rect ? { x: n.rect.x, y: n.rect.y } : undefined,
    };
}
function parseSnapshotEnvelope(result) {
    if (result.isError)
        return null;
    try {
        const envelope = JSON.parse(result.content[0].text);
        if (!envelope.ok || !envelope.data?.nodes)
            return null;
        return envelope.data.nodes;
    }
    catch {
        return null;
    }
}
async function fetchSnapshotNodes() {
    const first = await runAgentDevice(['snapshot', '-i']);
    const initialNodes = parseSnapshotEnvelope(first);
    if (initialNodes === null)
        return { ok: false, reason: 'fetch-failed' };
    if (!isAgentDeviceRunnerSentinel(initialNodes)) {
        const platform = getActiveSession()?.platform;
        if (platform)
            cacheSnapshot(platform, initialNodes);
        return { ok: true, nodes: initialNodes };
    }
    const session = getActiveSession();
    const recovery = await recoverFromRunnerLeak({ platform: session?.platform, appId: session?.appId, sessionName: session?.name }, {
        closeSession: () => runAgentDevice(['close']),
        openSession: ({ appId, platform, attachOnly }) => reopenSessionForRecovery(appId, platform, attachOnly),
        resnapshot: () => runAgentDevice(['snapshot', '-i']),
        parseNodes: parseSnapshotEnvelope,
    });
    if (!recovery.recovered) {
        return { ok: false, reason: 'runner-leak-unrecovered', recoveryReason: recovery.reason };
    }
    const recoveredNodes = parseSnapshotEnvelope(recovery.result);
    if (recoveredNodes === null)
        return { ok: false, reason: 'fetch-failed' };
    const platform = getActiveSession()?.platform;
    if (platform)
        cacheSnapshot(platform, recoveredNodes);
    return { ok: true, nodes: recoveredNodes, recoveredTier: recovery.tier };
}
async function fetchFindCandidates(query, exact) {
    const snap = await fetchSnapshotNodes();
    if (!snap.ok)
        return snap;
    const needle = query.toLowerCase();
    const candidates = snap.nodes
        .filter((n) => {
        const label = n.label ?? '';
        const id = n.identifier ?? '';
        if (exact)
            return label === query || id === query;
        return label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
    })
        .slice(0, 10)
        .map(candidateFromNode);
    return { ok: true, candidates, recoveredTier: snap.recoveredTier };
}
function runnerLeakFailResult(query, recoveryReason) {
    const queryHint = query ? ` (while resolving "${query}")` : '';
    return failResult(`device_find/snapshot returned AgentDeviceRunner's own UI tree instead of the target app${queryHint} (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.`, {
        code: 'RUNNER_LEAK',
        recoveryReason,
        hint: 'Manually close + reopen the session with device_snapshot action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). The recovery may have killed the JS context — re-establish CDP via cdp_connect before reading state. Upstream: Callstack/agent-device, see B119/GH#35.',
    });
}
async function pressCandidate(candidate, action) {
    const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
    if (action === 'click') {
        return runAgentDevice(['press', ref]);
    }
    return okResult({ ref: candidate.ref, label: candidate.label, testID: candidate.testID });
}
// B119: when an underlying snapshot triggered runner-leak recovery, surface
// that side-effect on the wrapping result so callers (LLM agents) know the
// app may have been relaunched and CDP/state may have been invalidated.
function tagPressIfRecovered(result, tier) {
    if (!tier || result.isError)
        return result;
    try {
        const envelope = JSON.parse(result.content[0].text);
        envelope.meta = { ...envelope.meta, recovered: 'agent-device-runner-leak', recoveryTier: tier };
        return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    }
    catch {
        return result;
    }
}
export function createDeviceFindHandler() {
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
                return failResult(`Snapshot unavailable — cannot resolve ${args.exact ? 'exact' : 'index-based'} match for "${args.text}". Retry after device_snapshot action=open/snapshot.`, { code: 'SNAPSHOT_UNAVAILABLE', query: args.text });
            }
            const { candidates, recoveredTier } = find;
            if (candidates.length === 0) {
                return failResult(`No element matches "${args.text}" (exact=${args.exact === true})`, { code: 'NOT_FOUND', query: args.text });
            }
            if (args.index !== undefined) {
                if (args.index < 0 || args.index >= candidates.length) {
                    return failResult(`index ${args.index} out of range (got ${candidates.length} candidates)`, { code: 'INDEX_OUT_OF_RANGE', count: candidates.length, candidates });
                }
                return tagPressIfRecovered(await pressCandidate(candidates[args.index], args.action), recoveredTier);
            }
            // exact=true, no index: require single match
            if (candidates.length === 1) {
                return tagPressIfRecovered(await pressCandidate(candidates[0], args.action), recoveredTier);
            }
            return failResult(`AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`, { code: 'AMBIGUOUS_MATCH', query: args.text, candidates, hint: 'Add index: N to pick one.' });
        }
        const cliArgs = ['find', args.text];
        if (args.action)
            cliArgs.push(args.action);
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
                    return failResult(`AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements. Use device_press with one of these refs, or retry with index: N.`, {
                        code: 'AMBIGUOUS_MATCH',
                        query: args.text,
                        candidates,
                        hint: 'Pick the correct ref (prefer one with hittable=true) and call device_press(ref="...") directly, or call device_find again with index: N.',
                    });
                }
            }
        }
        return result;
    });
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
export function findInputForPressable(nodes, pressableRef) {
    if (!nodes)
        return null;
    const cleanRef = pressableRef.replace(/^@/, '');
    const pressableNode = nodes.find((n) => n.ref === cleanRef);
    if (!pressableNode?.identifier?.endsWith(PRESSABLE_SUFFIX))
        return null;
    const baseId = pressableNode.identifier.slice(0, -PRESSABLE_SUFFIX.length);
    if (!baseId)
        return null;
    const inputNode = nodes.find((n) => n.identifier === baseId && n.type !== undefined && TEXT_INPUT_TYPES.has(n.type));
    return inputNode ? `@${inputNode.ref}` : null;
}
export function createDevicePressHandler() {
    return withSession(async (args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        const cliArgs = ['press', ref];
        if (args.doubleTap)
            cliArgs.push('--double-tap');
        if (args.count && args.count > 1)
            cliArgs.push('--count', String(args.count));
        if (args.holdMs && args.holdMs > 0)
            cliArgs.push('--hold-ms', String(args.holdMs));
        const result = await runAgentDevice(cliArgs);
        if (!result.isError && args.waitForFocusMs && args.waitForFocusMs > 0) {
            await new Promise((r) => setTimeout(r, args.waitForFocusMs));
        }
        return result;
    });
}
export function createDeviceLongPressHandler() {
    return withSession((args) => {
        if (args.ref) {
            const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
            const cliArgs = ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
            return runAgentDevice(cliArgs);
        }
        if (args.x != null && args.y != null) {
            const cliArgs = ['longpress', String(args.x), String(args.y)];
            if (args.durationMs)
                cliArgs.push(String(args.durationMs));
            return runAgentDevice(cliArgs);
        }
        return Promise.resolve(failResult('Provide either ref or x+y coordinates'));
    });
}
// Splits a chunk into segments where no segment, after space→%s encoding,
// will contain a user-literal %s. Android's `input text` interprets %s as
// space — the ONLY special sequence it recognizes (empirically verified:
// %%, %p, %n, %d, %t, %S, lone %, trailing % all pass through literally).
// There is no escape mechanism (no %% → %, no \%s). The fix (B97) is to
// ensure % and s from user text never appear adjacent in the same `input
// text` call: send % alone, then s... in the next call.
export function splitChunkAroundPercentS(chunk) {
    const parts = chunk.split('%s');
    if (parts.length === 1)
        return [chunk];
    const segments = [];
    for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
            segments.push('%');
            const rest = 's' + parts[i];
            if (rest.length > 0)
                segments.push(rest);
        }
        else if (parts[i].length > 0) {
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
export function buildAdbInputTextArgv(chunk) {
    const escaped = chunk
        .replace(/ /g, '%s')
        .replace(/'/g, "'\\''");
    return ['shell', 'input', 'text', `'${escaped}'`];
}
const ANDROID_INPUT_CHUNK_SIZE = 10;
async function androidClipboardFill(text) {
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(`Android text input failed: ${msg}`);
    }
}
function isAndroidSession() {
    const session = getActiveSession();
    if (session?.platform === 'android')
        return true;
    if (session?.platform)
        return false;
    return !!process.env.ANDROID_SERIAL;
}
const FOCUS_DELAY_MS = 150;
const NO_FOCUSED_INPUT_RE = /no focused text input|no focused element|element is not focused/i;
function isNoFocusedInputError(result) {
    if (!result.isError)
        return false;
    const text = result.content?.[0]?.text ?? '';
    return NO_FOCUSED_INPUT_RE.test(text);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function maestroFillFallback(ref, text, platform) {
    const escapedRef = yamlEscape(ref.replace(/^@/, ''));
    const escapedText = yamlEscape(text);
    const yaml = `- tapOn:\n    id: "${escapedRef}"\n- inputText: "${escapedText}"`;
    const result = await runMaestroInline(yaml, { platform, slug: 'fill-fallback', timeoutMs: 30_000 });
    if (result.passed) {
        return okResult({ filled: true, method: 'maestro', length: text.length }, { meta: { fallbackUsed: 'maestro' } });
    }
    return failResult(`device_fill fell through all fallbacks. Last error: ${result.error ?? result.output.slice(0, 200)}`, { code: 'FILL_FAILED', tried: ['primary', 'retap', platform === 'android' ? 'adb' : 'maestro'] });
}
export function createDeviceFillHandler() {
    return withSession(async (args) => {
        const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
        const androidSession = isAndroidSession();
        const needsAndroidWorkaround = androidSession && (args.text.length > ANDROID_FILL_MAX_SAFE_LEN ||
            ANDROID_UNSAFE_CHARS.test(args.text));
        // Android workaround path: press + chunked adb input. Short-circuits — no fallback
        // chain needed because the Android path is already a fallback for agent-device fill.
        if (needsAndroidWorkaround) {
            const pressResult = await runAgentDevice(['press', ref]);
            if (pressResult.isError)
                return pressResult;
            await sleep(300);
            return androidClipboardFill(args.text);
        }
        const focusWaitMs = args.waitForKeyboardMs ?? FOCUS_DELAY_MS;
        // G6: Always tap before fill so keyboard focus lands on this @ref, even in sequential
        // press+fill+press+fill flows where the previous call left focus on a different field.
        const preTap = await runAgentDevice(['press', ref]);
        if (preTap.isError) {
            // If we can't even tap the element, fall straight through to fill — it may still
            // work via the fast-runner coordinate path, and we want its error message, not ours.
        }
        else {
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
                            const envelope = JSON.parse(resolved.content[0].text);
                            return okResult(envelope.data, { meta: { fallbackUsed: 'pressable-resolution', resolvedRef } });
                        }
                        catch {
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
                    const envelope = JSON.parse(retry.content[0].text);
                    return okResult(envelope.data, { meta: { fallbackUsed: 'retap' } });
                }
                catch {
                    return retry;
                }
            }
        }
        // Fallback 2: platform-specific last resort.
        if (androidSession) {
            const adbResult = await androidClipboardFill(args.text);
            if (!adbResult.isError) {
                try {
                    const envelope = JSON.parse(adbResult.content[0].text);
                    return okResult(envelope.data, { meta: { fallbackUsed: 'adb' } });
                }
                catch {
                    return adbResult;
                }
            }
        }
        // Fallback 3: Maestro inputText (iOS, or Android if adb fallback also failed).
        const platform = androidSession ? 'android' : 'ios';
        return maestroFillFallback(ref, args.text, platform);
    });
}
// Default screen dimensions for common devices — used when screen rect cache is empty.
// Covers iPhone 17 Pro / 15 Pro / 14 Pro Max and similar Android 1080x2400 phones.
const DEFAULT_SCREEN = { width: 402, height: 874 };
const SWIPE_FRACTION = 0.4;
const DEFAULT_SWIPE_DURATION_MS = 300;
function computeSwipeFromDirection(direction, screen) {
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
export function exactModeRejectionMessage(reason) {
    if (reason === 'count-pattern-incompatible') {
        return 'exact: true is incompatible with count/pattern (those route through agent-device daemon which enforces safe-normalized timing). Drop count/pattern or drop exact.';
    }
    return 'exact: true requires fast-runner (iOS only, session must be open). Fast-runner unavailable — open a device session via device_snapshot action=open, then retry.';
}
export function createDeviceSwipeHandler() {
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
                return failResult(exactModeRejectionMessage('count-pattern-incompatible'), { code: 'EXACT_INCOMPATIBLE', hint: 'count and pattern only work via agent-device daemon, which enforces safe-normalized timing. Drop one to proceed.' });
            }
            if (!isFastRunnerAvailable()) {
                return failResult(exactModeRejectionMessage('fast-runner-unavailable'), { code: 'EXACT_REQUIRES_FAST_RUNNER', hint: 'fast-runner is the only path that respects user-supplied durationMs verbatim. Open a device session first.' });
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
                }
                catch (err) {
                    if (args.exact === true) {
                        return failResult(`fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`, { code: 'EXACT_FAST_RUNNER_FAILED' });
                    }
                    /* fall through */
                }
            }
            const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
            if (args.durationMs)
                cliArgs.push(String(args.durationMs));
            if (args.count && args.count > 1)
                cliArgs.push('--count', String(args.count));
            if (args.pattern)
                cliArgs.push('--pattern', args.pattern);
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
                }
                catch (err) {
                    if (args.exact === true) {
                        return failResult(`fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`, { code: 'EXACT_FAST_RUNNER_FAILED' });
                    }
                    /* fall through */
                }
            }
            const cliArgs = ['swipe', String(coords.x1), String(coords.y1), String(coords.x2), String(coords.y2), String(duration)];
            if (args.count && args.count > 1)
                cliArgs.push('--count', String(args.count));
            if (args.pattern)
                cliArgs.push('--pattern', args.pattern);
            return runAgentDevice(cliArgs);
        }
        return failResult('Provide either direction or x1,y1,x2,y2 coordinates');
    });
}
export function createDeviceScrollHandler() {
    return withSession(async (args) => {
        // B106 fix: Route iOS scroll through fast-runner's direct HID synthesis
        // when available. The agent-device daemon path uses XCTest's high-level
        // gesture API which calls `waitForIdle` after the drag — this hangs
        // indefinitely on screens driven by Reanimated `useAnimatedScrollHandler`
        // because the UI thread is never "idle" between scroll events. Fast-runner
        // uses `RunnerDaemonProxy.synthesize(eventRecord)` which is raw HID event
        // injection and returns as soon as events are delivered.
        if (isFastRunnerAvailable()) {
            const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
            const amount = Math.min(Math.max(args.amount ?? 0.5, 0), 1);
            const cx = Math.round(screen.width / 2);
            const cy = Math.round(screen.height / 2);
            const dy = Math.round(screen.height * SWIPE_FRACTION * amount);
            const dx = Math.round(screen.width * SWIPE_FRACTION * amount);
            let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
            switch (args.direction) {
                // "scroll down" = content moves up = finger moves up (swipe up)
                case 'down':
                    y1 = cy + Math.round(dy / 2);
                    y2 = cy - Math.round(dy / 2);
                    break;
                case 'up':
                    y1 = cy - Math.round(dy / 2);
                    y2 = cy + Math.round(dy / 2);
                    break;
                case 'left':
                    x1 = cx + Math.round(dx / 2);
                    x2 = cx - Math.round(dx / 2);
                    break;
                case 'right':
                    x1 = cx - Math.round(dx / 2);
                    x2 = cx + Math.round(dx / 2);
                    break;
            }
            try {
                const resp = await fastSwipe(x1, y1, x2, y2, DEFAULT_SWIPE_DURATION_MS);
                if (resp.ok) {
                    return okResult({ direction: args.direction, amount: args.amount ?? 0.5, method: 'fast-runner', x1, y1, x2, y2 });
                }
                // Fall through to daemon on fast-runner failure
            }
            catch {
                // Fall through to daemon on fast-runner error
            }
        }
        const cliArgs = ['scroll', args.direction];
        if (args.amount != null)
            cliArgs.push(String(args.amount));
        return runAgentDevice(cliArgs);
    });
}
export function createDeviceScrollIntoViewHandler() {
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
export function createDevicePinchHandler() {
    return withSession((args) => {
        const cliArgs = ['pinch', String(args.scale)];
        if (args.x != null && args.y != null) {
            cliArgs.push(String(args.x), String(args.y));
        }
        return runAgentDevice(cliArgs);
    });
}
// --- Back ---
export function createDeviceBackHandler() {
    return withSession(() => runAgentDevice(['back']));
}
// --- Focus Next (keyboard Next/Return button) ---
// Label priority order: "Go" and "Done" first because they are less likely to
// appear on in-app navigation buttons than "Next", reducing false-positive taps
// on wizard/form navigation buttons. Callers with a visible in-app "Next" button
// should use device_press on the next input @ref directly instead of this tool.
const NEXT_KEY_LABELS = ['Go', 'Done', 'Return', 'Next'];
export function createDeviceFocusNextHandler() {
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
            return failResult('Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.', { code: 'SNAPSHOT_UNAVAILABLE' });
        }
        const { nodes, recoveredTier } = snap;
        for (const label of NEXT_KEY_LABELS) {
            const match = nodes.find((n) => n.label === label);
            if (!match)
                continue;
            const pressResult = await runAgentDevice(['press', `@${match.ref}`]);
            if (pressResult.isError)
                continue; // Match found but tap failed — try next label
            try {
                const envelope = JSON.parse(pressResult.content[0].text);
                const meta = { keyUsed: label, ref: match.ref };
                if (recoveredTier) {
                    meta.recovered = 'agent-device-runner-leak';
                    meta.recoveryTier = recoveredTier;
                }
                return okResult(envelope.data, { meta });
            }
            catch {
                return pressResult;
            }
        }
        return failResult(`No keyboard ${NEXT_KEY_LABELS.join('/')} key visible in the accessibility tree. Tried: ${NEXT_KEY_LABELS.join(', ')}`, {
            code: 'KEYBOARD_NEXT_NOT_FOUND',
            hint: 'Keyboard may be dismissed, or the field may be the last in the form. If an in-app "Next" button is visible, prefer device_press on the next input @ref directly.',
        });
    });
}
