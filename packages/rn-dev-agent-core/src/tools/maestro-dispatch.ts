// B59: tiered dispatch between maestro-runner (preferred, 3× faster) and the
// upstream Maestro CLI (slower JVM-based fallback). The reason both paths
// exist: maestro-runner v1.0.9 has an upstream bug — it requires `adb` in
// PATH even when `--platform ios` is specified. On iOS-only dev machines
// (no Android SDK installed) every maestro-runner invocation fails. The
// fallback to `maestro` CLI keeps iOS-only users productive while we wait
// for the upstream fix.
//
// Decision tree:
//   1. platform === 'android' OR adb in PATH → maestro-runner (fast path)
//   2. platform === 'ios' AND adb missing AND `maestro` in PATH → Maestro CLI
//   3. neither viable → fail with a short install hint listing both options
//
// Same shape pattern as agent-device's 3-tier dispatch (fast-runner →
// daemon → CLI) — keeps the codebase architecturally consistent.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type MaestroRunner = 'maestro-runner' | 'maestro';

export interface MaestroDispatch {
  runner: MaestroRunner;
  binPath: string;
  /**
   * Builds the argv for `execFile(binPath, argv)` to run a single flow.
   * Both runners accept `<flow.yaml>` as the last positional but their
   * platform-targeting flags differ. `appFile` (GH#201) is the path to a
   * built `.app`/`.ipa`; maestro-runner needs it to reinstall on iOS
   * `clearState`. The Maestro CLI fallback does not accept it and ignores it.
   */
  buildArgs(
    platform: 'ios' | 'android',
    flowFile: string,
    appFile?: string,
    deviceId?: string,
  ): string[];
  /**
   * Present when a non-default runner was deliberately chosen — the B59 CLI
   * fallback (iOS-only, no adb) OR the B223 CLI preference (Android flow uses
   * hideKeyboard, which maestro-runner no-ops). Surfaces in the caller's
   * warnResult so users see why the chosen path differs from the default.
   */
  fallbackReason?: string;
  /**
   * GH #356 / B223: set when an Android flow needs `hideKeyboard` but the
   * official Maestro CLI is unavailable, so we fell back to maestro-runner —
   * which silently no-ops `hideKeyboard` on Android. Surfaces a warning so the
   * user knows the keyboard will not actually be dismissed.
   */
  degradedReason?: string;
}

export interface MaestroDispatchInputs {
  platform: 'ios' | 'android';
  /**
   * GH #356 / B223: the flow contains a `hideKeyboard` step. maestro-runner
   * v1.0.9 silently no-ops `hideKeyboard` on Android (reports pass in ~5ms,
   * keyboard stays up). When set on Android, prefer the official Maestro CLI,
   * which honors `hideKeyboard`. No effect on iOS (maestro-runner honors it).
   */
  flowHasHideKeyboard?: boolean;
  /** Override for tests. Defaults to `which adb` via spawnSync. */
  whichAdb?: () => string | null;
  /** Override for tests. Defaults to `which maestro` via spawnSync. */
  whichMaestro?: () => string | null;
  /** Override for tests. Defaults to ~/.maestro-runner/bin/maestro-runner. */
  maestroRunnerPath?: () => string | null;
}

// Process-wide cache. PATH doesn't change mid-process under normal use,
// so probing `which` once per binary is enough. Tests pass injected
// resolvers, which bypass the cache (each call computes fresh).
const cache: { adb?: string | null; maestro?: string | null } = {};

function defaultWhichAdb(): string | null {
  if (cache.adb !== undefined) return cache.adb;
  const r = spawnSync('which', ['adb'], { encoding: 'utf8' });
  cache.adb = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  return cache.adb;
}

function defaultWhichMaestro(): string | null {
  if (cache.maestro !== undefined) return cache.maestro;
  const r = spawnSync('which', ['maestro'], { encoding: 'utf8' });
  cache.maestro = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  return cache.maestro;
}

function defaultMaestroRunnerPath(): string | null {
  const path = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
  return existsSync(path) ? path : null;
}

/**
 * Test-only: clear the cached `which` results. Production code never calls
 * this; tests reset between cases to avoid leakage.
 */
export function _resetMaestroDispatchCache(): void {
  delete cache.adb;
  delete cache.maestro;
  warnedFallbackReasons.clear();
}

// Per-process set of fallback reasons we've already surfaced to the user.
// Used by shouldWarnFallback() so a session running 100 flows via the
// fallback doesn't get 100 identical warnings — the first one is enough,
// subsequent successes carry the reason silently in meta. Failures still
// surface the reason because the user is already paying attention.
const warnedFallbackReasons = new Set<string>();

/**
 * Returns true on the FIRST call for a given reason in this process,
 * false on subsequent calls. Callers use this to decide whether to wrap
 * an otherwise-successful result in warnResult() (loud) or okResult()
 * with the reason in meta (quiet). Failures should warn unconditionally.
 */
export function shouldWarnFallback(reason: string): boolean {
  if (warnedFallbackReasons.has(reason)) return false;
  warnedFallbackReasons.add(reason);
  return true;
}

export interface MaestroDispatchError {
  error: string;
  hint: string;
}

