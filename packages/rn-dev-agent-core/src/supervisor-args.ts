/**
 * Pure, side-effect-free helpers for building the worker spawn argument list.
 *
 * Kept separate from supervisor.ts because importing supervisor.ts runs its
 * top-level code (takes the single-instance lock, spawns the worker) — these
 * functions need to be importable by unit tests without any of that.
 *
 * node:sqlite availability by version:
 *   v < 22.5   — module absent, store degrades gracefully (no flag)
 *   22.5 ≤ v < 23.6 — requires --experimental-sqlite to enable
 *   v ≥ 23.6   — on by default, flag is a recognised no-op but unnecessary
 */

/**
 * Returns `['--experimental-sqlite']` when the given Node version requires the
 * flag to enable `node:sqlite`, or `[]` otherwise.
 *
 * @param version - semver string to test (default: `process.versions.node`)
 */
export function sqliteFlagForNode(version?: string): string[] {
  const v = version ?? process.versions.node;
  const [majorStr, minorStr] = v.split('.');
  const major = parseInt(majorStr ?? '0', 10);
  const minor = parseInt(minorStr ?? '0', 10);

  // Flag range: 22.5 ≤ v < 23.6
  //   major===22 && minor>=5  → needs flag (module exists but behind the flag)
  //   major===23 && minor<6   → needs flag (not yet default-on)
  //   otherwise               → no flag (module absent or already default-on)
  const requiresFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 6);

  return requiresFlag ? ['--experimental-sqlite'] : [];
}

/**
 * Returns the full argument array to pass to `spawn(process.execPath, ...)`.
 * Node VM flags come first (so they are interpreted by Node, not the script),
 * then the worker script path, then `--no-lock` (worker-level flag).
 */
export function workerSpawnArgs(
  workerPath: string,
  sqliteWarningFilterPath: string,
  version?: string,
  forwardedArgs: readonly string[] = [],
): string[] {
  const diagnosticArgs = forwardedArgs.includes('--diagnostic-contract-probe')
    ? ['--diagnostic-contract-probe']
    : [];
  return [
    ...sqliteFlagForNode(version),
    '--import',
    sqliteWarningFilterPath,
    workerPath,
    '--no-lock',
    ...diagnosticArgs,
  ];
}

export function supervisorRelaunchArgs(
  supervisorPath: string,
  sqliteWarningFilterPath: string,
  version?: string,
  forwardedArgs: readonly string[] = [],
): string[] {
  return [
    ...sqliteFlagForNode(version),
    '--import',
    sqliteWarningFilterPath,
    supervisorPath,
    ...forwardedArgs,
  ];
}
