import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * GH#201: true when the flow clears app state. Two Maestro forms both uninstall
 * (and so need `--app-file` to reinstall on maestro-runner):
 *   - `launchApp: { clearState: true }`
 *   - the standalone `- clearState` command (in the validator allowlist)
 */
export function flowUsesClearState(flowText: string): boolean {
  return /clearState:\s*true\b/.test(flowText)
    || /^[ \t]*-[ \t]*clearState[ \t]*$/m.test(flowText);
}

export interface ResolveAppFileDeps {
  /** Returns the installed `.app` container path for a bundle id, or null. */
  getAppContainer?: (bundleId: string) => string | null;
  /** Returns the newest built `.app` under DerivedData, or null. */
  newestDerivedDataApp?: () => string | null;
  /** Existence check (injectable for tests). */
  exists?: (path: string) => boolean;
}

/**
 * GH#201: locate a built `.app` to pass to `maestro-runner --app-file` so an
 * iOS `clearState` flow can reinstall after uninstall. Tries the simulator's
 * installed container first (cheapest, always current), then the newest
 * DerivedData product. Returns null when neither resolves.
 */
export function resolveIosAppFile(bundleId: string, deps: ResolveAppFileDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
  const fromContainer = getAppContainer(bundleId);
  if (fromContainer && exists(fromContainer)) return fromContainer;
  const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
  if (fromDerived && exists(fromDerived)) return fromDerived;
  return null;
}

export type AppFileResolution =
  | { ok: true; appFile?: string }
  | { ok: false; error: string };

/**
 * GH#201: decide the `--app-file` value for a single flow. Returns the explicit
 * override untouched; otherwise only an iOS `clearState` flow needs one (so it
 * can reinstall after uninstall). Shared by maestro_run, maestro_test_all, and
 * runMaestroInline so all three reinstall on clearState — previously only
 * maestro_run resolved the app file, leaving the other two to hit the exact
 * uninstall-without-reinstall failure #201 fixed.
 */
export function resolveAppFileForClearState(
  platform: 'ios' | 'android',
  flowText: string,
  headerAppId: string | undefined,
  explicitAppFile?: string,
  deps?: ResolveAppFileDeps,
): AppFileResolution {
  if (explicitAppFile) return { ok: true, appFile: explicitAppFile };
  if (platform !== 'ios' || !flowUsesClearState(flowText)) return { ok: true };
  if (!headerAppId) {
    return {
      ok: false,
      error:
        'Flow uses clearState on iOS but no appId is known to locate the .app. ' +
        'Add `appId:` to the flow header or pass appFile=<path-to-.app>.',
    };
  }
  const appFile = resolveIosAppFile(headerAppId, deps) ?? undefined;
  if (!appFile) {
    return {
      ok: false,
      error:
        `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. ` +
        'Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).',
    };
  }
  return { ok: true, appFile };
}

function defaultGetAppContainer(bundleId: string): string | null {
  try {
    const out = execFileSync(
      'xcrun',
      ['simctl', 'get_app_container', 'booted', bundleId, 'app'],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}
