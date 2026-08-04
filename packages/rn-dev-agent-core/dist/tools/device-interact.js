import { runNative, getActiveSession, clearActiveSession, getCachedScreenRect, cacheSnapshot, getCachedSnapshot, isSnapshotCacheValid, markSnapshotDirty, } from '../agent-device-wrapper.js';
import { isFastRunnerAvailable, fastSwipe, stopFastRunner, adoptPersistedFastRunnerState, } from '../runners/rn-fast-runner-client.js';
import { stopAndroidRunner } from '../runners/rn-android-runner-client.js';
import { surfaceKeyboardGuard, healKeyboardOccludedTap, } from '../runners/keyboard-guard.js';
import { resolveBundleId } from '../project-config.js';
import { withSession } from '../utils.js';
import { okResult, failResult, createStepTimer } from '../utils.js';
import { maestroRefusalResult, runMaestroInline, yamlEscape } from '../maestro-invoke.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak } from './runner-leak-recovery.js';
import { reopenSessionForRecovery } from './device-session.js';
import { getCachedMetadata, getCachedSignature, isRefMapFresh, lookupRef, refCenter, } from '../fast-runner-ref-map.js';
import { attemptJsFill, settleRead, probeInputState, finalFiberVerify, combineVerificationOracles, decideNativeRetype, } from './fill-verify.js';
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
const TYPE_PRIORITY_FOR_TAP = {
    Button: 100,
    Cell: 95,
    Switch: 90,
    Link: 80,
    Other: 60,
    StaticText: 30,
    Image: 25,
    ScrollView: 10,
};
function typePriority(type) {
    if (!type)
        return 50;
    return TYPE_PRIORITY_FOR_TAP[type] ?? 50;
}
function rectKey(rect) {
    if (!rect)
        return null;
    return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}
