export type FillMutation = 'none' | 'observed' | 'possible';

export interface FillDescriptor {
  testID: string;
  nativeType: string;
}

export interface FillRequest {
  descriptor: FillDescriptor;
  text: string;
}

export type FillOwnerResult =
  | { kind: 'native-eligible' }
  | { kind: 'success'; focusedBefore: boolean }
  | {
      kind: 'failure';
      code: string;
      mutation: FillMutation;
      reason: string;
    };

export type FillCoordinatorResult =
  | { kind: 'success'; owner: 'fiber' | 'native'; focusedBefore: boolean }
  | {
      kind: 'failure';
      code: string;
      mutation: FillMutation;
      reason: string;
      owner: 'fiber' | 'native';
    };

export interface FillCoordinatorDeps {
  controlledFill: (request: FillRequest) => Promise<FillOwnerResult>;
  nativeFill: (
    request: FillRequest,
  ) => Promise<Exclude<FillOwnerResult, { kind: 'native-eligible' }>>;
}

/**
 * The single exact-fill transition table. The controlled helper gets first
 * refusal because only it can prove React ownership. Native is entered only
 * when that helper positively classifies the target as uncontrolled. Each
 * owner is called at most once; an uncertain dispatch is terminal.
 */
export async function runFillCoordinator(
  request: FillRequest,
  deps: FillCoordinatorDeps,
): Promise<FillCoordinatorResult> {
  let controlled: FillOwnerResult;
  try {
    controlled = await deps.controlledFill(request);
  } catch {
    return {
      kind: 'failure',
      code: 'TEXT_ENTRY_UNVERIFIED',
      mutation: 'possible',
      reason: 'dispatch-uncertain',
      owner: 'fiber',
    };
  }

  if (controlled.kind === 'success') {
    return { ...controlled, owner: 'fiber' };
  }
  if (controlled.kind === 'failure') {
    return { ...controlled, owner: 'fiber' };
  }

  try {
    const native = await deps.nativeFill(request);
    return { ...native, owner: 'native' };
  } catch {
    return {
      kind: 'failure',
      code: 'TEXT_ENTRY_UNVERIFIED',
      mutation: 'possible',
      reason: 'dispatch-uncertain',
      owner: 'native',
    };
  }
}
