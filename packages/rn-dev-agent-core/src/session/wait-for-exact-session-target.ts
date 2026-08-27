import type { AwaitWithinBoundary } from '../cdp-client.js';
import type { ToolErrorCode, HermesTarget } from '../types.js';
import type { WorkerAuthorityStatus } from './runtime.js';
import { targetMatchesSession } from './session-target.js';

const TARGET_POLL_INTERVAL_MS = 250;

interface ExactDeviceTargetInput {
  platform: 'ios' | 'android';
  deviceId: string;
  targets: readonly HermesTarget[];
}

export interface ExactSessionTargetWaitDependencies {
  readAuthority(): WorkerAuthorityStatus;
  listTargetsExact(port: number): Promise<{ port: number; targets: HermesTarget[] }>;
  filterTargetsForExactDevice(
    input: ExactDeviceTargetInput,
    awaitWithinBoundary: AwaitWithinBoundary,
  ): Promise<HermesTarget[]>;
  now?(): number;
  wait?(ms: number): Promise<void>;
  setDeadlineTimer?(callback: () => void, ms: number): unknown;
  clearDeadlineTimer?(timer: unknown): void;
}

export interface ExactSessionTargetWaitObservation {
  advertisedTargetCount: number;
  sessionTargetCount: number;
  exactTargetCount: number;
}

export type ExactSessionTargetWaitResult =
  | {
      outcome: 'ready';
      requestedMs: number;
      elapsedMs: number;
      probes: number;
      lastObservation: ExactSessionTargetWaitObservation;
      authority: Extract<WorkerAuthorityStatus, { available: true }>;
    }
  | {
      outcome: 'timeout';
      requestedMs: number;
      elapsedMs: number;
      probes: number;
      lastObservation: ExactSessionTargetWaitObservation | null;
    }
  | {
      outcome: 'refused';
      requestedMs: number;
      elapsedMs: number;
      probes: number;
      code: ToolErrorCode;
      reason: string;
      lastObservation: ExactSessionTargetWaitObservation | null;
    };

class TargetWaitDeadlineError extends Error {}

function authorityRefusal(
  status: WorkerAuthorityStatus,
): { code: ToolErrorCode; reason: string } | null {
  if (!status.available) {
    return {
      code: status.code as ToolErrorCode,
      reason:
        'Waiting for a Hermes target requires an available authority session; inspect rn_session status.',
    };
  }
  if (status.state === 'blocked' || status.state === 'handoff_cleanup') {
    return {
      code: 'SESSION_AUTHORITY_REQUIRED',
      reason: 'The current worker does not own this worktree; inspect rn_session status.',
    };
  }
  const terminal = status.bindings.metroTerminal as
    | { code?: unknown; reason?: unknown }
    | undefined;
  if (terminal) {
    return {
      code: 'METRO_AUTHORITY_MISMATCH',
      reason:
        typeof terminal.reason === 'string'
          ? terminal.reason
          : 'The authority-bound Metro is no longer live.',
    };
  }
  const device = status.bindings.device as
    | { platform?: unknown; deviceId?: unknown; appId?: unknown }
    | undefined;
  if (
    !device ||
    (device.platform !== 'ios' && device.platform !== 'android') ||
    typeof device.deviceId !== 'string' ||
    typeof device.appId !== 'string'
  ) {
    return {
      code: 'CDP_TARGET_AUTHORITY_MISMATCH',
      reason: 'Waiting for a Hermes target requires an exact session device and app binding.',
    };
  }
  return null;
}

function targetBinding(status: Extract<WorkerAuthorityStatus, { available: true }>) {
  const device = status.bindings.device as {
    platform: 'ios' | 'android';
    deviceId: string;
    appId: string;
  };
  const metro = status.bindings.metro as { port?: unknown; mode?: unknown } | undefined;
  const port = metro?.port;
  if (!Number.isSafeInteger(port) || (metro?.mode !== 'managed' && metro?.mode !== 'external')) {
    return null;
  }
  return {
    sessionId: status.sessionId,
    claimEpoch: status.claimEpoch,
    authorityVersion: status.authorityVersion,
    platform: device.platform,
    deviceId: device.deviceId,
    appId: device.appId,
    metroMode: metro.mode,
    metroPort: Number(port),
  };
}

function sameTargetBinding(
  left: NonNullable<ReturnType<typeof targetBinding>>,
  right: NonNullable<ReturnType<typeof targetBinding>>,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.claimEpoch === right.claimEpoch &&
    left.authorityVersion === right.authorityVersion &&
    left.platform === right.platform &&
    left.deviceId === right.deviceId &&
    left.appId === right.appId &&
    left.metroMode === right.metroMode &&
    left.metroPort === right.metroPort
  );
}