/**
 * GH #356 / B223: detect whether a parsed Maestro flow contains a
 * `hideKeyboard` step. Maestro represents it as the bare string command
 * `'hideKeyboard'`; we also accept the object form `{ hideKeyboard: ... }`
 * defensively. Used to route Android hideKeyboard flows to the official
 * Maestro CLI (maestro-runner no-ops hideKeyboard on Android).
 */
export function flowContainsHideKeyboard(commands: readonly unknown[]): boolean {
  return commands.some(
    (c) =>
      c === 'hideKeyboard' ||
      (typeof c === 'object' && c !== null && 'hideKeyboard' in (c as Record<string, unknown>)),
  );
}

export function chooseMaestroDispatch(
  inputs: MaestroDispatchInputs,
): MaestroDispatch | MaestroDispatchError {
  const whichAdb = inputs.whichAdb ?? defaultWhichAdb;
  const whichMaestro = inputs.whichMaestro ?? defaultWhichMaestro;
  const runnerPath = (inputs.maestroRunnerPath ?? defaultMaestroRunnerPath)();

  // GH #356 / B223: maestro-runner v1.0.9 silently no-ops `hideKeyboard` on
  // Android (reports pass in ~5ms, `mInputShown` stays true), which defeats the
  // keyboard-occlusion guard's whole purpose. When an Android flow contains a
  // hideKeyboard step, prefer the official Maestro CLI — verified to honor it on
  // Android (`mInputShown=false` after). iOS maestro-runner honors hideKeyboard,
  // so this only applies to Android.
  const needsOfficialForKeyboard =
    inputs.platform === 'android' && inputs.flowHasHideKeyboard === true;
  if (needsOfficialForKeyboard) {
    const maestroPath = whichMaestro();
    if (maestroPath) {
      return {
        runner: 'maestro',
        binPath: maestroPath,
        buildArgs: (platform, flowFile, _appFile, deviceId) => [
          'test',
          '--platform',
          platform,
          ...(deviceId ? ['--udid', deviceId] : []),
          flowFile,
        ],
        fallbackReason:
          'Android flow uses hideKeyboard; maestro-runner v1.0.9 no-ops it on Android (B223) — using the Maestro CLI so the keyboard is actually dismissed',
      };
    }
    // CLI unavailable: fall through to maestro-runner (Tier 1) but mark the
    // result degraded so the caller warns the keyboard will not be dismissed.
  }

  // Tier 1: maestro-runner. Viable when (a) the binary is installed and
  // (b) we're on android OR adb is reachable (so the upstream bug doesn't bite).
  const runnerViable =
    runnerPath !== null && (inputs.platform === 'android' || whichAdb() !== null);
  if (runnerViable && runnerPath) {
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
      ...(needsOfficialForKeyboard
        ? {
            degradedReason:
              'Android flow uses hideKeyboard but the Maestro CLI is not installed; maestro-runner v1.0.9 no-ops hideKeyboard on Android (B223), so the keyboard will NOT be dismissed. Install the Maestro CLI (`brew install maestro`) for the keyboard-occlusion fix to work on Android.',
          }
        : {}),
    };
  }

  // Tier 2: Maestro CLI fallback. Slower JVM cold start (~2s) but works on
  // iOS-only machines. Use when maestro-runner can't run AND `maestro` is
  // installed.
  const maestroPath = whichMaestro();
  if (maestroPath) {
    const reason =
      runnerPath === null
        ? 'maestro-runner not installed'
        : 'maestro-runner v1.0.9 requires adb in PATH (upstream bug — see B59); falling back to Maestro CLI';
    return {
      runner: 'maestro',
      binPath: maestroPath,
      // Maestro CLI: `maestro test --platform <platform> <flow.yaml>`. The
      // `--platform`/`-p` selector is the only platform flag v2.x exposes
      // (per `maestro test --help`: [-p=<platform>]). Both reviewers
      // (Gemini conf 97, Codex conf 98) caught the earlier draft using a
      // non-existent --device-type flag — would have silently broken the
      // entire B59 fallback on its target machines.
      // The Maestro CLI handles clearState reinstall from the flow's appId
      // header and exposes no --app-file flag, so appFile is intentionally ignored here.
      buildArgs: (platform, flowFile, _appFile, deviceId) => [
        'test',
        '--platform',
        platform,
        ...(deviceId ? ['--udid', deviceId] : []),
        flowFile,
      ],
      fallbackReason: reason,
    };
  }

  // Tier 3: nothing usable. Fail-fast with both install instructions —
  // far better than letting maestro-runner timeout opaquely.
  return {
    error:
      'Neither maestro-runner nor maestro CLI is usable. ' +
      (runnerPath === null ? 'maestro-runner not installed. ' : '') +
      (inputs.platform === 'ios' && whichAdb() === null
        ? 'maestro-runner v1.0.9 needs adb in PATH (upstream B59) but adb is not installed. '
        : '') +
      'Install Maestro CLI (`brew install maestro`) for iOS-only setups, ' +
      'or install Android SDK (`brew install android-platform-tools`) plus ' +
      '`curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash` ' +
      'for the faster maestro-runner path.',
    hint:
      inputs.platform === 'ios'
        ? 'iOS-only quickstart: brew install maestro'
        : 'install Android SDK + maestro-runner for fastest path',
  };
}
