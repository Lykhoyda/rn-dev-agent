export class UnsupportedStepError extends Error {
    stepKey;
    constructor(stepKey) {
        super(`cdp-flow-replay: unsupported Maestro step "${stepKey}" (no CDP/JS mapping)`);
        this.stepKey = stepKey;
        this.name = 'UnsupportedStepError';
    }
}
const interp = (s, p) => s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, k) => p[k] ?? `\${${k}}`);
const asString = (x) => (typeof x === 'string' ? x : null);
const isObj = (x) => typeof x === 'object' && x !== null && !Array.isArray(x);
export function normalizeSteps(body, params) {
    const out = [];
    for (const raw of body) {
        if (raw === 'waitForAnimationToEnd') {
            out.push({ t: 'wait' });
            continue;
        }
        if (!isObj(raw))
            throw new UnsupportedStepError(typeof raw === 'string' ? raw : `non-object(${typeof raw})`);
        const keys = Object.keys(raw);
        if (keys.length !== 1)
            throw new UnsupportedStepError(keys.join('+') || 'empty');
        const key = keys[0];
        const v = raw[key];
        switch (key) {
            case 'launchApp': {
                // GH #580: `simctl launch` cannot clear state (that needs uninstall +
                // reinstall), so an unhonorable key must refuse, not silently drop.
                if (isObj(v)) {
                    const unsupported = Object.keys(v).filter((k) => k !== 'stopApp');
                    if (unsupported.length > 0)
                        throw new UnsupportedStepError(`launchApp (unsupported keys: ${unsupported.sort().join(', ')})`);
                    // A non-boolean stopApp would coerce to false — different launch
                    // semantics than the author wrote, which is the same silent lie.
                    if ('stopApp' in v && typeof v.stopApp !== 'boolean')
                        throw new UnsupportedStepError('launchApp (stopApp must be a boolean)');
                }
                out.push({ t: 'launch', stopApp: isObj(v) && v.stopApp === true });
                break;
            }
            case 'tapOn': {
                const id = isObj(v) ? asString(v.id) : null;
                if (!id)
                    throw new UnsupportedStepError('tapOn (missing string id)');
                out.push({ t: 'tap', id: interp(id, params) });
                break;
            }
            case 'inputText': {
                const text = asString(v);
                if (text === null)
                    throw new UnsupportedStepError('inputText (value not a string)');
                out.push({ t: 'type', text: interp(text, params) });
                break;
            }
            case 'assertVisible': {
                const id = isObj(v) ? asString(v.id) : null;
                if (!id)
                    throw new UnsupportedStepError('assertVisible (missing string id)');
                out.push({ t: 'assert', id: interp(id, params) });
                break;
            }
            case 'waitForAnimationToEnd':
                out.push({ t: 'wait' });
                break;
            case 'runFlow': {
                const when = isObj(v) && isObj(v.when) && isObj(v.when.visible) ? asString(v.when.visible.id) : null;
                const commands = isObj(v) ? v.commands : undefined;
                if (!when || !Array.isArray(commands))
                    throw new UnsupportedStepError('runFlow (need when.visible.id + commands[])');
                out.push({
                    t: 'runFlow',
                    whenVisible: interp(when, params),
                    commands: normalizeSteps(commands, params),
                });
                break;
            }
            default:
                throw new UnsupportedStepError(key);
        }
    }
    return out;
}
export function firstTestId(steps) {
    for (const s of steps) {
        if (s.t === 'tap' || s.t === 'assert')
            return s.id;
    }
    return null;
}
// Bound the walk so a pathologically nested action body cannot stall the scan.
const MAX_ANCHOR_DEPTH = 20;
// Counted, not OR-ed: two matches inside one step must stay detectably ambiguous.
function countIdHits(node, params, selector, index, depth, nested, scan) {
    if (depth > MAX_ANCHOR_DEPTH) {
        scan.truncated = true;
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node)
            countIdHits(child, params, selector, index, depth + 1, nested, scan);
        return;
    }
    if (!isObj(node))
        return;
    for (const [key, value] of Object.entries(node)) {
        if (key === 'id' && typeof value === 'string' && interp(value, params) === selector) {
            scan.hits.push({ index, nested });
            continue;
        }
        countIdHits(value, params, selector, index, depth + 1, nested || key === 'commands', scan);
    }
}
/**
 * GH #580: locate the one source step targeting `selector` so a reactive fallback
 * resumes there instead of replaying already-executed mutations. Anything but a
 * single top-level occurrence refuses — resuming at an enclosing `runFlow` would
 * redispatch the siblings preceding a nested match, and a truncated walk cannot
 * prove a deeper duplicate does not exist.
 */