export async function waitForExactSessionTarget(
  timeoutMs: number,
  dependencies: ExactSessionTargetWaitDependencies,
): Promise<ExactSessionTargetWaitResult> {
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setDeadlineTimer =
    dependencies.setDeadlineTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearDeadlineTimer =
    dependencies.clearDeadlineTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let probes = 0;
  let lastObservation: ExactSessionTargetWaitObservation | null = null;

  const elapsedMs = () => Math.max(0, Math.min(timeoutMs, now() - startedAt));
  const timeoutResult = (): ExactSessionTargetWaitResult => ({
    outcome: 'timeout',
    requestedMs: timeoutMs,
    elapsedMs: elapsedMs(),
    probes,
    lastObservation,
  });
  const awaitWithinDeadline: AwaitWithinBoundary = async <T>(operation: () => Promise<T>) => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) throw new TargetWaitDeadlineError();
    let timer: unknown;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setDeadlineTimer(() => reject(new TargetWaitDeadlineError()), remainingMs);
        }),
      ]);
      if (now() >= deadline) throw new TargetWaitDeadlineError();
      return result;
    } finally {
      if (timer !== undefined) clearDeadlineTimer(timer);
    }
  };

  while (now() < deadline) {
    const authority = dependencies.readAuthority();
    const refusal = authorityRefusal(authority);
    if (refusal) {
      return {
        outcome: 'refused',
        requestedMs: timeoutMs,
        elapsedMs: elapsedMs(),
        probes,
        ...refusal,
        lastObservation,
      };
    }
    if (!authority.available) throw new Error('unreachable');
    const binding = targetBinding(authority);
    if (!binding) {
      if (!authority.bindings.pendingBuild) {
        return {
          outcome: 'refused',
          requestedMs: timeoutMs,
          elapsedMs: elapsedMs(),
          probes,
          code: 'METRO_AUTHORITY_MISMATCH',
          reason: 'Waiting for a Hermes target requires a live authority-bound Metro.',
          lastObservation,
        };
      }
    } else {
      let exactDeviceProbeStarted = false;
      try {
        const listed = await awaitWithinDeadline(() =>
          dependencies.listTargetsExact(binding.metroPort),
        );
        probes += 1;
        if (listed.port !== binding.metroPort) {
          return {
            outcome: 'refused',
            requestedMs: timeoutMs,
            elapsedMs: elapsedMs(),
            probes,
            code: 'CDP_TARGET_AUTHORITY_MISMATCH',
            reason: 'Target discovery escaped the authority-bound Metro port.',
            lastObservation,
          };
        }
        const sessionTargets = listed.targets.filter((target) =>
          targetMatchesSession(target, {
            platform: binding.platform,
            bundleId: binding.appId,
          }),
        );
        let exactTargets: HermesTarget[] = [];
        if (sessionTargets.length > 0) {
          exactDeviceProbeStarted = true;
          exactTargets = await awaitWithinDeadline(() =>
            dependencies.filterTargetsForExactDevice(
              {
                platform: binding.platform,
                deviceId: binding.deviceId,
                targets: sessionTargets,
              },
              awaitWithinDeadline,
            ),
          );
        }
        lastObservation = {
          advertisedTargetCount: listed.targets.length,
          sessionTargetCount: sessionTargets.length,
          exactTargetCount: exactTargets.length,
        };
        const refreshedAuthority = dependencies.readAuthority();
        const refreshedRefusal = authorityRefusal(refreshedAuthority);
        if (refreshedRefusal) {
          return {
            outcome: 'refused',
            requestedMs: timeoutMs,
            elapsedMs: elapsedMs(),
            probes,
            ...refreshedRefusal,
            lastObservation: null,
          };
        }
        if (!refreshedAuthority.available) throw new Error('unreachable');
        const refreshedBinding = targetBinding(refreshedAuthority);
        if (!refreshedBinding || !sameTargetBinding(binding, refreshedBinding)) {
          lastObservation = null;
        } else if (exactTargets.length === 1) {
          return {
            outcome: 'ready',
            requestedMs: timeoutMs,
            elapsedMs: elapsedMs(),
            probes,
            lastObservation,
            authority: refreshedAuthority,
          };
        } else if (exactTargets.length > 1) {
          return {
            outcome: 'refused',
            requestedMs: timeoutMs,
            elapsedMs: elapsedMs(),
            probes,
            code: 'CDP_TARGET_AUTHORITY_MISMATCH',
            reason: 'More than one target matches the exact session device.',
            lastObservation,
          };
        }
      } catch (error) {
        if (error instanceof TargetWaitDeadlineError) return timeoutResult();
        if (exactDeviceProbeStarted) {
          return {
            outcome: 'refused',
            requestedMs: timeoutMs,
            elapsedMs: elapsedMs(),
            probes,
            code: 'CDP_TARGET_AUTHORITY_MISMATCH',
            reason:
              'The advertised Hermes target cannot be associated with the exact session device.',
            lastObservation,
          };
        }
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return timeoutResult();
    try {
      await awaitWithinDeadline(() => wait(Math.min(TARGET_POLL_INTERVAL_MS, remainingMs)));
    } catch (error) {
      if (error instanceof TargetWaitDeadlineError) return timeoutResult();
      throw error;
    }
  }

  return timeoutResult();
}
