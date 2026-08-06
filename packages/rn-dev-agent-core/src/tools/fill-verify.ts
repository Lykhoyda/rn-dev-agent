// GH #581: strict fill-truth model. A fill is `filled:true` only when the
// final arbiter proves a stable exact value through an authoritative oracle —
// fiber read-back for controlled inputs, native verifyInput for uncontrolled
// ones. Changed/half-length/same-length values, masked lengths, unreadable
// states, and oracle disagreement are inconclusive and hard-fail.

export type FiberVerifyOutcome = 'exact' | 'mismatch' | 'unreadable';

export interface FiberVerifyInput {
  text: string;
  valueAfter: string | null;
}

export function classifyFiberVerification(input: FiberVerifyInput): FiberVerifyOutcome {
  if (input.valueAfter === null) return 'unreadable';
  return input.valueAfter === input.text ? 'exact' : 'mismatch';
}

export type NativeVerifyVerdict =
  | 'exact'
  | 'mismatch'
  | 'unreadable'
  | 'secure-masked'
  | 'target-lost'
  | 'ambiguous'
  | 'unavailable';

export interface FinalVerification {
  verified: boolean;
  oracle: 'fiber' | 'native' | 'fiber+native' | 'none';
  fiber: FiberVerifyOutcome | 'unavailable';
  native: NativeVerifyVerdict;
  nativeStable: boolean;
  /** True when a readable oracle proved a stable wrong value (clear-first correction may descend). */
  observedMismatch: boolean;
}

// Arbitration: fiber-exact (controlled) verifies unless the native oracle
// READ a conflicting value; native stable-exact verifies when fiber cannot
// read. Native `ambiguous`/`target-lost` poison BOTH oracles — the same
// identifier ambiguity or screen change undermines the fiber's testID
// resolution too — so they hard-fail and veto corrective descent.
export function combineVerificationOracles(
  fiber: FiberVerifyOutcome | 'unavailable',
  native: NativeVerifyVerdict,
  nativeStable: boolean,
): FinalVerification {
  const targetCompromised = native === 'ambiguous' || native === 'target-lost';
  const fiberReadable = fiber === 'exact' || fiber === 'mismatch';
  let verified = false;
  let oracle: FinalVerification['oracle'] = 'none';
  if (!targetCompromised) {
    if (fiber === 'exact' && native === 'exact' && nativeStable) {
      verified = true;
      oracle = 'fiber+native';
    } else if (fiber === 'exact' && native !== 'mismatch') {
      // Controlled fiber truth stands unless the native oracle READ a
      // conflicting value; an exact-but-still-settling native read agrees.
      verified = true;
      oracle = 'fiber';
    } else if (!fiberReadable && native === 'exact' && nativeStable) {
      verified = true;
      oracle = 'native';
    }
  }
  // Corrective descent needs an UNANIMOUS readable mismatch: any exact claim
  // from either oracle (stable or not) makes the state disagreement/settling —
  // inconclusive and never retryable.
  const anyExact = fiber === 'exact' || native === 'exact';
  const observedMismatch =
    !verified &&
    !targetCompromised &&
    !anyExact &&
    (fiber === 'mismatch' || (native === 'mismatch' && nativeStable));
  return {
    verified,
    oracle,
    fiber,
    native,
    nativeStable,
    observedMismatch,
  };
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
  if (SNAPSHOT_REF_TOKEN.test(stripped))
    return opts.cachedIdentifier && opts.cachedIdentifier.length > 0 ? opts.cachedIdentifier : null;
  if (/^\d+$/.test(stripped)) return null;
  return stripped;
}

export type NativeRetypeDecision = { action: 'retype'; delayMs: number } | { action: 'escalate' };

const RETYPE_DELAY_MS = 40;

// Only an OBSERVED stable mismatch may descend (same-target clear-first
// correction); inconclusive outcomes never retype.
export function decideNativeRetype(
  verification: FinalVerification,
  attemptsSoFar: number,
  maxAttempts: number,
): NativeRetypeDecision {
  if (!verification.observedMismatch || attemptsSoFar >= maxAttempts) {
    return { action: 'escalate' };
  }
  return { action: 'retype', delayMs: RETYPE_DELAY_MS };
}

