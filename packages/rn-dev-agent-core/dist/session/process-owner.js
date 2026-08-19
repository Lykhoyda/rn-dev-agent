import { probeProcessBirth } from './process-birth.js';
function defaultProcessState(pid) {
    try {
        process.kill(pid, 0);
        return 'alive';
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return 'dead';
        if (code === 'EPERM')
            return 'alive';
        return 'unknown';
    }
}
export function inspectSessionOwner(owner, dependencies = {}) {
    const state = (dependencies.processState ?? defaultProcessState)(owner.pid);
    if (state === 'dead')
        return 'mismatch';
    if (state === 'unknown')
        return 'unknown';
    const observed = (dependencies.probeBirth ?? probeProcessBirth)(owner.pid);
    // GH #792: an absent recorded process disproves ownership; only an unreadable identity
    // stays unknown, and an unknown owner is still treated as live.
    if (observed.status === 'absent')
        return 'mismatch';
    if (observed.status === 'unknown')
        return 'unknown';
    return observed.birth.token === owner.token ? 'match' : 'mismatch';
}
