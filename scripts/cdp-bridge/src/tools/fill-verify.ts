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

export interface EvaluateSeam {
  evaluate: (expression: string) => Promise<{ value?: unknown; error?: unknown }>;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsFillResult {
  handled: boolean;
  outcome?: FillVerifyOutcome;
  valueAfter?: string | null;
  controlled?: boolean;
  handler?: string;
}

// 5 reads × 80ms between = ~320ms settle window, covering the common ~300ms RN
// onChangeText debounce so a slow-but-correct controlled update is not misread as
// corruption (GH#191 multi-review H2). The happy path breaks on the first read.
const READ_SETTLE_TRIES = 5;
const READ_SETTLE_DELAY_MS = 80;

async function readInputValueOnce(
  deps: EvaluateSeam,
  testID: string,
): Promise<{ value: string | null; controlled: boolean } | null> {
  try {
    const r = await deps.evaluate('__RN_AGENT.readInputValue(' + JSON.stringify(testID) + ')');
    if (!r.error && typeof r.value === 'string') {
      const read = JSON.parse(r.value) as { value?: string | null; controlled?: boolean; __agent_error?: string };
      if (!read.__agent_error) return { value: read.value ?? null, controlled: read.controlled ?? false };
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/**
 * Poll readInputValue until the controlled re-render flushes. Stops on exact, or
 * when the value diverges from the pre-type `valueBefore` (flushed → classify).
 * Defeats the debounced-onChangeText read race. valueBefore null (uncontrolled)
 * → polls then returns null → unverifiable upstream.
 */
export async function settleRead(
  deps: EvaluateSeam,
  testID: string,
  text: string,
  valueBefore: string | null,
): Promise<{ value: string | null; controlled: boolean }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let value: string | null = valueBefore;
  let controlled = false;
  let everRead = false;
  for (let i = 0; i < READ_SETTLE_TRIES; i++) {
    const rb = await readInputValueOnce(deps, testID);
    if (rb) {
      value = rb.value;
      controlled = rb.controlled;
      everRead = true;
    }
    if (value === text) break;
    if (value !== valueBefore) break;
    if (i < READ_SETTLE_TRIES - 1) await sleep(READ_SETTLE_DELAY_MS);
  }
  // If we never got a successful read, the field value is unknown → null → unverifiable upstream.
  if (!everRead) return { value: null, controlled: false };
  return { value, controlled };
}

/**
 * JS-first fill: eval-1 probes + fires onChangeText (no-op when no handler), then
 * settle-poll the value. Any CDP hiccup / stale helper degrades to handled:false.
 */
export async function attemptJsFill(deps: EvaluateSeam, testID: string, text: string): Promise<JsFillResult> {
  let probe: Record<string, unknown>;
  try {
    const expr = '__RN_AGENT.interact(' + JSON.stringify({ action: 'typeText', testID, text, verify: true }) + ')';
    const r = await deps.evaluate(expr);
    if (r.error || typeof r.value !== 'string') return { handled: false };
    probe = JSON.parse(r.value) as Record<string, unknown>;
  } catch {
    return { handled: false };
  }
  if (probe.error) return { handled: false };
  if (probe.controlled === undefined) return { handled: false };
  if (probe.handlerCalled === false || probe.handlerCalled === undefined) return { handled: false };

  const valueBefore = typeof probe.valueBefore === 'string' ? probe.valueBefore : null;
  const settled = await settleRead(deps, testID, text, valueBefore);
  return {
    handled: true,
    outcome: classifyFillVerification({ text, valueAfter: settled.value, controlled: settled.controlled }),
    valueAfter: settled.value,
    controlled: settled.controlled,
    handler: typeof probe.handlerCalled === 'string' ? probe.handlerCalled : undefined,
  };
}