export interface EvaluateSeam {
  evaluate: (expression: string) => Promise<{ value?: unknown; error?: unknown }>;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsFillResult {
  handled: boolean;
  /** The mutating evaluate may have reached the app but its outcome is unknown — treat as possible mutation. */
  dispatchUncertain?: boolean;
  outcome?: FiberVerifyOutcome;
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
      const read = JSON.parse(r.value) as {
        value?: string | null;
        controlled?: boolean;
        __agent_error?: string;
      };
      if (!read.__agent_error)
        return { value: read.value ?? null, controlled: read.controlled ?? false };
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** Mutation-free controlled-ness/value probe used to pick the fill tier. */
export async function probeInputState(
  deps: EvaluateSeam,
  testID: string,
): Promise<{ readable: boolean; controlled: boolean; value: string | null }> {
  const read = await readInputValueOnce(deps, testID);
  if (!read) return { readable: false, controlled: false, value: null };
  return { readable: true, controlled: read.controlled, value: read.value };
}

/**
 * Poll readInputValue until the controlled re-render flushes. Stops on exact, or
 * when the value diverges from the pre-type `valueBefore` (flushed → classify).
 * Defeats the debounced-onChangeText read race. valueBefore null (uncontrolled)
 * → polls then returns null → unreadable upstream.
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
  // If we never got a successful read, the field value is unknown → null → unreadable upstream.
  if (!everRead) return { value: null, controlled: false };
  return { value, controlled };
}

const FIBER_CONFIRM_DELAY_MS = 150;
const FINAL_VERIFY_TRIES = 6;
const FINAL_VERIFY_DELAY_MS = 100;

/**
 * Final fiber oracle: poll through the declared settle window until the exact
 * value appears, then require it to hold on a delayed confirmation read (an
 * early exact that reverts is a mismatch). A non-exact value counts as
 * `mismatch` only when stable across consecutive reads; an unstable or
 * uncontrolled read is inconclusive (`unreadable`). Fiber-exact is only ever
 * reported for controlled inputs — the value prop is the authoritative state.
 */
export async function finalFiberVerify(
  deps: EvaluateSeam,
  testID: string,
  text: string,
): Promise<FiberVerifyOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let previous: { value: string | null; controlled: boolean } | null = null;
  let last: { value: string | null; controlled: boolean } | null = null;
  for (let i = 0; i < FINAL_VERIFY_TRIES; i++) {
    const read = await readInputValueOnce(deps, testID);
    if (read) {
      if (read.value === text && read.controlled) {
        await sleep(FIBER_CONFIRM_DELAY_MS);
        const confirm = await readInputValueOnce(deps, testID);
        if (confirm && confirm.value === text && confirm.controlled) return 'exact';
        return 'unreadable';
      }
      previous = last;
      last = read;
    } else {
      // A failed read breaks consecutiveness — stability evidence resets.
      previous = null;
      last = null;
    }
    if (i < FINAL_VERIFY_TRIES - 1) await sleep(FINAL_VERIFY_DELAY_MS);
  }
  // Mismatch requires the FINAL two consecutive reads to agree on the same
  // controlled non-null value; anything else is inconclusive.
  if (
    last !== null &&
    previous !== null &&
    last.value !== null &&
    last.controlled &&
    previous.controlled &&
    last.value === previous.value
  ) {
    return 'mismatch';
  }
  return 'unreadable';
}

/**
 * JS-first fill: eval-1 probes + fires onChangeText (no-op when no handler), then
 * settle-poll the value. Any CDP hiccup / stale helper degrades to handled:false.
 */
export async function attemptJsFill(
  deps: EvaluateSeam,
  testID: string,
  text: string,
): Promise<JsFillResult> {
  let probe: Record<string, unknown>;
  // A failure AFTER the mutating evaluate was sent is ambiguous (the handler
  // may have fired) — flagged dispatchUncertain so callers hard-fail instead
  // of typing again. A helper-reported error is a clean pre-mutation no-op.
  try {
    const expr =
      '__RN_AGENT.interact(' +
      JSON.stringify({ action: 'typeText', testID, text, verify: true }) +
      ')';
    const r = await deps.evaluate(expr);
    if (r.error || typeof r.value !== 'string') {
      return { handled: false, dispatchUncertain: true };
    }
    probe = JSON.parse(r.value) as Record<string, unknown>;
  } catch {
    return { handled: false, dispatchUncertain: true };
  }
  // A helper-reported error is a provable pre-mutation no-op; a response shape
  // without `controlled` is an unknown helper contract — the handler may have
  // fired, so it is dispatch-uncertain.
  if (probe.error) return { handled: false };
  if (probe.controlled === undefined) return { handled: false, dispatchUncertain: true };
  if (probe.handlerCalled === false || probe.handlerCalled === undefined) return { handled: false };

  const valueBefore = typeof probe.valueBefore === 'string' ? probe.valueBefore : null;
  const settled = await settleRead(deps, testID, text, valueBefore);
  // A read that lost controlled-ness mid-flight is not authoritative.
  let outcome = settled.controlled
    ? classifyFiberVerification({ text, valueAfter: settled.value })
    : ('unreadable' as FiberVerifyOutcome);
  if (outcome === 'mismatch') {
    // A transient divergence is not proof of a wrong value — require the
    // non-exact value to hold on a confirmation read before reporting it.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(FIBER_CONFIRM_DELAY_MS);
    const confirm = await readInputValueOnce(deps, testID);
    if (confirm && confirm.value === text && confirm.controlled) {
      outcome = 'exact';
    } else if (
      !confirm ||
      !confirm.controlled ||
      confirm.value === null ||
      confirm.value !== settled.value
    ) {
      outcome = 'unreadable';
    }
  }
  return {
    handled: true,
    outcome,
    controlled: settled.controlled,
    handler: typeof probe.handlerCalled === 'string' ? probe.handlerCalled : undefined,
  };
}
