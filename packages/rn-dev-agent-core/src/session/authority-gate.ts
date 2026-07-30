import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolErrorCode } from '../types.js';
import { failResult, type ToolResult } from '../utils.js';
import type { OperationRef, SessionRef, SessionRegistry, SessionStatus } from './registry.js';
import { authorityErrorMeta, SessionAuthorityError, shortAuthorityIdentity } from './registry.js';
import type { WorkerAuthorityStatus } from './runtime.js';
import { authorityProfileFor, type AuthorityAxis, type AuthorityProfile } from './tool-profiles.js';

export interface AuthorityObservation {
  axis: AuthorityAxis;
  identity: string;
  detail?: Record<string, unknown>;
}

interface AuthorityProbeInput {
  axis: AuthorityAxis;
  phase: 'preflight' | 'postflight';
  tool: string;
  profile: AuthorityProfile;
  status: SessionStatus;
  args: Record<string, unknown>;
}

interface AuthorityGateRuntime {
  requireAvailable(): { registry: SessionRegistry; session: SessionRef };
  status(): WorkerAuthorityStatus;
}

interface AuthorityGateDependencies {
  probe(input: AuthorityProbeInput): Promise<AuthorityObservation>;
  refreshRuntimeBinding?(status: SessionStatus): Promise<Record<string, unknown>>;
  relaunchBoundRuntime?(status: SessionStatus): Promise<void>;
  onRunnerReleased?(runner: Record<string, unknown>): Promise<void> | void;
}

const optionalBundleAdmission = Symbol('optionalBundleAdmission');
const managedNativeOrigin = Symbol('managedNativeOrigin');
const managedRunnerPark = Symbol('managedRunnerPark');

type AuthorityAwareArgs = Record<string, unknown> & {
  [optionalBundleAdmission]?: () => Promise<boolean>;
  [managedNativeOrigin]?: {
    claim(): Promise<void>;
    complete(targetExpected: boolean): Promise<void>;
    relaunch(): Promise<void>;
  };
  [managedRunnerPark]?: () => Promise<void>;
};

export async function claimOptionalBundleAuthority(args: object): Promise<boolean> {
  return (await (args as AuthorityAwareArgs)[optionalBundleAdmission]?.()) ?? false;
}

export async function claimManagedNativeOriginAuthority(args: object): Promise<void> {
  const authority = (args as AuthorityAwareArgs)[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError(
      'METRO_ORIGIN_MISMATCH',
      'managed native origin authority is unavailable',
    );
  }
  await authority.claim();
}

export async function completeManagedNativeOriginAuthority(
  args: object,
  targetExpected: boolean,
): Promise<void> {
  const authority = (args as AuthorityAwareArgs)[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError(
      'METRO_ORIGIN_MISMATCH',
      'managed native origin authority is unavailable',
    );
  }
  await authority.complete(targetExpected);
}

export async function relaunchManagedNativeOriginApp(args: object): Promise<void> {
  const authority = (args as AuthorityAwareArgs)[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError(
      'METRO_ORIGIN_MISMATCH',
      'managed native origin relaunch authority is unavailable',
    );
  }
  await authority.relaunch();
}

export async function completeManagedRunnerParkAuthority(args: object): Promise<void> {
  const complete = (args as AuthorityAwareArgs)[managedRunnerPark];
  if (!complete) {
    throw new SessionAuthorityError(
      'RUNNER_OWNERSHIP_MISMATCH',
      'managed runner parking authority is unavailable',
    );
  }
  await complete();
}

const axisBinding: Partial<Record<AuthorityAxis, string>> = {
  I: 'install',
  M: 'metro',
  B: 'bundle',
  D: 'device',
  R: 'runner',
  O: 'observe',
  P: 'proof',
};

const axisErrors: Record<AuthorityAxis, ToolErrorCode> = {
  C: 'SESSION_AUTHORITY_REQUIRED',
  S: 'SOURCE_WORKTREE_MISMATCH',
  I: 'APP_INSTALL_IDENTITY_CHANGED',
  M: 'METRO_AUTHORITY_MISMATCH',
  A: 'METRO_ORIGIN_MISMATCH',
  B: 'BUNDLE_HANDSHAKE_UNAVAILABLE',
  D: 'DEVICE_AUTHORITY_MISMATCH',
  R: 'RUNNER_OWNERSHIP_MISMATCH',
  O: 'OBSERVE_AUTHORITY_MISMATCH',
  P: 'PROOF_AUTHORITY_MISMATCH',
};

function requireCompleteAxes(status: SessionStatus, profile: AuthorityProfile): void {
  for (const axis of profile.axes) {
    if (axis === 'C') {
      if (!status.worker.instanceId || !status.worker.birthAvailable) {
        throw new SessionAuthorityError(axisErrors.C, 'worker controller identity is incomplete');
      }
      continue;
    }
    if (axis === 'S') {
      if (!status.source.kind) {
        throw new SessionAuthorityError(axisErrors.S, 'source identity is incomplete');
      }
      continue;
    }
    if (axis === 'A') {
      if (!status.bindings.metro || !status.bindings.device) {
        throw new SessionAuthorityError(
          axisErrors.A,
          'native app origin requires Metro and device authority',
        );
      }
      continue;
    }
    const binding = axisBinding[axis];
    if (binding && !status.bindings[binding]) {
      throw new SessionAuthorityError(axisErrors[axis], `${axis} authority is not bound`);
    }
  }
}

function isAuthenticatedIdempotentMetroStop(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): boolean {
  if (tool !== 'rn_session' || args.action !== 'stop_metro') return false;
  try {
    const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
      ok?: unknown;
      data?: { stopped?: unknown; alreadyStopped?: unknown };
    };
    return (
      envelope.ok === true &&
      envelope.data?.stopped === false &&
      envelope.data.alreadyStopped === true
    );
  } catch {
    return false;
  }
}

function isAuthenticatedIdempotentRunnerClose(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  initialStatus: SessionStatus,
): boolean {
  if (tool !== 'device_snapshot' || args.action !== 'close' || initialStatus.bindings.runner) {
    return false;
  }
  try {
    const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
      ok?: unknown;
      data?: { closed?: unknown };
    };
    return envelope.ok === true && envelope.data?.closed === true;
  } catch {
    return false;
  }
}

