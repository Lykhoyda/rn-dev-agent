import type { ToolResult } from '../utils.js';

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

export function surfaceKeyboardGuard<T extends ToolResult>(result: T): T {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return result;

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }
  // "never throws" contract: JSON.parse('null') / scalars survive the try
  // block but explode on property access below.
  if (envelope === null || typeof envelope !== 'object') return result;

  const data = envelope.data as Record<string, unknown> | undefined;
  const keyboardGuard = data?.keyboardGuard;
  if (typeof keyboardGuard !== 'string') return result;

  const meta = (envelope.meta as Record<string, unknown> | undefined) ?? {};
  envelope.meta = { ...meta, keyboardGuard };

  // #379: runners report the guard step's native duration (probe + dismissal)
  // as data.keyboardGuardMs; lift it into the meta.timings_ms convention.
  const keyboardGuardMs = data?.keyboardGuardMs;
  if (typeof keyboardGuardMs === 'number') {
    const timings = (meta.timings_ms as Record<string, unknown> | undefined) ?? {};
    envelope.meta = {
      ...(envelope.meta as Record<string, unknown>),
      timings_ms: { ...timings, keyboardGuard: keyboardGuardMs },
    };
  }

  return {
    ...result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
}

// #379: the iOS guard's verify-or-refuse arm. Old runner artifacts predate the
// structured `code`, so the message prefix is the compatibility match — but
// only as a prefix, to avoid snagging errors that merely mention the code.
export function isKeyboardOccludedRefusal(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return false;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return false;
  }
  if (envelope === null || typeof envelope !== 'object') return false;
  const { code, error } = envelope as { code?: unknown; error?: unknown };
  if (code === 'KEYBOARD_OCCLUDED') return true;
  return typeof error === 'string' && error.startsWith('KEYBOARD_OCCLUDED');
}

export interface KeyboardAutoHealDeps {
  /** Dismiss via the injected JS helper; resolves true when it reports dismissed. */
  dismissViaJs: () => Promise<boolean>;
  /** Refresh the snapshot/ref map — targets relayout when the keyboard lifts. */
  refreshSnapshot: () => Promise<unknown>;
  /** Re-run the original tap exactly once. */
  retryTap: () => Promise<ToolResult>;
}

/**
 * #379 KEYBOARD_OCCLUDED auto-heal (JS-first, per D1250's fill pattern).
 * Bounded by construction: retryTap is the raw tap, so a second refusal flows
 * out unhealed. The retried tap re-runs the native occlusion guard — a JS
 * dismissal that didn't actually take effect can never tap through the
 * keyboard, it just re-refuses.
 */
export async function healKeyboardOccludedTap(
  first: ToolResult,
  deps: KeyboardAutoHealDeps | null,
): Promise<ToolResult> {
  if (!deps || !isKeyboardOccludedRefusal(first)) return first;
  const t0 = Date.now();
  let dismissed = false;
  try {
    dismissed = await deps.dismissViaJs();
  } catch {
    return first;
  }
  if (!dismissed) return first;
  try {
    await deps.refreshSnapshot();
  } catch {
    // Stale coords are survivable: the retry either re-binds by identity
    // (Story 05) or refuses again — never worse than skipping the retry.
  }
  const retried = await deps.retryTap();
  return tagKeyboardAutoHeal(retried, Date.now() - t0);
}

function tagKeyboardAutoHeal(result: ToolResult, healMs: number): ToolResult {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return result;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }
  if (envelope === null || typeof envelope !== 'object') return result;
  const meta = (envelope.meta as Record<string, unknown> | undefined) ?? {};
  envelope.meta = {
    ...meta,
    // A retry that refused again keeps its own guard status; only a served
    // tap is stamped as JS-dismissed.
    ...(result.isError ? {} : { keyboardGuard: 'js_dismissed' }),
    keyboardAutoHeal: { dismissed: true, healMs },
  };
  return {
    ...result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
}
