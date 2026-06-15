// D1206 Tier 2 Sprint B — Macro-Asserts.
//
// State-assertive primitives that wrap CDP introspection (Redux/Zustand
// store state, navigation state) and device snapshot (testID / visible-
// text presence) with assertion semantics. Returns failResult on
// assertion miss with the actual value, expected operator, and
// remediation hint.
//
// Why these matter: Maestro asserts pixels. These assert internal app
// state — the differentiated capability the plugin owns over Maestro
// Cloud / KaneAI / BrowserStack (D1206). Used both directly by the LLM
// during interactive walks and (eventually) embedded in Maestro flows
// via runScript: shell-out to the future CLI surface.
import { okResult, failResult, withConnection, withSession } from '../utils.js';
import { runNative } from '../agent-device-wrapper.js';
import { findRefByTestID, snapshotEnvelopeFailed } from './device-batch.js';
/**
 * Phase 128 (post-review #1): unwrap the {type, state} envelope produced
 * by getStoreState() in injected-helpers.ts:810. Without this, all
 * non-trivial assertions (length/contains/equals) compare against the
 * wrapper object instead of the resolved state value.
 *
 * Exported for unit tests.
 */
export function unwrapStoreEnvelope(value) {
    if (value !== null &&
        typeof value === 'object' &&
        'type' in value &&
        'state' in value) {
        return value.state;
    }
    return value;
}
// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — testable in isolation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Deep-equal sufficient for assertion use cases (primitives, arrays, plain
 * objects). Doesn't handle Date/RegExp/Map/Set/circular — store state we
 * read via cdp is JSON-serialized, so those can't appear.
 */
export function deepEqual(a, b) {
    if (a === b)
        return true;
    if (a === null || b === null)
        return false;
    if (typeof a !== 'object' || typeof b !== 'object')
        return false;
    if (Array.isArray(a) !== Array.isArray(b))
        return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!deepEqual(a[i], b[i]))
                return false;
        return true;
    }
    const oa = a;
    const ob = b;
    const ka = Object.keys(oa);
    const kb = Object.keys(ob);
    if (ka.length !== kb.length)
        return false;
    for (const k of ka)
        if (!deepEqual(oa[k], ob[k]))
            return false;
    return true;
}
export function evaluateReduxAssertions(actual, assertions) {
    // exists is the implicit default if nothing else is asserted.
    const ops = Object.keys(assertions).filter((k) => assertions[k] !== undefined);
    if (ops.length === 0) {
        if (actual === undefined || actual === null) {
            return { matched: false, failure: { op: 'exists', expected: true, actual } };
        }
        return { matched: true };
    }
    for (const op of ops) {
        const expected = assertions[op];
        let pass = false;
        switch (op) {
            case 'equals':
                pass = deepEqual(actual, expected);
                break;
            case 'exists':
                pass = expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;
                break;
            case 'notExists':
                pass = expected ? actual === undefined || actual === null : actual !== undefined && actual !== null;
                break;
            case 'length':
                pass = (Array.isArray(actual) || typeof actual === 'string') && actual.length === expected;
                break;
            case 'contains':
                pass = Array.isArray(actual) && actual.some((x) => deepEqual(x, expected));
                break;
            case 'gt':
                pass = typeof actual === 'number' && actual > expected;
                break;
            case 'lt':
                pass = typeof actual === 'number' && actual < expected;
                break;
            case 'gte':
                pass = typeof actual === 'number' && actual >= expected;
                break;
            case 'lte':
                pass = typeof actual === 'number' && actual <= expected;
                break;
        }
        if (!pass)
            return { matched: false, failure: { op, expected, actual } };
    }
    return { matched: true };
}
/**
 * Phase 128 (post-review #2): the simplify() path in injected-helpers.ts:411
 * produces `{ routeName, params, stack: [string,...], index, nested? }` —
 * note `stack` (array of strings), not `routes` (array of objects). The raw
 * pre-simplify React Navigation devtools state uses `routes: [{name,...}]`.
 * Support both so inStack assertions work on the most common production
 * path (simplify branch).
 */
