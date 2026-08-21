import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolErrorCode } from '../types.js';
import { failResult, type ToolResult } from '../utils.js';
import type { OperationRef, SessionRef, SessionRegistry, SessionStatus } from './registry.js';
import { authorityErrorMeta, SessionAuthorityError, shortAuthorityIdentity } from './registry.js';
import { isProvenMetroOriginMismatch } from './metro-origin.js';
import { reissueInstallBinding } from './install-reissue.js';
import type { WorkerAuthorityStatus } from './runtime.js';
import {
  LOGIN_PROLOGUE_ALIAS,
  LOGIN_PROLOGUE_BLOCKED,
  appendLoginOverrideAudit,
  evaluateLoginPrologueGuard,
  readLoginPrologueOutcome,
  type LoginPrologueOutcome,
} from '../domain/login-prologue.js';
import {
  authorityProfileFor,
  requiresExactInstalledArtifact,
  type AuthorityAxis,
  type AuthorityProfile,
} from './tool-profiles.js';

export interface AuthorityObservation {
  axis: AuthorityAxis;
  identity: string;
  detail?: Record<string, unknown>;
}

export interface AuthorityProbeInput {
  axis: AuthorityAxis;
  phase: 'preflight' | 'postflight';
  tool: string;
  profile: AuthorityProfile;
  status: SessionStatus;
  args: Record<string, unknown>;
}

export interface StagedRuntimeRelaunch {
  probe(input: AuthorityProbeInput): Promise<AuthorityObservation>;
  refreshRuntimeBinding(status: SessionStatus): Promise<Record<string, unknown>>;
  assertActive(): void;
  publish(status: SessionStatus): void;
  cancel(): void;
}

export interface ManagedNativeOriginReproveOptions {
  readinessTimeoutMs?: number;
}

interface AuthorityGateRuntime {
  requireAvailable(): { registry: SessionRegistry; session: SessionRef };
  status(): WorkerAuthorityStatus;
  blockedContenderError(): SessionAuthorityError;
}

