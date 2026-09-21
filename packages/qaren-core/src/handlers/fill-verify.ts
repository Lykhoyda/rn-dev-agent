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
