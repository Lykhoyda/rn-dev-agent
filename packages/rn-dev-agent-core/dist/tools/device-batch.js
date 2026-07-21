import { runNative } from '../agent-device-wrapper.js';
import { settleEnabled } from '../lifecycle/settle.js';
import { buildDirectionalScrollCliArgs, buildDirectionalSwipeCliArgs, fetchFindCandidates, pressCandidate, } from './device-interact.js';
import { withSession, okResult, failResult } from '../utils.js';
import { healKeyboardOccludedTap, surfaceKeyboardGuard } from '../runners/keyboard-guard.js';
import { captureAndResizeScreenshot } from './device-list.js';
// GH #321: a11y node types that represent something the agent can act on. Used
// to compact the batch's final payload to just the actionable surface.
const INTERACTIVE_A11Y_TYPES = new Set([
    'Button',
    'TextField',
    'SecureTextField',
    'TextView',
    'Switch',
    'Slider',
    'Link',
    'Cell',
    'MenuItem',
    'Tab',
    'Stepper',
    'SegmentedControl',
    'SearchField',
    'Toggle',
    'CheckBox',
    'RadioButton',
]);
/**
 * GH #321: reduce a device_snapshot payload to only its actionable nodes, each
 * compacted to { ref, type, label, identifier, hittable? }. Non-node payloads
 * (e.g. a screenshot result) and falsy input pass through unchanged. Exported
 * for unit tests; pure.
 */
export function salientizeSnapshotData(data) {
    if (!data || typeof data !== 'object')
        return data;
    const d = data;
    if (!Array.isArray(d.nodes))
        return data; // not a node snapshot — leave as-is
    const nodes = [];
    for (const n of d.nodes) {
        const type = typeof n.type === 'string' ? n.type : '';
        const identifier = typeof n.identifier === 'string' && n.identifier ? n.identifier : '';
        // Fail-safe: keep a node if it's an interactive type OR carries a testID.
        // A custom Pressable can surface as a11y type "Other" — dropping it on type
        // alone would strand the agent ("nothing to tap here") on a real control.
        if (!INTERACTIVE_A11Y_TYPES.has(type) && !identifier)
            continue;
        const entry = {};
        if (n.ref)
            entry.ref = n.ref;
        if (type)
            entry.type = type;
        if (typeof n.label === 'string' && n.label)
            entry.label = n.label;
        if (identifier)
            entry.identifier = identifier;
        // hittable=false means disabled OR center-off-screen (#395 semantics), not
        // "dead" — the right reaction is often scroll-into-view, not skip.
        if (n.hittable === false)
            entry.hittable = false;
        nodes.push(entry);
    }
    return { nodes, salient: true, fullNodeCount: d.nodes.length };
}
/**
 * Phase 125: snapshot-based testID resolution — single source of truth for
 * testID-keyed batch steps. Each call snapshots, returning the fresh ref so
 * layout-change drift can't invalidate refs across step boundaries.
 *
 * Phase 128 (post-review #3): supports BOTH snapshot shapes.
 *   - Daemon/CLI shape: `{data: {nodes: [{ref, identifier, ...}]}}` (flat)
 *   - iOS fast-runner shape: `{data: {tree: {ref?, identifier?, children?: [...]}}}`
 *     (nested XCUIElement dict). agent-device-wrapper.ts:483 documents this.
 *     Fast-runner snapshots populate AFTER the first daemon snapshot warms
 *     up the ref-map, so subsequent iOS testID lookups hit the tree shape
 *     and used to silently fail.
 *
 * GH #396: always returns the BARE ref id (no `@` prefix). The in-tree
 * runners emit envelope refs as `@e68` while the legacy daemon emitted `e68`;
 * callers compose the press target as `@${ref}`, so a passed-through prefix
 * produced `@@e68` → ref-map miss → misleading STALE_REF failure.
 *
 * Exported for unit tests; pure once a snapshot envelope is provided.
 */