export function extractStack(navState) {
    const out = new Set();
    // Simplified shape: stack is array of strings.
    if (Array.isArray(navState.stack)) {
        for (const n of navState.stack)
            if (typeof n === 'string')
                out.add(n);
    }
    // Raw shape: routes is array of {name}.
    if (Array.isArray(navState.routes)) {
        for (const r of navState.routes) {
            const name = r?.name;
            if (typeof name === 'string')
                out.add(name);
        }
    }
    // Walk nested nav stacks if present (Expo Router nests).
    if (navState.nested) {
        for (const n of extractStack(navState.nested))
            out.add(n);
    }
    return Array.from(out);
}
export function evaluateRouteAssertions(navState, assertions) {
    if (assertions.name !== undefined) {
        if (navState.routeName !== assertions.name) {
            return { matched: false, failure: { field: 'name', expected: assertions.name, actual: navState.routeName } };
        }
    }
    if (assertions.paramsEquals !== undefined) {
        if (!deepEqual(navState.params, assertions.paramsEquals)) {
            return { matched: false, failure: { field: 'params', expected: assertions.paramsEquals, actual: navState.params } };
        }
    }
    if (assertions.inStack !== undefined) {
        const stack = extractStack(navState);
        if (!stack.includes(assertions.inStack)) {
            return { matched: false, failure: { field: 'inStack', expected: assertions.inStack, actual: stack } };
        }
    }
    return { matched: true };
}
// ─────────────────────────────────────────────────────────────────────────────
// Polling helper
// ─────────────────────────────────────────────────────────────────────────────
async function pollUntil(fn, timeoutMs, intervalMs = 200) {
    const start = Date.now();
    while (true) {
        const out = await fn();
        if (out.matched)
            return out;
        if (timeoutMs <= 0 || Date.now() - start >= timeoutMs)
            return out;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
export function createExpectReduxHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (!args.path || typeof args.path !== 'string') {
            return failResult('expect_redux requires a path (e.g. "cart.items")');
        }
        const assertions = {
            equals: args.equals,
            exists: args.exists,
            notExists: args.notExists,
            length: args.length,
            contains: args.contains,
            gt: args.gt,
            lt: args.lt,
            gte: args.gte,
            lte: args.lte,
        };
        const pathArg = JSON.stringify(args.path);
        const typeArg = args.storeType ? JSON.stringify(args.storeType) : 'undefined';
        const expression = client.bridgeWithFallback(`getStoreState(${pathArg}, ${typeArg})`);
        const probe = async () => {
            const result = await client.evaluate(expression);
            if (result.error || typeof result.value !== 'string') {
                return { matched: false, result: { kind: 'eval-failed', reason: result.error ?? 'No string response from getStoreState' } };
            }
            let raw = undefined;
            try {
                raw = JSON.parse(result.value);
            }
            catch {
                return { matched: false, result: { kind: 'eval-failed', reason: 'getStoreState returned non-JSON' } };
            }
            // Phase 128 (post-review #8): truncation surfaces with the user's
            // original op preserved so the failure shape is accurate.
            if (raw !== null && typeof raw === 'object' && '__agent_truncated' in raw) {
                return { matched: false, result: { kind: 'truncated', previewSize: raw.originalLength } };
            }
            // Phase 128 (post-review #7): surface __agent_error from getStoreState
            // (path not found, no store mounted) as a distinct failure code.
            if (raw !== null && typeof raw === 'object' && '__agent_error' in raw) {
                const obj = raw;
                const hints = [];
                if (typeof obj.hint === 'string')
                    hints.push(obj.hint);
                if (typeof obj.hint2 === 'string')
                    hints.push(obj.hint2);
                if (typeof obj.hint3 === 'string')
                    hints.push(obj.hint3);
                return {
                    matched: false,
                    result: {
                        kind: 'path-not-found',
                        agentError: typeof obj.__agent_error === 'string' ? obj.__agent_error : 'unknown error',
                        availableKeys: obj.availableKeys,
                        hints: hints.length ? hints : undefined,
                    },
                };
            }
            // Phase 128 (post-review #1): unwrap {type, state} envelope from
            // getStoreState before asserting against operators.
            const actual = unwrapStoreEnvelope(raw);
            const ev = evaluateReduxAssertions(actual, assertions);
            if (ev.matched)
                return { matched: true, result: { kind: 'matched', actual } };
            return { matched: false, result: { kind: 'mismatched', actual, eval: ev } };
        };
        const polled = await pollUntil(probe, args.timeoutMs ?? 0);
        const result = polled.result;
        if (result.kind === 'matched') {
            return okResult({ matched: true, path: args.path, actual: result.actual });
        }
        if (result.kind === 'eval-failed') {
            return failResult(`expect_redux: store evaluator failed: ${result.reason}`, 'EVAL_FAILED', {
                path: args.path,
            });
        }
        if (result.kind === 'path-not-found') {
            return failResult(`expect_redux: path "${args.path}" not found — ${result.agentError}`, 'PATH_NOT_FOUND', {
                path: args.path,
                availableKeys: result.availableKeys,
                hints: result.hints,
                hint: 'Call cdp_store_state with no path to inspect the full store shape, then narrow.',
            });
        }
        if (result.kind === 'truncated') {
            // Phase 128 (post-review #8): preserve the user's intended op so
            // the failure shape is meaningful even when the payload was clipped.
            return failResult(`expect_redux: store payload at "${args.path}" exceeded the 30KB safe-stringify cap; assertion not evaluated`, 'STORE_TRUNCATED', {
                path: args.path,
                requestedAssertions: assertions,
                originalLength: result.previewSize,
                hint: 'Narrow the path to a smaller slice (e.g. "cart.items" instead of "cart") so the payload fits under the cap.',
            });
        }
        // Mismatched (assertion failure proper).
        return failResult(`expect_redux assertion failed at ${args.path}: ${result.eval.matched ? '' : result.eval.failure.op}`, 'ASSERTION_FAILED', {
            path: args.path,
            actual: result.actual,
            expected: result.eval.matched ? undefined : result.eval.failure.expected,
            op: result.eval.matched ? undefined : result.eval.failure.op,
            hint: 'If state is async (post-mutation), pass timeoutMs (e.g. 1000) to retry. If the path is wrong, call cdp_store_state without operators to inspect the shape.',
        });
    });
}
export function createExpectRouteHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.name === undefined && args.paramsEquals === undefined && args.inStack === undefined) {
            return failResult('expect_route requires at least one of: name, paramsEquals, inStack');
        }
        const probe = async () => {
            const result = await client.evaluate(client.helperExpr('getNavState()'));
            if (result.error || typeof result.value !== 'string') {
                return { matched: false, result: { navState: { error: result.error ?? 'no nav state' }, eval: { matched: false, failure: { field: 'name', expected: args.name, actual: undefined } } } };
            }
            let parsed;
            try {
                parsed = JSON.parse(result.value);
            }
            catch {
                return { matched: false, result: { navState: { error: 'malformed nav state' }, eval: { matched: false, failure: { field: 'name', expected: args.name, actual: undefined } } } };
            }
            const ev = evaluateRouteAssertions(parsed, args);
            return { matched: ev.matched, result: { navState: parsed, eval: ev } };
        };
        const polled = await pollUntil(probe, args.timeoutMs ?? 0);
        const { navState, eval: ev } = polled.result;
        if (ev.matched) {
            return okResult({ matched: true, navState });
        }
        return failResult(`expect_route assertion failed: ${ev.failure.field}`, 'ASSERTION_FAILED', {
            field: ev.failure.field,
            actual: ev.failure.actual,
            expected: ev.failure.expected,
            navState,
            hint: 'Call cdp_navigation_state directly to inspect the full route tree. If a navigation animation is in flight, pass timeoutMs (e.g. 1000) to retry.',
        });
    });
}
export function createExpectVisibleByTestIDHandler() {
    return withSession(async (args) => {
        if (!args.testID || typeof args.testID !== 'string') {
            return failResult('expect_visible_by_testid requires testID');
        }
        const expectVisible = args.exists !== false; // default true
        const probe = async () => {
            const result = await runNative(['snapshot', '-i']);
            const envelope = result.content?.[0]?.text ?? '';
            // Phase 128 (post-review #5): peek ok flag BEFORE computing
            // visibility — distinguishes infrastructure failure from "not present"
            // so we can't silent-pass an exists:false assertion when the snapshot
            // call actually failed.
            if (snapshotEnvelopeFailed(envelope)) {
                return { matched: false, result: { kind: 'snapshot-failed', envelope } };
            }
            const ref = findRefByTestID(envelope, args.testID);
            const visible = ref !== null;
            return { matched: visible === expectVisible, result: { kind: 'resolved', ref } };
        };
        const polled = await pollUntil(probe, args.timeoutMs ?? 0);
        if (polled.result.kind === 'snapshot-failed') {
            return failResult(`expect_visible_by_testid: snapshot failed while resolving testID "${args.testID}" — agent-device unreachable, daemon crashed, or snapshot timed out`, 'SNAPSHOT_FAILED', {
                testID: args.testID,
                envelope: polled.result.envelope.slice(0, 500),
                hint: 'Run cdp_status / device_list to verify the device + agent-device session are healthy. This is NOT a "testID missing" condition.',
            });
        }
        const { ref } = polled.result;
        const visible = ref !== null;
        if (polled.matched) {
            return okResult({ matched: true, testID: args.testID, visible, ref: ref ?? null });
        }
        return failResult(`expect_visible_by_testid: testID "${args.testID}" was ${visible ? 'visible' : 'NOT visible'}; expected ${expectVisible ? 'visible' : 'NOT visible'}`, 'ASSERTION_FAILED', {
            testID: args.testID,
            actualVisible: visible,
            expectedVisible: expectVisible,
            ref,
            hint: visible
                ? 'Element IS on screen but you expected it absent. Possible: stale modal, overlay not yet dismissed.'
                : 'Element is NOT on screen. Possible: animation in flight, mounted later, scrolled out of view. Pass timeoutMs (e.g. 2000) to retry, or call device_snapshot to see what IS rendered.',
        });
    });
}
export function findRefsByText(snapshotEnvelope, text, exact) {
    try {
        const env = JSON.parse(snapshotEnvelope);
        if (!env.ok)
            return [];
        const nodes = env.data?.nodes ?? [];
        const matches = nodes.filter((n) => {
            if (typeof n.label !== 'string')
                return false;
            if (exact)
                return n.label === text;
            return n.label.includes(text);
        });
        return matches.map((n) => n.ref).filter((r) => typeof r === 'string');
    }
    catch {
        return [];
    }
}
export function createExpectTextHandler() {
    return withSession(async (args) => {
        if (!args.text || typeof args.text !== 'string') {
            return failResult('expect_text requires text');
        }
        const expectVisible = args.exists !== false;
        const exact = args.exact === true;
        const probe = async () => {
            const result = await runNative(['snapshot', '-i']);
            const envelope = result.content?.[0]?.text ?? '';
            // Phase 128 (post-review #5): same snapshot-failure peek as
            // expect_visible_by_testid. exists:false would otherwise silent-pass.
            if (snapshotEnvelopeFailed(envelope)) {
                return { matched: false, result: { kind: 'snapshot-failed', envelope } };
            }
            const refs = findRefsByText(envelope, args.text, exact);
            const visible = refs.length > 0;
            return { matched: visible === expectVisible, result: { kind: 'resolved', refs } };
        };
        const polled = await pollUntil(probe, args.timeoutMs ?? 0);
        if (polled.result.kind === 'snapshot-failed') {
            return failResult(`expect_text: snapshot failed while searching for "${args.text}" — agent-device unreachable, daemon crashed, or snapshot timed out`, 'SNAPSHOT_FAILED', {
                text: args.text,
                envelope: polled.result.envelope.slice(0, 500),
                hint: 'Run cdp_status / device_list to verify the device + agent-device session are healthy. This is NOT a "text not present" condition.',
            });
        }
        const { refs } = polled.result;
        const visible = refs.length > 0;
        if (polled.matched) {
            return okResult({ matched: true, text: args.text, exact, visible, refs });
        }
        return failResult(`expect_text: text "${args.text}" was ${visible ? 'visible' : 'NOT visible'}; expected ${expectVisible ? 'visible' : 'NOT visible'}`, 'ASSERTION_FAILED', {
            text: args.text,
            exact,
            actualVisible: visible,
            expectedVisible: expectVisible,
            refs,
            hint: visible
                ? 'Text IS on screen but you expected it absent.'
                : 'Text is NOT on screen. Try exact=false for substring match, or device_snapshot to see what labels are rendered.',
        });
    });
}
