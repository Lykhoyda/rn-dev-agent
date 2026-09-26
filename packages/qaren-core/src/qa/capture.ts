import { isRecord } from './questions.js';
import { frontFromSurface, join, validateReactHostEvidence } from './screen.js';
import type { DigestEntry, NativeNode, ReactHostEvidence, Screen } from './screen.js';
import { PRESENCE_BUDGET_MS, validateNativePresence } from './native-presence.js';
import {
  applyPrivateInputs,
  PrivateInputCaptureError,
  validatePrivateInputs,
} from './private-input.js';

export class NativeCaptureError extends Error {
  readonly code = 'NATIVE_CAPTURE_UNAVAILABLE' as const;

  constructor() {
    super('Native capture is unavailable.');
    this.name = 'NativeCaptureError';
  }
}

export interface NativeObservation {
  presenceCapture?: unknown;
  snapshotGeneration?: unknown;
  nodes?: NativeNode[];
  truncated?: unknown;
  normalizationDroppedNodes?: unknown;
  surface?: string;
  snapshotVerdict?: unknown;
}

export interface ReactObservation {
  interactive?: DigestEntry[];
  truncated?: unknown;
  verdict?: unknown;
  hostEvidence?: unknown;
}

export interface CaptureDeps {
  requirePrivateInputs?: boolean;
  appId?: string;
  now?(): number;
  native(): Promise<NativeObservation>;
  react(): Promise<ReactObservation>;
  warn?(message: string): void;
}

type Coverage = NonNullable<Screen['coverage']>;

function nativeCaptureCoverage(observation: NativeObservation): Coverage['native'] {
  const verdict = isRecord(observation.snapshotVerdict) ? observation.snapshotVerdict : undefined;
  if (
    observation.truncated === true ||
    (typeof observation.normalizationDroppedNodes === 'number' &&
      observation.normalizationDroppedNodes > 0) ||
    verdict?.state === 'degraded' ||
    verdict?.state === 'failed' ||
    verdict?.refMapUpdated === false ||
    (Array.isArray(verdict?.reasons) && verdict.reasons.length > 0) ||
    (Array.isArray(observation.nodes) &&
      typeof verdict?.nodeCount === 'number' &&
      (observation.nodes.length === 0 || verdict.nodeCount !== observation.nodes.length))
  )
    return 'incomplete';
  return Array.isArray(observation.nodes) &&
    observation.nodes.length > 0 &&
    observation.truncated === false &&
    observation.normalizationDroppedNodes === 0 &&
    verdict?.state === 'ok' &&
    verdict.nodeCount === observation.nodes.length &&
    verdict.refMapUpdated === true &&
    Array.isArray(verdict.reasons) &&
    verdict.reasons.length === 0
    ? 'complete'
    : 'unknown';
}

function reactCaptureCoverage(observation: ReactObservation): Coverage['react'] {
  const verdict = isRecord(observation.verdict) ? observation.verdict : undefined;
  if (
    observation.truncated === true ||
    verdict?.state === 'failed' ||
    verdict?.state === 'degraded' ||
    verdict?.complete === false ||
    (typeof verdict?.path === 'string' && verdict.path !== 'interactive') ||
    (Array.isArray(verdict?.reasons) && verdict.reasons.length > 0)
  )
    return 'incomplete';
  return Array.isArray(observation.interactive) &&
    (observation.truncated === undefined || observation.truncated === false) &&
    verdict?.state === 'ok' &&
    verdict.path === 'interactive' &&
    verdict.complete === true
    ? 'complete'
    : 'unknown';
}

function reactCoverage(
  observation: ReactObservation,
  acquired: Coverage['react'],
  hostEvidence: ReactHostEvidence | undefined,
): Coverage['react'] {
  if (
    acquired === 'incomplete' ||
    (observation.hostEvidence !== undefined && !hostEvidence) ||
    hostEvidence?.complete === false
  )
    return 'incomplete';
  return acquired === 'complete' && hostEvidence?.complete === true ? 'complete' : 'unknown';
}

export async function captureScreen(deps: CaptureDeps): Promise<Screen> {
  try {
    return await capture(deps);
  } catch (error) {
    if (error instanceof NativeCaptureError) throw error;
    if (deps.requirePrivateInputs || error instanceof PrivateInputCaptureError)
      throw new PrivateInputCaptureError();
    throw error;
  }
}

async function capture(deps: CaptureDeps): Promise<Screen> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let native: NativeObservation;
  try {
    native = await deps.native();
  } catch (error) {
    if (deps.requirePrivateInputs) throw new NativeCaptureError();
    throw error;
  }
  let react: ReactObservation = {};
  try {
    react = await deps.react();
  } catch (error) {
    if (deps.requirePrivateInputs || error instanceof PrivateInputCaptureError)
      throw new PrivateInputCaptureError();
    deps.warn?.('interactive digest unavailable; React coverage is unknown');
  }
  validatePrivateInputs(react, deps.requirePrivateInputs);
  const nodes = Array.isArray(native.nodes) ? native.nodes : [];
  const digest = Array.isArray(react.interactive) ? react.interactive : [];
  const captureCoverage: Coverage = {
    native: nativeCaptureCoverage(native),
    react: reactCaptureCoverage(react),
  };
  const hostEvidence = validateReactHostEvidence(react.hostEvidence);
  const elapsed = now() - started;
  const nativePresence =
    captureCoverage.native === 'complete' && elapsed >= 0 && elapsed < PRESENCE_BUDGET_MS
      ? validateNativePresence(native.presenceCapture, nodes, native.snapshotGeneration, deps.appId)
      : undefined;
  return applyPrivateInputs(react, {
    ...join(
      nodes,
      digest,
      frontFromSurface(native.surface, nodes),
      {
        native: nativePresence
          ? 'complete'
          : captureCoverage.native === 'incomplete' || native.presenceCapture !== undefined
            ? 'incomplete'
            : 'unknown',
        react: reactCoverage(react, captureCoverage.react, hostEvidence),
      },
      hostEvidence,
      nativePresence ?? (native.presenceCapture !== undefined ? 'unknown' : undefined),
    ),
    captureCoverage,
  });
}
