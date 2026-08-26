export type NativeVerifyVerdict =
  | 'exact'
  | 'mismatch'
  | 'unreadable'
  | 'secure-masked'
  | 'target-lost'
  | 'ambiguous'
  | 'unavailable';

export interface NativeVerification {
  verified: boolean;
  native: NativeVerifyVerdict;
  nativeStable: boolean;
  observedMismatch: boolean;
}

export function classifyNativeVerification(
  native: NativeVerifyVerdict,
  nativeStable: boolean,
): NativeVerification {
  return {
    verified: native === 'exact' && nativeStable,
    native,
    nativeStable,
    observedMismatch: native === 'mismatch' && nativeStable,
  };
}

export type NativeRetypeDecision = { action: 'retype'; delayMs: number } | { action: 'escalate' };

const RETYPE_DELAY_MS = 40;

export function decideNativeRetype(
  verification: NativeVerification,
  attemptsSoFar: number,
  maxAttempts: number,
): NativeRetypeDecision {
  if (!verification.observedMismatch || attemptsSoFar >= maxAttempts) {
    return { action: 'escalate' };
  }
  return { action: 'retype', delayMs: RETYPE_DELAY_MS };
}
