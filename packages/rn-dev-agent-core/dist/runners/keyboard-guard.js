export function resolveKeyboardGuard(env) {
    const raw = (env.RN_KEYBOARD_GUARD ?? '').trim().toLowerCase();
    return !(raw === '0' || raw === 'false');
}
const GUARDED_VERBS = new Set(['tap', 'press', 'longPress']);
export function withKeyboardGuard(payload, verb, env) {
    if (!GUARDED_VERBS.has(verb))
        return payload;
    return { ...payload, guardKeyboard: resolveKeyboardGuard(env) };
}
export function surfaceKeyboardGuard(result) {
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string')
        return result;
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        return result;
    }
    // "never throws" contract: JSON.parse('null') / scalars survive the try
    // block but explode on property access below.
    if (envelope === null || typeof envelope !== 'object')
        return result;
    const data = envelope.data;
    const keyboardGuard = data?.keyboardGuard;
    if (typeof keyboardGuard !== 'string')
        return result;
    const meta = envelope.meta ?? {};
    envelope.meta = { ...meta, keyboardGuard };
    // #379: runners report the guard step's native duration (probe + dismissal)
    // as data.keyboardGuardMs; lift it into the meta.timings_ms convention.
    const keyboardGuardMs = data?.keyboardGuardMs;
    if (typeof keyboardGuardMs === 'number') {
        const timings = meta.timings_ms ?? {};
        envelope.meta = {
            ...envelope.meta,
            timings_ms: { ...timings, keyboardGuard: keyboardGuardMs },
        };
    }
    return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
}
// #379: the iOS guard's verify-or-refuse arm. Old runner artifacts predate the
// structured `code`, so the message prefix is the compatibility match — but
// only as a prefix, to avoid snagging errors that merely mention the code.
export function isKeyboardOccludedRefusal(result) {
    if (!result.isError)
        return false;
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string')
        return false;
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        return false;
    }
    if (envelope === null || typeof envelope !== 'object')
        return false;
    const { code, error } = envelope;
    if (code === 'KEYBOARD_OCCLUDED')
        return true;
    return typeof error === 'string' && error.startsWith('KEYBOARD_OCCLUDED');
}
/**
 * #379 KEYBOARD_OCCLUDED auto-heal (JS-first, per D1250's fill pattern).
 * Bounded by construction: retryTap is the raw tap, so a second refusal flows
 * out unhealed. The retried tap re-runs the native occlusion guard — a JS
 * dismissal that didn't actually take effect can never tap through the
 * keyboard, it just re-refuses.
 */
export async function healKeyboardOccludedTap(first, deps) {
    if (!deps || !isKeyboardOccludedRefusal(first))
        return first;
    const t0 = Date.now();
    let dismissed = false;
    try {
        dismissed = await deps.dismissViaJs();
    }
    catch {
        return first;
    }
    if (!dismissed)
        return first;
    try {
        await deps.refreshSnapshot();
    }
    catch {
        // Stale coords are survivable: the retry either re-binds by identity
        // (Story 05) or refuses again — never worse than skipping the retry.
    }
    const retried = await deps.retryTap();
    return tagKeyboardAutoHeal(retried, Date.now() - t0);
}
function tagKeyboardAutoHeal(result, healMs) {
    const text = result.content?.[0]?.text;
    if (typeof text !== 'string')
        return result;
    let envelope;
    try {
        envelope = JSON.parse(text);
    }
    catch {
        return result;
    }
    if (envelope === null || typeof envelope !== 'object')
        return result;
    const meta = envelope.meta ?? {};
    envelope.meta = {
        ...meta,
        // A retry that refused again keeps its own guard status; only a served
        // tap is stamped as JS-dismissed.
        ...(result.isError ? {} : { keyboardGuard: 'js_dismissed' }),
        keyboardAutoHeal: { dismissed: true, healMs },
    };
    return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
}
