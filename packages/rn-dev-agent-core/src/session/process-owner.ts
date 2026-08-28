import {
  probeProcessBirth,
  type ProcessBirth,
  type ProcessBirthProbe,
  type ProcessBirthProbeCause,
} from './process-birth.js';
import {
  SessionAuthorityError,
  type OwnerStatus,
  type SessionAuthorityErrorDetails,
  type SessionOwner,
} from './registry.js';

type ProcessState = 'alive' | 'dead' | 'unknown';

interface ProcessOwnerDependencies {
  processState?: (pid: number) => ProcessState;
  probeBirth?: (pid: number) => ProcessBirthProbe;
  now?: () => number;
}

export type ProcessOwnerInspection =
  | { status: 'match'; pid: number }
  | { status: 'mismatch'; pid: number; expected: string; observed: string }
  | { status: 'absent'; pid: number }
  | { status: 'unknown'; pid: number; cause: ProcessBirthProbeCause };

export const PROCESS_ATTESTATION_UNAVAILABLE_NEXT_ACTION =
  'Process identity could not be read in time on a loaded host. Reduce host process contention, then retry the original operation; do not reopen or rebind the device.';

function defaultProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

export function inspectSessionOwner(
  owner: SessionOwner,
  dependencies: ProcessOwnerDependencies = {},
): OwnerStatus {
  const inspection = inspectSessionOwnerAttestation(owner, dependencies);
  return inspection.status === 'match'
    ? 'match'
    : inspection.status === 'unknown'
      ? 'unknown'
      : 'mismatch';
}

export function inspectSessionOwnerAttestation(
  owner: SessionOwner,
  dependencies: ProcessOwnerDependencies = {},
): ProcessOwnerInspection {
  const now = dependencies.now ?? Date.now;
  const stateStartedAt = now();
  const state = (dependencies.processState ?? defaultProcessState)(owner.pid);
  if (state === 'dead') return { status: 'absent', pid: owner.pid };
  if (state === 'unknown') {
    return {
      status: 'unknown',
      pid: owner.pid,
      cause: {
        pid: owner.pid,
        step: 'signal',
        failure: 'read',
        elapsedMs: Math.max(0, now() - stateStartedAt),
      },
    };
  }
  const observed = (dependencies.probeBirth ?? probeProcessBirth)(owner.pid);
  if (observed.status === 'absent') return { status: 'absent', pid: owner.pid };
  if (observed.status === 'unknown') {
    return { status: 'unknown', pid: owner.pid, cause: observed.cause };
  }
  return observed.birth.token === owner.token
    ? { status: 'match', pid: owner.pid }
    : {
        status: 'mismatch',
        pid: owner.pid,
        expected: owner.token,
        observed: observed.birth.token,
      };
}

export function ownerRefusalDetails(
  inspection: Exclude<ProcessOwnerInspection, { status: 'match' }>,
): SessionAuthorityErrorDetails {
  if (inspection.status === 'unknown') {
    return {
      attestation: 'unavailable',
      ...inspection.cause,
      nextAction: PROCESS_ATTESTATION_UNAVAILABLE_NEXT_ACTION,
    };
  }
  if (inspection.status === 'absent') {
    return { attestation: 'absent', pid: inspection.pid };
  }
  return {
    attestation: 'mismatch',
    pid: inspection.pid,
    expected: inspection.expected,
    observed: inspection.observed,
  };
}

export function processBirthRefusalDetails(
  probe: Exclude<ProcessBirthProbe, { status: 'present' }>,
  pid: number,
): SessionAuthorityErrorDetails {
  return probe.status === 'unknown'
    ? {
        attestation: 'unavailable',
        ...probe.cause,
        nextAction: PROCESS_ATTESTATION_UNAVAILABLE_NEXT_ACTION,
      }
    : { attestation: 'absent', pid };
}

export function requireProcessBirthAttestation(
  pid: number,
  subject: string,
  probeBirth: (pid: number) => ProcessBirthProbe = probeProcessBirth,
): ProcessBirth {
  const probe = probeBirth(pid);
  if (probe.status === 'present') return probe.birth;
  const unavailable = probe.status === 'unknown';
  throw new SessionAuthorityError(
    'PROCESS_BIRTH_UNAVAILABLE',
    unavailable
      ? `${subject} process identity could not be read on a loaded host`
      : `${subject} process is absent`,
    undefined,
    processBirthRefusalDetails(probe, pid),
  );
}

export function processBirthProbeFromReader(
  pid: number,
  readBirth: (pid: number) => ProcessBirth | null,
): ProcessBirthProbe {
  const birth = readBirth(pid);
  return birth
    ? { status: 'present', birth }
    : {
        status: 'unknown',
        cause: { pid, step: 'platform', failure: 'read', elapsedMs: 0 },
      };
}
