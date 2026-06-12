import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
// Insurance caps: the lookup rides on an already-failed recovery path and
// must stay bounded — per-read timeouts are clamped to the remaining
// deadline so one slow plutil cannot blow the total budget.
const SNAPSHOT_SCAN_CAP = 10;
const SNAPSHOT_SCAN_BUDGET_MS = 3000;
const PLUTIL_TIMEOUT_MS = 2000;
function defaultListSnapshots() {
    const dir = join(tmpdir(), 'rn-appfile-snapshots');
    try {
        return readdirSync(dir)
            .filter((name) => name.endsWith('.app'))
            .map((name) => join(dir, name));
    }
    catch {
        return [];
    }
}
function defaultReadBundleId(appPath, timeoutMs) {
    try {
        const out = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Info.plist')], { timeout: timeoutMs, encoding: 'utf8' });
        return out.trim() || null;
    }
    catch {
        return null;
    }
}
function defaultMtimeMs(appPath) {
    try {
        return statSync(appPath).mtimeMs;
    }
    catch {
        return null;
    }
}
/**
 * GH #262: find a reinstallable .app snapshot for a bundle id in the GH #201
 * snapshot dir. Stat pass → newest-first sort → cap (readdir order is
 * arbitrary; capping first could drop the newest match), so plutil only runs
 * on the newest candidates and the first match is the newest. Bounded and
 * best-effort: any error or budget overrun returns null — the hint never
 * fails the report it rides on.
 */
export function findSnapshotForBundleId(bundleId, deps = {}) {
    const listSnapshots = deps.listSnapshots ?? defaultListSnapshots;
    const readBundleId = deps.readBundleId ?? defaultReadBundleId;
    const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
    const now = deps.now ?? Date.now;
    try {
        const deadline = now() + SNAPSHOT_SCAN_BUDGET_MS;
        const candidates = listSnapshots()
            .map((path) => ({ path, m: mtimeMs(path) }))
            .filter((c) => c.m !== null)
            .sort((a, b) => b.m - a.m)
            .slice(0, SNAPSHOT_SCAN_CAP);
        for (const { path, m } of candidates) {
            const remaining = deadline - now();
            if (remaining <= 0)
                return null;
            if (readBundleId(path, Math.min(PLUTIL_TIMEOUT_MS, remaining)) === bundleId) {
                return { path, mtimeMs: m };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
/** GH #262: `findSnapshotForBundleId` formatted as advice input. */
export function snapshotHintForBundleId(bundleId, deps = {}) {
    try {
        const now = deps.now ?? Date.now;
        const snap = findSnapshotForBundleId(bundleId, deps);
        if (!snap)
            return null;
        return {
            path: snap.path,
            ageMinutes: Math.max(0, Math.round((now() - snap.mtimeMs) / 60_000)),
        };
    }
    catch {
        return null;
    }
}
