import { execFileSync } from 'node:child_process';
function execute(dependencies, file, args) {
    if (dependencies.execute)
        return dependencies.execute(file, args);
    return execFileSync(file, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
    });
}
function endpoint(port) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('PHYSICAL_ANDROID_METRO_UNREACHABLE: authority-bound Metro port is invalid');
    }
    return `tcp:${port}`;
}
function adb(deviceId, args, dependencies) {
    try {
        return execute(dependencies, 'adb', ['-s', deviceId, ...args]);
    }
    catch (error) {
        throw new Error(`PHYSICAL_ANDROID_METRO_UNREACHABLE: adb could not configure Metro reachability on exact device ${deviceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function isPhysicalAndroid(deviceId, dependencies) {
    if (/^emulator-\d+$/.test(deviceId))
        return false;
    return adb(deviceId, ['shell', 'getprop', 'ro.kernel.qemu'], dependencies).trim() !== '1';
}
function listReverseForwards(deviceId, dependencies) {
    return adb(deviceId, ['reverse', '--list'], dependencies)
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map((parts) => ({
        local: parts[parts.length - 2],
        remote: parts[parts.length - 1],
    }))
        .filter((forward) => forward.local.startsWith('tcp:') && forward.remote.startsWith('tcp:'));
}
function assertBindingMatches(binding, deviceId, metroPort) {
    const exact = endpoint(metroPort);
    if (binding.platform !== 'android' ||
        binding.deviceId !== deviceId ||
        binding.metroPort !== metroPort ||
        binding.local !== exact ||
        binding.remote !== exact) {
        throw new Error('PHYSICAL_ANDROID_METRO_UNREACHABLE: retained adb reverse authority does not match the exact device and Metro port');
    }
}
function removeExactForwardAfterFailedSetup(deviceId, exact, dependencies) {
    const current = listReverseForwards(deviceId, dependencies).filter((forward) => forward.local === exact);
    if (current.length === 1 && current[0].remote === exact) {
        adb(deviceId, ['reverse', '--remove', exact], dependencies);
    }
}
export function ensureAndroidMetroReverse(input, dependencies = {}) {
    const exact = endpoint(input.metroPort);
    if (!isPhysicalAndroid(input.deviceId, dependencies)) {
        if (input.binding) {
            throw new Error('PHYSICAL_ANDROID_METRO_UNREACHABLE: emulator authority cannot retain a physical-device adb reverse binding');
        }
        return { binding: null, created: false, physical: false };
    }
    if (input.binding)
        assertBindingMatches(input.binding, input.deviceId, input.metroPort);
    const matchingLocal = listReverseForwards(input.deviceId, dependencies).filter((forward) => forward.local === exact);
    if (matchingLocal.length > 0) {
        if (input.binding && matchingLocal.length === 1 && matchingLocal[0].remote === exact) {
            return { binding: input.binding, created: false, physical: true };
        }
        throw new Error(`PHYSICAL_ANDROID_METRO_UNREACHABLE: exact device ${input.deviceId} already has a foreign adb reverse for ${exact}; refusing to replace or adopt it`);
    }
    let created = false;
    try {
        adb(input.deviceId, ['reverse', exact, exact], dependencies);
        created = true;
        const verified = listReverseForwards(input.deviceId, dependencies).filter((forward) => forward.local === exact);
        if (verified.length !== 1 || verified[0].remote !== exact) {
            throw new Error(`PHYSICAL_ANDROID_METRO_UNREACHABLE: adb did not verify ${exact} -> ${exact} on exact device ${input.deviceId}`);
        }
        return {
            binding: {
                platform: 'android',
                deviceId: input.deviceId,
                metroPort: input.metroPort,
                local: exact,
                remote: exact,
            },
            created: true,
            physical: true,
        };
    }
    catch (error) {
        if (!created)
            throw error;
        try {
            removeExactForwardAfterFailedSetup(input.deviceId, exact, dependencies);
        }
        catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: failed setup left exact adb reverse cleanup unresolved');
        }
        throw error;
    }
}
export function removeAndroidMetroReverse(binding, dependencies = {}) {
    assertBindingMatches(binding, binding.deviceId, binding.metroPort);
    const matchingLocal = listReverseForwards(binding.deviceId, dependencies).filter((forward) => forward.local === binding.local);
    if (matchingLocal.length === 0)
        return;
    if (matchingLocal.length !== 1 || matchingLocal[0].remote !== binding.remote) {
        throw new Error(`PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: ${binding.local} on exact device ${binding.deviceId} changed to a foreign forward; refusing to remove it`);
    }
    adb(binding.deviceId, ['reverse', '--remove', binding.local], dependencies);
    if (listReverseForwards(binding.deviceId, dependencies).some((forward) => forward.local === binding.local)) {
        throw new Error(`PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: session-owned ${binding.local} remains on exact device ${binding.deviceId}`);
    }
}