export function findResumeAnchor(body, params, selector) {
    if (!selector)
        return { found: false, reason: 'no-match' };
    const scan = { hits: [], truncated: false };
    body.forEach((raw, index) => countIdHits(raw, params, selector, index, 0, false, scan));
    if (scan.truncated)
        return { found: false, reason: 'too-deep' };
    if (scan.hits.length === 0)
        return { found: false, reason: 'no-match' };
    if (scan.hits.length > 1)
        return { found: false, reason: 'ambiguous' };
    return scan.hits[0].nested
        ? { found: false, reason: 'nested-match' }
        : { found: true, index: scan.hits[0].index };
}
// GH #580: resumed suffixes report source indices, not suffix-relative indices.
export async function replayFlow(steps, dispatch, opts = {}) {
    const offset = opts.indexOffset ?? 0;
    const trace = [];
    let lastTapped = null;
    const sourceIndex = (i) => opts.sourceIndex ?? i + offset;
    const fail = (i, reason) => ({
        passed: false,
        failedStepIndex: sourceIndex(i),
        reason,
        steps: trace,
    });
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        try {
            switch (s.t) {
                case 'launch':
                    await dispatch.launch(s.stopApp);
                    trace.push({ sourceIndex: sourceIndex(i), t: s.t, ok: true });
                    break;
                case 'tap':
                    await dispatch.press(s.id);
                    lastTapped = s.id;
                    trace.push({ sourceIndex: sourceIndex(i), t: s.t, target: s.id, ok: true });
                    break;
                case 'type': {
                    if (!lastTapped)
                        return fail(i, 'inputText before any tapOn — no focus target');
                    await dispatch.type(lastTapped, s.text);
                    trace.push({ sourceIndex: sourceIndex(i), t: s.t, target: lastTapped, ok: true });
                    break;
                }
                case 'assert': {
                    const ok = await dispatch.isVisible(s.id);
                    trace.push({ sourceIndex: sourceIndex(i), t: s.t, target: s.id, ok });
                    if (!ok)
                        return fail(i, `assertVisible: "${s.id}" not present in CDP tree`);
                    break;
                }
                case 'wait':
                    await dispatch.settle();
                    trace.push({ sourceIndex: sourceIndex(i), t: s.t, ok: true });
                    break;
                case 'runFlow': {
                    if (await dispatch.isVisible(s.whenVisible)) {
                        const sub = await replayFlow(s.commands, dispatch, { sourceIndex: sourceIndex(i) });
                        trace.push(...sub.steps);
                        if (!sub.passed) {
                            return {
                                passed: false,
                                failedStepIndex: sourceIndex(i),
                                reason: sub.reason,
                                steps: trace,
                            };
                        }
                    }
                    else {
                        trace.push({
                            sourceIndex: sourceIndex(i),
                            t: s.t,
                            target: s.whenVisible,
                            ok: true,
                        });
                    }
                    break;
                }
            }
        }
        catch (e) {
            trace.push({
                sourceIndex: sourceIndex(i),
                t: s.t,
                target: 'id' in s ? s.id : undefined,
                ok: false,
            });
            return fail(i, e instanceof Error ? e.message : String(e));
        }
    }
    return { passed: true, steps: trace };
}
