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
    const data = envelope.data;
    const keyboardGuard = data?.keyboardGuard;
    if (typeof keyboardGuard !== 'string')
        return result;
    const meta = envelope.meta ?? {};
    envelope.meta = { ...meta, keyboardGuard };
    return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
    };
}