function containedRunnerAuthority(
  result: unknown,
  runner: Record<string, unknown> | null | undefined,
): {
  claim: { type: 'runner'; key: string };
  runnerAbsent: boolean;
} | null {
  if (!runner) return null;
  try {
    const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
      ok?: unknown;
      code?: unknown;
      meta?: {
        runnerTimeoutRecovery?: {
          poisoned?: unknown;
          reapDisposition?: unknown;
          verification?: unknown;
          runner?: {
            before?: {
              pid?: unknown;
              port?: unknown;
              deviceId?: unknown;
            };
          };
        };
      };
    };
    const recovery = envelope.meta?.runnerTimeoutRecovery;
    const before = recovery?.runner?.before;
    const typedOutcome =
      envelope.code === 'RUNNER_TIMEOUT' ||
      (envelope.ok === true && recovery?.verification === 'exact-readback');
    if (
      !typedOutcome ||
      recovery?.poisoned !== true ||
      !['reaped', 'already-absent', 'replacement-preserved'].includes(
        String(recovery.reapDisposition),
      ) ||
      !before ||
      before.pid !== runner.pid ||
      before.port !== runner.port ||
      before.deviceId !== runner.deviceId
    ) {
      return null;
    }
    const platform = runner.platform;
    const deviceId = runner.deviceId;
    const port = runner.port;
    if (
      (platform !== 'ios' && platform !== 'android') ||
      typeof deviceId !== 'string' ||
      typeof port !== 'number' ||
      !Number.isSafeInteger(port)
    ) {
      return null;
    }
    return {
      claim: { type: 'runner', key: `${platform}:${deviceId}:${String(port)}` },
      runnerAbsent:
        recovery.reapDisposition === 'reaped' || recovery.reapDisposition === 'already-absent',
    };
  } catch {
    return null;
  }
}

function requireDeviceTransition(status: SessionStatus, args: Record<string, unknown>): void {
  const action = args.action ?? 'snapshot';
  if (action === 'open') {
    for (const binding of ['install', 'metro', 'device']) {
      if (!status.bindings[binding]) {
        throw new SessionAuthorityError(
          binding === 'install' ? 'APP_INSTALL_IDENTITY_CHANGED' : 'SESSION_AUTHORITY_REQUIRED',
          `${binding} authority must be bound before opening the native runner`,
        );
      }
    }
    const device = status.bindings.device as Record<string, unknown>;
    if (
      args.platform !== device.platform ||
      args.deviceId !== device.deviceId ||
      args.appId !== device.appId
    ) {
      throw new SessionAuthorityError(
        'DEVICE_AUTHORITY_MISMATCH',
        'device_snapshot open arguments must equal the exact session device binding',
      );
    }
  }
}

function bindExactArgument(
  args: Record<string, unknown>,
  field: string,
  expected: unknown,
  code: ToolErrorCode,
): void {
  if (expected === undefined || expected === null || expected === '') return;
  const supplied = args[field];
  if (supplied !== undefined && supplied !== expected) {
    throw new SessionAuthorityError(
      code,
      `${field} contradicts the active session binding`,
      undefined,
      {
        expected: shortAuthorityIdentity(expected),
        observed: shortAuthorityIdentity(supplied),
      },
    );
  }
  args[field] = expected;
}

function bindSourcePaths(status: SessionStatus, args: Record<string, unknown>): void {
  let appRoot: string;
  try {
    if (typeof status.source.appRoot !== 'string') throw new Error('missing app root');
    appRoot = realpathSync(status.source.appRoot);
  } catch {
    throw new SessionAuthorityError(
      'SOURCE_WORKTREE_MISMATCH',
      'active session app root is unavailable',
    );
  }
  for (const field of ['projectRoot', 'flowPath', 'flowDir', 'scanDir'] as const) {
    const supplied = args[field];
    if (supplied === undefined) continue;
    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new SessionAuthorityError(
        'SOURCE_WORKTREE_MISMATCH',
        `${field} must be a non-empty path within the active app root`,
      );
    }
    let candidate: string;
    try {
      candidate = realpathSync(isAbsolute(supplied) ? supplied : resolve(appRoot, supplied));
    } catch {
      throw new SessionAuthorityError(
        'SOURCE_WORKTREE_MISMATCH',
        `${field} cannot be resolved within the active app root`,
      );
    }
    const child = relative(appRoot, candidate);
    if (
      child === '..' ||
      child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(child)
    ) {
      throw new SessionAuthorityError(
        'SOURCE_WORKTREE_MISMATCH',
        `${field} is outside the active session app root`,
      );
    }
    args[field] = candidate;
  }
}

function bindSessionArguments(
  status: SessionStatus,
  profile: AuthorityProfile,
  args: Record<string, unknown>,
): void {
  bindSourcePaths(status, args);
  const device = status.bindings.device as Record<string, unknown> | undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const install = status.bindings.install as Record<string, unknown> | undefined;
  const replacingDeviceAuthority = args.action === 'bind_device';
  if (
    device &&
    !replacingDeviceAuthority &&
    (profile.axes.includes('D') || profile.kind === 'transition')
  ) {
    bindExactArgument(args, 'platform', device.platform, 'DEVICE_AUTHORITY_MISMATCH');
    bindExactArgument(args, 'deviceId', device.deviceId, 'DEVICE_AUTHORITY_MISMATCH');
    bindExactArgument(args, 'appId', device.appId, 'APP_INSTALL_IDENTITY_CHANGED');
    bindExactArgument(args, 'bundleId', device.appId, 'APP_INSTALL_IDENTITY_CHANGED');
  }
  if (install && profile.axes.includes('I')) {
    bindExactArgument(args, 'platform', install.platform, 'APP_INSTALL_IDENTITY_CHANGED');
    bindExactArgument(args, 'deviceId', install.deviceId, 'APP_INSTALL_IDENTITY_CHANGED');
    bindExactArgument(args, 'appId', install.appId, 'APP_INSTALL_IDENTITY_CHANGED');
    bindExactArgument(args, 'bundleId', install.appId, 'APP_INSTALL_IDENTITY_CHANGED');
  }
  if (metro && (profile.axes.includes('M') || profile.kind === 'transition')) {
    bindExactArgument(args, 'metroPort', metro.port, 'METRO_AUTHORITY_MISMATCH');
  }
  if (profile.sessionIdentity) {
    bindExactArgument(args, 'sessionId', status.sessionId, 'AUTHORITY_LOST_DURING_OPERATION');
    bindExactArgument(args, 'claimEpoch', status.claimEpoch, 'AUTHORITY_LOST_DURING_OPERATION');
  }
}

