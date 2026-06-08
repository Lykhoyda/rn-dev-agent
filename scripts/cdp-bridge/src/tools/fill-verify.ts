export type FillVerifyOutcome =
  | 'verified-exact'
  | 'verified-transformed'
  | 'corrupted'
  | 'unverifiable';

export interface FillVerifyInput {
  text: string;
  valueAfter: string | null;
  controlled: boolean;
  priorValueAfter?: string | null;
}

const HALF = 0.5;

/**
 * Pure classification of a fill read-back. Escalation (`corrupted`) fires only
 * on a STRONG corruption signature — empty, or < half length and not yet proven
 * stable — exactly the #191 char-drop. Masks/formatters/maxLength → transformed.
 * Unreadable → unverifiable (soft-accept; never error merely for lack of proof).
 * NOTE (known gap, spec §9): length-only classification cannot distinguish a
 * length-preserving transform (autoCapitalize) from a length-preserving native
 * autocorrect swap; the JS path is deterministic so this bites only the native
 * path, where prong-3 suppression is the mitigation.
 */
export function classifyFillVerification(input: FillVerifyInput): FillVerifyOutcome {
  const { text, valueAfter, priorValueAfter } = input;
  if (valueAfter === null) return 'unverifiable';
  if (valueAfter === text) return 'verified-exact';
  if (text.length === 0) return 'corrupted';
  if (valueAfter.length > 0 && valueAfter.length >= HALF * text.length) return 'verified-transformed';
  if (
    priorValueAfter !== undefined &&
    priorValueAfter !== null &&
    valueAfter !== '' &&
    valueAfter === priorValueAfter
  ) {
    return 'verified-transformed';
  }
  return 'corrupted';
}

export interface ResolveTestIdOpts {
  explicitTestId?: string;
  cachedIdentifier?: string;
}

const SNAPSHOT_REF_TOKEN = /^e\d+$/; // fast-runner-ref-map mints `e${counter}`

/**
 * Resolve the testID for the JS-first path. Explicit wins; a snapshot ref token
 * (`@e5`) resolves via cached identifier (null if uncached → native path); a
 * bare numeric ref → null; anything else is taken as a literal testID.
 */
export function resolveJsTestId(ref: string, opts: ResolveTestIdOpts = {}): string | null {
  if (opts.explicitTestId && opts.explicitTestId.length > 0) return opts.explicitTestId;
  const stripped = ref.replace(/^@/, '');
  if (stripped.length === 0) return null;
  if (SNAPSHOT_REF_TOKEN.test(stripped)) return opts.cachedIdentifier && opts.cachedIdentifier.length > 0 ? opts.cachedIdentifier : null;
  if (/^\d+$/.test(stripped)) return null;
  return stripped;
}

export type NativeRetypeDecision =
  | { action: 'accept' }
  | { action: 'retype'; delayMs: number }
  | { action: 'escalate' };

const RETYPE_DELAY_MS = 40;

/** Pure decision for the native read-back loop. */
export function decideNativeRetype(
  outcome: FillVerifyOutcome,
  attemptsSoFar: number,
  maxAttempts: number,
): NativeRetypeDecision {
  if (outcome !== 'corrupted') return { action: 'accept' };
  if (attemptsSoFar >= maxAttempts) return { action: 'escalate' };
  return { action: 'retype', delayMs: RETYPE_DELAY_MS };
}
