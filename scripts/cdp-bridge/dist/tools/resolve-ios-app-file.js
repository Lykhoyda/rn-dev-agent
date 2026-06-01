import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
/** GH#201: true when the flow text contains a `clearState: true` directive. */
export function flowUsesClearState(flowText) {
    return /clearState:\s*true\b/.test(flowText);
}
/**
 * GH#201: locate a built `.app` to pass to `maestro-runner --app-file` so an
 * iOS `clearState` flow can reinstall after uninstall. Tries the simulator's
 * installed container first (cheapest, always current), then the newest
 * DerivedData product. Returns null when neither resolves.
 */
export function resolveIosAppFile(bundleId, deps = {}) {
    const exists = deps.exists ?? existsSync;
    const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
    const fromContainer = getAppContainer(bundleId);
    if (fromContainer && exists(fromContainer))
        return fromContainer;
    const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
    if (fromDerived && exists(fromDerived))
        return fromDerived;
    return null;
}
function defaultGetAppContainer(bundleId) {
    try {
        const out = execFileSync('xcrun', ['simctl', 'get_app_container', 'booted', bundleId, 'app'], { encoding: 'utf8', timeout: 5_000 }).trim();
        return out || null;
    }
    catch {
        return null;
    }
}