interface AuthorityGateDependencies {
  probe(input: AuthorityProbeInput): Promise<AuthorityObservation>;
  recoverRuntimeConnection?(status: SessionStatus): Promise<boolean>;
  runtimeConnectionChanged?(status: SessionStatus): boolean;
  refreshRuntimeBinding?(status: SessionStatus): Promise<Record<string, unknown>>;
  relaunchBoundRuntime?(status: SessionStatus): Promise<StagedRuntimeRelaunch | void>;
  reconnectBoundRuntime?(
    status: SessionStatus,
    options?: ManagedNativeOriginReproveOptions,
  ): Promise<StagedRuntimeRelaunch | void>;
  onRunnerReleased?(runner: Record<string, unknown>): Promise<void> | void;
  onRuntimeBundleInvalidated?(): void;
  snapshotCaptureCheckpoint?(): number;
  promoteSnapshotOrigin?(checkpoint: number): void;
  reissueInstallBinding?(
    install: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null;
  loginSupervisorOverrideToken?(): string | undefined;
}

const optionalBundleAdmission = Symbol('optionalBundleAdmission');
const managedNativeOrigin = Symbol('managedNativeOrigin');
const managedRunnerPark = Symbol('managedRunnerPark');
const managedInstallReissue = Symbol('managedInstallReissue');

type AuthorityAwareArgs = Record<string, unknown> & {
  [optionalBundleAdmission]?: () => Promise<boolean>;
  [managedNativeOrigin]?: {
    claim(): Promise<void>;
    complete(targetExpected: boolean): Promise<void>;
    relaunch(): Promise<void>;
    reprove(options?: ManagedNativeOriginReproveOptions): Promise<void>;
  };
  [managedRunnerPark]?: () => Promise<void>;
  [managedInstallReissue]?: () => Promise<void>;
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

/**
 * GH #708: re-prove the managed native origin after a mid-flow relaunch whose
 * dev-client only re-registered once the flow's own post-launch steps ran.
 * Reconnect-only — it never relaunches, so the flow's end state survives.
 */
export async function reproveManagedNativeOrigin(
  args: object,
  options?: ManagedNativeOriginReproveOptions,
): Promise<void> {
  const authority = (args as AuthorityAwareArgs)[managedNativeOrigin];
  if (!authority) {
    throw new SessionAuthorityError(
      'METRO_ORIGIN_MISMATCH',
      'managed native origin re-prove authority is unavailable',
    );
  }
  await authority.reprove(options);
}

/**
 * GH #705: commit a new install receipt after Maestro reinstalled the session's
 * own attested `.app` for a `clearState` flow. Refuses unless the freshly
 * installed bytes still hash to the bound receipt's artifactDigest.
 */
export async function reissueManagedInstallAuthority(args: object): Promise<void> {
  const reissue = (args as AuthorityAwareArgs)[managedInstallReissue];
  if (!reissue) {
    throw new SessionAuthorityError(
      'APP_INSTALL_IDENTITY_CHANGED',
      'managed install re-issue authority is unavailable',
    );
  }
  await reissue();
}

export function hasManagedNativeOriginAuthority(args: object): boolean {
  return (args as AuthorityAwareArgs)[managedNativeOrigin] !== undefined;
}

export function hasManagedInstallReissueAuthority(args: object): boolean {
  return typeof (args as AuthorityAwareArgs)[managedInstallReissue] === 'function';
}

export function hasManagedRunnerParkAuthority(args: object): boolean {
  return typeof (args as AuthorityAwareArgs)[managedRunnerPark] === 'function';
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

function successEnvelopeFlag(result: unknown, field: string): boolean {
  try {
    const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
      ok?: unknown;
      data?: Record<string, unknown>;
    };
    return envelope.ok === true && envelope.data?.[field] === true;
  } catch {
    return false;
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

// Prefer the durable offer/journal over the arguments: a journal resume supplies
// neither platform nor deviceId. ADR L5's confirmed initial transfer has no durable
// offer or journal at preflight, so its exact scope arrives in the arguments; the
// commit itself is still proven independently by staleDeviceReleaseCommitted.
function staleDeviceReleaseScope(
  tool: string,
  args: Record<string, unknown>,
  status: SessionStatus,
): { platform: string; deviceId: string } | null {
  if (tool !== 'rn_session' || args.action !== 'release_stale_device') return null;
  const scope = (status.bindings.staleDeviceCleanup ?? status.bindings.staleDeviceRelease) as
    | { platform?: unknown; deviceId?: unknown }
    | null
    | undefined;
  if (!scope || typeof scope.platform !== 'string' || typeof scope.deviceId !== 'string') {
    if (typeof args.platform === 'string' && typeof args.deviceId === 'string') {
      return { platform: args.platform, deviceId: args.deviceId };
    }
    return null;
  }
  return { platform: scope.platform, deviceId: scope.deviceId };
}

// `finishStaleResourceRelease` clears journal + offer and advances the generation in the
// same transaction as the claim deletions, so observing all three proves the scoped
// release committed — independently of whether this call still owns its fence.
function staleDeviceReleaseCommitted(
  runtime: AuthorityGateRuntime,
  initialAuthorityVersion: number,
): boolean {
  const current = runtime.status();
  return (
    current.available &&
    current.authorityVersion > initialAuthorityVersion &&
    !current.bindings.staleDeviceCleanup &&
    !current.bindings.staleDeviceRelease
  );
}

// The commit stands either way, but only a genuine authority failure may be reported as a
// lost fence: any other post-commit error carries a neutral code and its own reason.
function postCommitFailureMeta(
  error: unknown,
  released: { platform: string; deviceId: string },
): Record<string, unknown> {
  const fenceLost = error instanceof SessionAuthorityError;
  const detail = {
    code: fenceLost ? error.code : (authorityErrorCode(error) ?? 'POST_COMMIT_FAILURE'),
    reason: error instanceof Error ? error.message : String(error),
    released,
  };
  return {
    authorityLostAfterCommit: fenceLost ? detail : undefined,
    failedAfterCommit: fenceLost ? undefined : detail,
    nextAction: fenceLost
      ? 'The exact device release is committed. Re-read rn_session action "status" ' +
        'before the next fenced operation; this session no longer holds the fence it started with.'
      : 'The exact device release is committed. Re-read rn_session action "status" ' +
        'before the next fenced operation; the reported failure happened after the commit.',
  };
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

// A byte-identical reinstall (runner-respawn recovery, clearState replay, an
// identical dev rebuild) rotates installGeneration but not artifactDigest, and
// used to hard-stop every gated tool while status still said ready. A preflight
// axis-I refusal retries once behind the GH #705 digest proof; a foreign or
// unattestable artifact still throws APP_INSTALL_IDENTITY_CHANGED unchanged.
function reissueInstallAfterPreflightRefusal(
  registry: SessionRegistry,
  runtime: AuthorityGateRuntime,
  operation: OperationRef,
  status: SessionStatus,
  dependencies: AuthorityGateDependencies,
  error: unknown,
  axes: readonly AuthorityAxis[],
  tool: string,
  args: Record<string, unknown>,
): { operation: OperationRef; status: SessionStatus } | null {
  if (
    !axes.includes('I') ||
    Boolean(status.bindings.proof) ||
    requiresExactInstalledArtifact(tool, args) ||
    authorityErrorCode(error) !== 'APP_INSTALL_IDENTITY_CHANGED'
  ) {
    return null;
  }
  const install = (dependencies.reissueInstallBinding ?? reissueInstallBinding)(
    status.bindings.install as Record<string, unknown> | undefined,
  );
  if (!install) return null;
  registry.verifyOperation(operation);
  const reissuedOperation = registry.replaceBindingsDuringOperation(operation, {
    bindings: { install },
  });
  const reissuedStatus = runtime.status();
  if (!reissuedStatus.available) {
    throw new SessionAuthorityError(reissuedStatus.code, reissuedStatus.reason);
  }
  return { operation: reissuedOperation, status: reissuedStatus };
}

async function preflightWithInstallReissue(
  registry: SessionRegistry,
  runtime: AuthorityGateRuntime,
  dependencies: AuthorityGateDependencies,
  context: {
    tool: string;
    profile: AuthorityProfile;
    args: Record<string, unknown>;
    axes: readonly AuthorityAxis[];
  },
  operation: OperationRef,
  status: SessionStatus,
): Promise<{ before: AuthorityObservation[]; operation: OperationRef; status: SessionStatus }> {
  const { tool, profile, args, axes } = context;
  const probeAll = (probed: SessionStatus): Promise<AuthorityObservation[]> =>
    Promise.all(
      axes.map((axis) =>
        dependencies.probe({ axis, phase: 'preflight', tool, profile, status: probed, args }),
      ),
    );
  try {
    return { before: await probeAll(status), operation, status };
  } catch (preflightError) {
    const reissued = reissueInstallAfterPreflightRefusal(
      registry,
      runtime,
      operation,
      status,
      dependencies,
      preflightError,
      axes,
      tool,
      args,
    );
    if (!reissued) throw preflightError;
    return {
      before: await probeAll(reissued.status),
      operation: reissued.operation,
      status: reissued.status,
    };
  }
}

function requireDeviceTransition(status: SessionStatus, args: Record<string, unknown>): void {
  const action = args.action ?? 'snapshot';
  if (action === 'open') {
    for (const binding of ['install', 'device']) {
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

function requireRetainedRunnerOwnership(registry: SessionRegistry, status: SessionStatus): void {
  const runner = status.bindings.runner as Record<string, unknown> | undefined;
  const device = status.bindings.device as Record<string, unknown> | undefined;
  if (!runner) return;
  const platform = runner.platform;
  const deviceId = runner.deviceId;
  const port = runner.port;
  if (
    (platform !== 'ios' && platform !== 'android') ||
    typeof deviceId !== 'string' ||
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    runner.sessionId !== status.sessionId ||
    runner.claimEpoch !== status.claimEpoch ||
    typeof runner.instanceId !== 'string' ||
    typeof runner.capability !== 'string' ||
    typeof runner.pid !== 'number' ||
    typeof runner.processBirth !== 'string' ||
    device?.platform !== platform ||
    device.deviceId !== deviceId ||
    device.appId !== runner.appId
  ) {
    throw new SessionAuthorityError(
      'RUNNER_OWNERSHIP_MISMATCH',
      'retained runner cleanup claim no longer matches the authenticated binding',
    );
  }
  const claim = registry.getClaim('runner', `${platform}:${deviceId}:${String(port)}`);
  if (claim?.sessionId !== status.sessionId || claim.claimEpoch !== status.claimEpoch) {
    throw new SessionAuthorityError(
      'RUNNER_OWNERSHIP_MISMATCH',
      'retained runner cleanup claim no longer matches the authenticated binding',
    );
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

const SOURCE_FENCED_SESSION_ACTIONS = new Set([
  'bind_source',
  'bind_device',
  'preview_integration',
  'apply_integration',
]);

function bindSourcePaths(
  status: SessionStatus,
  args: Record<string, unknown>,
  tool?: string,
): void {
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
    // GH #776: these rn_session actions own projectRoot as a repository-identity
    // fence, not a path inside the bound app root — bind_source declares a root
    // outside it, and the fenced actions refuse SOURCE_ROOT_DIVERGENCE naming
    // both paths. Filesystem containment would pre-empt that typed refusal.
    // Scoped to the exact rn_session tool so no other surface can skip the fence.
    if (
      field === 'projectRoot' &&
      tool === 'rn_session' &&
      typeof args.action === 'string' &&
      SOURCE_FENCED_SESSION_ACTIONS.has(args.action)
    ) {
      continue;
    }
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
      // GH #776: name both paths so a linked-worktree caller can see the divergence.
      throw new SessionAuthorityError(
        'SOURCE_WORKTREE_MISMATCH',
        `${field} ${candidate} is outside the active session app root ${appRoot}`,
        undefined,
        field === 'projectRoot'
          ? {
              nextAction: `Run rn_session action "bind_source" with projectRoot "${candidate}" to rebind the session to that worktree, then retry.`,
            }
          : undefined,
      );
    }
    args[field] = candidate;
  }
}

function bindSessionArguments(
  status: SessionStatus,
  profile: AuthorityProfile,
  args: Record<string, unknown>,
  tool?: string,
): void {
  bindSourcePaths(status, args, tool);
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

function parseLoginPrologueOutcome(result: unknown): LoginPrologueOutcome | null {
  try {
    const envelope = JSON.parse((result as ToolResult).content?.[0]?.text ?? '{}') as {
      data?: unknown;
      meta?: { loginPrologue?: unknown };
    };
    return readLoginPrologueOutcome(envelope.data ?? envelope.meta?.loginPrologue);
  } catch {
    return null;
  }
}

function missingLoginPrologueOutcome(): LoginPrologueOutcome {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    state: LOGIN_PROLOGUE_BLOCKED,
    alias: LOGIN_PROLOGUE_ALIAS,
    startedAt: timestamp,
    endedAt: timestamp,
    elapsedMs: 0,
    steps: [],
    inventory: { count: 0, actionIds: [] },
    failure: {
      code: 'LOGIN_PROLOGUE_RESULT_INVALID',
      detail: 'The login prologue returned no valid terminal state.',
    },
  };
}

function pendingLoginPrologueOutcome(): LoginPrologueOutcome {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    state: LOGIN_PROLOGUE_BLOCKED,
    alias: LOGIN_PROLOGUE_ALIAS,
    startedAt: timestamp,
    endedAt: timestamp,
    elapsedMs: 0,
    steps: [],
    inventory: { count: 0, actionIds: [] },
    failure: {
      code: 'LOGIN_PROLOGUE_IN_PROGRESS',
      detail: 'The login prologue has not completed authoritative validation.',
    },
  };
}

function persistLoginPrologueOutcome(
  runtime: AuthorityGateRuntime,
  registry: SessionRegistry,
  operation: OperationRef,
  status: SessionStatus,
  outcome: LoginPrologueOutcome,
): { operation: OperationRef; status: SessionStatus } {
  const priorOutcome = readLoginPrologueOutcome(status.bindings.loginPrologue);
  const overrides = outcome.overrides ?? priorOutcome?.overrides;
  const nextOperation = registry.replaceBindingsDuringOperation(operation, {
    bindings: {
      loginPrologue: {
        ...outcome,
        ...(overrides ? { overrides } : {}),
      },
    },
  });
  const nextStatus = runtime.status();
  if (!nextStatus.available) {
    throw new SessionAuthorityError(nextStatus.code, nextStatus.reason);
  }
  return { operation: nextOperation, status: nextStatus };
}

function isActionReplayTool(tool: string): boolean {
  return tool === 'cdp_run_action' || tool === 'cdp_login_prologue';
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

// GH #630: unavailable managed-origin evidence stays optional for raw native
// control (GH #677), but a PROVEN foreign-Metro origin must refuse fail-closed.
function isOptionalNativeOriginFailure(error: unknown): boolean {
  if (isProvenMetroOriginMismatch(error)) return false;
  const code = authorityErrorCode(error);
  return (
    code === 'METRO_INSTANCE_CHANGED' ||
    code === 'METRO_AUTHORITY_MISMATCH' ||
    code === 'METRO_ORIGIN_MISMATCH'
  );
}

async function probeOptionalNativeOrigin(
  dependencies: AuthorityGateDependencies,
  input: Omit<AuthorityProbeInput, 'axis'>,
): Promise<AuthorityObservation[]> {
  if (!input.status.bindings.metro || !input.status.bindings.device) return [];
  let metro: AuthorityObservation | null = null;
  try {
    metro = await dependencies.probe({ ...input, axis: 'M' });
  } catch (error) {
    if (!isOptionalNativeOriginFailure(error)) throw error;
  }
  try {
    const origin = await dependencies.probe({ ...input, axis: 'A' });
    return metro ? [metro, origin] : [];
  } catch (error) {
    if (isOptionalNativeOriginFailure(error)) return [];
    throw error;
  }
}

async function beginOptionalNativeOrigin(
  dependencies: AuthorityGateDependencies,
  input: Omit<AuthorityProbeInput, 'axis' | 'phase'>,
): Promise<AuthorityObservation[]> {
  if (input.profile.nativeOrigin !== 'optional') return [];
  return probeOptionalNativeOrigin(dependencies, { ...input, phase: 'preflight' });
}

async function confirmOptionalNativeOrigin(
  dependencies: AuthorityGateDependencies,
  before: readonly AuthorityObservation[],
  input: Omit<AuthorityProbeInput, 'axis' | 'phase'>,
): Promise<{ after: AuthorityObservation[]; proven: boolean }> {
  const after =
    before.length > 0
      ? await probeOptionalNativeOrigin(dependencies, { ...input, phase: 'postflight' })
      : [];
  const proven =
    before.length === 2 &&
    after.length === 2 &&
    before.every(
      (observation) =>
        observation.identity ===
        after.find((candidate) => candidate.axis === observation.axis)?.identity,
    );
  return { after, proven };
}

// Staged snapshot receipts re-validate against the live runner binding at
// commit, so a gate-owned runner release leaves nothing committable.
function platformReceiptAuthorityHeld(status: SessionStatus): boolean {
  return Boolean(status.bindings.runner);
}

function nativeOriginMeta(
  profile: AuthorityProfile,
  proven: boolean,
): { originAuthority: 'proven' | 'not-proven' } | Record<string, never> {
  return profile.nativeOrigin ? { originAuthority: proven ? 'proven' : 'not-proven' } : {};
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

function resultAllowsOriginProof(result: unknown): boolean {
  const first = (result as ToolResult | undefined)?.content?.[0];
  if (!first?.text) return true;
  try {
    const envelope = JSON.parse(first.text) as {
      meta?: {
        snapshotProvenance?: {
          source?: unknown;
          originAuthority?: unknown;
        };
      };
    };
    const provenance = envelope.meta?.snapshotProvenance;
    return provenance?.source !== 'cache' || provenance.originAuthority === 'proven';
  } catch {
    return true;
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
    originAuthority: profile.nativeOrigin
      ? observations.some(({ axis }) => axis === 'A')
        ? 'proven'
        : 'not-proven'
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
  promotion?: Pick<StagedRuntimeRelaunch, 'assertActive'> & {
    onCommitted(operation: OperationRef): void;
  },
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
  if (!runtimeTargetChanged && !promotion) {
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
    assertBeforeCommit: promotion?.assertActive,
    onCommitted: promotion?.onCommitted,
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

function restoreRuntimeBundleReplacement(
  registry: SessionRegistry,
  operation: OperationRef,
  priorStatus: SessionStatus,
  candidateBundle: Record<string, unknown>,
): OperationRef {
  const priorBundle = priorStatus.bindings.bundle as Record<string, unknown> | undefined;
  const metro = priorStatus.bindings.metro as Record<string, unknown> | undefined;
  const priorTargetId = priorBundle?.targetId;
  const candidateTargetId = candidateBundle.targetId;
  const metroPort = metro?.port;
  if (typeof candidateTargetId !== 'string' || !Number.isSafeInteger(metroPort)) {
    throw new SessionAuthorityError(
      'CDP_TARGET_AUTHORITY_MISMATCH',
      'runtime promotion compensation lost its exact target authority',
    );
  }
  const targetChanged = priorTargetId !== candidateTargetId;
  return registry.replaceBindingsDuringOperation(operation, {
    state: priorStatus.state,
    bindings: { bundle: priorBundle ?? null },
    releaseResources: targetChanged
      ? [{ type: 'target', key: `${String(metroPort)}:${candidateTargetId}` }]
      : [],
    claimResources:
      targetChanged && typeof priorTargetId === 'string'
        ? [{ type: 'target', key: `${String(metroPort)}:${priorTargetId}` }]
        : [],
  });
}

function invalidateRuntimeBundle(
  registry: SessionRegistry,
  operation: OperationRef,
  status: SessionStatus,
  onInvalidated?: () => void,
): OperationRef {
  const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
  const metro = status.bindings.metro as Record<string, unknown> | undefined;
  const oldTargetId = priorBundle?.targetId;
  const metroPort = metro?.port;
  const nextOperation = registry.replaceBindingsDuringOperation(operation, {
    state: 'device_bound',
    bindings: { bundle: null },
    releaseResources:
      typeof oldTargetId === 'string' && Number.isSafeInteger(metroPort)
        ? [{ type: 'target', key: `${String(metroPort)}:${oldTargetId}` }]
        : [],
  });
  onInvalidated?.();
  return nextOperation;
}

async function reconcileRecoverableRuntime(
  runtime: AuthorityGateRuntime,
  dependencies: AuthorityGateDependencies,
  registry: SessionRegistry,
  operation: OperationRef,
  status: SessionStatus,
  profile: AuthorityProfile,
  allowRecovery: boolean,
): Promise<{
  operation: OperationRef;
  status: SessionStatus;
  runtimeTargetChanged: boolean;
}> {
  if (!profile.axes.includes('B') && !registry.operationHasAxis(operation, 'B')) {
    return { operation, status, runtimeTargetChanged: false };
  }
  if (allowRecovery && !dependencies.recoverRuntimeConnection) {
    return { operation, status, runtimeTargetChanged: false };
  }
  const recovered = allowRecovery
    ? await registry.runWithOperation(operation, () =>
        dependencies.recoverRuntimeConnection!(status),
      )
    : dependencies.runtimeConnectionChanged?.(status);
  if (!recovered) return { operation, status, runtimeTargetChanged: false };
  if (!dependencies.refreshRuntimeBinding) {
    throw new SessionAuthorityError(
      'BUNDLE_HANDSHAKE_UNAVAILABLE',
      'authoritative reconnect cannot commit without a binding refresh',
    );
  }
  const bundle = await dependencies.refreshRuntimeBinding(status);
  return reconcileRuntimeBundleReplacement(
    runtime,
    registry,
    operation,
    status,
    status.bindings.bundle as Record<string, unknown> | undefined,
    status.bindings.metro as Record<string, unknown> | undefined,
    bundle,
  );
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
                          ? (['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R'] as const)
                          : (['C', 'S'] as const),
                      nativeOrigin:
                        tool === 'device_snapshot'
                          ? baseProfile.nativeOrigin
                          : tool === 'proof_capture'
                            ? ('required' as const)
                            : undefined,
                      mutation: true,
                      liveBundleProbe: tool === 'proof_capture',
                    }
                  : baseProfile;

        const runtimeStatus = runtime.status();
        const loginDecision = evaluateLoginPrologueGuard({
          binding: runtimeStatus.available ? runtimeStatus.bindings.loginPrologue : undefined,
          tool,
          args,
          mutation: profile.mutation,
          expectedOverrideToken: dependencies.loginSupervisorOverrideToken?.(),
        });
        delete args.supervisorOverrideToken;
        if (!loginDecision.allowed) {
          return failResult(
            'LOGIN_PROLOGUE_BLOCKED: the deterministic login action did not produce an authoritative passing RunRecord; mutating tools are disabled for this session.',
            'LOGIN_PROLOGUE_BLOCKED',
            {
              loginPrologue: runtimeStatus.available
                ? runtimeStatus.bindings.loginPrologue
                : undefined,
              overrideRejected: loginDecision.suppliedOverride,
              nextAction:
                'Repair the exact user-login action and rerun cdp_login_prologue, or supply a supervisorOverrideToken configured by RN_LOGIN_PROLOGUE_OVERRIDE_TOKEN for this mutating call.',
            },
          );
        }
        if (loginDecision.override && profile.kind === 'transition') {
          return failResult(
            'LOGIN_PROLOGUE_BLOCKED: supervisor overrides cannot authorize transition mutations.',
            'LOGIN_PROLOGUE_BLOCKED',
            {
              loginPrologue: runtimeStatus.available
                ? runtimeStatus.bindings.loginPrologue
                : undefined,
              transitionOverrideRejected: true,
              nextAction:
                'Repair the exact user-login action and rerun cdp_login_prologue before this transition.',
            },
          );
        }
        if (profile.kind === 'diagnostic') {
          return addMeta(await handler(...handlerArgs), { authoritative: false });
        }
        if (runtimeStatus.available && runtimeStatus.state === 'blocked') {
          return authorityFailure(runtime.blockedContenderError());
        }
        if (
          runtimeStatus.available &&
          tool === 'observe' &&
          ((args.action === 'start' && runtimeStatus.bindings.observe) ||
            (args.action === 'stop' && !runtimeStatus.bindings.observe))
        ) {
          profile = baseProfile;
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
            bindSessionArguments(runtimeStatus, profile, args, tool);
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
          let committedStaleDeviceRelease: {
            result: unknown;
            scope: { platform: string; deviceId: string };
            initialAuthorityVersion: number;
          } | null = null;
          try {
            const available = runtime.requireAvailable();
            registry = available.registry;
            const initialStatus = runtime.status();
            if (!initialStatus.available) {
              throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
            }
            let status: SessionStatus = initialStatus;
            let runtimeTargetChanged = false;
            let initialAuthorityVersion = status.authorityVersion;
            const gateCommitsProof = tool === 'proof_capture' && args.action === 'begin_rehearsal';
            const retainsRunnerCleanupAuthority =
              tool === 'device_snapshot' &&
              args.action === 'close' &&
              Boolean(status.bindings.runner);
            bindSessionArguments(status, profile, args, tool);
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
                      before: ['C', 'S', 'I', 'D'] as AuthorityAxis[],
                      after: ['C', 'S', 'I', 'D', 'R'] as AuthorityAxis[],
                    }
                  : {
                      before: ['C', 'S', 'D'] as AuthorityAxis[],
                      after: ['C', 'S', 'D'] as AuthorityAxis[],
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
            if (retainsRunnerCleanupAuthority) {
              requireRetainedRunnerOwnership(registry, status);
            }
            const preflight = await preflightWithInstallReissue(
              registry,
              runtime,
              dependencies,
              { tool, profile, args, axes: transitionAxes.before },
              operation,
              status,
            );
            const before = preflight.before;
            operation = preflight.operation;
            status = preflight.status;
            initialAuthorityVersion = status.authorityVersion;
            const optionalOriginBefore = await beginOptionalNativeOrigin(dependencies, {
              tool,
              profile,
              status,
              args,
            });
            registry.verifyOperation(operation);
            const snapshotCheckpoint = dependencies.snapshotCaptureCheckpoint?.();
            const result = await registry.runWithOperation(operation, () =>
              handler(...handlerArgs),
            );
            if (!resultSucceeded(result)) {
              if (tool === 'cdp_restart' && args.hardReset === true) {
                registry.verifyOperation(operation);
                operation = invalidateRuntimeBundle(
                  registry,
                  operation,
                  status,
                  dependencies.onRuntimeBundleInvalidated,
                );
                return addMeta(result, {
                  authoritative: false,
                  authorityInvalidated: true,
                  nextAction:
                    'Run rn_session action "pin_dev_client" before another CDP operation.',
                });
              }
              return addMeta(result, {
                authoritative: false,
                ...nativeOriginMeta(profile, false),
              });
            }
            beganProofRehearsal = gateCommitsProof;
            const staleReleaseScope = staleDeviceReleaseScope(tool, args, initialStatus);
            if (staleReleaseScope) {
              committedStaleDeviceRelease = {
                result,
                scope: staleReleaseScope,
                initialAuthorityVersion,
              };
            }
            if (tool === 'rn_session' && args.action === 'release') {
              operation = null;
              return addMeta(result, {
                authoritative: false,
                authorityTransition: true,
              });
            }
            // GH #776: terminality is proven by the envelope, never assumed from the
            // action — only the released row cannot complete its own fence. Any other
            // outcome must fall through, or it strands an operation row that refuses
            // every later call with OPERATION_ALREADY_IN_PROGRESS.
            const bindSource = tool === 'rn_session' && args.action === 'bind_source';
            const idempotentBindSource = bindSource && successEnvelopeFlag(result, 'alreadyBound');
            if (bindSource && successEnvelopeFlag(result, 'released')) {
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
              if (
                !nextStatus.available ||
                (!idempotentBindSource && nextStatus.authorityVersion <= initialAuthorityVersion)
              ) {
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
                operation = invalidateRuntimeBundle(
                  registry,
                  operation,
                  status,
                  dependencies.onRuntimeBundleInvalidated,
                );
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
            const { after: optionalOriginAfter, proven: optionalOriginProven } =
              await confirmOptionalNativeOrigin(dependencies, optionalOriginBefore, {
                tool,
                profile,
                status,
                args,
              });
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
            const transitionReceiptsCommittable = platformReceiptAuthorityHeld(status);
            if (
              operation &&
              optionalOriginProven &&
              transitionReceiptsCommittable &&
              snapshotCheckpoint !== undefined &&
              dependencies.promoteSnapshotOrigin
            ) {
              await registry.runWithOperation(operation, async () => {
                dependencies.promoteSnapshotOrigin!(snapshotCheckpoint);
              });
            }
            if (operation && transitionReceiptsCommittable) {
              registry.commitPlatformAuthorityReceipts(operation);
            }
            const transitionReceiptProfile = optionalOriginProven
              ? {
                  ...profile,
                  axes: [...transitionAxes.after, 'M' as const, 'A' as const],
                }
              : { ...profile, axes: transitionAxes.after };
            return addMeta(result, {
              authorityTransition: true,
              ...nativeOriginMeta(
                profile,
                profile.nativeOrigin === 'required' || optionalOriginProven,
              ),
              authorityReceipt: receipt(status, transitionReceiptProfile, [
                ...after,
                ...(optionalOriginProven ? optionalOriginAfter : []),
              ]),
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
            // Losing the fence AFTER the release committed is a real authority loss, but
            // failing the call would deny a side effect the registry still proves.
            if (
              committedStaleDeviceRelease &&
              staleDeviceReleaseCommitted(
                runtime,
                committedStaleDeviceRelease.initialAuthorityVersion,
              )
            ) {
              return addMeta(committedStaleDeviceRelease.result, {
                authoritative: false,
                authorityTransition: true,
                ...nativeOriginMeta(profile, false),
                ...postCommitFailureMeta(error, committedStaleDeviceRelease.scope),
              });
            }
            return addMeta(authorityFailure(error), nativeOriginMeta(profile, false));
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
        let stagedRuntimeRelaunch: StagedRuntimeRelaunch | undefined;
        try {
          const available = runtime.requireAvailable();
          registry = available.registry;
          const initialStatus = runtime.status();
          if (!initialStatus.available) {
            throw new SessionAuthorityError(initialStatus.code, initialStatus.reason);
          }
          let status: SessionStatus = initialStatus;
          requireCompleteAxes(status, profile);
          bindSessionArguments(status, profile, args, tool);
          operation = registry.beginOperation(available.session, {
            operationId: randomUUID(),
            tool,
            profile: profile.axes.join(''),
          });
          const preflightRecovery = await reconcileRecoverableRuntime(
            runtime,
            dependencies,
            registry,
            operation,
            status,
            profile,
            true,
          );
          operation = preflightRecovery.operation;
          status = preflightRecovery.status;
          const preflight = await preflightWithInstallReissue(
            registry,
            runtime,
            dependencies,
            { tool, profile, args, axes: profile.axes },
            operation,
            status,
          );
          const before = preflight.before;
          operation = preflight.operation;
          status = preflight.status;
          const initialOperationAuthorityVersion = operation.authorityVersion;
          const optionalNativeOriginBefore = await beginOptionalNativeOrigin(dependencies, {
            tool,
            profile,
            status,
            args,
          });
          const optionalBefore: AuthorityObservation[] = [];
          const managedOriginObservations: AuthorityObservation[] = [];
          const managedBundleObservations: AuthorityObservation[] = [];
          let managedOriginCompleted = false;
          let managedOriginCompletedWithTarget = false;
          let managedRuntimeTargetChanged = false;
          let optionalBundleClaimed = false;
          let optionalBundleRecoveryFailed = false;
          let managedRunnerParked = false;
          let installReceiptReissued = false;
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
                registry!.beginOperationAxisAdmission(operation!, 'B');
                let optionalBundleAdmitted = false;
                try {
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
                  optionalBundleAdmitted = true;
                  return true;
                } finally {
                  registry!.completeOperationAxisAdmission(operation!, 'B', optionalBundleAdmitted);
                }
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
              const stagedRelaunch = stagedRuntimeRelaunch;
              const promotionStatus = {
                ...currentStatus,
                bindings: { ...currentStatus.bindings },
              };
              let promotionCommitted = false;
              let originObservation: AuthorityObservation;
              let bundleObservation: AuthorityObservation;
              let candidateBundle: Record<string, unknown> | undefined;
              try {
                const probe = stagedRelaunch?.probe ?? dependencies.probe;
                originObservation = await probe({
                  axis: 'A',
                  phase: 'postflight',
                  tool,
                  profile,
                  status: currentStatus,
                  args,
                });
                if (!stagedRelaunch && !dependencies.refreshRuntimeBinding) {
                  throw new SessionAuthorityError(
                    'BUNDLE_HANDSHAKE_UNAVAILABLE',
                    'managed lifecycle cannot commit without a binding refresh',
                  );
                }
                candidateBundle = stagedRelaunch
                  ? await stagedRelaunch.refreshRuntimeBinding(currentStatus)
                  : await dependencies.refreshRuntimeBinding!(currentStatus);
                bundleObservation = await probe({
                  axis: 'B',
                  phase: 'postflight',
                  tool,
                  profile,
                  status: {
                    ...currentStatus,
                    bindings: { ...currentStatus.bindings, bundle: candidateBundle },
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
                  candidateBundle,
                  stagedRelaunch
                    ? {
                        assertActive: stagedRelaunch.assertActive,
                        onCommitted: (committedOperation) => {
                          promotionCommitted = true;
                          operation = committedOperation;
                        },
                      }
                    : undefined,
                );
                operation = reconciliation.operation;
                status = reconciliation.status;
                managedRuntimeTargetChanged ||= reconciliation.runtimeTargetChanged;
                if (stagedRelaunch) {
                  stagedRelaunch.assertActive();
                  stagedRelaunch.publish(status);
                  stagedRuntimeRelaunch = undefined;
                }
              } catch (error) {
                if (stagedRelaunch) {
                  let compensationError: unknown;
                  if (promotionCommitted) {
                    try {
                      operation = restoreRuntimeBundleReplacement(
                        registry!,
                        operation!,
                        promotionStatus,
                        candidateBundle!,
                      );
                      const restoredStatus = runtime.status();
                      if (restoredStatus.available) status = restoredStatus;
                    } catch (restoreError) {
                      compensationError = restoreError;
                    }
                  }
                  stagedRelaunch.cancel();
                  if (stagedRuntimeRelaunch === stagedRelaunch) {
                    stagedRuntimeRelaunch = undefined;
                  }
                  if (compensationError) {
                    throw new AggregateError(
                      [error, compensationError],
                      'BUNDLE_HANDSHAKE_UNAVAILABLE: staged runtime promotion compensation failed',
                    );
                  }
                  throw error;
                }
                const failedStatus = runtime.status();
                if (failedStatus.available && failedStatus.bindings.bundle) {
                  try {
                    registry!.verifyOperation(operation!);
                    operation = invalidateRuntimeBundle(
                      registry!,
                      operation!,
                      failedStatus,
                      dependencies.onRuntimeBundleInvalidated,
                    );
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
                  stagedRuntimeRelaunch?.cancel();
                  stagedRuntimeRelaunch = undefined;
                  stagedRuntimeRelaunch =
                    (await dependencies.relaunchBoundRuntime(currentStatus)) ?? undefined;
                  registry!.verifyOperation(operation!);
                },
                reprove: async (options?: ManagedNativeOriginReproveOptions) => {
                  const currentStatus = runtime.status();
                  if (!currentStatus.available) {
                    throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                  }
                  registry!.verifyOperation(operation!);
                  if (!dependencies.reconnectBoundRuntime) {
                    throw new SessionAuthorityError(
                      'METRO_ORIGIN_MISMATCH',
                      'managed native origin reconnect is unavailable',
                    );
                  }
                  stagedRuntimeRelaunch?.cancel();
                  stagedRuntimeRelaunch = undefined;
                  stagedRuntimeRelaunch =
                    (await dependencies.reconnectBoundRuntime(currentStatus, options)) ?? undefined;
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
                    operation = invalidateRuntimeBundle(
                      registry!,
                      operation!,
                      currentStatus,
                      dependencies.onRuntimeBundleInvalidated,
                    );
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
          if (profile.managedInstallReissue) {
            Object.defineProperty(args, managedInstallReissue, {
              configurable: true,
              value: async () => {
                const currentStatus = runtime.status();
                if (!currentStatus.available) {
                  throw new SessionAuthorityError(currentStatus.code, currentStatus.reason);
                }
                registry!.verifyOperation(operation!);
                const install = (dependencies.reissueInstallBinding ?? reissueInstallBinding)(
                  currentStatus.bindings.install as Record<string, unknown> | undefined,
                );
                if (!install) return;
                operation = registry!.replaceBindingsDuringOperation(operation!, {
                  bindings: { install },
                });
                const reissuedStatus = runtime.status();
                if (!reissuedStatus.available) {
                  throw new SessionAuthorityError(reissuedStatus.code, reissuedStatus.reason);
                }
                status = reissuedStatus;
                installReceiptReissued = true;
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
                if (
                  profile.nativeOrigin === 'optional' &&
                  optionalNativeOriginBefore.length !== 2
                ) {
                  throw new SessionAuthorityError(
                    'METRO_ORIGIN_MISMATCH',
                    'native fallback requires proven managed app origin',
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
          if (loginDecision.override) {
            const outcome = readLoginPrologueOutcome(status.bindings.loginPrologue);
            if (outcome?.state !== LOGIN_PROLOGUE_BLOCKED) {
              throw new SessionAuthorityError(
                'LOGIN_PROLOGUE_BLOCKED',
                'the blocked login prologue state disappeared before override audit',
              );
            }
            const persisted = persistLoginPrologueOutcome(
              runtime,
              registry,
              operation,
              status,
              appendLoginOverrideAudit(outcome, loginDecision.audit),
            );
            operation = persisted.operation;
            status = persisted.status;
          }
          if (tool === 'cdp_login_prologue') {
            const persisted = persistLoginPrologueOutcome(
              runtime,
              registry,
              operation,
              status,
              pendingLoginPrologueOutcome(),
            );
            operation = persisted.operation;
            status = persisted.status;
          }
          registry.verifyOperation(operation);
          const snapshotCheckpoint = dependencies.snapshotCaptureCheckpoint?.();
          let result = await registry.runWithOperation(operation, () => handler(...handlerArgs));
          let loginPrologueOutcome: LoginPrologueOutcome | null = null;
          if (tool === 'cdp_login_prologue') {
            loginPrologueOutcome = parseLoginPrologueOutcome(result);
            if (!loginPrologueOutcome) {
              loginPrologueOutcome = missingLoginPrologueOutcome();
              result = failResult(
                'Login prologue returned no valid terminal state.',
                'LOGIN_PROLOGUE_BLOCKED',
                { loginPrologue: loginPrologueOutcome },
              );
            }
            if (loginPrologueOutcome.state === LOGIN_PROLOGUE_BLOCKED) {
              const persisted = persistLoginPrologueOutcome(
                runtime,
                registry,
                operation,
                status,
                loginPrologueOutcome,
              );
              operation = persisted.operation;
              status = persisted.status;
            }
          }
          let runtimeTargetChanged = false;
          const postHandlerRecovery = await reconcileRecoverableRuntime(
            runtime,
            dependencies,
            registry,
            operation,
            status,
            profile,
            resultSucceeded(result),
          );
          operation = postHandlerRecovery.operation;
          status = postHandlerRecovery.status;
          runtimeTargetChanged = postHandlerRecovery.runtimeTargetChanged;
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
            (isActionReplayTool(tool) && (optionalBundleClaimed || optionalBundleRecoveryFailed));
          const reconcilesRuntimeTarget = directRuntimeReset || nestedRuntimeReset;
          let authorityInvalidated = false;
          if (directRuntimeReset && !resultSucceeded(result)) {
            operation = invalidateRuntimeBundle(
              registry,
              operation,
              status,
              dependencies.onRuntimeBundleInvalidated,
            );
            return addMeta(result, {
              authorityInvalidated: true,
              nextAction: 'Run rn_session action "pin_dev_client" before another CDP operation.',
            });
          }
          if (reconcilesRuntimeTarget && (resultSucceeded(result) || nestedRuntimeReset)) {
            const priorBundle = status.bindings.bundle as Record<string, unknown> | undefined;
            const metro = status.bindings.metro as Record<string, unknown> | undefined;
            let bundle: Record<string, unknown> | null = null;
            try {
              if (isActionReplayTool(tool) && optionalBundleRecoveryFailed) {
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
              operation = invalidateRuntimeBundle(
                registry,
                operation,
                status,
                dependencies.onRuntimeBundleInvalidated,
              );
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
              if (isActionReplayTool(tool) && !optionalBundleClaimed) {
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
              runtimeTargetChanged ||= reconciliation.runtimeTargetChanged;
            }
          }
          const { after: optionalNativeOriginAfter, proven: optionalNativeOriginProven } =
            await confirmOptionalNativeOrigin(dependencies, optionalNativeOriginBefore, {
              tool,
              profile,
              status,
              args,
            });
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
          const resultOriginProvenanceAllowsProof = resultAllowsOriginProof(result);
          const effectiveFinalOrigin = resultOriginProvenanceAllowsProof ? finalOrigin : undefined;
          const effectiveOptionalNativeOriginProven =
            resultOriginProvenanceAllowsProof && optionalNativeOriginProven;
          const receiptObservations = effectiveFinalOrigin
            ? [...after, effectiveFinalOrigin, ...(finalManagedBundle ? [finalManagedBundle] : [])]
            : [...after, ...(effectiveOptionalNativeOriginProven ? optionalNativeOriginAfter : [])];
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
          const receiptProfile = effectiveFinalOrigin
            ? {
                ...runnerAwareReceiptProfile,
                axes: [
                  ...runnerAwareReceiptProfile.axes,
                  'A' as const,
                  ...(finalManagedBundle ? (['B'] as const) : []),
                ],
              }
            : effectiveOptionalNativeOriginProven
              ? {
                  ...runnerAwareReceiptProfile,
                  axes: [...runnerAwareReceiptProfile.axes, 'M' as const, 'A' as const],
                }
              : runnerAwareReceiptProfile;
          // Gate-owned binding transitions (for example lazy runner parking)
          // advance C's authority generation through the active operation CAS.
          // Verify that exact advanced fence first, then tolerate only its C
          // identity change. An external generation change still fails CAS.
          const controllerGenerationAdvanced =
            operation.authorityVersion !== initialOperationAuthorityVersion;
          registry.verifyOperation(operation);
          for (const observation of allBefore) {
            if (controllerGenerationAdvanced && observation.axis === 'C') continue;
            if ((runtimeTargetChanged || managedRuntimeTargetChanged) && observation.axis === 'B') {
              continue;
            }
            // GH #705: a digest-proven reinstall of the session's own artifact
            // re-issues the install receipt mid-operation; only that exact
            // gate-owned transition may move I.
            if (installReceiptReissued && observation.axis === 'I') continue;
            if (!postflightAxes.includes(observation.axis)) continue;
            const postflight = after.find((candidate) => candidate.axis === observation.axis);
            if (observation.identity !== postflight?.identity) {
              throw new SessionAuthorityError(
                'AUTHORITY_LOST_DURING_OPERATION',
                `${observation.axis} authority changed during the operation`,
              );
            }
          }
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
          const nativeOriginProven =
            resultOriginProvenanceAllowsProof &&
            (profile.axes.includes('A') ||
              Boolean(effectiveFinalOrigin) ||
              effectiveOptionalNativeOriginProven);
          if (!resultIsCanonicalSuccess(result)) {
            return addMeta(result, {
              authoritative: false,
              ...nativeOriginMeta(profile, nativeOriginProven),
              ...(authorityInvalidated
                ? {
                    authorityInvalidated: true,
                    nextAction:
                      'Run rn_session action "pin_dev_client" before another CDP operation.',
                  }
                : {}),
            });
          }
          if (profile.nativeOrigin === 'required' && !nativeOriginProven) {
            throw new SessionAuthorityError(
              'METRO_ORIGIN_MISMATCH',
              'strict native evidence requires proven managed app origin',
            );
          }
          const receiptsCommittable =
            !runnerAuthorityReleased && platformReceiptAuthorityHeld(status);
          if (
            operation &&
            nativeOriginProven &&
            receiptsCommittable &&
            snapshotCheckpoint !== undefined &&
            dependencies.promoteSnapshotOrigin
          ) {
            await registry.runWithOperation(operation, async () => {
              dependencies.promoteSnapshotOrigin!(snapshotCheckpoint);
            });
          }
          if (operation && receiptsCommittable) {
            registry.commitPlatformAuthorityReceipts(operation);
          }
          if (operation && loginPrologueOutcome?.state === 'passed') {
            const persisted = persistLoginPrologueOutcome(
              runtime,
              registry,
              operation,
              status,
              loginPrologueOutcome,
            );
            operation = persisted.operation;
            status = persisted.status;
          }
          return addMeta(result, {
            ...nativeOriginMeta(profile, nativeOriginProven),
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
          return addMeta(authorityFailure(error), nativeOriginMeta(profile, false));
        } finally {
          stagedRuntimeRelaunch?.cancel();
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
