export class UnsupportedStepError extends Error {
    stepKey;
    constructor(stepKey) {
        super(`cdp-flow-replay: unsupported Maestro step "${stepKey}" (no CDP/JS mapping)`);
        this.stepKey = stepKey;
        this.name = 'UnsupportedStepError';
    }
}
export class ReplayDispatchError extends Error {
    code;
    meta;
    constructor(code, message, meta) {
        super(message);
        this.code = code;
        this.meta = meta;
        this.name = 'ReplayDispatchError';
    }
}
const interp = (s, p) => s.replace(/\$\{([A-Z_][A-Z0-9_]*)(?:\s*\?\?\s*(['"])(.*?)\2)?\}/g, (match, key, _quote, fallback) => p[key] ?? fallback ?? match);
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
            case 'extendedWaitUntil': {
                const id = isObj(v) && isObj(v.visible) ? asString(v.visible.id) : null;
                const timeoutMs = isObj(v) ? v.timeout : undefined;
                if (!id || !Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 0)
                    throw new UnsupportedStepError('extendedWaitUntil (need visible.id + non-negative integer timeout)');
                out.push({ t: 'waitVisible', id: interp(id, params), timeoutMs: Number(timeoutMs) });
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
export async function replayFlow(steps, dispatch, opts = {}) {
    const offset = opts.indexOffset ?? 0;
    const trace = [];
    let lastTapped = null;
    const sourceIndex = (i) => opts.sourceIndex ?? i + offset;
    const fail = (i, reason, failureCode, failureMeta) => ({
        passed: false,
        failedStepIndex: sourceIndex(i),
        ...(failureCode ? { failureCode } : {}),
        ...(failureMeta ? { failureMeta } : {}),
        reason,
        steps: trace,
    });
    const requireNotAborted = () => {
        if (opts.signal?.aborted) {
            throw new ReplayDispatchError('RUNNER_TIMEOUT', 'React-tree replay exceeded its execution deadline');
        }
    };
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const startedAt = Date.now();
        try {
            requireNotAborted();
            switch (s.t) {
                case 'launch':
                    await dispatch.launch(s.stopApp);
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        ok: true,
                        durationMs: Date.now() - startedAt,
                    });
                    break;
                case 'tap':
                    await dispatch.press(s.id);
                    lastTapped = s.id;
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        target: s.id,
                        ok: true,
                        durationMs: Date.now() - startedAt,
                    });
                    break;
                case 'type': {
                    if (!lastTapped)
                        return fail(i, 'inputText before any tapOn — no focus target');
                    await dispatch.type(lastTapped, s.text);
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        target: lastTapped,
                        ok: true,
                        durationMs: Date.now() - startedAt,
                    });
                    break;
                }
                case 'assert': {
                    const verdict = await dispatch.visibility(s.id);
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        target: s.id,
                        ok: verdict.visible,
                        durationMs: Date.now() - startedAt,
                    });
                    if (!verdict.visible)
                        return fail(i, verdict.reason ?? `assertVisible: "${s.id}" is not frontmost`, verdict.code ?? 'ASSERTION_FAILED');
                    break;
                }
                case 'waitVisible': {
                    const deadline = Date.now() + s.timeoutMs;
                    let verdict = await dispatch.visibility(s.id);
                    while (!verdict.visible && Date.now() < deadline) {
                        requireNotAborted();
                        await new Promise((resolve) => setTimeout(resolve, 100));
                        verdict = await dispatch.visibility(s.id);
                    }
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        target: s.id,
                        ok: verdict.visible,
                        durationMs: Date.now() - startedAt,
                    });
                    if (!verdict.visible)
                        return fail(i, verdict.reason ?? `extendedWaitUntil: "${s.id}" is not frontmost`, verdict.code ?? 'TESTID_NOT_FOUND');
                    break;
                }
                case 'wait':
                    await dispatch.settle();
                    trace.push({
                        sourceIndex: sourceIndex(i),
                        t: s.t,
                        ok: true,
                        durationMs: Date.now() - startedAt,
                    });
                    break;
                case 'runFlow': {
                    if ((await dispatch.visibility(s.whenVisible)).visible) {
                        const sub = await replayFlow(s.commands, dispatch, {
                            sourceIndex: sourceIndex(i),
                            signal: opts.signal,
                        });
                        trace.push(...sub.steps);
                        if (!sub.passed) {
                            return {
                                passed: false,
                                failedStepIndex: sourceIndex(i),
                                ...(sub.failureCode ? { failureCode: sub.failureCode } : {}),
                                ...(sub.failureMeta ? { failureMeta: sub.failureMeta } : {}),
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
                            durationMs: Date.now() - startedAt,
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
                durationMs: Date.now() - startedAt,
            });
            return fail(i, e instanceof Error ? e.message : String(e), e instanceof ReplayDispatchError ? e.code : undefined, e instanceof ReplayDispatchError ? e.meta : undefined);
        }
    }
    return { passed: true, steps: trace };
}
