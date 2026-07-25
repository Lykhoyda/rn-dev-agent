import { probeManagedMetroListener } from './managed-metro.js';
import { probeProcessBirth } from './process-birth.js';
import { SessionAuthorityError } from './registry.js';
async function waitForExactStopped(probe, timeoutMs, code, message) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const status = probe();
        if (status === 'stopped')
            return;
        if (status === 'unknown') {
            throw new SessionAuthorityError(code, `${message}; shutdown identity is unknown`);
        }
        if (Date.now() >= deadline) {
            throw new SessionAuthorityError(code, message);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
export async function stopBoundObserve(binding, listenerProbe = probeManagedMetroListener, processProbe = probeProcessBirth, timeoutMs = 2_000) {
    const port = Number(binding.port);
    const pid = Number(binding.pid);
    const expectedBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.cleanupCapability ?? '');
    if (!Number.isSafeInteger(port) ||
        !Number.isSafeInteger(pid) ||
        !expectedBirth ||
        !instanceId ||
        !capability) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup authority is incomplete');
    }
    const currentListener = listenerProbe(port);
    if (currentListener.status === 'unknown') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener lookup is inconclusive');
    }
    if (currentListener.status === 'absent' || currentListener.pid !== pid)
        return;
    const currentBirth = processProbe(pid);
    if (currentBirth.status === 'unknown') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe process identity is unavailable');
    }
    if (currentBirth.status === 'absent') {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener identity is internally inconsistent');
    }
    if (currentBirth.birth.token !== expectedBirth) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe listener PID was reused before cleanup completed');
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/stop`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${capability}`,
            'x-rn-observe-instance': instanceId,
        },
    });
    if (!response.ok) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe server refused fenced cleanup');
    }
    await waitForExactStopped(() => {
        const observed = listenerProbe(port);
        if (observed.status === 'unknown')
            return 'unknown';
        return observed.status === 'listening' && observed.pid === pid ? 'running' : 'stopped';
    }, timeoutMs, 'OBSERVE_AUTHORITY_MISMATCH', 'Observe listener did not stop before the cleanup deadline');
}
export async function stopBoundRunner(binding, processProbe = probeProcessBirth, signalProcess = process.kill, timeoutMs = 2_000) {
    const pid = Number(binding.pid);
    const expectedBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.capability ?? '');
    if (!Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'runner cleanup identity is incomplete');
    }
    const current = processProbe(pid);
    if (current.status === 'unknown') {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'runner process identity is unavailable');
    }
    if (current.status === 'absent' || current.birth.token !== expectedBirth)
        return;
    signalProcess(pid, 'SIGTERM');
    await waitForExactStopped(() => {
        const observed = processProbe(pid);
        if (observed.status === 'unknown')
            return 'unknown';
        return observed.status === 'present' && observed.birth.token === expectedBirth
            ? 'running'
            : 'stopped';
    }, timeoutMs, 'RUNNER_ADOPTION_REQUIRED', 'runner process did not stop before the cleanup deadline');
}
