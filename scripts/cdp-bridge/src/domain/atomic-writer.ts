// Issue #101 fix — atomic YAML+sidecar writes for ReusableAction.
//
// The naive ordering "write YAML, then update sidecar with the new
// mtime" has a silent failure mode: if the YAML write succeeds and the
// sidecar write fails (disk full, permission denied, ENOSPC, …), the
// on-disk YAML mtime advances but the sidecar still records the OLD
// mtime as `lastSeenMtimeMs`. Next call to `yamlEditedSinceLastSeen`
// reports a human edit that didn't happen, and self-repair refuses to
// operate.
//
// This module fixes that with **sidecar-first ordering plus a future
// mtime buffer**:
//
//   1. Write sidecar.tmp with `lastSeenMtimeMs = Date.now() + 1_000`
//      (one second in the future — bigger than any plausible YAML write
//      duration, smaller than any plausible human edit interval).
//   2. Atomic-rename sidecar.tmp → sidecar.
//   3. Write yaml.tmp with the new content.
//   4. Atomic-rename yaml.tmp → yaml.
//   5. (Optimistic) re-stat the YAML, write sidecar.tmp with the actual
//      mtime, atomic-rename. Brings `lastSeenMtimeMs` back to the precise
//      value but is not load-bearing for safety.
//
// Crash analysis:
//
//   - Crash before step 2 → no on-disk change. Safe.
//   - Crash between 2 and 4 → sidecar has future mtime, YAML still old.
//     `yamlEditedSinceLastSeen` returns false (current_mtime <
//     lastSeenMtimeMs). No false-positive alarm. Safe.
//   - Crash between 4 and 5 → YAML new, sidecar has future mtime ≥
//     YAML's actual mtime. `yamlEditedSinceLastSeen` returns false. Safe.
//   - Crash during 5 → as previous case (sidecar's lastSeenMtimeMs is
//     slightly imprecise but still ≥ actual YAML mtime). Safe.
//
// Test seam: the public API is on a single exported object so tests can
// `mock.method(atomicWriter, '_writeFile', ...)` to inject failures.

import {
  writeFileSync,
  renameSync,
  statSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { ActionRuntimeState } from './reusable-action.js';

// Multi-LLM review of PR #109 findings 1+2: `finalMtimeMs = _stat(yaml)`
// breaks the safety invariant in two scenarios — (a) slow writes where
// the actual YAML mtime exceeds `projectedMtimeMs` and step 5 happens
// to swallow a follow-on error, leaving the persisted sidecar at the
// stale projected value; (b) clock-skew on networked filesystems where
// the server-side mtime is *behind* `projectedMtimeMs`, regressing
// `lastSeenMtimeMs` and hiding real human edits within the skew window.
// Both are fixed by (i) using `Math.max(actual, projected)` so the
// recorded value never goes backwards, and (ii) dropping the step-5
// try/catch — the action isn't safely written without it, so a caller
// that retries on failure produces the correct behaviour.

/**
 * Number of milliseconds the projected `lastSeenMtimeMs` is set ahead of
 * `Date.now()` during the sidecar-first phase. Must be:
 * - LARGER than any plausible YAML write duration (~10 ms typical).
 * - SMALLER than any plausible human-edit interval (multiple seconds).
 *
 * 1 second satisfies both with a safe margin.
 */
export const FUTURE_MTIME_BUFFER_MS = 1_000;

export interface PairWriteResult {
  yamlPath: string;
  sidecarPath: string;
  /** Actual YAML mtime after both writes succeed. */
  finalMtimeMs: number;
  /** True iff the optimistic step-5 sidecar refresh ran. */
  refreshedSidecar: boolean;
}

/**
 * Atomic write of a (YAML, sidecar) pair using sidecar-first ordering.
 * Returns the resolved paths plus the final on-disk mtime. Throws if any
 * intermediate step fails — caller decides whether to surface the error
 * or recover.
 *
 * Side effects: creates parent directories for both paths, writes/renames
 * the two files, may leave behind `.tmp` files on hard crash (next call
 * overwrites them — they're not load-bearing).
 *
 * @param yamlPath  Absolute path of the target YAML file.
 * @param yamlContent  Final YAML text to persist.
 * @param sidecarPath  Absolute path of the target sidecar JSON file.
 * @param state  ActionRuntimeState to persist; `lastSeenMtimeMs` is
 *               overridden by the writer (caller's value is ignored —
 *               the writer owns this field's timing-correctness).
 */
function pairWriteImpl(
  yamlPath: string,
  yamlContent: string,
  sidecarPath: string,
  state: ActionRuntimeState,
): PairWriteResult {
  ensureDir(yamlPath);
  ensureDir(sidecarPath);

  const yamlTmp = `${yamlPath}.tmp`;
  const sidecarTmp = `${sidecarPath}.tmp`;

  // Step 1+2: sidecar with projected future mtime, atomic rename.
  const projectedMtimeMs = Date.now() + FUTURE_MTIME_BUFFER_MS;
  const projectedState: ActionRuntimeState = {
    ...state,
    lastSeenMtimeMs: projectedMtimeMs,
  };
  atomicWriter._writeFile(sidecarTmp, JSON.stringify(projectedState, null, 2) + '\n');
  atomicWriter._rename(sidecarTmp, sidecarPath);

  // Step 3+4: YAML, atomic rename.
  atomicWriter._writeFile(yamlTmp, yamlContent);
  atomicWriter._rename(yamlTmp, yamlPath);

  // Step 5 (mandatory after PR #109 review): resync sidecar to the
  // ACTUAL YAML mtime, but never let the recorded value regress below
  // `projectedMtimeMs`. This handles two failure modes the original
  // try/catch silently allowed:
  //
  //   - Slow writes (CI fsync queue saturation, antivirus stalls):
  //     actual_yaml_mtime > projectedMtimeMs. Math.max picks actual,
  //     so the sidecar ends up with a value ≥ what's on disk.
  //
  //   - Clock skew on NFS / Docker bind mounts: actual_yaml_mtime <
  //     projectedMtimeMs. Math.max keeps projectedMtimeMs, so the
  //     recorded value doesn't regress and a future legitimate edit
  //     within the skew window still produces mtime > recorded.
  //
  // Errors are NOT swallowed — if step 5 fails, the operation is not
  // safely complete. Caller should retry; the on-disk sidecar already
  // holds `projectedMtimeMs` (from step 1+2), so a retry won't see a
  // false-positive alarm.
  const actualMtimeMs = atomicWriter._statMtimeMs(yamlPath);
  const finalMtimeMs = Math.max(actualMtimeMs, projectedMtimeMs);
  const finalState: ActionRuntimeState = {
    ...state,
    lastSeenMtimeMs: finalMtimeMs,
  };
  atomicWriter._writeFile(sidecarTmp, JSON.stringify(finalState, null, 2) + '\n');
  atomicWriter._rename(sidecarTmp, sidecarPath);

  return { yamlPath, sidecarPath, finalMtimeMs, refreshedSidecar: true };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!atomicWriter._exists(dir)) atomicWriter._mkdir(dir);
}