export function findRefsByTestID(snapshotEnvelope, testID) {
    try {
        const env = JSON.parse(snapshotEnvelope);
        if (env.ok === false)
            return [];
        // Daemon/CLI shape — flat array.
        const nodes = env.data?.nodes;
        if (Array.isArray(nodes)) {
            return nodes
                .filter((n) => n.identifier === testID && typeof n.ref === 'string')
                .map((n) => bareRef(n.ref));
        }
        // Fast-runner shape — nested tree.
        if (env.data?.tree) {
            const refs = [];
            collectRefsInTree(env.data.tree, testID, refs);
            return refs;
        }
        return [];
    }
    catch {
        return [];
    }
}
// GH #386 (Story 05 Task 8): back-compat wrapper — first match or null. Kept
// for callers/tests that only ever cared about a single ref; batch call sites
// now go through findRefsByTestID directly so they can refuse on ambiguity.
export function findRefByTestID(snapshotEnvelope, testID) {
    return findRefsByTestID(snapshotEnvelope, testID)[0] ?? null;
}
function bareRef(ref) {
    return ref.startsWith('@') ? ref.slice(1) : ref;
}
function collectRefsInTree(node, testID, out) {
    if (node.identifier === testID && typeof node.ref === 'string')
        out.push(bareRef(node.ref));
    if (Array.isArray(node.children)) {
        for (const child of node.children)
            collectRefsInTree(child, testID, out);
    }
}
/**
 * Phase 128 (post-review #5/#6): peek the agent-device envelope's ok flag
 * BEFORE computing testID resolution / visibility. Distinguishes
 * "snapshot infrastructure failed" from "element not present" so callers
 * can route to SNAPSHOT_FAILED vs TESTID_NOT_FOUND with accurate hints.
 */
