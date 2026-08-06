function isPositiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function hasCompleteRunnerCleanupIdentity(binding) {
    const processBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.capability ?? '');
    if (!isPositiveSafeInteger(binding.pid) ||
        !isPositiveSafeInteger(binding.port) ||
        !processBirth ||
        !instanceId ||
        !capability) {
        return false;
    }
    if (String(binding.platform ?? '') !== 'android')
        return true;
    return Boolean(String(binding.deviceId ?? ''));
}
export function hasCompleteRecorderCleanupIdentity(binding) {
    const script = String(binding.script ?? '');
    const scope = String(binding.scope ?? '');
    if (!script || !/^[a-f0-9]{64}$/.test(scope))
        return false;
    if (binding.phase === 'starting')
        return true;
    return isPositiveSafeInteger(binding.pid) && Boolean(String(binding.processBirth ?? ''));
}