/**
 * Best-effort cleanup of orphaned `.tmp` files left by a crashed previous
 * call. Called by `pairWrite` before each operation. Idempotent.
 *
 * Routes through `atomicWriter._unlink` / `_exists` so PR #109 review
 * finding (E) — "tests can't simulate mkdir/unlink failures" — is
 * resolved: the seam is now complete across all fs operations the
 * writer performs.
 */
function cleanupOrphans(yamlPath: string, sidecarPath: string): void {
  for (const orphan of [`${yamlPath}.tmp`, `${sidecarPath}.tmp`]) {
    if (atomicWriter._exists(orphan)) {
      try { atomicWriter._unlink(orphan); } catch { /* ignore */ }
    }
  }
}

/**
 * Public API. Tests can mock the underscore-prefixed methods to inject
 * filesystem failures for atomicity assertions.
 */
export const atomicWriter = {
  /** Underlying `fs.writeFileSync(path, content, 'utf8')`. */
  _writeFile(path: string, content: string): void {
    writeFileSync(path, content, 'utf8');
  },
  /** Underlying `fs.renameSync(from, to)`. */
  _rename(from: string, to: string): void {
    renameSync(from, to);
  },
  /** Underlying `fs.statSync(path).mtimeMs`. */
  _statMtimeMs(path: string): number {
    return statSync(path).mtimeMs;
  },
  /** Underlying `fs.existsSync(path)`. Routed through the seam so test
   *  cases for ensureDir / cleanupOrphans can simulate exotic failures
   *  (PR #109 review). */
  _exists(path: string): boolean {
    return existsSync(path);
  },
  /** Underlying `fs.mkdirSync(path, { recursive: true })`. */
  _mkdir(path: string): void {
    mkdirSync(path, { recursive: true });
  },
  /** Underlying `fs.unlinkSync(path)`. Used by orphan-cleanup. */
  _unlink(path: string): void {
    unlinkSync(path);
  },

  /**
   * Atomic pair-write. Cleans up any orphaned `.tmp` files before
   * starting. Throws on the first failed step — caller decides whether
   * to surface or recover.
   */
  pairWrite(
    yamlPath: string,
    yamlContent: string,
    sidecarPath: string,
    state: ActionRuntimeState,
  ): PairWriteResult {
    cleanupOrphans(yamlPath, sidecarPath);
    return pairWriteImpl(yamlPath, yamlContent, sidecarPath, state);
  },
};
