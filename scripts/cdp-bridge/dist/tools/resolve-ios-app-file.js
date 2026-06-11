import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
/**
 * GH#201: true when the flow clears app state. Two Maestro forms both uninstall
 * (and so need `--app-file` to reinstall on maestro-runner):
 *   - `launchApp: { clearState: true }`
 *   - the standalone `- clearState` command (in the validator allowlist)
 */
export function flowUsesClearState(flowText) {
    return /clearState:\s*true\b/.test(flowText)
        || /^[ \t]*-[ \t]*clearState[ \t]*$/m.test(flowText);
}
/** GH#186 live-gate finding: clearState UNINSTALLS the app, deleting the very
 * container `--app-file` pointed into — the reinstall then read a deleted
 * path. Snapshot the bundle outside the container (APFS clonefile via cp -c
 * fallback to plain copy) so it survives the uninstall. */
function defaultSnapshotApp(appPath) {
    try {
        // Fixed per-app destination, replaced each resolve — an mkdtemp per
        // clearState flow would accumulate full .app copies in $TMPDIR until OS
        // reaping (PR #276 review). Concurrent same-app flows can't race: the
        // arbiter makes the flow plane exclusive.
        const destDir = join(tmpdir(), 'rn-appfile-snapshots');
        const dest = join(destDir, basename(appPath));
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(destDir, { recursive: true });
        try {
            execFileSync('cp', ['-Rc', appPath, dest], { timeout: 30_000, stdio: 'ignore' });
        }
        catch {
            cpSync(appPath, dest, { recursive: true });
        }
        return dest;
    }
    catch {
        return null;
    }
}
/**
 * GH#201: locate a built `.app` to pass to `maestro-runner --app-file` so an
 * iOS `clearState` flow can reinstall after uninstall. The installed container
 * is the most current source, but its path dies with the uninstall — so it is
 * snapshotted out first. Falls back to the newest DerivedData product.
 */
export function resolveIosAppFile(bundleId, deps = {}) {
    const exists = deps.exists ?? existsSync;
    const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
    const snapshotApp = deps.snapshotApp ?? defaultSnapshotApp;
    const fromContainer = getAppContainer(bundleId);
    if (fromContainer && exists(fromContainer)) {
        const snapshot = snapshotApp(fromContainer);
        if (snapshot)
            return snapshot;
    }
    const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
    if (fromDerived && exists(fromDerived))
        return fromDerived;
    return null;
}
/**
 * GH#201: decide the `--app-file` value for a single flow. Returns the explicit
 * override untouched; otherwise only an iOS `clearState` flow needs one (so it
 * can reinstall after uninstall). Shared by maestro_run, maestro_test_all, and
 * runMaestroInline so all three reinstall on clearState — previously only
 * maestro_run resolved the app file, leaving the other two to hit the exact
 * uninstall-without-reinstall failure #201 fixed.
 */
export function resolveAppFileForClearState(platform, flowText, headerAppId, explicitAppFile, deps) {
    if (explicitAppFile)
        return { ok: true, appFile: explicitAppFile };
    if (platform !== 'ios' || !flowUsesClearState(flowText))
        return { ok: true };
    if (!headerAppId) {
        return {
            ok: false,
            error: 'Flow uses clearState on iOS but no appId is known to locate the .app. ' +
                'Add `appId:` to the flow header or pass appFile=<path-to-.app>.',
        };
    }
    const appFile = resolveIosAppFile(headerAppId, deps) ?? undefined;
    if (!appFile) {
        return {
            ok: false,
            error: `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. ` +
                'Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).',
        };
    }
    return { ok: true, appFile };
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
