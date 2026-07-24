import { randomUUID } from 'node:crypto';
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
}

const optionalBundleAdmission = Symbol('optionalBundleAdmission');

type AuthorityAwareArgs = Record<string, unknown> & {
  [optionalBundleAdmission]?: () => Promise<boolean>;
};

export async function claimOptionalBundleAuthority(args: object): Promise<boolean> {
  return (await (args as AuthorityAwareArgs)[optionalBundleAdmission]?.()) ?? false;
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
    const binding = axisBinding[axis];
    if (binding && !status.bindings[binding]) {
      throw new SessionAuthorityError(axisErrors[axis], `${axis} authority is not bound`);
    }
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

function bindSessionArguments(
  status: SessionStatus,
  profile: AuthorityProfile,
  args: Record<string, unknown>,
): void {
  const device = status.bindings.device as Record<string, unknown> | undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const install = status.bindings.install as Record<string, unknown> | undefined;
  if (device && (profile.axes.includes('D') || profile.kind === 'transition')) {
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
  };
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
        const profile =
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
        if (profile.kind === 'transition') {
          let operation: OperationRef | null = null;
          let registry: SessionRegistry | null = null;
          try {
            const available = runtime.requireAvailable();
            registry = available.registry;
            const initialStatus = runtime.status();
            if (!initialStatus.available) {
              throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
            }
            let status: SessionStatus = initialStatus;
            const initialAuthorityVersion = status.authorityVersion;
            bindSessionArguments(status, profile, args);
            if (tool === 'device_snapshot') requireDeviceTransition(status, args);
            const transitionAxes =
              tool === 'device_snapshot'
                ? args.action === 'open'
                  ? {
                      before: ['C', 'S', 'I', 'M', 'D'] as AuthorityAxis[],
                      after: ['C', 'S', 'I', 'M', 'D', 'R'] as AuthorityAxis[],
                    }
                  : {
                      before: ['C', 'S', 'I', 'M', 'D', 'R'] as AuthorityAxis[],
                      after: ['C', 'S', 'I', 'M', 'D'] as AuthorityAxis[],
                    }
                : tool === 'observe'
                  ? args.action === 'stop'
                    ? {
                        before: ['C', 'S', 'I', 'M', 'B', 'D', 'R', 'O'] as AuthorityAxis[],
                        after: ['C', 'S', 'I', 'M', 'B', 'D', 'R'] as AuthorityAxis[],
                      }
                    : {
                        before: ['C', 'S', 'I', 'M', 'B', 'D', 'R'] as AuthorityAxis[],
                        after: ['C', 'S', 'I', 'M', 'B', 'D', 'R', 'O'] as AuthorityAxis[],
                      }
                  : tool === 'rn_session' && args.action === 'prepare_handoff'
                    ? { before: [...profile.axes], after: [] as AuthorityAxis[] }
                    : { before: [...profile.axes], after: [...profile.axes] };
            requireCompleteAxes(status, { ...profile, axes: transitionAxes.before });
            operation = registry.beginOperation(available.session, {
              operationId: randomUUID(),
              tool,
              profile: `transition:${transitionAxes.before.join('')}>${transitionAxes.after.join('')}`,
            });
            const before = await Promise.all(
              transitionAxes.before.map((axis) =>
                dependencies.probe({ axis, phase: 'preflight', tool, profile, status, args }),
              ),
            );
            registry.verifyOperation(operation);
            const result = await registry.runWithOperation(operation, () =>
              handler(...handlerArgs),
            );
            if (!resultIsCanonicalSuccess(result)) {
              return addMeta(result, { authoritative: false });
            }
            if (tool === 'rn_session' && args.action === 'release') {
              operation = null;
              return addMeta(result, {
                authoritative: false,
                authorityTransition: true,
              });
            }
            const gateCommitsProof = tool === 'proof_capture' && args.action === 'begin_rehearsal';
            if (!gateCommitsProof) {
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
            requireCompleteAxes(status, { ...profile, axes: transitionAxes.after });
            const after = await Promise.all(
              transitionAxes.after.map((axis) =>
                dependencies.probe({ axis, phase: 'postflight', tool, profile, status, args }),
              ),
            );
            for (const observation of before) {
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
              const current = runtime.requireAvailable();
              registry.endOperation(operation);
              operation = null;
              current.registry.updateBindings(current.session, {
                bindings: { proof: { runId } },
                expectedAuthorityVersion: status.authorityVersion,
              });
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
            return authorityFailure(error);
          } finally {
            if (registry && operation) {
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
          let optionalBundleClaimed = false;
          let optionalBundleRecoveryFailed = false;
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
                  const metro = currentStatus.bindings.metro as
                    | Record<string, unknown>
                    | undefined;
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
          registry.verifyOperation(operation);
          const result = await registry.runWithOperation(operation, () => handler(...handlerArgs));
          const directRuntimeReset = tool === 'cdp_reload' || tool === 'cdp_restart';
          const nestedRuntimeReset =
            tool === 'cdp_run_e2e_suite' ||
            tool === 'cdp_auto_login' ||
            (tool === 'cdp_nav_graph' && args.action === 'go') ||
            (tool === 'cdp_run_action' && Boolean(status.bindings.bundle));
          const reconcilesRuntimeTarget = directRuntimeReset || nestedRuntimeReset;
          let authorityInvalidated = false;
          if (directRuntimeReset && !resultSucceeded(result)) {
            const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
            const metro = status.bindings.metro as Record<string, unknown> | undefined;
            const oldTargetId = priorBundle?.targetId;
            const metroPort = metro?.port;
            operation = registry.replaceBindingsDuringOperation(operation, {
              state: 'device_bound',
              bindings: { bundle: null },
              releaseResources:
                typeof oldTargetId === 'string' && Number.isSafeInteger(metroPort)
                  ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
                  : [],
            });
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
              const oldTargetId = priorBundle?.targetId;
              const metroPort = metro?.port;
              operation = registry.replaceBindingsDuringOperation(operation, {
                state: 'device_bound',
                bindings: { bundle: null },
                releaseResources:
                  typeof oldTargetId === 'string' && Number.isSafeInteger(metroPort)
                    ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
                    : [],
              });
              const refreshedStatus = runtime.status();
              if (!refreshedStatus.available) {
                throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
              }
              status = refreshedStatus;
              if (!resultSucceeded(result)) {
                return addMeta(result, {
                  authorityInvalidated: true,
                  nextAction: 'Run rn_session action "pin_dev_client" before another CDP operation.',
                });
              }
              if (tool === 'cdp_run_action' && !optionalBundleClaimed) {
                authorityInvalidated = true;
              } else {
                throw error;
              }
            }
            if (!authorityInvalidated && bundle) {
              const oldTargetId = priorBundle?.targetId;
              const newTargetId = bundle.targetId;
              const metroPort = metro?.port;
              if (
                typeof oldTargetId !== 'string' ||
                typeof newTargetId !== 'string' ||
                !Number.isSafeInteger(metroPort)
              ) {
                throw new SessionAuthorityError(
                  'CDP_TARGET_AUTHORITY_MISMATCH',
                  'runtime reset did not produce an exact target replacement',
                );
              }
              runtimeTargetChanged =
                oldTargetId !== newTargetId ||
                priorBundle?.connectionGeneration !== bundle.connectionGeneration;
              if (runtimeTargetChanged) {
                operation = registry.replaceBindingsDuringOperation(operation, {
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
                const refreshedStatus = runtime.status();
                if (!refreshedStatus.available) {
                  throw new SessionAuthorityError(refreshedStatus.code, refreshedStatus.reason);
                }
                status = refreshedStatus;
              }
            }
          }
          const effectiveProfile =
            optionalBefore.length > 0
              ? { ...profile, axes: [...profile.axes, ...optionalBefore.map(({ axis }) => axis)] }
              : profile;
          const allBefore = [...before, ...optionalBefore];
          const after = await Promise.all(
            effectiveProfile.axes.map((axis) =>
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
          for (let index = 0; index < allBefore.length; index += 1) {
            if (runtimeTargetChanged && allBefore[index]?.axis === 'B') continue;
            if (allBefore[index]?.identity !== after[index]?.identity) {
              throw new SessionAuthorityError(
                'AUTHORITY_LOST_DURING_OPERATION',
                `${allBefore[index]?.axis ?? 'unknown'} authority changed during the operation`,
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
              registry.endOperation(operation);
              operation = null;
              registry.updateBindings(available.session, {
                bindings: { proof: null },
                expectedAuthorityVersion: status.authorityVersion,
              });
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
            authorityReceipt: receipt(status, effectiveProfile, after),
            ...(authorityInvalidated
              ? {
                  authorityInvalidated: true,
                  nextAction: 'Run rn_session action "pin_dev_client" before another CDP operation.',
                }
              : {}),
          });
        } catch (error) {
          return authorityFailure(error);
        } finally {
          if (registry && operation) {
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
