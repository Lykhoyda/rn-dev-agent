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
import { writeFileSync, renameSync, statSync, mkdirSync, existsSync, unlinkSync, } from 'node:fs';
import { dirname } from 'node:path';
/**
 * Number of milliseconds the projected `lastSeenMtimeMs` is set ahead of
 * `Date.now()` during the sidecar-first phase. Must be:
 * - LARGER than any plausible YAML write duration (~10 ms typical).
 * - SMALLER than any plausible human-edit interval (multiple seconds).
 *
 * 1 second satisfies both with a safe margin.
 */
export const FUTURE_MTIME_BUFFER_MS = 1_000;
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
function pairWriteImpl(yamlPath, yamlContent, sidecarPath, state) {
    ensureDir(yamlPath);
    ensureDir(sidecarPath);
    const yamlTmp = `${yamlPath}.tmp`;
    const sidecarTmp = `${sidecarPath}.tmp`;
    // Step 1+2: sidecar with projected future mtime, atomic rename.
    const projectedMtimeMs = Date.now() + FUTURE_MTIME_BUFFER_MS;
    const projectedState = {
        ...state,
        lastSeenMtimeMs: projectedMtimeMs,
    };
    atomicWriter._writeFile(sidecarTmp, JSON.stringify(projectedState, null, 2) + '\n');
    atomicWriter._rename(sidecarTmp, sidecarPath);
    // Step 3+4: YAML, atomic rename.
    atomicWriter._writeFile(yamlTmp, yamlContent);
    atomicWriter._rename(yamlTmp, yamlPath);
    // Step 5 (optional): resync sidecar to actual mtime. Wrapped in a
    // try so that an error here doesn't poison the result — partial
    // failure leaves sidecar with the projected future mtime, which is
    // already safe per the crash analysis above.
    let refreshedSidecar = false;
    let finalMtimeMs = projectedMtimeMs;
    try {
        finalMtimeMs = atomicWriter._statMtimeMs(yamlPath);
        const finalState = {
            ...state,
            lastSeenMtimeMs: finalMtimeMs,
        };
        atomicWriter._writeFile(sidecarTmp, JSON.stringify(finalState, null, 2) + '\n');
        atomicWriter._rename(sidecarTmp, sidecarPath);
        refreshedSidecar = true;
    }
    catch {
        // Step 5 failed but the sidecar still holds projectedMtimeMs which
        // is ≥ any real YAML mtime — no false-positive alarm possible.
    }
    return { yamlPath, sidecarPath, finalMtimeMs, refreshedSidecar };
}
function ensureDir(filePath) {
    const dir = dirname(filePath);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
}
/**
 * Best-effort cleanup of orphaned `.tmp` files left by a crashed previous
 * call. Called by `pairWrite` before each operation. Idempotent.
 */
function cleanupOrphans(yamlPath, sidecarPath) {
    for (const orphan of [`${yamlPath}.tmp`, `${sidecarPath}.tmp`]) {
        if (existsSync(orphan)) {
            try {
                unlinkSync(orphan);
            }
            catch { /* ignore */ }
        }
    }
}
/**
 * Public API. Tests can mock the underscore-prefixed methods to inject
 * filesystem failures for atomicity assertions.
 */
export const atomicWriter = {
    /** Underlying `fs.writeFileSync(path, content, 'utf8')`. */
    _writeFile(path, content) {
        writeFileSync(path, content, 'utf8');
    },
    /** Underlying `fs.renameSync(from, to)`. */
    _rename(from, to) {
        renameSync(from, to);
    },
    /** Underlying `fs.statSync(path).mtimeMs`. */
    _statMtimeMs(path) {
        return statSync(path).mtimeMs;
    },
    /**
     * Atomic pair-write. Cleans up any orphaned `.tmp` files before
     * starting. Throws on the first failed step — caller decides whether
     * to surface or recover.
     */
    pairWrite(yamlPath, yamlContent, sidecarPath, state) {
        cleanupOrphans(yamlPath, sidecarPath);
        return pairWriteImpl(yamlPath, yamlContent, sidecarPath, state);
    },
};