function authorityFailure(error: unknown): ToolResult {
  if (error instanceof SessionAuthorityError) {
    return failResult(error.message, error.code as ToolErrorCode, authorityErrorMeta(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1];
  return failResult(
    message,
    (code as ToolErrorCode | undefined) ?? 'AUTHORITY_LOST_DURING_OPERATION',
  );
}

function authorityErrorCode(error: unknown): string | undefined {
  return error instanceof SessionAuthorityError
    ? error.code
    : /^([A-Z][A-Z0-9_]+):/.exec(error instanceof Error ? error.message : String(error))?.[1];
}

function isOptionalBundleFailure(error: unknown): boolean {
  const code = authorityErrorCode(error);
  return (
    code === 'BUNDLE_HANDSHAKE_UNAVAILABLE' ||
    code === 'BUNDLE_IDENTITY_MISMATCH' ||
    code === 'CDP_TARGET_AUTHORITY_MISMATCH' ||
    code === 'TARGET_CLAIM_CONFLICT'
  );
}

function addMeta(result: unknown, meta: Record<string, unknown>): unknown {
  if (!result || typeof result !== 'object') return result;
  const toolResult = result as ToolResult;
  const first = toolResult.content?.[0];
  if (!first?.text) return result;
  try {
    const envelope = JSON.parse(first.text) as Record<string, unknown>;
    envelope.meta = {
      ...(envelope.meta as Record<string, unknown> | undefined),
      ...meta,
    };
    return {
      ...toolResult,
      content: [{ ...first, text: JSON.stringify(envelope) }, ...toolResult.content.slice(1)],
    };
  } catch {
    return result;
  }
}

function resultSucceeded(result: unknown): boolean {
  const first = (result as ToolResult | undefined)?.content?.[0];
  if (!first?.text) return false;
  try {
    return (JSON.parse(first.text) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function resultIsCanonicalSuccess(result: unknown): boolean {
  const first = (result as ToolResult | undefined)?.content?.[0];
  if (!first?.text) return false;
  try {
    const envelope = JSON.parse(first.text) as {
      ok?: unknown;
      truncated?: unknown;
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    return (
      envelope.ok === true &&
      envelope.truncated !== true &&
      !envelope.meta?.warning &&
      envelope.data?.partial !== true &&
      envelope.data?.truncated !== true &&
      envelope.data?.inconclusive !== true
    );
  } catch {
    return false;
  }
}

function proofDiscardConfirmed(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const content = (result as ToolResult).content;
  if (!Array.isArray(content) || typeof content[0]?.text !== 'string') return false;
  try {
    const envelope = JSON.parse(content[0].text) as {
      ok?: boolean;
      data?: { discarded?: boolean };
    };
    return envelope.ok === true && envelope.data?.discarded === true;
  } catch {
    return false;
  }
}

function receipt(
  status: SessionStatus,
  profile: AuthorityProfile,
  observations: readonly AuthorityObservation[],
): Record<string, unknown> {
  return {
    version: 1,
    sessionId: status.sessionId.slice(0, 12),
    claimEpoch: status.claimEpoch,
    authorityVersion: status.authorityVersion,
    axes: observations.map(({ axis, identity, detail }) => ({
      axis,
      identity: identity.slice(0, 16),
      ...(detail ? { detail } : {}),
    })),
    bundle: profile.axes.includes('B')
      ? { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' }
      : undefined,
    nativeAppOrigin: profile.axes.includes('A')
      ? {
          authorityScope: observations.some(({ axis }) => axis === 'A')
            ? 'live-metro-target-device'
            : 'preflight-live-metro-target-device',
        }
      : undefined,
  };
}

function reconcileRuntimeBundleReplacement(
  runtime: AuthorityGateRuntime,
  registry: SessionRegistry,
  operation: OperationRef,
  status: SessionStatus,
  priorBundle: Record<string, unknown> | undefined,
  metro: Record<string, unknown> | undefined,
  bundle: Record<string, unknown>,
): {
  operation: OperationRef;
  status: SessionStatus;
  runtimeTargetChanged: boolean;
} {
  const oldTargetId = priorBundle?.targetId;
  const newTargetId = bundle.targetId;
  const metroPort = metro?.port;
  if (typeof newTargetId !== 'string' || !Number.isSafeInteger(metroPort)) {
    throw new SessionAuthorityError(
      'CDP_TARGET_AUTHORITY_MISMATCH',
      'runtime reset did not produce an exact target replacement',
    );
  }
  const runtimeTargetChanged =
    oldTargetId !== newTargetId ||
    priorBundle?.connectionGeneration !== bundle.connectionGeneration;
  if (!runtimeTargetChanged) {
    return { operation, status, runtimeTargetChanged };
  }
  const nextOperation = registry.replaceBindingsDuringOperation(operation, {
    state: 'ready',
    bindings: { bundle },
    releaseResources:
      typeof oldTargetId === 'string' && oldTargetId !== newTargetId
        ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
        : [],
    claimResources:
      oldTargetId !== newTargetId
        ? [{ type: 'target', key: `${String(metroPort)}:${newTargetId}` }]
        : [],
  });
  const refreshedStatus = runtime.status();
  if (!refreshedStatus.available) {
    throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
  }
  return {
    operation: nextOperation,
    status: refreshedStatus,
    runtimeTargetChanged,
  };
}

function invalidateRuntimeBundle(
  registry: SessionRegistry,
  operation: OperationRef,
  status: SessionStatus,
): OperationRef {
  const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const oldTargetId = priorBundle?.targetId;
  const metroPort = metro?.port;
  return registry.replaceBindingsDuringOperation(operation, {
    state: 'device_bound',
    bindings: { bundle: null },
    releaseResources:
      typeof oldTargetId === 'string' && Number.isSafeInteger(metroPort)
        ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
        : [],
  });
}

export function createAuthorityGate(
  runtime: AuthorityGateRuntime,
  dependencies: AuthorityGateDependencies,
): {
  wrap(
    tool: string,
    handler: (...args: unknown[]) => Promise<unknown>,
  ): (...args: unknown[]) => Promise<unknown>;
} {
  return {
    wrap:
      (tool, handler) =>
      async (...handlerArgs) => {
        const args =
          handlerArgs[0] && typeof handlerArgs[0] === 'object'
            ? (handlerArgs[0] as Record<string, unknown>)
            : {};
        const baseProfile = authorityProfileFor(tool, args);
        let profile =
          tool === 'rn_session' &&
          (args.action === 'status' ||
            args.action === 'preview_integration' ||
            args.action === 'accept_handoff' ||
            args.action === 'adopt_stale')
            ? {
                kind: 'diagnostic' as const,
                axes: [] as const,
                mutation: false,
                liveBundleProbe: false,
              }
            : tool === 'observe' && args.action === 'status'
              ? {
                  kind: 'diagnostic' as const,
                  axes: [] as const,
                  mutation: false,
                  liveBundleProbe: false,
                }
              : tool === 'proof_capture' && (args.action === 'status' || args.action === 'contract')
                ? {
                    kind: 'diagnostic' as const,
                    axes: [] as const,
                    mutation: false,
                    liveBundleProbe: false,
                  }
                : (tool === 'device_snapshot' &&
                      (args.action === 'open' || args.action === 'close')) ||
                    (tool === 'observe' &&
                      (args.action === 'start' ||
                        args.action === 'restart' ||
                        args.action === 'stop')) ||
                    (tool === 'proof_capture' && args.action === 'begin_rehearsal')
                  ? {
                      kind: 'transition' as const,
                      axes:
                        tool === 'proof_capture'
                          ? (['C', 'S', 'I', 'M', 'B', 'D', 'R'] as const)
                          : (['C', 'S'] as const),
                      mutation: true,
                      liveBundleProbe: tool === 'proof_capture',
                    }
                  : baseProfile;

        if (profile.kind === 'diagnostic') {
          return addMeta(await handler(...handlerArgs), { authoritative: false });
        }
        const runtimeStatus = runtime.status();
        if (runtimeStatus.available && runtimeStatus.state === 'blocked') {
          return authorityFailure(
            new SessionAuthorityError(
              'SESSION_AUTHORITY_REQUIRED',
              'blocked contender exposes only accept_handoff and adopt_stale recovery',
            ),
          );
        }
        if (
          runtimeStatus.available &&
          tool === 'observe' &&
          args.action === 'start' &&
          runtimeStatus.bindings.observe
        ) {
          profile = {
            kind: 'authoritative',
            axes: ['C', 'S', 'O'],
            mutation: false,
            liveBundleProbe: false,
          };
        }
        if (
          runtimeStatus.available &&
          tool === 'cdp_disconnect' &&
          !runtimeStatus.bindings.bundle
        ) {
          profile = {
            kind: 'authoritative',
            axes: ['C', 'S'],
            mutation: false,
            liveBundleProbe: false,
          };
        }
        if (runtimeStatus.available && tool === 'cdp_restart' && args.hardReset === true) {
          try {
            bindSessionArguments(runtimeStatus, profile, args);
            profile = authorityProfileFor(tool, args);
          } catch (error) {
            return authorityFailure(error);
          }
        }
        if (profile.kind === 'transition') {
          let operation: OperationRef | null = null;
          let registry: SessionRegistry | null = null;
          let retainProofCleanupFence = false;
          let beganProofRehearsal = false;
          let publishedProofBinding = false;
          try {
            const available = runtime.requireAvailable();
            registry = available.registry;
            const initialStatus = runtime.status();
            if (!initialStatus.available) {
              throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
            }
            let status: SessionStatus = initialStatus;
            let runtimeTargetChanged = false;
            const initialAuthorityVersion = status.authorityVersion;
            const gateCommitsProof = tool === 'proof_capture' && args.action === 'begin_rehearsal';
            bindSessionArguments(status, profile, args);
            if (tool === 'device_snapshot') requireDeviceTransition(status, args);
            if (gateCommitsProof && status.bindings.proof) {
              throw new SessionAuthorityError(
                'PROOF_AUTHORITY_MISMATCH',
                'an active proof run must be finalized or discarded before beginning another',
              );
            }
            const transitionAxes =
              tool === 'device_snapshot'
                ? args.action === 'open'
                  ? {
                      before: ['C', 'S', 'I', 'M', 'D'] as AuthorityAxis[],
                      after: ['C', 'S', 'I', 'M', 'D', 'R'] as AuthorityAxis[],
                    }
                  : {
                      before: [
                        'C',
                        'S',
                        'D',
                        ...(status.bindings.runner ? (['R'] as const) : []),
                      ] as AuthorityAxis[],
                      after: ['C', 'S', 'D'] as AuthorityAxis[],
                    }
                : tool === 'observe'
                  ? args.action === 'stop'
                    ? {
                        before: ['C', 'S', 'O'] as AuthorityAxis[],
                        after: ['C', 'S'] as AuthorityAxis[],
                      }
                    : {
                        before: ['C', 'S', 'I', 'M', 'B', 'D', 'R'] as AuthorityAxis[],
                        after: ['C', 'S', 'I', 'M', 'B', 'D', 'R', 'O'] as AuthorityAxis[],
                      }
                  : tool === 'rn_session' && args.action === 'prepare_handoff'
                    ? { before: [...profile.axes], after: [] as AuthorityAxis[] }
                    : tool === 'cdp_restart' && args.hardReset === true && args.platform === 'ios'
                      ? {
                          before: [...profile.axes],
                          after: profile.axes.filter((axis) => axis !== 'R'),
                        }
                      : { before: [...profile.axes], after: [...profile.axes] };
            requireCompleteAxes(status, { ...profile, axes: transitionAxes.before });
            const operationInput = {
              operationId: randomUUID(),
              tool,
              profile: `transition:${transitionAxes.before.join('')}>${transitionAxes.after.join('')}`,
            };
            operation =
              tool === 'rn_session' && args.action === 'cancel_handoff'
                ? registry.beginHandoffCancellationOperation(available.session, operationInput)
                : registry.beginOperation(available.session, operationInput);
            const before = await Promise.all(
              transitionAxes.before.map((axis) =>
                dependencies.probe({ axis, phase: 'preflight', tool, profile, status, args }),
              ),
            );
            registry.verifyOperation(operation);
            const result = await registry.runWithOperation(operation, () =>
              handler(...handlerArgs),
            );
            if (!resultSucceeded(result)) {
              if (tool === 'cdp_restart' && args.hardReset === true) {
                registry.verifyOperation(operation);
                operation = invalidateRuntimeBundle(registry, operation, status);
                return addMeta(result, {
                  authoritative: false,
                  authorityInvalidated: true,
                  nextAction:
                    'Run rn_session action "pin_dev_client" before another CDP operation.',
                });
              }
              return addMeta(result, { authoritative: false });
            }
            beganProofRehearsal = gateCommitsProof;
            if (tool === 'rn_session' && args.action === 'release') {
              operation = null;
              return addMeta(result, {
                authoritative: false,
                authorityTransition: true,
              });
            }
            const idempotentMetroStop = isAuthenticatedIdempotentMetroStop(tool, args, result);
            const idempotentRunnerClose = isAuthenticatedIdempotentRunnerClose(
              tool,
              args,
              result,
              initialStatus,
            );
            if (!gateCommitsProof && !idempotentMetroStop && !idempotentRunnerClose) {
              registry.verifyOperation(operation);
              const nextStatus = runtime.status();
              if (!nextStatus.available || nextStatus.authorityVersion <= initialAuthorityVersion) {
                throw new SessionAuthorityError(
                  'AUTHORITY_LOST_DURING_OPERATION',
                  'transition did not advance the fenced authority generation',
                );
              }
              status = nextStatus;
            }
            if (tool === 'cdp_restart' && args.hardReset === true) {
              const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
              const metro = status.bindings.metro as Record<string, unknown> | undefined;
              if (!dependencies.refreshRuntimeBinding) {
                throw new SessionAuthorityError(
                  'BUNDLE_HANDSHAKE_UNAVAILABLE',
                  'runtime reset cannot commit without a binding refresh',
                );
              }
              let bundle: Record<string, unknown>;
              try {
                bundle = await dependencies.refreshRuntimeBinding(status);
              } catch (error) {
                operation = invalidateRuntimeBundle(registry, operation, status);
                throw error;
              }
              const reconciliation = reconcileRuntimeBundleReplacement(
                runtime,
                registry,
                operation,
                status,
                priorBundle,
                metro,
                bundle,
              );
              operation = reconciliation.operation;
              status = reconciliation.status;
              runtimeTargetChanged = reconciliation.runtimeTargetChanged;
            }
            requireCompleteAxes(status, { ...profile, axes: transitionAxes.after });
            const after = await Promise.all(
              transitionAxes.after.map((axis) =>
                dependencies.probe({ axis, phase: 'postflight', tool, profile, status, args }),
              ),
            );
            for (const observation of before) {
              if (runtimeTargetChanged && observation.axis === 'B') continue;
              if (observation.axis === 'C' || !transitionAxes.after.includes(observation.axis)) {
                continue;
              }
              const postflight = after.find((candidate) => candidate.axis === observation.axis);
              if (observation.identity !== postflight?.identity) {
                throw new SessionAuthorityError(
                  'AUTHORITY_LOST_DURING_OPERATION',
                  `${observation.axis} authority changed during the transition`,
                );
              }
            }
            if (gateCommitsProof) {
              const runId = typeof args.runId === 'string' ? args.runId : '';
              if (!runId) {
                throw new SessionAuthorityError(
                  'PROOF_AUTHORITY_MISMATCH',
                  'proof transition did not provide a run ID',
                );
              }
              const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
                ok?: boolean;
              };
              if (envelope.ok !== true) return result;
              operation = registry.replaceBindingsDuringOperation(operation, {
                bindings: { proof: { runId } },
              });
              publishedProofBinding = true;
              const proofStatus = runtime.status();
              if (!proofStatus.available) {
                throw new SessionAuthorityError(proofStatus.code, proofStatus.reason);
              }
              status = proofStatus;
            }
            if (operation) registry.commitPlatformAuthorityReceipts(operation);
            return addMeta(result, {
              authorityTransition: true,
              authorityReceipt: receipt(status, { ...profile, axes: transitionAxes.after }, after),
            });
          } catch (error) {
            if (beganProofRehearsal) {
              try {
                const rollback = await handler({ action: 'discard' });
                if (!proofDiscardConfirmed(rollback)) {
                  throw new Error('PROOF_AUTHORITY_MISMATCH: rehearsal rollback was rejected');
                }
                if (publishedProofBinding) {
                  if (!registry || !operation) {
                    throw new Error('PROOF_AUTHORITY_MISMATCH: proof registry was lost');
                  }
                  registry.verifyOperation(operation);
                  registry.endOperationWithBindings(operation, { proof: null });
                  operation = null;
                }
              } catch (rollbackError) {
                retainProofCleanupFence = operation !== null;
                return authorityFailure(
                  new AggregateError(
                    [error, rollbackError],
                    'PROOF_AUTHORITY_MISMATCH: rehearsal rollback failed',
                  ),
                );
              }
            }
            return authorityFailure(error);
          } finally {
            if (registry && operation && !retainProofCleanupFence) {
              try {
                registry.endOperation(operation);
              } catch {
                registry.cancelOperation(operation);
              }
            }
          }
        }

        let operation: OperationRef | null = null;
        let registry: SessionRegistry | null = null;
        let retainProofCleanupFence = false;
        let publishedProofFinalize = false;
        try {
          const available = runtime.requireAvailable();
          registry = available.registry;
          const initialStatus = runtime.status();
          if (!initialStatus.available) {
            throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
          }
          let status: SessionStatus = initialStatus;
          requireCompleteAxes(status, profile);
          bindSessionArguments(status, profile, args);
          operation = registry.beginOperation(available.session, {
            operationId: randomUUID(),
            tool,
            profile: profile.axes.join(''),
          });
          const before = await Promise.all(
            profile.axes.map((axis) =>
              dependencies.probe({ axis, phase: 'preflight', tool, profile, status, args }),
            ),
          );
          const optionalBefore: AuthorityObservation[] = [];
          const managedOriginObservations: AuthorityObservation[] = [];
          const managedBundleObservations: AuthorityObservation[] = [];
          let managedOriginCompleted = false;
          let managedOriginCompletedWithTarget = false;
          let managedRuntimeTargetChanged = false;
          let optionalBundleClaimed = false;
          let optionalBundleRecoveryFailed = false;
          let managedRunnerParked = false;
          if (profile.optionalAxes?.includes('B')) {
            Object.defineProperty(args, optionalBundleAdmission, {
              configurable: true,
              value: async () => {
                if (optionalBundleClaimed) return true;
                let currentStatus = runtime.status();
                if (!currentStatus.available) {
                  throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                }
                if (!currentStatus.bindings.bundle) return false;
                let observation: AuthorityObservation;
                try {
                  observation = await dependencies.probe({
                    axis: 'B',
                    phase: 'preflight',
                    tool,
                    profile,
                    status: currentStatus,
                    args,
                  });
                } catch (error) {
                  if (
                    authorityErrorCode(error) !== 'CDP_TARGET_AUTHORITY_MISMATCH' ||
                    !dependencies.refreshRuntimeBinding
                  ) {
                    if (!isOptionalBundleFailure(error)) throw error;
                    return false;
                  }
                  registry!.verifyOperation(operation!);
                  let bundle: Record<string, unknown>;
                  try {
                    bundle = await dependencies.refreshRuntimeBinding(currentStatus);
                  } catch (refreshError) {
                    if (refreshError instanceof SessionAuthorityError) {
                      if (!isOptionalBundleFailure(refreshError)) throw refreshError;
                    }
                    optionalBundleRecoveryFailed = true;
                    return false;
                  }
                  const priorBundle = currentStatus.bindings.bundle as
                    | Record<string, unknown>
                    | undefined;
                  const metro = currentStatus.bindings.metro as Record<string, unknown> | undefined;
                  const oldTargetId = priorBundle?.targetId;
                  const newTargetId = bundle.targetId;
                  const metroPort = metro?.port;
                  if (
                    typeof oldTargetId !== 'string' ||
                    typeof newTargetId !== 'string' ||
                    !Number.isSafeInteger(metroPort)
                  ) {
                    optionalBundleRecoveryFailed = true;
                    return false;
                  }
                  const candidateStatus: SessionStatus = {
                    ...currentStatus,
                    bindings: {
                      ...currentStatus.bindings,
                      bundle,
                    },
                  };
                  try {
                    observation = await dependencies.probe({
                      axis: 'B',
                      phase: 'preflight',
                      tool,
                      profile,
                      status: candidateStatus,
                      args,
                    });
                  } catch (refreshedProbeError) {
                    if (!isOptionalBundleFailure(refreshedProbeError)) {
                      throw refreshedProbeError;
                    }
                    optionalBundleRecoveryFailed = true;
                    return false;
                  }
                  registry!.verifyOperation(operation!);
                  try {
                    operation = registry!.replaceBindingsDuringOperation(operation!, {
                      state: 'ready',
                      bindings: { bundle },
                      releaseResources:
                        oldTargetId !== newTargetId
                          ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
                          : [],
                      claimResources:
                        oldTargetId !== newTargetId
                          ? [{ type: 'target', key: `${String(metroPort)}:${newTargetId}` }]
                          : [],
                    });
                  } catch (replacementError) {
                    if (!isOptionalBundleFailure(replacementError)) throw replacementError;
                    optionalBundleRecoveryFailed = true;
                    return false;
                  }
                  const refreshedStatus = runtime.status();
                  if (!refreshedStatus.available) {
                    throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
                  }
                  currentStatus = refreshedStatus;
                }
                registry!.verifyOperation(operation!);
                status = currentStatus;
                optionalBefore.push(observation);
                optionalBundleRecoveryFailed = false;
                optionalBundleClaimed = true;
                return true;
              },
            });
          }
          if (profile.managedOrigin) {
            const claimOrigin = async (): Promise<void> => {
              const currentStatus = runtime.status();
              if (!currentStatus.available) {
                throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
              }
              registry!.verifyOperation(operation!);
              let originObservation: AuthorityObservation;
              let bundleObservation: AuthorityObservation;
              try {
                originObservation = await dependencies.probe({
                  axis: 'A',
                  phase: 'postflight',
                  tool,
                  profile,
                  status: currentStatus,
                  args,
                });
                if (!dependencies.refreshRuntimeBinding) {
                  throw new SessionAuthorityError(
                    'BUNDLE_HANDSHAKE_UNAVAILABLE',
                    'managed lifecycle cannot commit without a binding refresh',
                  );
                }
                const bundle = await dependencies.refreshRuntimeBinding(currentStatus);
                bundleObservation = await dependencies.probe({
                  axis: 'B',
                  phase: 'postflight',
                  tool,
                  profile,
                  status: {
                    ...currentStatus,
                    bindings: { ...currentStatus.bindings, bundle },
                  },
                  args,
                });
                registry!.verifyOperation(operation!);
                const reconciliation = reconcileRuntimeBundleReplacement(
                  runtime,
                  registry!,
                  operation!,
                  currentStatus,
                  currentStatus.bindings.bundle as Record<string, unknown> | undefined,
                  currentStatus.bindings.metro as Record<string, unknown> | undefined,
                  bundle,
                );
                operation = reconciliation.operation;
                status = reconciliation.status;
                managedRuntimeTargetChanged ||= reconciliation.runtimeTargetChanged;
              } catch (error) {
                const failedStatus = runtime.status();
                if (failedStatus.available && failedStatus.bindings.bundle) {
                  try {
                    registry!.verifyOperation(operation!);
                    operation = invalidateRuntimeBundle(registry!, operation!, failedStatus);
                    const invalidatedStatus = runtime.status();
                    if (invalidatedStatus.available) status = invalidatedStatus;
                  } catch {}
                }
                throw error;
              }
              managedOriginObservations.push(originObservation);
              managedBundleObservations.push(bundleObservation);
            };
            Object.defineProperty(args, managedNativeOrigin, {
              configurable: true,
              value: {
                claim: claimOrigin,
                relaunch: async () => {
                  const currentStatus = runtime.status();
                  if (!currentStatus.available) {
                    throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                  }
                  registry!.verifyOperation(operation!);
                  if (!dependencies.relaunchBoundRuntime) {
                    throw new SessionAuthorityError(
                      'METRO_ORIGIN_MISMATCH',
                      'managed native origin relaunch is unavailable',
                    );
                  }
                  await dependencies.relaunchBoundRuntime(currentStatus);
                  registry!.verifyOperation(operation!);
                },
                complete: async (targetExpected: boolean) => {
                  managedOriginCompleted = true;
                  managedOriginCompletedWithTarget = targetExpected;
                  if (targetExpected) {
                    await claimOrigin();
                    return;
                  }
                  const currentStatus = runtime.status();
                  if (!currentStatus.available) {
                    throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                  }
                  registry!.verifyOperation(operation!);
                  if (currentStatus.bindings.bundle) {
                    operation = invalidateRuntimeBundle(registry!, operation!, currentStatus);
                    const invalidatedStatus = runtime.status();
                    if (!invalidatedStatus.available) {
                      throw new SessionAuthorityError(
                        invalidatedStatus.code,
                        invalidatedStatus.reason,
                      );
                    }
                    status = invalidatedStatus;
                  }
                },
              },
            });
          }
          if (profile.managedRunnerPark) {
            Object.defineProperty(args, managedRunnerPark, {
              configurable: true,
              value: async () => {
                if (managedRunnerParked) return;
                const currentStatus = runtime.status();
                if (!currentStatus.available) {
                  throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                }
                const runner = currentStatus.bindings.runner as
                  | { platform?: unknown; deviceId?: unknown; port?: unknown }
                  | undefined;
                if (!runner) {
                  throw new SessionAuthorityError(
                    'RUNNER_OWNERSHIP_MISMATCH',
                    'managed runner parking lost the bound runner before commit',
                  );
                }
                registry!.verifyOperation(operation!);
                operation = registry!.replaceBindingsDuringOperation(operation!, {
                  state: currentStatus.bindings.bundle ? 'ready' : 'device_bound',
                  bindings: { runner: null },
                  releaseResources: [
                    {
                      type: 'runner',
                      key: `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`,
                    },
                  ],
                });
                await dependencies.onRunnerReleased?.(runner);
                const parkedStatus = runtime.status();
                if (!parkedStatus.available) {
                  throw new SessionAuthorityError(parkedStatus.code, parkedStatus.reason);
                }
                status = parkedStatus;
                managedRunnerParked = true;
              },
            });
          }
          registry.verifyOperation(operation);
          const result = await registry.runWithOperation(operation, () => handler(...handlerArgs));
          const containedRunner = containedRunnerAuthority(
            result,
            status.bindings.runner as Record<string, unknown> | null | undefined,
          );
          if (containedRunner?.runnerAbsent) {
            registry.verifyOperation(operation);
            operation = registry.replaceBindingsDuringOperation(operation, {
              state: status.bindings.bundle ? 'ready' : 'device_bound',
              bindings: { runner: null },
              releaseResources: [containedRunner.claim],
            });
            await dependencies.onRunnerReleased?.(
              status.bindings.runner as Record<string, unknown>,
            );
            const containedStatus = runtime.status();
            if (!containedStatus.available) {
              throw new SessionAuthorityError(containedStatus.code, containedStatus.reason);
            }
            status = containedStatus;
          }
          publishedProofFinalize =
            tool === 'proof_capture' &&
            args.action === 'finalize' &&
            resultIsCanonicalSuccess(result);
          const directRuntimeReset = tool === 'cdp_reload' || tool === 'cdp_restart';
          const nestedRuntimeReset =
            tool === 'cdp_run_e2e_suite' ||
            tool === 'cdp_auto_login' ||
            (tool === 'cdp_nav_graph' && args.action === 'go') ||
            (tool === 'cdp_run_action' && Boolean(status.bindings.bundle));
          const reconcilesRuntimeTarget = directRuntimeReset || nestedRuntimeReset;
          let authorityInvalidated = false;
          if (directRuntimeReset && !resultSucceeded(result)) {
            operation = invalidateRuntimeBundle(registry, operation, status);
            return addMeta(result, {
              authorityInvalidated: true,
              nextAction: 'Run rn_session action "pin_dev_client" before another CDP operation.',
            });
          }
          let runtimeTargetChanged = false;
          if (reconcilesRuntimeTarget && (resultSucceeded(result) || nestedRuntimeReset)) {
            const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
            const metro = status.bindings.metro as Record<string, unknown> | undefined;
            let bundle: Record<string, unknown> | null = null;
            try {
              if (tool === 'cdp_run_action' && optionalBundleRecoveryFailed) {
                throw new SessionAuthorityError(
                  'BUNDLE_HANDSHAKE_UNAVAILABLE',
                  'reactive bundle authority did not verify',
                );
              }
              if (!dependencies.refreshRuntimeBinding) {
                throw new SessionAuthorityError(
                  'BUNDLE_HANDSHAKE_UNAVAILABLE',
                  'runtime reset cannot commit without a binding refresh',
                );
              }
              bundle = await dependencies.refreshRuntimeBinding(status);
            } catch (error) {
              operation = invalidateRuntimeBundle(registry, operation, status);
              const refreshedStatus = runtime.status();
              if (!refreshedStatus.available) {
                throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
              }
              status = refreshedStatus;
              if (!resultSucceeded(result)) {
                return addMeta(result, {
                  authorityInvalidated: true,
                  nextAction:
                    'Run rn_session action "pin_dev_client" before another CDP operation.',
                });
              }
              if (tool === 'cdp_run_action' && !optionalBundleClaimed) {
                authorityInvalidated = true;
              } else {
                throw error;
              }
            }
            if (!authorityInvalidated && bundle) {
              const reconciliation = reconcileRuntimeBundleReplacement(
                runtime,
                registry,
                operation,
                status,
                priorBundle,
                metro,
                bundle,
              );
              operation = reconciliation.operation;
              status = reconciliation.status;
              runtimeTargetChanged = reconciliation.runtimeTargetChanged;
            }
          }
          const effectiveProfile =
            optionalBefore.length > 0
              ? { ...profile, axes: [...profile.axes, ...optionalBefore.map(({ axis }) => axis)] }
              : profile;
          const allBefore = [...before, ...optionalBefore];
          const managedTargetAbsent = managedOriginCompleted && !managedOriginCompletedWithTarget;
          const optionalPostflightAxes = managedTargetAbsent
            ? []
            : optionalBefore.map(({ axis }) => axis);
          const runnerAuthorityReleased = managedRunnerParked || containedRunner !== null;
          const postflightAxes = [
            ...(profile.postflightAxes ?? profile.axes),
            ...optionalPostflightAxes,
          ].filter((axis) => !(runnerAuthorityReleased && axis === 'R'));
          const after = await Promise.all(
            postflightAxes.map((axis) =>
              dependencies.probe({
                axis,
                phase: 'postflight',
                tool,
                profile: effectiveProfile,
                status,
                args,
              }),
            ),
          );
          const finalOrigin = managedOriginCompletedWithTarget
            ? managedOriginObservations.at(-1)
            : undefined;
          const finalManagedBundle = managedOriginCompletedWithTarget
            ? managedBundleObservations.at(-1)
            : undefined;
          const receiptObservations = finalOrigin
            ? [...after, finalOrigin, ...(finalManagedBundle ? [finalManagedBundle] : [])]
            : after;
          const receiptBaseProfile = managedTargetAbsent
            ? {
                ...effectiveProfile,
                axes: effectiveProfile.axes.filter((axis) => axis !== 'B'),
              }
            : effectiveProfile;
          const runnerAwareReceiptProfile = runnerAuthorityReleased
            ? {
                ...receiptBaseProfile,
                axes: receiptBaseProfile.axes.filter((axis) => axis !== 'R'),
              }
            : receiptBaseProfile;
          const receiptProfile = finalOrigin
            ? {
                ...runnerAwareReceiptProfile,
                axes: [
                  ...runnerAwareReceiptProfile.axes,
                  'A' as const,
                  ...(finalManagedBundle ? (['B'] as const) : []),
                ],
              }
            : runnerAwareReceiptProfile;
          for (const observation of allBefore) {
            if ((runtimeTargetChanged || managedRuntimeTargetChanged) && observation.axis === 'B') {
              continue;
            }
            if (!postflightAxes.includes(observation.axis)) continue;
            const postflight = after.find((candidate) => candidate.axis === observation.axis);
            if (observation.identity !== postflight?.identity) {
              throw new SessionAuthorityError(
                'AUTHORITY_LOST_DURING_OPERATION',
                `${observation.axis} authority changed during the operation`,
              );
            }
          }
          registry.verifyOperation(operation);
          if (
            tool === 'proof_capture' &&
            (args.action === 'finalize' || args.action === 'discard')
          ) {
            const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
              ok?: boolean;
            };
            if (envelope.ok === true) {
              if (args.action === 'discard' && !proofDiscardConfirmed(result)) {
                throw new SessionAuthorityError(
                  'PROOF_AUTHORITY_MISMATCH',
                  'durable proof cleanup was not confirmed by the recorder lifecycle',
                );
              }
              registry.endOperationWithBindings(operation, { proof: null });
              operation = null;
            }
          }
          if (!resultIsCanonicalSuccess(result)) {
            return addMeta(result, {
              authoritative: false,
              ...(authorityInvalidated
                ? {
                    authorityInvalidated: true,
                    nextAction:
                      'Run rn_session action "pin_dev_client" before another CDP operation.',
                  }
                : {}),
            });
          }
          if (operation) registry.commitPlatformAuthorityReceipts(operation);
          return addMeta(result, {
            authorityReceipt: receipt(status, receiptProfile, receiptObservations),
            ...(authorityInvalidated
              ? {
                  authorityInvalidated: true,
                  nextAction:
                    'Run rn_session action "pin_dev_client" before another CDP operation.',
                }
              : {}),
          });
        } catch (error) {
          if (publishedProofFinalize) {
            try {
              const rollback = await handler({ action: 'discard' });
              if (!proofDiscardConfirmed(rollback)) {
                throw new Error('PROOF_AUTHORITY_MISMATCH: finalized proof rollback was rejected');
              }
              if (!registry || !operation) {
                throw new Error('PROOF_AUTHORITY_MISMATCH: proof registry was lost');
              }
              registry.verifyOperation(operation);
              registry.endOperationWithBindings(operation, { proof: null });
              operation = null;
            } catch (rollbackError) {
              retainProofCleanupFence = operation !== null;
              return authorityFailure(
                new AggregateError(
                  [error, rollbackError],
                  'PROOF_AUTHORITY_MISMATCH: finalized proof cleanup is unconfirmed',
                ),
              );
            }
          }
          return authorityFailure(error);
        } finally {
          if (registry && operation && !retainProofCleanupFence) {
            try {
              registry.endOperation(operation);
            } catch {
              registry.cancelOperation(operation);
            }
          }
        }
      },
  };
}
