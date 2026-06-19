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
            case 'launchApp':
                out.push({ t: 'launch', stopApp: isObj(v) && v.stopApp === true });
                break;
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
export async function replayFlow(steps, dispatch) {
    const trace = [];
    let lastTapped = null;
    const fail = (i, reason) => ({
        passed: false,
        failedStepIndex: i,
        reason,
        steps: trace,
    });
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        try {
            switch (s.t) {
                case 'launch':
                    await dispatch.launch(s.stopApp);
                    trace.push({ t: s.t, ok: true });
                    break;
                case 'tap':
                    await dispatch.press(s.id);
                    lastTapped = s.id;
                    trace.push({ t: s.t, target: s.id, ok: true });
                    break;
                case 'type': {
                    if (!lastTapped)
                        return fail(i, 'inputText before any tapOn — no focus target');
                    await dispatch.type(lastTapped, s.text);
                    trace.push({ t: s.t, target: lastTapped, ok: true });
                    break;
                }
                case 'assert': {
                    const ok = await dispatch.isVisible(s.id);
                    trace.push({ t: s.t, target: s.id, ok });
                    if (!ok)
                        return fail(i, `assertVisible: "${s.id}" not present in CDP tree`);
                    break;
                }
                case 'wait':
                    await dispatch.settle();
                    trace.push({ t: s.t, ok: true });
                    break;
                case 'runFlow': {
                    if (await dispatch.isVisible(s.whenVisible)) {
                        const sub = await replayFlow(s.commands, dispatch);
                        trace.push(...sub.steps);
                        if (!sub.passed) {
                            return {
                                passed: false,
                                failedStepIndex: i,
                                reason: sub.reason,
                                steps: trace,
                            };
                        }
                    }
                    else {
                        trace.push({ t: s.t, target: s.whenVisible, ok: true });
                    }
                    break;
                }
            }
        }
        catch (e) {
            trace.push({ t: s.t, target: 'id' in s ? s.id : undefined, ok: false });
            return fail(i, e instanceof Error ? e.message : String(e));
        }
    }
    return { passed: true, steps: trace };
}
