import { getMaestroRunnerPath, MAESTRO_RUNNER_PIN, PINNED_RUNNER_INSTALL_HINT, } from '../domain/engine-pin.js';
export function _resetMaestroDispatchCache() {
    warnedFallbackReasons.clear();
}
const warnedFallbackReasons = new Set();
export function shouldWarnFallback(reason) {
    if (warnedFallbackReasons.has(reason))
        return false;
    warnedFallbackReasons.add(reason);
    return true;
}
export function flowContainsHideKeyboard(commands) {
    return commands.some((c) => c === 'hideKeyboard' ||
        (typeof c === 'object' && c !== null && 'hideKeyboard' in c));
}
export function chooseMaestroDispatch(inputs) {
    const runnerPath = (inputs.maestroRunnerPath ?? getMaestroRunnerPath)();
    if (runnerPath) {
        return {
            runner: 'maestro-runner',
            binPath: runnerPath,
            buildArgs: (platform, flowFile, appFile, deviceId) => [
                ...(appFile ? ['--app-file', appFile] : []),
                '--platform',
                platform,
                ...(deviceId ? ['--device', deviceId] : []),
                'test',
                flowFile,
            ],
        };
    }
    return {
        error: `Session maestro-runner ${MAESTRO_RUNNER_PIN.version} is not installed in the pin-cache. ` +
            `Install exactly ${MAESTRO_RUNNER_PIN.version} via ${PINNED_RUNNER_INSTALL_HINT}. ` +
            `Ambient PATH maestro-runner, ~/.maestro-runner, and brew maestro are never used.`,
        hint: `run ensure-maestro-runner.sh for exactly ${MAESTRO_RUNNER_PIN.version}`,
    };
}