export function rankSnapshotNodes(nodes) {
    const withScore = nodes.map((node, originalIndex) => ({
        node,
        originalIndex,
        score: typePriority(node.type) * 10 + (node.hittable === true ? 1 : 0),
    }));
    withScore.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        return a.originalIndex - b.originalIndex;
    });
    const seenRects = new Set();
    const ranked = [];
    for (const s of withScore) {
        const key = rectKey(s.node.rect);
        if (key !== null) {
            if (seenRects.has(key))
                continue;
            seenRects.add(key);
        }
        ranked.push(s.node);
    }
    return ranked;
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
export async function fetchSnapshotNodes(allowCache = false) {
    // GH #321 (live-sim speedup): serve device_find from the snapshot we already
    // captured when it's still a faithful picture of the screen (clean + fresh),
    // skipping a redundant runner round-trip. isSnapshotCacheValid() is false the
    // moment any mutating verb runs, so we never target against a stale screen.
    if (allowCache) {
        const platform = getActiveSession()?.platform;
        if (platform && isSnapshotCacheValid(platform)) {
            const cached = getCachedSnapshot(platform);
            if (cached)
                return { ok: true, nodes: cached.nodes };
        }
    }
    const first = await runNative(['snapshot', '-i']);
    const initialNodes = parseSnapshotEnvelope(first);
    if (initialNodes === null)
        return { ok: false, reason: 'fetch-failed' };
    // GH #409: a zero-node capture cannot support any "element absent" verdict —
    // it is indistinguishable from a degraded walk. Interactive consumers fail
    // closed instead of concluding "nothing on screen".
    if (initialNodes.length === 0)
        return { ok: false, reason: 'empty-capture' };
    if (!isAgentDeviceRunnerSentinel(initialNodes)) {
        const platform = getActiveSession()?.platform;
        if (platform)
            cacheSnapshot(platform, initialNodes);
        return { ok: true, nodes: initialNodes };
    }
    const session = getActiveSession();
    markSnapshotDirty(session?.platform);
    const recovery = await recoverFromRunnerLeak({
        platform: session?.platform,
        appId: session?.appId,
        deviceId: session?.deviceId,
        sessionName: session?.name,
    }, {
        closeSession: async () => {
            await stopFastRunner(session?.deviceId);
            await stopAndroidRunner(session?.deviceId);
            clearActiveSession();
            return okResult({ closed: true });
        },
        openSession: ({ appId, platform, deviceId, attachOnly }) => reopenSessionForRecovery(appId, platform, attachOnly, deviceId),
        resnapshot: () => runNative(['snapshot', '-i']),
        parseNodes: parseSnapshotEnvelope,
    });
    if (!recovery.recovered) {
        return { ok: false, reason: 'runner-leak-unrecovered', recoveryReason: recovery.reason };
    }
    const recoveredNodes = parseSnapshotEnvelope(recovery.result);
    if (recoveredNodes === null)
        return { ok: false, reason: 'fetch-failed' };
    if (recoveredNodes.length === 0)
        return { ok: false, reason: 'empty-capture' };
    const platform = getActiveSession()?.platform;
    if (platform)
        cacheSnapshot(platform, recoveredNodes);
    return { ok: true, nodes: recoveredNodes, recoveredTier: recovery.tier };
}
// GH #409: refusal for a zero-node capture — asserting NOT_FOUND on it would
// present a degraded capture as a legitimately empty screen.
function emptyCaptureFailResult(query) {
    return failResult(`Snapshot returned zero nodes — cannot distinguish an empty screen from a degraded capture` +
        (query !== undefined ? `; not asserting "${query}" is absent` : '') +
        `. Confirm the screen with device_screenshot or cdp_component_tree, then retry.`, { code: 'SNAPSHOT_DEGRADED', ...(query !== undefined ? { query } : {}) });
}
export async function fetchFindCandidates(query, exact = false, allowCache = false) {
    const snap = await fetchSnapshotNodes(allowCache);
    if (!snap.ok)
        return snap;
    const needle = query.toLowerCase();
    const matched = snap.nodes.filter((n) => {
        const label = n.label ?? '';
        const id = n.identifier ?? '';
        if (exact)
            return label === query || id === query;
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
function runnerLeakFailResult(query, recoveryReason) {
    const queryHint = query ? ` (while resolving "${query}")` : '';
    return failResult(`device_find/snapshot returned AgentDeviceRunner's own UI tree instead of the target app${queryHint} (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.`, {
        code: 'RUNNER_LEAK',
        recoveryReason,
        hint: 'Manually close + reopen the session with device_snapshot action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). The recovery may have killed the JS context — re-establish CDP via cdp_connect before reading state. Upstream: Callstack/agent-device, see B119/GH#35.',
    });
}
export async function pressCandidate(candidate, action, getClient) {
    const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
    if (action === 'click') {
        const tap = async () => surfaceKeyboardGuard(await runNative(['press', ref]));
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
export function createDeviceFindHandler(getClient) {
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
                return failResult(`Snapshot unavailable — cannot resolve ${args.exact ? 'exact' : 'index-based'} match for "${args.text}". Retry after device_snapshot action=open/snapshot.`, { code: 'SNAPSHOT_UNAVAILABLE', query: args.text });
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
                    return failResult(`index ${args.index} out of range (got ${candidates.length} candidates)`, { code: 'INDEX_OUT_OF_RANGE', count: candidates.length, candidates });
                }
                return tagPressIfRecovered(await pressCandidate(candidates[args.index], args.action, getClient), recoveredTier);
            }
            // exact=true, no index: require single match
            if (candidates.length === 1) {
                return tagPressIfRecovered(await pressCandidate(candidates[0], args.action, getClient), recoveredTier);
            }
            return failResult(`AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`, {
                code: 'AMBIGUOUS_MATCH',
                query: args.text,
                candidates,
                hint: 'Add index: N to pick one.',
            });
        }
        // GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: route
        // non-exact text finds through the snapshot-based orchestrator on iOS
        // always and on Android (default-on; opt-out via RN_ANDROID_RUNNER=0).
        // The legacy CLI path would respawn the upstream agent-device daemon,
        // which fights our in-tree runner for focus / UIAutomator. Using
        // runNative + fetchFindCandidates keeps us on the platform-aware
        // short-circuit.
        const activeSession = getActiveSession();
        const usesInTreeRunner = activeSession?.platform === 'ios' ||
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
                return tagPressIfRecovered(await pressCandidate(candidates[0], args.action, getClient), recoveredTier);
            }
            return failResult(`AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements. Use device_press with one of these refs, or retry with index: N.`, {
                code: 'AMBIGUOUS_MATCH',
                query: args.text,
                candidates,
                ...recoveredMeta,
                hint: 'Pick the correct ref (prefer one with hittable=true) and call device_press(ref="...") directly, or call device_find again with index: N.',
            });
        }
        return failResult(`device_find requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${activeSession?.platform ?? 'none'}.`, {
            code: 'IN_TREE_RUNNER_REQUIRED',
            platform: activeSession?.platform ?? null,
        });
    });
}
// GH #60 Bug 7: agent-device + Maestro emit a few different timeout strings
// ("daemon timeout", "Daemon error: daemon timeout", "request timed out")
// depending on tier. Match the patterns broadly enough to catch all of them
// without snagging unrelated timeouts (e.g. CDP evaluate timeouts inside
// other tools have different shapes that don't reach this path).
export function isDaemonTimeoutError(text) {
    if (!text)
        return false;
    const t = text.toLowerCase();
    return (t.includes('daemon timeout') ||
        t.includes('daemon error: daemon') ||
        /\bdaemon\b.*\btimed?\s?out\b/.test(t));
}
// GH #581: exact fill-target binding. Bind exactly one current-generation
// input to the caller's direct ref/testID, or uniquely map a
// `${base}-pressable` wrapper to exactly one `${base}` recognized input in the
// same snapshot. Zero/duplicate/conflicting matches reject without mutation.
const IOS_INPUT_TYPES = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);
const ANDROID_INPUT_TYPE_RE = /.+\.(\w*EditText|\w*AutoCompleteTextView)$/;
const PRESSABLE_SUFFIX = '-pressable';
export function isRecognizedInputType(type) {
    if (!type)
        return false;
    return IOS_INPUT_TYPES.has(type) || ANDROID_INPUT_TYPE_RE.test(type);
}
function isSecureInputNode(node) {
    return node.type === 'SecureTextField' || node.secure === true;
}
function cleanNodeRef(node) {
    return node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
}
// A positional @eN may only bind when its identity still matches the
// signature captured BEFORE this binding snapshot; a shifted generation
// rebinds by unique identity or rejects — never by recycled position.
export function bindExactFillTarget(nodes, rawRef, priorSignature) {
    const clean = rawRef.replace(/^@/, '');
    const positional = /^e\d+$/.test(clean);
    let node;
    if (positional) {
        const hasRobustIdentity = priorSignature !== null &&
            priorSignature !== undefined &&
            ((priorSignature.identifier?.trim().length ?? 0) > 0 ||
                (priorSignature.label?.trim().length ?? 0) > 0);
        if (!hasRobustIdentity) {
            return {
                ok: false,
                detail: `ref @${clean} has no robust pre-refresh identity for unique rebinding`,
            };
        }
        node = nodes.find((n) => cleanNodeRef(n) === clean);
        if (!node) {
            return { ok: false, detail: `ref @${clean} is not in the current snapshot generation` };
        }
        if (priorSignature) {
            const matches = nodes.filter((n) => (n.type ?? '') === priorSignature.type &&
                n.label === priorSignature.label &&
                n.identifier === priorSignature.identifier);
            if (matches.length !== 1) {
                return {
                    ok: false,
                    detail: `ref @${clean} identity ${matches.length > 1 ? 'matches multiple elements' : 'is absent'} in the current snapshot`,
                };
            }
            node = matches[0];
        }
    }
    else {
        const matches = nodes.filter((n) => n.identifier === clean);
        if (matches.length === 0) {
            return { ok: false, detail: `no element with testID "${clean}" in the current snapshot` };
        }
        if (matches.length > 1) {
            return {
                ok: false,
                detail: `testID "${clean}" matches ${matches.length} elements — duplicate identifiers cannot bind an exact input`,
            };
        }
        node = matches[0];
    }
    if (isRecognizedInputType(node.type)) {
        return {
            ok: true,
            binding: {
                inputRef: `@${cleanNodeRef(node)}`,
                inputTestId: node.identifier ?? null,
                focusRef: `@${cleanNodeRef(node)}`,
                wrapper: false,
                secure: isSecureInputNode(node),
            },
        };
    }
    const id = node.identifier;
    if (id?.endsWith(PRESSABLE_SUFFIX)) {
        const base = id.slice(0, -PRESSABLE_SUFFIX.length);
        if (base) {
            const inputs = nodes.filter((n) => n.identifier === base && isRecognizedInputType(n.type));
            if (inputs.length === 1) {
                return {
                    ok: true,
                    binding: {
                        inputRef: `@${cleanNodeRef(inputs[0])}`,
                        inputTestId: base,
                        focusRef: `@${cleanNodeRef(node)}`,
                        wrapper: true,
                        secure: isSecureInputNode(inputs[0]),
                    },
                };
            }
            if (inputs.length > 1) {
                return {
                    ok: false,
                    detail: `wrapper "${id}" maps to ${inputs.length} inputs with testID "${base}" — ambiguous`,
                };
            }
            return {
                ok: false,
                detail: `wrapper "${id}" has no recognized input with testID "${base}" in the current snapshot`,
            };
        }
    }
    return {
        ok: false,
        detail: `element @${cleanNodeRef(node)} (${node.type ?? 'unknown type'}) is not a recognized text input — pass the inner input's ref or testID`,
    };
}
// Story 04 (#385): thread a caller-supplied settle budget into runNative.
function settleOpts(args) {
    return args.settleTimeoutMs !== undefined ? { settle: { timeoutMs: args.settleTimeoutMs } } : {};
}
// Story 05 (#386): thread caller-supplied settle and retryIfNoChange into runNative opts.
function interactOpts(args) {
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
function keyboardHealDeps(getClient, retryTap) {
    const client = cdpClientOrNull(getClient);
    if (!client)
        return null;
    return {
        dismissViaJs: async () => {
            const r = await client.evaluate('__RN_AGENT.dismissKeyboard()');
            if (typeof r.value !== 'string')
                return false;
            try {
                const parsed = JSON.parse(r.value);
                return parsed?.dismissed === true;
            }
            catch {
                return false;
            }
        },
        refreshSnapshot: () => runNative(['snapshot']),
        retryTap,
    };
}
export function createDevicePressHandler(getClient) {
    return withSession(async (args) => {
        const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
        const hasCoordinates = args.x !== undefined && args.y !== undefined;
        if (hasRef === hasCoordinates) {
            return failResult('Provide exactly one press target: ref, or both x and y coordinates', 'INVALID_ARGUMENT');
        }
        const target = hasRef ? (args.ref.startsWith('@') ? args.ref : `@${args.ref}`) : undefined;
        const cliArgs = hasRef ? ['press', target] : ['press', String(args.x), String(args.y)];
        if (args.doubleTap)
            cliArgs.push('--double-tap');
        if (args.count && args.count > 1)
            cliArgs.push('--count', String(args.count));
        if (args.holdMs && args.holdMs > 0)
            cliArgs.push('--hold-ms', String(args.holdMs));
        const tap = async () => surfaceKeyboardGuard(await runNative(cliArgs, interactOpts(args)));
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
export function createDeviceLongPressHandler(getClient) {
    return withSession(async (args) => {
        let cliArgs;
        if (args.ref) {
            const ref = args.ref.startsWith('@') ? args.ref : `@${args.ref}`;
            cliArgs = ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
        }
        else if (args.x != null && args.y != null) {
            cliArgs = ['longpress', String(args.x), String(args.y)];
            if (args.durationMs)
                cliArgs.push(String(args.durationMs));
        }
        else {
            return failResult('Provide either ref or x+y coordinates');
        }
        const tap = async () => surfaceKeyboardGuard(await runNative(cliArgs, interactOpts(args)));
        const result = await tap();
        if (result.isError) {
            return healKeyboardOccludedTap(result, keyboardHealDeps(getClient, tap));
        }
        return result;
    });
}
function isAndroidSession() {
    const session = getActiveSession();
    if (session?.platform === 'android')
        return true;
    if (session?.platform)
        return false;
    return !!process.env.ANDROID_SERIAL;
}
// Story 10 (#391): the Android runner proved setText AND keyevents don't land —
// descend to the clear-first Maestro tier instead of re-tapping healthy focus.
function isSetTextRejectedError(result) {
    if (!result.isError)
        return false;
    const text = result.content?.[0]?.text ?? '';
    try {
        const envelope = JSON.parse(text);
        return envelope.code === 'SET_TEXT_REJECTED';
    }
    catch {
        return false;
    }
}
// Story 10 (#391): typing telemetry the iOS runner attaches to its `type`
// response (two-burst recipe + keyboard-presence wait). Surfaced as
// meta.typing when device_fill re-wraps the runner envelope.
export function extractTypingMeta(result) {
    try {
        const envelope = JSON.parse(result.content[0].text);
        const data = envelope.data;
        if (!data || (data.typingBurst === undefined && data.keyboardWaitMs === undefined))
            return null;
        return {
            ...(data.typingBurst !== undefined ? { burst: data.typingBurst } : {}),
            ...(data.keyboardWaitMs !== undefined ? { keyboardWaitMs: data.keyboardWaitMs } : {}),
        };
    }
    catch {
        return null;
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function extractSettleMeta(result) {
    try {
        const envelope = JSON.parse(result.content[0].text);
        const out = {};
        if (envelope.meta?.settle !== undefined)
            out.settle = envelope.meta.settle;
        if (typeof envelope.meta?.timings_ms?.settle === 'number') {
            out.settleMs = envelope.meta.timings_ms.settle;
        }
        return out;
    }
    catch {
        return {};
    }
}
export function cdpClientOrNull(getClient) {
    try {
        const c = getClient();
        return c && c.isConnected ? c : null;
    }
    catch {
        return null;
    }
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
// CURRENT generation.
export function resolveCachedIdentifier(ref) {
    const bareRef = ref.replace(/^@/, '');
    if (!isRefMapFresh() || lookupRef(bareRef) === null)
        return undefined;
    return getCachedMetadata(bareRef)?.identifier;
}
// Conservative default: an unlabeled failure after dispatch may have mutated.
export function extractMutationDisposition(result) {
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '{}');
        const m = envelope.meta?.mutation;
        if (m === 'none' || m === 'observed' || m === 'possible')
            return m;
    }
    catch {
        /* fall through */
    }
    return 'possible';
}
function extractErrorText(result) {
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '{}');
        return typeof envelope.error === 'string' ? envelope.error : 'unknown runner error';
    }
    catch {
        return 'unknown runner error';
    }
}
function extractErrorCode(result) {
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '{}');
        return typeof envelope.code === 'string' ? envelope.code : undefined;
    }
    catch {
        return undefined;
    }
}
const NATIVE_VERIFY_VERDICTS = new Set([
    'exact',
    'mismatch',
    'unreadable',
    'secure-masked',
    'target-lost',
    'ambiguous',
]);
async function runNativeVerifyInput(binding, text) {
    const result = await runNative(['verify-input', binding.inputRef, text], {
        settle: { enabled: false },
        exactTarget: { inputRef: binding.inputRef, secure: binding.secure },
    });
    if (result.isError)
        return { verdict: 'unavailable', stable: false };
    try {
        const envelope = JSON.parse(result.content[0].text);
        const v = envelope.data?.verifyVerdict;
        if (typeof v === 'string' && NATIVE_VERIFY_VERDICTS.has(v)) {
            return { verdict: v, stable: envelope.data?.verifyStable === true };
        }
    }
    catch {
        /* fall through */
    }
    return { verdict: 'unavailable', stable: false };
}
// The single fill arbiter's evidence gatherer: fiber oracle (controlled
// inputs) + native verifyInput (uncontrolled inputs), combined per the GH #581
// contract — disagreement is inconclusive, inconclusive is failure.
async function finalVerification(client, binding, jsTestId, text) {
    const fiberId = binding.inputTestId ?? jsTestId;
    let fiber = 'unavailable';
    if (client && fiberId) {
        fiber = await finalFiberVerify({ evaluate: (e) => client.evaluate(e) }, fiberId, text);
    }
    const native = await runNativeVerifyInput(binding, text);
    return combineVerificationOracles(fiber, native.verdict, native.stable);
}
// The ONLY producer of public fill success (single-success-rule invariant).
function verifiedFillResult(method, textLength, meta) {
    return okResult({ filled: true, method, length: textLength }, { meta: { ...meta, verify: 'exact' } });
}
function fillFailure(code, message, opts) {
    return failResult(message, code, {
        mutation: opts.mutation,
        pathsTried: opts.pathsTried,
        ...(opts.verification
            ? {
                verification: {
                    fiber: opts.verification.fiber,
                    native: opts.verification.native,
                    nativeStable: opts.verification.nativeStable,
                },
            }
            : {}),
        hint: opts.hint ??
            (opts.mutation === 'none'
                ? 'No text was entered. Refresh the snapshot (device_snapshot action=snapshot) and rebind the input before retrying.'
                : 'The field may have been mutated. Read the field state (device_snapshot or the fiber) before any manual retry — do not blindly re-run device_fill.'),
    });
}
function attachFillFailureDisposition(result, mutation, pathsTried) {
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '{}');
        const error = typeof envelope.error === 'string' ? envelope.error : 'Text entry was refused.';
        const meta = {
            ...envelope.meta,
            mutation,
            pathsTried,
            hint: mutation === 'none'
                ? 'No text was entered. Refresh the snapshot (device_snapshot action=snapshot) and rebind the input before retrying.'
                : 'The field may have been mutated. Read the field state (device_snapshot or the fiber) before any manual retry — do not blindly re-run device_fill.',
        };
        return typeof envelope.code === 'string'
            ? failResult(error, envelope.code, meta)
            : failResult(error, meta);
    }
    catch {
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'Text entry was refused.', {
            mutation,
            pathsTried,
        });
    }
}
async function clearControlledValue(client, testID) {
    try {
        await client.evaluate('__RN_AGENT.interact(' + JSON.stringify({ action: 'typeText', testID, text: '' }) + ')');
    }
    catch {
        return false;
    }
    const settled = await settleRead({ evaluate: (e) => client.evaluate(e) }, testID, '', null);
    return settled.value === '';
}
function exactTypeReadback(client, testID) {
    if (!client || !testID)
        return undefined;
    return async (expected) => {
        const result = await client.evaluate(`__RN_AGENT.readInputValue(${JSON.stringify(testID)})`);
        if (typeof result.value !== 'string')
            return { matches: false };
        try {
            const parsed = JSON.parse(result.value);
            const actual = typeof parsed.value === 'string' ? parsed.value : null;
            return { matches: actual === expected, actual };
        }
        catch {
            return { matches: false };
        }
    };
}
// Post-mutation corrective tier: always clear-first (eraseText) so a
// corrective attempt never appends; Maestro exit status is attempt evidence
// only and never public success. Failure output is not echoed (it can embed
// the flow's inputText).
async function maestroFillAttempt(targetId, text, platform, authorityArgs) {
    const escapedRef = yamlEscape(targetId.replace(/^@/, ''));
    const escapedText = yamlEscape(text);
    const yaml = `- tapOn:\n    id: "${escapedRef}"\n- eraseText\n- inputText: "${escapedText}"`;
    const result = await runMaestroInline(yaml, {
        platform,
        slug: 'fill-fallback',
        timeoutMs: 120_000,
        authorityArgs,
    });
    if (result.passed)
        return { attempted: true };
    const refusal = maestroRefusalResult(result, 'Maestro fill fallback was refused.', {
        tried: ['js', 'native', 'maestro'],
    });
    if (refusal)
        return { attempted: false, refusal };
    return { attempted: false };
}
const MAX_NATIVE_RETYPE = 2;
// GH #581 exact fill orchestrator (device_fill and device_batch's fill step):
// bind exactly one input, mutate through the runner's single exact operation,
// and emit success only from the final verification arbiter.
export async function performExactFill(args, client, tiers) {
    const platform = isAndroidSession() ? 'android' : 'ios';
    const pathsTried = [];
    let mutationSeen = 'none';
    // Capture the positional ref's identity BEFORE the binding snapshot so a
    // refreshed generation can only rebind by identity, never by recycled id.
    const cleanRefForSignature = args.ref.replace(/^@/, '');
    const priorSignature = /^e\d+$/.test(cleanRefForSignature)
        ? getCachedSignature(cleanRefForSignature)
        : null;
    const snap = await fetchSnapshotNodes(true);
    if (!snap.ok) {
        if (snap.reason === 'runner-leak-unrecovered') {
            return attachFillFailureDisposition(runnerLeakFailResult(args.ref, snap.recoveryReason), 'none', pathsTried);
        }
        return fillFailure('NO_TEXT_INPUT_TARGET', `device_fill could not snapshot the screen to bind "${args.ref}" (${snap.reason}); no text was entered.`, { mutation: 'none', pathsTried });
    }
    const bind = bindExactFillTarget(snap.nodes, args.ref, priorSignature);
    if (!bind.ok) {
        return fillFailure('NO_TEXT_INPUT_TARGET', `device_fill could not bind an exact input: ${bind.detail}. No text was entered.`, { mutation: 'none', pathsTried });
    }
    const binding = bind.binding;
    if (args.testID && args.testID !== binding.inputTestId) {
        return fillFailure('NO_TEXT_INPUT_TARGET', `device_fill could not prove that testID "${args.testID}" identifies the bound input. No text was entered.`, { mutation: 'none', pathsTried });
    }
    const fiberId = binding.inputTestId;
    const evalSeam = client ? { evaluate: (e) => client.evaluate(e) } : null;
    // Controlled inputs go through the fiber; the probe never fires handlers, so
    // uncontrolled inputs skip straight to native (no double-mutation window).
    if (tiers.js && client && evalSeam && fiberId) {
        const probe = await probeInputState(evalSeam, fiberId);
        if (probe.readable && probe.controlled) {
            pathsTried.push('js');
            const tJs = Date.now();
            const js = await attemptJsFill(evalSeam, fiberId, args.text);
            if (!js.handled && js.dispatchUncertain) {
                return fillFailure('TEXT_ENTRY_UNVERIFIED', 'The JS fill dispatch failed after it may have reached the app; not typing again.', { mutation: 'possible', pathsTried });
            }
            if (js.handled) {
                mutationSeen = 'observed';
                if (js.outcome === 'exact') {
                    const verification = await finalVerification(client, binding, fiberId, args.text);
                    if (verification.verified) {
                        return verifiedFillResult('js-onChangeText', args.text.length, {
                            textEntryPath: 'js',
                            verifiedOracle: verification.oracle,
                            handler: js.handler,
                            timings_ms: { jsType: Date.now() - tJs },
                        });
                    }
                    if (!verification.observedMismatch) {
                        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'The controlled fill could not be verified against the bound native input; not retrying.', { mutation: 'possible', pathsTried, verification });
                    }
                }
                if (js.outcome === 'unreadable') {
                    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'The onChangeText handler fired but the resulting value is unreadable — app state may have changed; not retrying.', { mutation: 'possible', pathsTried });
                }
                // Readable but not (stably) exact: correct clear-first via the same
                // handler, prove the clear, then descend to the native tier.
                const cleared = await clearControlledValue(client, fiberId);
                if (!cleared) {
                    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill could not verify the JS fill and could not prove a clean clear; not retrying.', { mutation: 'possible', pathsTried });
                }
            }
        }
    }
    pathsTried.push('native');
    if (tiers.abortSignal?.aborted) {
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill was cancelled before native typing.', {
            mutation: mutationSeen === 'none' ? 'none' : 'possible',
            pathsTried,
        });
    }
    const focusCenter = isRefMapFresh() ? refCenter(binding.focusRef) : null;
    const exactTarget = {
        inputRef: binding.inputRef,
        ...(focusCenter ? { focusX: focusCenter.x, focusY: focusCenter.y } : {}),
        ...(args.waitForKeyboardMs !== undefined ? { focusWaitMs: args.waitForKeyboardMs } : {}),
    };
    const tNative = Date.now();
    let lastVerification = null;
    for (let attempt = 0; attempt <= MAX_NATIVE_RETYPE; attempt++) {
        const clearFirst = attempt > 0 || args.text.length === 0;
        const primary = await runNative(['fill', binding.inputRef, args.text, ...(clearFirst ? ['--clear-first'] : [])], {
            ...(attempt === 0 ? settleOpts(args) : { settle: { enabled: false } }),
            exactTarget,
            verifyTypeReadback: exactTypeReadback(client, fiberId),
        });
        if (primary.isError) {
            const mutation = extractMutationDisposition(primary);
            if (isSetTextRejectedError(primary)) {
                if (mutation === 'possible') {
                    return fillFailure('TEXT_ENTRY_UNVERIFIED', `device_fill's native attempt may have mutated the field before rejecting text entry: ${extractErrorText(primary)}`, { mutation: 'possible', pathsTried });
                }
                if (mutation === 'observed') {
                    mutationSeen = 'observed';
                    const verification = await finalVerification(client, binding, fiberId, args.text);
                    lastVerification = verification;
                    if (verification.verified) {
                        return verifiedFillResult('native', args.text.length, {
                            textEntryPath: attempt === 0 ? 'native' : 'native-retype',
                            verifiedOracle: verification.oracle,
                            recovered: 'post-error-exact-readback',
                            retypes: attempt,
                            timings_ms: { nativeType: Date.now() - tNative },
                        });
                    }
                    if (!verification.observedMismatch) {
                        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill observed a rejected native mutation but could not prove a stable mismatch; not retrying.', { mutation: 'possible', pathsTried, verification });
                    }
                }
                break;
            }
            if (mutation === 'none') {
                if (mutationSeen !== 'none') {
                    return fillFailure('TEXT_ENTRY_UNVERIFIED', `device_fill's corrective native attempt was refused after an earlier mutation: ${extractErrorText(primary)}`, { mutation: 'possible', pathsTried });
                }
                const code = extractErrorCode(primary);
                return fillFailure(code === 'FOCUS_TARGET_OCCLUDED' ? 'FOCUS_TARGET_OCCLUDED' : 'NO_TEXT_INPUT_TARGET', `device_fill's native attempt was refused before mutation: ${extractErrorText(primary)}`, { mutation: 'none', pathsTried });
            }
            // Runner-timeout discipline: never resend; only an exact independent
            // read-back may promote a possibly-mutating failure to success.
            const verification = await finalVerification(client, binding, fiberId, args.text);
            if (verification.verified) {
                return verifiedFillResult('native', args.text.length, {
                    textEntryPath: attempt === 0 ? 'native' : 'native-retype',
                    verifiedOracle: verification.oracle,
                    recovered: 'post-error-exact-readback',
                    retypes: attempt,
                    timings_ms: { nativeType: Date.now() - tNative },
                });
            }
            return fillFailure('TEXT_ENTRY_UNVERIFIED', `device_fill's native attempt failed and the field could not be verified: ${extractErrorText(primary)}`, {
                mutation: mutationSeen === 'none' ? mutation : 'possible',
                pathsTried,
                verification,
            });
        }
        mutationSeen = 'observed';
        const primarySettle = extractSettleMeta(primary);
        const primaryTyping = extractTypingMeta(primary);
        const verification = await finalVerification(client, binding, fiberId, args.text);
        lastVerification = verification;
        if (verification.verified) {
            return verifiedFillResult('native', args.text.length, {
                textEntryPath: attempt === 0 ? 'native' : 'native-retype',
                verifiedOracle: verification.oracle,
                retypes: attempt,
                ...(primaryTyping ? { typing: primaryTyping } : {}),
                ...(primarySettle.settle !== undefined ? { settle: primarySettle.settle } : {}),
                timings_ms: {
                    nativeType: Date.now() - tNative,
                    ...(primarySettle.settleMs !== undefined ? { settle: primarySettle.settleMs } : {}),
                },
            });
        }
        const decision = decideNativeRetype(verification, attempt, MAX_NATIVE_RETYPE);
        if (decision.action === 'escalate') {
            if (!verification.observedMismatch) {
                return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill typed but the final read-back is inconclusive; not retrying.', { mutation: 'possible', pathsTried, verification });
            }
            break;
        }
        if (tiers.abortSignal?.aborted) {
            return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill was cancelled after a native attempt; no corrective retype was dispatched.', { mutation: 'possible', pathsTried, verification });
        }
        await sleep(decision.delayMs);
        if (tiers.abortSignal?.aborted) {
            return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill was cancelled before a corrective retype was dispatched.', { mutation: 'possible', pathsTried, verification });
        }
    }
    // Corrective Maestro tier: reachable only after an observed stable mismatch
    // or a runner-proven SET_TEXT_REJECTED — both safe for clear-first entry.
    if (!tiers.maestro) {
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill could not verify the fill and this caller does not use the Maestro tier.', {
            mutation: mutationSeen,
            pathsTried,
            verification: lastVerification ?? undefined,
        });
    }
    pathsTried.push('maestro');
    if (tiers.abortSignal?.aborted) {
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill was cancelled before the Maestro correction was dispatched.', { mutation: 'possible', pathsTried, verification: lastVerification ?? undefined });
    }
    const maestroId = binding.inputTestId ?? resolveCachedIdentifier(binding.inputRef);
    if (!maestroId) {
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill could not verify the fill and the input has no testID for the Maestro tier.', { mutation: mutationSeen, pathsTried, verification: lastVerification ?? undefined });
    }
    const maestro = await maestroFillAttempt(maestroId, args.text, platform, args);
    if (!maestro.attempted) {
        if (maestro.refusal)
            return attachFillFailureDisposition(maestro.refusal, 'possible', pathsTried);
        return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill fell through all tiers; the Maestro attempt did not run cleanly.', { mutation: 'possible', pathsTried, verification: lastVerification ?? undefined });
    }
    const maestroVerification = await finalVerification(client, binding, fiberId, args.text);
    if (maestroVerification.verified) {
        return verifiedFillResult('maestro', args.text.length, {
            textEntryPath: 'maestro',
            verifiedOracle: maestroVerification.oracle,
            timings_ms: { nativeType: Date.now() - tNative },
        });
    }
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'Text entry could not be verified after native and Maestro attempts.', { mutation: 'possible', pathsTried, verification: maestroVerification });
}
export function createDeviceFillHandler(getClient) {
    return withSession(async (args) => performExactFill(args, cdpClientOrNull(getClient), { js: true, maestro: true }));
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
export function buildDirectionalSwipeCliArgs(direction, durationMs) {
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
function computeScrollFromDirection(direction, amount, screen) {
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
export function buildDirectionalScrollCliArgs(direction, amount, durationMs) {
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
export function exactModeRejectionMessage(reason) {
    if (reason === 'count-pattern-incompatible') {
        return 'exact: true is incompatible with count/pattern (those route through agent-device daemon which enforces safe-normalized timing). Drop count/pattern or drop exact.';
    }
    return 'exact: true requires fast-runner (iOS only, session must be open). Fast-runner unavailable — open a device session via device_snapshot action=open, then retry.';
}
export function createDeviceSwipeHandler() {
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
                    const resp = await fastSwipe(args.x1, args.y1, args.x2, args.y2, args.durationMs, getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined);
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
            return runNative(cliArgs);
        }
        if (args.direction) {
            // B-Tier3 fix: Use real swipe gesture (not scroll) for direction-based swipes.
            const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
            const coords = computeSwipeFromDirection(args.direction, screen);
            const duration = args.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
            if (canUseFastRunner) {
                try {
                    const resp = await fastSwipe(coords.x1, coords.y1, coords.x2, coords.y2, duration, getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined);
                    if (resp.ok) {
                        return okResult({
                            direction: args.direction,
                            durationMs: duration,
                            method: 'fast-runner',
                            ...coords,
                        });
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
            const cliArgs = [
                'swipe',
                String(coords.x1),
                String(coords.y1),
                String(coords.x2),
                String(coords.y2),
                String(duration),
            ];
            if (args.count && args.count > 1)
                cliArgs.push('--count', String(args.count));
            if (args.pattern)
                cliArgs.push('--pattern', args.pattern);
            return runNative(cliArgs);
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
        const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
        const amount = Math.min(Math.max(args.amount ?? 0.5, 0), 1);
        const { x1, y1, x2, y2 } = computeScrollFromDirection(args.direction, amount, screen);
        // GH #383: adopt persisted per-device state so a respawned worker sees a
        // live runner before this fast-path gate.
        adoptPersistedFastRunnerState(getActiveSession()?.deviceId);
        if (isFastRunnerAvailable()) {
            try {
                const resp = await fastSwipe(x1, y1, x2, y2, DEFAULT_SWIPE_DURATION_MS, getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined);
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
            }
            catch {
                // Fall through to daemon on fast-runner error
            }
        }
        // Daemon / Android fallthrough: dispatch the COORDINATE form. The arg
        // builders throw on the raw direction form, so this previously crashed on
        // Android (always) and on the iOS fast-runner fallback.
        return runNative(buildDirectionalScrollCliArgs(args.direction, args.amount));
    });
}
export function createDeviceScrollIntoViewHandler() {
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
        const usesInTreeRunner = session?.platform === 'ios' ||
            (session?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');
        if (usesInTreeRunner) {
            return scrollIntoViewWithRunner(args);
        }
        return failResult(`device_scrollintoview requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${session?.platform ?? 'none'}.`, { code: 'IN_TREE_RUNNER_REQUIRED', platform: session?.platform ?? null });
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
async function scrollIntoViewWithRunner(args) {
    const MAX_ITERATIONS = 12;
    const timer = createStepTimer();
    const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
    const screenRect = { x: 0, y: 0, width: screen.width, height: screen.height };
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const snapRes = await runNative(['snapshot', '-i']);
        timer.mark('snapshot');
        if (snapRes.isError) {
            return failResult(`scrollintoview: snapshot failed at iteration ${i}: ${snapRes.content?.[0]?.text ?? 'unknown'}`, { code: 'SNAPSHOT_UNAVAILABLE' });
        }
        let nodes = [];
        try {
            const envelope = JSON.parse(snapRes.content?.[0]?.text ?? '{}');
            nodes = envelope.data?.nodes ?? [];
        }
        catch {
            return failResult(`scrollintoview: failed to parse snapshot envelope at iteration ${i}`);
        }
        const target = args.ref
            ? (nodes.find((n) => n.ref === (args.ref.startsWith('@') ? args.ref : `@${args.ref}`)) ??
                null)
            : findInLatestSnapshot(nodes, args.text);
        if (!target) {
            // Element not in snapshot at all; can't decide direction. Probably needs
            // initial scroll. Default to swiping up (down-direction-of-content) once
            // and retry — common case is reaching a below-fold element.
            if (i === 0) {
                const fallbackDir = decideScrollDirection({ x: 0, y: screen.height * 2, width: 1, height: 1 }, screenRect);
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
            return failResult(`scrollintoview: element "${args.ref ?? args.text}" not found after ${i} swipe iteration(s)`, { code: 'NOT_FOUND', iterations: i });
        }
        if (!target.rect) {
            return failResult(`scrollintoview: target has no rect — cannot decide direction`);
        }
        const direction = decideScrollDirection(target.rect, screenRect);
        if (direction === null) {
            return okResult({
                ref: target.ref,
                rect: target.rect,
                iterations: i,
                method: 'runner-orchestrator',
            }, { meta: { timings_ms: timer.timings() } });
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
            return failResult(`scrollintoview: swipe failed at iteration ${i}: ${swipeResp.content?.[0]?.text ?? 'unknown'}`);
        }
    }
    return failResult(`scrollintoview: target "${args.ref ?? args.text}" did not enter viewport after ${MAX_ITERATIONS} swipe iterations`, { code: 'SCROLL_EXHAUSTED', iterations: MAX_ITERATIONS });
}
export function createDevicePinchHandler() {
    return withSession((args) => {
        const cliArgs = ['pinch', String(args.scale)];
        if (args.x != null && args.y != null) {
            cliArgs.push(String(args.x), String(args.y));
        }
        return runNative(cliArgs);
    });
}
// --- Back ---
export function createDeviceBackHandler() {
    return withSession(() => runNative(['back']));
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
            if (snap.reason === 'empty-capture') {
                return emptyCaptureFailResult();
            }
            return failResult('Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.', { code: 'SNAPSHOT_UNAVAILABLE' });
        }
        const { nodes, recoveredTier } = snap;
        for (const label of NEXT_KEY_LABELS) {
            const match = nodes.find((n) => n.label === label);
            if (!match)
                continue;
            const pressResult = await runNative(['press', `@${match.ref}`]);
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
export function findInLatestSnapshot(nodes, query, opts = {}) {
    const exact = opts.exact ?? false;
    for (const n of nodes) {
        if (n.label === query || n.identifier === query)
            return n;
    }
    if (exact)
        return null;
    for (const n of nodes) {
        if (n.label?.includes(query) || n.identifier?.includes(query))
            return n;
    }
    return null;
}
/** Element fully or partially intersects the screen rect. */
export function isInViewport(element, screen) {
    const elRight = element.x + element.width;
    const elBottom = element.y + element.height;
    const screenRight = screen.x + screen.width;
    const screenBottom = screen.y + screen.height;
    return (element.x < screenRight && elRight > screen.x && element.y < screenBottom && elBottom > screen.y);
}
/** Choose a swipe direction that should bring `element` into the screen. Returns null when already visible. */
export function decideScrollDirection(element, screen) {
    if (isInViewport(element, screen))
        return null;
    if (element.y >= screen.y + screen.height)
        return 'up';
    if (element.y + element.height <= screen.y)
        return 'down';
    if (element.x >= screen.x + screen.width)
        return 'left';
    if (element.x + element.width <= screen.x)
        return 'right';
    return null;
}
