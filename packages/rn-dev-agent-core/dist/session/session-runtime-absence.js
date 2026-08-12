import { targetMatchesSession } from '../tools/status.js';
import { buildAndroidPidofArgs, buildIosAppRunningArgs } from '../tools/device-session.js';
// GH #750: a single sample cannot tell a terminated app from one that is still
// coming up after a clearState relaunch, so absence must hold across the gap.
export const SESSION_RUNTIME_ABSENCE_RESAMPLE_MS = 1_500;
const IOS_APP_PROBE_TIMEOUT_MS = 5_000;
const ANDROID_APP_PROBE_TIMEOUT_MS = 3_000;
class InconclusiveRuntimeProbeError extends Error {
}
function stdoutText(output) {
    return typeof output.stdout === 'string' ? output.stdout : output.stdout.toString('utf8');
}
async function isSessionAppRunning(binding, dependencies) {
    if (binding.platform === 'ios') {
        const output = await dependencies.execute('xcrun', buildIosAppRunningArgs(binding.deviceId), {
            timeout: IOS_APP_PROBE_TIMEOUT_MS,
        });
        return stdoutText(output).includes(`UIKitApplication:${binding.appId}`);
    }
    try {
        const output = await dependencies.execute('adb', buildAndroidPidofArgs(binding.appId, binding.deviceId), { timeout: ANDROID_APP_PROBE_TIMEOUT_MS });
        return stdoutText(output).trim().length > 0;
    }
    catch (error) {
        // `pidof` exits 1 with no output when the package holds no process; every
        // other failure means the probe itself could not answer.
        const failure = error;
        if (failure.code === 1 && failure.killed !== true)
            return false;
        throw error;
    }
}
async function observeSessionRuntimeAbsent(dependencies) {
    const binding = dependencies.resolveBinding();
    if (!binding)
        throw new InconclusiveRuntimeProbeError('session runtime binding is unresolved');
    const listed = await dependencies.listTargets(binding.metroPort);
    if (listed.port !== binding.metroPort) {
        throw new InconclusiveRuntimeProbeError('target discovery escaped the bound Metro port');
    }
    const advertised = listed.targets.some((candidate) => targetMatchesSession(candidate, { platform: binding.platform, bundleId: binding.appId }));
    if (advertised)
        return false;
    return !(await isSessionAppRunning(binding, dependencies));
}
/**
 * GH #750: reports absence only when two consecutive observations agree that the
 * bound Metro advertises no session target and the app holds no process. Every
 * inconclusive answer — an unresolved binding, a failed or timed-out device
 * probe, a target reappearing between samples — reports "present".
 */
export function createSessionRuntimeAbsenceProbe(dependencies) {
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    return async () => {
        try {
            if (!(await observeSessionRuntimeAbsent(dependencies)))
                return false;
            await wait(SESSION_RUNTIME_ABSENCE_RESAMPLE_MS);
            return await observeSessionRuntimeAbsent(dependencies);
        }
        catch {
            return false;
        }
    };
}
