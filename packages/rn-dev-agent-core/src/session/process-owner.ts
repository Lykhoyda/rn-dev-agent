import { readProcessBirth, type ProcessBirth } from './process-birth.js';
import type { OwnerStatus, SessionOwner } from './registry.js';

type ProcessState = 'alive' | 'dead' | 'unknown';

interface ProcessOwnerDependencies {
  processState?: (pid: number) => ProcessState;
  readBirth?: (pid: number) => ProcessBirth | null;
}

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
  const state = (dependencies.processState ?? defaultProcessState)(owner.pid);
  if (state === 'dead') return 'mismatch';
  if (state === 'unknown') return 'unknown';
  const observed = (dependencies.readBirth ?? readProcessBirth)(owner.pid);
  if (!observed) return 'unknown';
  return observed.token === owner.token ? 'match' : 'mismatch';
}
