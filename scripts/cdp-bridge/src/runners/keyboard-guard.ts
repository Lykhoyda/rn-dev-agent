export function resolveKeyboardGuard(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.RN_KEYBOARD_GUARD ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

const GUARDED_VERBS = new Set(['tap', 'press', 'longPress']);

export function withKeyboardGuard<T extends object>(
  payload: T,
  verb: string,
  env: NodeJS.ProcessEnv,
): T & { guardKeyboard?: boolean } {
  if (!GUARDED_VERBS.has(verb)) return payload;
  return { ...payload, guardKeyboard: resolveKeyboardGuard(env) };
}
