export function hasCompleteRunnerCleanupIdentity(binding) {
    const pid = Number(binding.pid);
    const processBirth = String(binding.processBirth ?? '');
    const instanceId = String(binding.instanceId ?? '');
    const capability = String(binding.capability ?? '');
    if (!Number.isSafeInteger(pid) || !processBirth || !instanceId || !capability)
        return false;
    if (String(binding.platform ?? '') !== 'android')
        return true;
    return Boolean(String(binding.deviceId ?? '')) && Number.isSafeInteger(Number(binding.port));
}
export function hasCompleteRecorderCleanupIdentity(binding) {
    const script = String(binding.script ?? '');
    const scope = String(binding.scope ?? '');
    if (!script || !/^[a-f0-9]{64}$/.test(scope))
        return false;
    if (binding.phase === 'starting')
        return true;
    return Number.isSafeInteger(Number(binding.pid)) && Boolean(String(binding.processBirth ?? ''));
}
