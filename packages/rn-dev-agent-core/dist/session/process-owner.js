import { readProcessBirth } from './process-birth.js';
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
    const observed = (dependencies.readBirth ?? readProcessBirth)(owner.pid);
    if (!observed)
        return 'unknown';
    return observed.token === owner.token ? 'match' : 'mismatch';
}
