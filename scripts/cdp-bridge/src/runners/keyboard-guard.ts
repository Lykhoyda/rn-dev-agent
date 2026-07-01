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

interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
}

export function surfaceKeyboardGuard<T extends ToolResultLike>(result: T): T {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return result;

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }

  const data = envelope.data as Record<string, unknown> | undefined;
  const keyboardGuard = data?.keyboardGuard;
  if (typeof keyboardGuard !== 'string') return result;

  const meta = (envelope.meta as Record<string, unknown> | undefined) ?? {};
  envelope.meta = { ...meta, keyboardGuard };

  return {
    ...result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
}
