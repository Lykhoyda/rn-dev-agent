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