export function snapshotEnvelopeFailed(envelope) {
    if (!envelope)
        return true;
    try {
        const env = JSON.parse(envelope);
        return env.ok === false;
    }
    catch {
        return true;
    }
}
async function resolveTestIDViaSnapshot(testID) {
    const result = await runNative(['snapshot', '-i']);
    const envelope = result.content?.[0]?.text ?? null;
    const snapshotFailed = snapshotEnvelopeFailed(envelope);
    if (snapshotFailed)
        return { refs: [], envelope, snapshotFailed: true };
    return { refs: findRefsByTestID(envelope, testID), envelope, snapshotFailed: false };
}
// GH #386 (Story 05 Task 8): batch shares the unique-match POLICY with the
// rest of the self-healing-taps story ("never guess-tap") — it matches by
// user-supplied testID against envelope JSON rather than the refreshRef
// signature matcher, so it shares the rule, not the matcher implementation.
function ambiguousTestIDFail(testID, refs) {
    return failResult(`testID "${testID}" matches ${refs.length} elements — refusing to guess-tap`, 'AMBIGUOUS_TESTID', {
        testID,
        candidates: refs.slice(0, 5).map((r) => `@${r}`),
        hint: 'Make the testID unique, or target a specific @ref from device_snapshot instead.',
    });
}
// #385: batch steps get a LOWER settle budget than standalone verbs — a
// 10-step walk on an animating screen at the 6000ms default would take up to
// ~60s. 2500ms still covers window-gate / screen-static and ~2 snapshot
// polls; settle:false skips entirely.
const BATCH_STEP_SETTLE_BUDGET_MS = 2500;
function stepSettleOpts(step) {
    if (step.settle === false)
        return { settle: { enabled: false } };
    return { settle: { timeoutMs: BATCH_STEP_SETTLE_BUDGET_MS } };
}
// Settle governs inter-step stability when it is on, so the blanket 300ms
// inter-step sleep drops to 0; an explicit caller delayMs is always honored.
// Env-gating alone is safe: the snapshot-eq tier works on ALL runners —
// capability flags only select the cheaper tiers.
export function resolveBatchDelayMs(explicit, env) {
    if (explicit !== undefined)
        return explicit;
    return settleEnabled(env) ? 0 : 300;
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function guardedBatchPress(cliArgs, opts, getClient) {
    const tap = async () => surfaceKeyboardGuard(await runNative(cliArgs, opts));
    const first = await tap();
    if (!first.isError || !getClient)
        return first;
    const client = getClient();
    if (!client.isConnected || !client.helpersInjected)
        return first;
    return healKeyboardOccludedTap(first, {
        dismissViaJs: async () => {
            const result = await client.evaluate('__RN_AGENT.dismissKeyboard()');
            if (typeof result.value !== 'string')
                return false;
            try {
                return JSON.parse(result.value).dismissed === true;
            }
            catch {
                return false;
            }
        },
        refreshSnapshot: () => runNative(['snapshot', '-i']),
        retryTap: tap,
    });
}
async function dismissKeyboardWithParity(settleOpts, getClient) {
    const native = await runNative(['keyboard', 'dismiss'], settleOpts);
    if (!native.isError)
        return native;
    const attemptedTiers = ['native-swipe', 'native-control'];
    if (getClient) {
        const client = getClient();
        if (client.isConnected && client.helpersInjected) {
            attemptedTiers.push('js');
            try {
                const js = await client.evaluate('__RN_AGENT.dismissKeyboard()');
                const parsed = typeof js.value === 'string' ? JSON.parse(js.value) : null;
                if (parsed?.dismissed) {
                    const check = await runNative(['snapshot', '-i']);
                    const text = check.content?.[0]?.text;
                    const visible = typeof text === 'string'
                        ? JSON.parse(text).data?.keyboardVisible
                        : undefined;
                    if (visible === false) {
                        return okResult({ dismissed: true, via: 'js', attemptedTiers });
                    }
                }
            }
            catch {
                // Fall through to the honest typed refusal below.
            }
        }
    }
    return failResult('KEYBOARD_DISMISS_FAILED: every available dismissal tier failed; keyboard visibility was not proven false.', 'KEYBOARD_DISMISS_FAILED', { attemptedTiers });
}
async function executeStep(step, getClient) {
    switch (step.action) {
        case 'find': {
            // Phase 125: testID-keyed find re-resolves via snapshot per call.
            // Phase 128 (post-review #5/#6): distinguish snapshot infrastructure
            // failure from "testID not present" so the user gets the right hint.
            if (step.testID) {
                const { refs, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
                if (snapshotFailed) {
                    return failResult(`Snapshot failed while resolving testID "${step.testID}" — agent-device unreachable, daemon crashed, or snapshot timed out`, 'SNAPSHOT_FAILED', {
                        testID: step.testID,
                        envelope: envelope?.slice(0, 500),
                        hint: 'Run cdp_status / device_list to verify the device + agent-device session are healthy. This is NOT a "testID missing" condition.',
                    });
                }
                // GH #386: a bare inspection find (no tap) is permissive — refusing a
                // read loses capability the caller never asked to spend (review
                // consensus #5). Only gate the refusal when a tap would follow.
                if (refs.length > 1 && step.tap)
                    return ambiguousTestIDFail(step.testID, refs);
                const ref = refs[0];
                if (!ref) {
                    return failResult(`testID "${step.testID}" not found in current UI snapshot`, 'TESTID_NOT_FOUND', {
                        testID: step.testID,
                        hint: 'Element may not be on-screen yet (animation? modal not mounted?). Re-snapshot after a short wait, or use device_snapshot directly to inspect the tree.',
                    });
                }
                if (step.tap)
                    return guardedBatchPress(['press', `@${ref}`], stepSettleOpts(step), getClient);
                return okResult({
                    resolved: ref,
                    testID: step.testID,
                    ...(refs.length > 1
                        ? { ambiguous: true, candidates: refs.slice(0, 5).map((r) => `@${r}`) }
                        : {}),
                    snapshotEnvelopePreviewBytes: envelope?.length ?? 0,
                });
            }
            if (!step.text)
                return failResult('find requires text or testID');
            const findResult = await fetchFindCandidates(step.text, false);
            if (!findResult.ok) {
                return failResult(`find: snapshot unavailable for "${step.text}"`, {
                    code: 'SNAPSHOT_UNAVAILABLE',
                    query: step.text,
                });
            }
            if (findResult.candidates.length === 0) {
                return failResult(`No element matches "${step.text}"`, {
                    code: 'NOT_FOUND',
                    query: step.text,
                });
            }
            if (step.tap)
                return pressCandidate(findResult.candidates[0], 'click');
            return okResult({
                ref: findResult.candidates[0].ref,
                label: findResult.candidates[0].label,
                testID: findResult.candidates[0].testID,
            });
        }
        case 'press': {
            if (step.testID) {
                const { refs, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
                if (snapshotFailed) {
                    return failResult(`Snapshot failed while resolving testID "${step.testID}" for press — agent-device unreachable`, 'SNAPSHOT_FAILED', { testID: step.testID, envelope: envelope?.slice(0, 500) });
                }
                if (refs.length > 1)
                    return ambiguousTestIDFail(step.testID, refs);
                const ref = refs[0];
                if (!ref) {
                    return failResult(`testID "${step.testID}" not found in current UI snapshot`, 'TESTID_NOT_FOUND', {
                        testID: step.testID,
                    });
                }
                return guardedBatchPress(['press', `@${ref}`], stepSettleOpts(step), getClient);
            }
            if (!step.ref)
                return failResult('press requires ref or testID');
            const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
            return guardedBatchPress(['press', ref], stepSettleOpts(step), getClient);
        }
        case 'fill': {
            if (!step.text)
                return failResult('fill requires text');
            if (step.testID) {
                const { refs, envelope, snapshotFailed } = await resolveTestIDViaSnapshot(step.testID);
                if (snapshotFailed) {
                    return failResult(`Snapshot failed while resolving testID "${step.testID}" for fill — agent-device unreachable`, 'SNAPSHOT_FAILED', { testID: step.testID, envelope: envelope?.slice(0, 500) });
                }
                if (refs.length > 1)
                    return ambiguousTestIDFail(step.testID, refs);
                const ref = refs[0];
                if (!ref) {
                    return failResult(`testID "${step.testID}" not found in current UI snapshot`, 'TESTID_NOT_FOUND', {
                        testID: step.testID,
                    });
                }
                return runNative(['fill', `@${ref}`, step.text], stepSettleOpts(step));
            }
            if (!step.ref)
                return failResult('fill requires ref or testID. Use a find+tap step first to focus the field, or pass testID for fresh resolution.');
            const ref = step.ref.startsWith('@') ? step.ref : `@${step.ref}`;
            return runNative(['fill', ref, step.text], stepSettleOpts(step));
        }
        case 'swipe': {
            if (!step.direction)
                return failResult('swipe requires direction');
            return runNative(buildDirectionalSwipeCliArgs(step.direction, step.ms), stepSettleOpts(step));
        }
        case 'scroll': {
            if (!step.direction)
                return failResult('scroll requires direction');
            // Coordinate form — the raw ['scroll', direction] shape throws in the
            // iOS/Android arg builders and aborted the whole batch.
            return runNative(buildDirectionalScrollCliArgs(step.direction), stepSettleOpts(step));
        }
        case 'back': {
            return runNative(['back'], stepSettleOpts(step));
        }
        case 'hideKeyboard': {
            return dismissKeyboardWithParity(stepSettleOpts(step), getClient);
        }
        case 'snapshot': {
            return runNative(['snapshot', '-i']);
        }
        case 'screenshot': {
            // B121: route through the resize wrapper (B120 default maxWidth=800)
            // so batch-step screenshots don't pay native-resolution context cost.
            return captureAndResizeScreenshot({});
        }
        case 'wait': {
            await sleep(step.ms ?? 500);
            return okResult({ waited: step.ms ?? 500 });
        }
        default:
            return failResult(`Unknown action: ${step.action}`);
    }
}
function isOk(result) {
    try {
        const parsed = JSON.parse(result.content[0].text);
        return parsed.ok;
    }
    catch {
        return !result.isError;
    }
}
function extractData(result) {
    try {
        const parsed = JSON.parse(result.content[0].text);
        return parsed.data;
    }
    catch {
        return null;
    }
}
export function createDeviceBatchHandler(getClient) {
    return withSession(async (args) => {
        const { steps, screenshotOn = 'failure', continueOnError = false, finalSnapshot: finalSnapshotMode = 'salient', } = args;
        const delayMs = resolveBatchDelayMs(args.delayMs, process.env);
        if (!steps || steps.length === 0) {
            return failResult('steps array is required and must not be empty');
        }
        const batchStart = Date.now();
        const results = [];
        let finalSnapshot = null;
        let failedStep = null;
        const failureRecords = [];
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const stepStart = Date.now();
            // Phase 125: per-step timeout override; default 15s.
            // Note: timed-out steps continue executing in background (agent-device CLI
            // calls cannot be cancelled). The timeout prevents the batch from hanging,
            // but the underlying action may complete after the timeout fires.
            const stepTimeout = step.timeoutMs ?? 15_000;
            let stepTimer;
            let stepTimedOut = false;
            const result = await Promise.race([
                executeStep(step, getClient),
                new Promise((resolve) => {
                    stepTimer = setTimeout(() => {
                        stepTimedOut = true;
                        resolve(failResult(`Step ${i + 1} timed out after ${stepTimeout}ms; remaining steps were not started because the native operation may still be completing`));
                    }, stepTimeout);
                }),
            ]);
            if (stepTimer)
                clearTimeout(stepTimer);
            const success = isOk(result);
            const durationMs = Date.now() - stepStart;
            const stepResult = {
                step: i + 1,
                action: step.action,
                success,
                durationMs,
            };
            if (!success) {
                try {
                    const parsed = JSON.parse(result.content[0].text);
                    stepResult.error = parsed.error;
                }
                catch {
                    /* ignore */
                }
            }
            if (step.action === 'snapshot' && success) {
                finalSnapshot = extractData(result);
            }
            else if (step.action === 'find' && success && step.testID !== undefined && !step.tap) {
                // GH #386: expose the testID-find-without-tap payload — the only find
                // variant whose ok payload carries the ambiguous/candidates info —
                // otherwise it's computed but never reaches the batch caller.
                // Text-based finds and find+tap keep their pre-existing shape
                // (no per-step data).
                stepResult.data = extractData(result);
            }
            results.push(stepResult);
            // A native command cannot be cancelled after Promise.race returns. Never
            // start a later OTP/form fill behind a timed-out mutation: that is the
            // interleaving boundary. Timeout therefore overrides optional and
            // continueOnError, while ordinary failures retain their legacy policy.
            if (!success && (!step.optional || stepTimedOut)) {
                // Capture failure screenshot regardless of continueOnError so the
                // diagnostic trail isn't lost.
                if (screenshotOn === 'failure' || screenshotOn === 'each') {
                    try {
                        // B121: route through resize wrapper.
                        const ssResult = await captureAndResizeScreenshot({});
                        if (isOk(ssResult)) {
                            stepResult.data = extractData(ssResult);
                        }
                    }
                    catch {
                        /* best effort */
                    }
                }
                if (continueOnError && !stepTimedOut) {
                    // Phase 125: record the failure and proceed. failedStep stays null
                    // so the batch returns success-shape with failure_count populated.
                    failureRecords.push(stepResult);
                }
                else {
                    failedStep = stepResult;
                    break;
                }
            }
            if (screenshotOn === 'each' && step.action !== 'screenshot') {
                // B121: route through resize wrapper so per-step captures pay budget.
                try {
                    await captureAndResizeScreenshot({});
                }
                catch {
                    /* ignore */
                }
            }
            if (i < steps.length - 1 && step.action !== 'wait' && delayMs > 0) {
                await sleep(delayMs);
            }
        }
        if (!failedStep && screenshotOn === 'end') {
            try {
                // B121: route through resize wrapper.
                const ssResult = await captureAndResizeScreenshot({});
                if (isOk(ssResult)) {
                    finalSnapshot = extractData(ssResult);
                }
            }
            catch {
                /* best effort */
            }
        }
        // GH #321: skip the implicit trailing snapshot when the caller doesn't want
        // it (action-only batches that verify via expect_*/cdp_store_state) — saves a
        // full ~1,450 ms snapshot round-trip.
        if (!finalSnapshot && !failedStep && finalSnapshotMode !== 'none') {
            try {
                const snapResult = await runNative(['snapshot', '-i']);
                if (isOk(snapResult)) {
                    finalSnapshot = extractData(snapResult);
                }
            }
            catch {
                /* best effort */
            }
        }
        // GH #321: by default return only the actionable surface (compact salient
        // digest). 'full' keeps the legacy complete node list. A node-shaped payload
        // is required; a screenshot 'end' payload passes through untouched.
        if (finalSnapshot && finalSnapshotMode === 'salient') {
            finalSnapshot = salientizeSnapshotData(finalSnapshot);
        }
        const totalDuration = Date.now() - batchStart;
        if (failedStep) {
            return failResult(`Step ${failedStep.step} failed: ${failedStep.action}${failedStep.error ? ' — ' + failedStep.error : ''}`, {
                steps_completed: failedStep.step - 1,
                total_steps: steps.length,
                failed_step: failedStep,
                duration_ms: totalDuration,
                results,
            });
        }
        // Phase 125: under continueOnError, surface partial-failure shape so the
        // caller knows N steps failed but the batch finished. Without continueOnError
        // a non-optional failure already aborted via failedStep above, so we'd never
        // reach here with failureRecords populated under that branch.
        return okResult({
            success: failureRecords.length === 0,
            steps_completed: steps.length,
            total_steps: steps.length,
            failure_count: failureRecords.length,
            failures: failureRecords.length ? failureRecords : undefined,
            duration_ms: totalDuration,
            results,
            final_snapshot: finalSnapshot,
        });
    });
}
