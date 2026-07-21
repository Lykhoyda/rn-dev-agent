import { failResult, okResult } from '../utils.js';
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
    if (code === 'KEYBOARD_OCCLUDED' || code === 'KEYBOARD_DISMISS_FAILED')
        return true;
    return (typeof error === 'string' &&
        (error.startsWith('KEYBOARD_OCCLUDED') || error.startsWith('KEYBOARD_DISMISS_FAILED')));
}
export function keyboardVisibility(result) {
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string')
        return null;
    try {
        const envelope = JSON.parse(text);
        if (envelope.ok === false)
            return null;
        if (typeof envelope.data?.keyboardVisible === 'boolean') {
            return envelope.data.keyboardVisible;
        }
        return typeof envelope.data?.visible === 'boolean' ? envelope.data.visible : null;
    }
    catch {
        return null;
    }
}
const KEYBOARD_POSTCHECK_ATTEMPTS = 5;
const KEYBOARD_POSTCHECK_DELAY_MS = 100;
export async function waitForKeyboardHidden(refreshSnapshot, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    let last = 'unknown';
    for (let attempt = 0; attempt < KEYBOARD_POSTCHECK_ATTEMPTS; attempt += 1) {
        const visible = keyboardVisibility(await refreshSnapshot());
        if (visible === false)
            return 'hidden';
        // A producer that never emits visibility will not start on a later poll.
        if (visible === null)
            return 'unknown';
        last = 'visible';
        if (attempt < KEYBOARD_POSTCHECK_ATTEMPTS - 1)
            await sleep(KEYBOARD_POSTCHECK_DELAY_MS);
    }
    return last;
}
function nativeDismissTiers(via) {
    return via === 'native-control' ? ['native-control'] : ['native-control', via];
}
/** Shared standalone/batch dismissal chain with an independent hidden-state check. */
export async function dismissKeyboardWithParity(deps) {
    const native = await deps.nativeDismiss();
    if (!native.isError) {
        let data = {};
        try {
            data =
                JSON.parse(native.content[0]?.text ?? '{}').data ?? {};
        }
        catch {
            // A malformed native success cannot prove that the keyboard is hidden.
        }
        if (data.wasVisible === false && data.visible !== true) {
            return okResult({
                dismissed: false,
                keyboardGuard: 'no_keyboard',
                via: 'no_keyboard',
                attemptedTiers: [],
            });
        }
        if (data.dismissed === true && data.visible !== true) {
            const via = typeof data.via === 'string' ? data.via : 'native-control';
            // Producers that do not report keyboard visibility (Android runner,
            // protocol-v1 iOS) can only be corroborated by an independent probe;
            // absence of a visibility field is not a disconfirmation.
            const observed = data.visible === false ? 'hidden' : await waitForKeyboardHidden(deps.refreshSnapshot);
            if (observed !== 'visible') {
                return okResult({
                    dismissed: true,
                    keyboardGuard: 'auto_dismissed',
                    via,
                    attemptedTiers: nativeDismissTiers(via),
                    visibilityProof: observed === 'hidden' ? 'observed-hidden' : 'unavailable',
                });
            }
        }
    }
    const attemptedTiers = ['native-control', 'native-swipe'];
    if (deps.dismissViaJs) {
        attemptedTiers.push('js');
        try {
            if (await deps.dismissViaJs()) {
                const observed = await waitForKeyboardHidden(deps.refreshSnapshot);
                if (observed !== 'visible') {
                    return okResult({
                        dismissed: true,
                        keyboardGuard: 'auto_dismissed',
                        via: 'js',
                        attemptedTiers,
                        visibilityProof: observed === 'hidden' ? 'observed-hidden' : 'unavailable',
                    });
                }
            }
        }
        catch {
            // Fall through to the typed refusal; no hidden state was proven.
        }
    }
    return failResult('KEYBOARD_DISMISS_FAILED: every available dismissal tier failed; the keyboard was still observed visible.', 'KEYBOARD_DISMISS_FAILED', { attemptedTiers });
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
        if ((await waitForKeyboardHidden(deps.refreshSnapshot)) === 'visible')
            return first;
    }
    catch {
        return first;
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
        ...(result.isError ? {} : { keyboardGuard: 'auto_dismissed', via: 'js' }),
        keyboardAutoHeal: { dismissed: true, via: 'js', healMs },
    };
    return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
}
