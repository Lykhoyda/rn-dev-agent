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
  readdirSync,
  openSync,
  closeSync,
  chmodSync,
  fstatSync,
  lstatSync,
  readFileSync,
  linkSync,
  constants,
} from 'node:fs';
import { dirname, basename } from 'node:path';
import type { ActionRuntimeState } from './reusable-action.js';
import {
  linkFileIntoVerifiedDirectory,
  linkFileIntoVerifiedDirectoryFd,
  probeProcessBirth,
  publishFileIfUnchangedDarwin,
  publishFileIfUnchangedInVerifiedDirectory,
  unlinkFileFromVerifiedDirectoryFd,
  type NativePublicationWitness,
} from '../session/process-birth.js';

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

/**
 * GH #111: orphan .tmp files older than this threshold are eligible for
 * cleanup. Any process that's been alive for 5 minutes hasn't crashed
 * mid-pairWrite — the orphan must be from a prior crashed run. Concurrent
 * pairWrite calls don't collide because each call uses a unique stamp,
 * but a stale orphan from a crashed process would otherwise stick around
 * forever. 5 minutes is conservative (allows long fsync queues / CI
 * antivirus stalls).
 */
export const ORPHAN_MAX_AGE_MS = 5 * 60 * 1_000;

/** Generate a unique tmp-file stamp per pairWrite call. Crash-resistant
 *  and concurrent-safe — two pairWrites for the same action path won't
 *  collide because each owns its own tmp namespace. */
function generateTmpStamp(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${process.pid}.${Date.now().toString(36)}.${rand}`;
}

export interface PairWriteResult {
  yamlPath: string;
  sidecarPath: string;
  /** Actual YAML mtime after both writes succeed. */
  finalMtimeMs: number;
  /** True iff the optimistic step-5 sidecar refresh ran. */
  refreshedSidecar: boolean;
}

const ACTION_WRITE_LOCK_TIMEOUT_MS = 5_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const ACTION_WRITE_PRECONDITION = Symbol('action-write-precondition');

interface ActionWriteLockOwner {
  pid: number;
  birth: string;
}

let localLockOwner: ActionWriteLockOwner | null = null;
const heldWriteLocks = new Set<string>();

function actionWriteLockPath(yamlPath: string): string {
  return `${yamlPath.replace(/\.yml$/i, '.yaml')}.write.lock`;
}

function currentLockOwner(): ActionWriteLockOwner {
  if (localLockOwner) return localLockOwner;
  const observed = probeProcessBirth(process.pid);
  if (observed.status !== 'present') {
    throw new Error('Could not establish action writer process identity.');
  }
  localLockOwner = { pid: process.pid, birth: observed.birth.token };
  return localLockOwner;
}

function readLockOwner(lockPath: string): ActionWriteLockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<ActionWriteLockOwner>;
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 || !parsed.birth) return null;
    return { pid: Number(parsed.pid), birth: parsed.birth };
  } catch {
    return null;
  }
}

function lockOwnerIsGone(owner: ActionWriteLockOwner): boolean {
  const observed = probeProcessBirth(owner.pid);
  return (
    observed.status === 'absent' ||
    (observed.status === 'present' && observed.birth.token !== owner.birth)
  );
}

function withPairWriteLock<T>(
  yamlPath: string,
  operation: () => T,
  acquisitionPrecondition?: () => boolean,
): T {
  if (acquisitionPrecondition && !acquisitionPrecondition()) throw ACTION_WRITE_PRECONDITION;
  ensureDir(yamlPath);
  const lockPath = actionWriteLockPath(yamlPath);
  if (heldWriteLocks.has(lockPath)) return operation();
  // Owner inode must live beside the YAML so link(2) stays on-volume.
  // Walking three parents put tmp-dir tests at `/.rn-action-write-owner.*` (EACCES).
  const ownerPath = `${dirname(yamlPath)}/.rn-action-write-owner.${generateTmpStamp()}`;
  const owner = currentLockOwner();
  const lockFd = openSync(ownerPath, 'wx', 0o600);
  writeFileSync(lockFd, `${JSON.stringify(owner)}\n`, 'utf8');
  const deadline = Date.now() + ACTION_WRITE_LOCK_TIMEOUT_MS;
  let acquired = false;
  let identity: ReturnType<typeof fstatSync> | null = null;
  try {
    while (!acquired) {
      try {
        if (acquisitionPrecondition && !acquisitionPrecondition()) {
          throw ACTION_WRITE_PRECONDITION;
        }
        linkSync(ownerPath, lockPath);
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let lockStat;
        try {
          lockStat = lstatSync(lockPath);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw statError;
        }
        if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
          throw new Error(`Refusing invalid action write lock at ${lockPath}.`);
        }
        const existingOwner = readLockOwner(lockPath);
        if (existingOwner && lockOwnerIsGone(existingOwner)) {
          try {
            const current = lstatSync(lockPath);
            if (current.dev === lockStat.dev && current.ino === lockStat.ino) unlinkSync(lockPath);
          } catch (unlinkError) {
            if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for action write lock at ${lockPath}.`);
        }
        Atomics.wait(lockWaitBuffer, 0, 0, 10);
      }
    }
    unlinkSync(ownerPath);
    identity = fstatSync(lockFd);
    heldWriteLocks.add(lockPath);
    try {
      return operation();
    } finally {
      heldWriteLocks.delete(lockPath);
    }
  } finally {
    if (identity) {
      try {
        const current = lstatSync(lockPath);
        if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
      } catch {}
    }
    closeSync(lockFd);
    try {
      unlinkSync(ownerPath);
    } catch {}
  }
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
  publicationPrecondition?: () => boolean,
  yamlPublicationPrecondition?: () => boolean,
  expectedYamlContent?: string,
  createExclusive = false,
  witnesses: readonly NativePublicationWitness[] = [],
): PairWriteResult | null {
  if (publicationPrecondition && !publicationPrecondition()) return null;
  ensureDir(yamlPath);
  ensureDir(sidecarPath);

  let yamlDirectoryFd: number | undefined;
  let sidecarDirectoryFd: number | undefined;
  if (witnesses.length > 0) {
    try {
      yamlDirectoryFd = openSync(
        dirname(yamlPath),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
      sidecarDirectoryFd = openSync(
        dirname(sidecarPath),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
    } catch {
      if (yamlDirectoryFd !== undefined) closeSync(yamlDirectoryFd);
      return null;
    }
  }
  try {
    if (publicationPrecondition && !publicationPrecondition()) return null;
    return pairWriteInDirectories(
      yamlPath,
      yamlContent,
      sidecarPath,
      state,
      publicationPrecondition,
      yamlPublicationPrecondition,
      expectedYamlContent,
      createExclusive,
      witnesses,
      yamlDirectoryFd,
      sidecarDirectoryFd,
    );
  } finally {
    if (sidecarDirectoryFd !== undefined) closeSync(sidecarDirectoryFd);
    if (yamlDirectoryFd !== undefined) closeSync(yamlDirectoryFd);
  }
}

function pairWriteInDirectories(
  yamlPath: string,
  yamlContent: string,
  sidecarPath: string,
  state: ActionRuntimeState,
  publicationPrecondition: (() => boolean) | undefined,
  yamlPublicationPrecondition: (() => boolean) | undefined,
  expectedYamlContent: string | undefined,
  createExclusive: boolean,
  witnesses: readonly NativePublicationWitness[],
  yamlDirectoryFd: number | undefined,
  sidecarDirectoryFd: number | undefined,
): PairWriteResult | null {
  let yamlMode: number | undefined;
  if (expectedYamlContent !== undefined) {
    let targetFd: number;
    try {
      targetFd = openSync(yamlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const target = fstatSync(targetFd);
      if (!target.isFile() || readFileSync(targetFd, 'utf8') !== expectedYamlContent) return null;
      yamlMode = target.mode & 0o7777;
    } finally {
      closeSync(targetFd);
    }
  } else if (createExclusive) {
    yamlMode = 0o600;
  }

  let sidecarMode = 0o600;
  try {
    const sidecarFd = openSync(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const sidecar = fstatSync(sidecarFd);
      if (!sidecar.isFile()) return null;
      sidecarMode = sidecar.mode & 0o7777;
    } finally {
      closeSync(sidecarFd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }

  // GH #111: unique stamp per call so two concurrent pairWrites against
  // the same action id never share a tmp namespace. Without this, B's
  // cleanupOrphans could unlink A's in-flight .tmp file and produce an
  // opaque ENOENT during A's rename.
  const stamp = generateTmpStamp();
  const yamlTmp = `${yamlPath}.tmp.${stamp}`;
  const sidecarTmp = `${sidecarPath}.tmp.${stamp}`;

  // Step 1+2: sidecar with projected future mtime, atomic rename.
  const projectedMtimeMs = Date.now() + FUTURE_MTIME_BUFFER_MS;
  const projectedState: ActionRuntimeState = {
    ...state,
    lastSeenMtimeMs: projectedMtimeMs,
  };
  const projectedSidecar = JSON.stringify(projectedState, null, 2) + '\n';
  if (publicationPrecondition && !publicationPrecondition()) return null;
  atomicWriter._writeFileWithMode(sidecarTmp, projectedSidecar, sidecarMode);
  if (publicationPrecondition && !publicationPrecondition()) {
    removeCandidate(sidecarTmp, sidecarDirectoryFd);
    return null;
  }

  const priorSidecarExisted = publicationPrecondition ? atomicWriter._exists(sidecarPath) : false;
  const priorSidecar = priorSidecarExisted ? readFileSync(sidecarPath, 'utf8') : null;

  function restorePriorSidecar(): void {
    if (priorSidecar === null) {
      if (sidecarDirectoryFd === undefined) {
        atomicWriter._unlink(sidecarPath);
      } else {
        unlinkFileFromVerifiedDirectoryFd(sidecarDirectoryFd, basename(sidecarPath));
      }
    } else {
      const restoreStamp = generateTmpStamp();
      const restorePath = `${sidecarPath}.tmp.${restoreStamp}`;
      atomicWriter._writeFileWithMode(restorePath, priorSidecar, sidecarMode);
      try {
        if (sidecarDirectoryFd === undefined) {
          atomicWriter._rename(restorePath, sidecarPath);
        } else {
          atomicWriter._publishIfUnchanged(
            restorePath,
            sidecarPath,
            projectedSidecar,
            restoreStamp,
            undefined,
            sidecarDirectoryFd,
          );
        }
      } finally {
        removeCandidate(restorePath, sidecarDirectoryFd);
      }
    }
  }

  function rollbackYaml(): void {
    if (yamlDirectoryFd === undefined || expectedYamlContent === undefined) return;
    const rollbackStamp = generateTmpStamp();
    const rollbackPath = `${yamlPath}.tmp.${rollbackStamp}`;
    atomicWriter._writeFileWithMode(rollbackPath, expectedYamlContent, yamlMode ?? 0o600);
    try {
      atomicWriter._publishIfUnchanged(
        rollbackPath,
        yamlPath,
        yamlContent,
        rollbackStamp,
        undefined,
        yamlDirectoryFd,
      );
    } finally {
      removeCandidate(rollbackPath, yamlDirectoryFd);
    }
  }

  function writeYamlTmp(): void {
    if (yamlMode === undefined) atomicWriter._writeFile(yamlTmp, yamlContent);
    else atomicWriter._writeFileWithMode(yamlTmp, yamlContent, yamlMode);
  }

  if (createExclusive) {
    // New files must not publish a sidecar without a YAML. Write YAML first.
    try {
      writeYamlTmp();
    } catch (error) {
      try {
        atomicWriter._unlink(sidecarTmp);
      } catch {
        /* tmp may already be gone */
      }
      try {
        atomicWriter._unlink(yamlTmp);
      } catch {
        /* tmp may not exist yet */
      }
      throw error;
    }
    if (publicationPrecondition && !publicationPrecondition()) {
      removeCandidate(sidecarTmp, sidecarDirectoryFd);
      removeCandidate(yamlTmp, yamlDirectoryFd);
      return null;
    }
    const yamlPublished =
      (!publicationPrecondition || publicationPrecondition()) &&
      atomicWriter._linkIfAbsent(
        yamlTmp,
        yamlPath,
        publicationPrecondition,
        yamlDirectoryFd,
        witnesses,
      );
    if (!yamlPublished) {
      removeCandidate(sidecarTmp, sidecarDirectoryFd);
      removeCandidate(yamlTmp, yamlDirectoryFd);
      return null;
    }
    if (sidecarDirectoryFd === undefined) atomicWriter._rename(sidecarTmp, sidecarPath);
    else if (
      !atomicWriter._linkIfAbsent(
        sidecarTmp,
        sidecarPath,
        publicationPrecondition,
        sidecarDirectoryFd,
        witnesses,
      )
    ) {
      removeCandidate(yamlPath, yamlDirectoryFd);
      removeCandidate(sidecarTmp, sidecarDirectoryFd);
      return null;
    }
    removeCandidate(yamlTmp, yamlDirectoryFd);
  } else {
    // Existing files: sidecar-first so a YAML write failure cannot look like a human edit.
    if (publicationPrecondition && !publicationPrecondition()) {
      removeCandidate(sidecarTmp, sidecarDirectoryFd);
      return null;
    }
    const sidecarPublished =
      sidecarDirectoryFd === undefined
        ? (atomicWriter._rename(sidecarTmp, sidecarPath), true)
        : priorSidecar === null
          ? atomicWriter._linkIfAbsent(
              sidecarTmp,
              sidecarPath,
              publicationPrecondition,
              sidecarDirectoryFd,
              witnesses,
            )
          : atomicWriter._publishIfUnchanged(
              sidecarTmp,
              sidecarPath,
              priorSidecar,
              stamp,
              publicationPrecondition,
              sidecarDirectoryFd,
              witnesses,
            );
    removeCandidate(sidecarTmp, sidecarDirectoryFd);
    if (!sidecarPublished) return null;
    try {
      writeYamlTmp();
    } catch (error) {
      try {
        atomicWriter._unlink(yamlTmp);
      } catch {
        /* tmp may not exist yet */
      }
      throw error;
    }
    const yamlPublished =
      expectedYamlContent === undefined
        ? !yamlPublicationPrecondition || yamlPublicationPrecondition()
        : atomicWriter._publishIfUnchanged(
            yamlTmp,
            yamlPath,
            expectedYamlContent,
            stamp,
            yamlPublicationPrecondition,
            yamlDirectoryFd,
            witnesses,
          );
    if (!yamlPublished) {
      if (yamlPublicationPrecondition && !yamlPublicationPrecondition()) {
        try {
          const candidate = lstatSync(yamlTmp);
          if (!candidate.isFile() || candidate.isSymbolicLink()) return null;
        } catch {
          return null;
        }
      }
      restorePriorSidecar();
      removeCandidate(yamlTmp, yamlDirectoryFd);
      return null;
    }
    if (expectedYamlContent === undefined) atomicWriter._rename(yamlTmp, yamlPath);
    else removeCandidate(yamlTmp, yamlDirectoryFd);
  }

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
  atomicWriter._writeFileWithMode(
    sidecarTmp,
    JSON.stringify(finalState, null, 2) + '\n',
    sidecarMode,
  );
  const publishedYamlMatches = (): boolean => {
    try {
      const yamlFd = openSync(yamlPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const yaml = fstatSync(yamlFd);
        return yaml.isFile() && readFileSync(yamlFd, 'utf8') === yamlContent;
      } finally {
        closeSync(yamlFd);
      }
    } catch {
      return false;
    }
  };
  if (!publishedYamlMatches()) {
    removeCandidate(sidecarTmp, sidecarDirectoryFd);
    rollbackYaml();
    restorePriorSidecar();
    return null;
  }
  const finalSidecarPublished =
    sidecarDirectoryFd === undefined
      ? (atomicWriter._rename(sidecarTmp, sidecarPath), true)
      : atomicWriter._publishIfUnchanged(
          sidecarTmp,
          sidecarPath,
          projectedSidecar,
          `${stamp}.final`,
          witnesses.length === 0 ? publishedYamlMatches : undefined,
          sidecarDirectoryFd,
          witnesses,
        );
  removeCandidate(sidecarTmp, sidecarDirectoryFd);
  if (!finalSidecarPublished) {
    rollbackYaml();
    restorePriorSidecar();
    return null;
  }

  return { yamlPath, sidecarPath, finalMtimeMs, refreshedSidecar: true };
}

function removeCandidate(path: string, directoryFd?: number): void {
  try {
    atomicWriter._unlink(path);
  } catch {}
  if (directoryFd !== undefined) {
    try {
      unlinkFileFromVerifiedDirectoryFd(directoryFd, basename(path));
    } catch {}
  }
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!atomicWriter._exists(dir)) atomicWriter._mkdir(dir);
}

/**
 * Best-effort cleanup of orphaned `.tmp.<stamp>` files left by a crashed
 * previous call (GH #111). Called by `pairWrite` before each operation.
 * Idempotent.
 *
 * Only removes `.tmp.<stamp>` files matching the target path's prefix
 * AND older than ORPHAN_MAX_AGE_MS — concurrent writers' fresh tmp files
 * are untouched. A crashed process's stale tmp file becomes eligible
 * after 5 minutes, well past any plausible pairWrite duration.
 *
 * Routes through `atomicWriter._readdir` / `_statMtimeMs` / `_unlink`
 * so tests can mock cleanup behavior deterministically.
 */
function cleanupOrphans(yamlPath: string, sidecarPath: string): void {
  const now = Date.now();
  for (const targetPath of [yamlPath, sidecarPath]) {
    const dir = dirname(targetPath);
    const prefix = `${basename(targetPath)}.tmp.`;
    let entries: string[];
    try {
      entries = atomicWriter._readdir(dir);
    } catch {
      continue; // dir doesn't exist yet — no orphans possible
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const orphanPath = `${dir}/${entry}`;
      try {
        const mtimeMs = atomicWriter._statMtimeMs(orphanPath);
        if (now - mtimeMs < ORPHAN_MAX_AGE_MS) continue; // fresh — likely a concurrent writer's
        atomicWriter._unlink(orphanPath);
      } catch {
        /* best-effort */
      }
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
  _writeFileWithMode(path: string, content: string, mode: number): void {
    const fd = openSync(path, 'wx', mode);
    try {
      writeFileSync(fd, content, 'utf8');
    } finally {
      closeSync(fd);
    }
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
  /** Underlying `fs.readdirSync(path)`. Used by GH #111 prefix-scan cleanup. */
  _readdir(path: string): string[] {
    return readdirSync(path);
  },

  _linkIfAbsent(
    candidatePath: string,
    targetPath: string,
    publicationPrecondition?: () => boolean,
    directoryFd?: number,
    witnesses: readonly NativePublicationWitness[] = [],
  ): boolean {
    if (publicationPrecondition && !publicationPrecondition()) return false;
    if (directoryFd !== undefined) {
      return linkFileIntoVerifiedDirectoryFd(
        directoryFd,
        basename(candidatePath),
        basename(targetPath),
        witnesses,
      );
    }
    let openedDirectoryFd: number;
    try {
      openedDirectoryFd = openSync(
        dirname(targetPath),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
      );
    } catch {
      return false;
    }
    try {
      const directory = fstatSync(openedDirectoryFd);
      if (!directory.isDirectory() || (publicationPrecondition && !publicationPrecondition())) {
        return false;
      }
      return atomicWriter._linkIntoVerifiedDirectory(openedDirectoryFd, candidatePath, targetPath);
    } finally {
      closeSync(openedDirectoryFd);
    }
  },

  _linkIntoVerifiedDirectory(
    directoryFd: number,
    candidatePath: string,
    targetPath: string,
  ): boolean {
    return linkFileIntoVerifiedDirectory(directoryFd, candidatePath, targetPath);
  },

  _publishIfUnchanged(
    candidatePath: string,
    targetPath: string,
    expectedContent: string,
    stamp: string,
    publicationPrecondition?: () => boolean,
    directoryFd?: number,
    witnesses: readonly NativePublicationWitness[] = [],
  ): boolean {
    let targetFd: number;
    try {
      targetFd = openSync(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return false;
    }
    try {
      const opened = fstatSync(targetFd);
      const current = lstatSync(targetPath);
      if (
        !opened.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        readFileSync(targetFd, 'utf8') !== expectedContent ||
        (publicationPrecondition && !publicationPrecondition())
      ) {
        return false;
      }
      const expectedPath = `${candidatePath}.expected.${stamp}`;
      chmodSync(candidatePath, opened.mode & 0o7777);
      atomicWriter._writeFileWithMode(expectedPath, expectedContent, opened.mode & 0o7777);
      try {
        if (directoryFd !== undefined) {
          return publishFileIfUnchangedInVerifiedDirectory(
            directoryFd,
            basename(targetPath),
            basename(candidatePath),
            basename(expectedPath),
            witnesses,
          );
        }
        return publishFileIfUnchangedDarwin(targetFd, targetPath, candidatePath, expectedPath);
      } finally {
        try {
          atomicWriter._unlink(expectedPath);
        } catch {}
        if (directoryFd !== undefined) {
          try {
            unlinkFileFromVerifiedDirectoryFd(directoryFd, basename(expectedPath));
          } catch {}
        }
      }
    } catch {
      return false;
    } finally {
      closeSync(targetFd);
    }
  },

  withLock<T>(yamlPath: string, operation: () => T): T {
    return withPairWriteLock(yamlPath, operation);
  },

  writeTextCreateExclusive(
    yamlPath: string,
    content: string,
    precondition: () => boolean,
  ): boolean {
    try {
      return withPairWriteLock(
        yamlPath,
        () => {
          if (!precondition()) return false;
          const candidatePath = `${dirname(yamlPath)}/.rn-action-create.${generateTmpStamp()}`;
          atomicWriter._writeFileWithMode(candidatePath, content, 0o600);
          try {
            return atomicWriter._linkIfAbsent(candidatePath, yamlPath, precondition);
          } finally {
            try {
              atomicWriter._unlink(candidatePath);
            } catch {
              /* candidate may vanish if the actions dir was swapped */
            }
          }
        },
        precondition,
      );
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION) return false;
      throw error;
    }
  },

  writeSidecarConditional(
    yamlPath: string,
    sidecarPath: string,
    state: ActionRuntimeState,
    precondition: () => boolean,
    witnesses: readonly NativePublicationWitness[] = [],
  ): boolean {
    try {
      return withPairWriteLock(
        yamlPath,
        () => {
          if (!precondition()) return false;
          cleanupOrphans(yamlPath, sidecarPath);
          ensureDir(sidecarPath);

          const directoryFd = openSync(
            dirname(sidecarPath),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
          );
          try {
            if (!precondition()) return false;

            let expectedContent: string | null = null;
            let mode = 0o600;
            try {
              const sidecarFd = openSync(sidecarPath, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const sidecar = fstatSync(sidecarFd);
                if (!sidecar.isFile()) return false;
                expectedContent = readFileSync(sidecarFd, 'utf8');
                mode = sidecar.mode & 0o7777;
              } finally {
                closeSync(sidecarFd);
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
            }
            if (!precondition()) return false;

            const stamp = generateTmpStamp();
            const candidatePath = `${sidecarPath}.tmp.${stamp}`;
            atomicWriter._writeFileWithMode(
              candidatePath,
              JSON.stringify(state, null, 2) + '\n',
              mode,
            );
            try {
              if (!precondition()) return false;
              return expectedContent === null
                ? atomicWriter._linkIfAbsent(
                    candidatePath,
                    sidecarPath,
                    precondition,
                    directoryFd,
                    witnesses,
                  )
                : atomicWriter._publishIfUnchanged(
                    candidatePath,
                    sidecarPath,
                    expectedContent,
                    stamp,
                    precondition,
                    directoryFd,
                    witnesses,
                  );
            } finally {
              try {
                atomicWriter._unlink(candidatePath);
              } catch {}
              try {
                unlinkFileFromVerifiedDirectoryFd(directoryFd, basename(candidatePath));
              } catch {}
            }
          } finally {
            closeSync(directoryFd);
          }
        },
        precondition,
      );
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION) return false;
      throw error;
    }
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
    return withPairWriteLock(yamlPath, () => {
      cleanupOrphans(yamlPath, sidecarPath);
      const result = pairWriteImpl(yamlPath, yamlContent, sidecarPath, state);
      if (!result) throw new Error(`Unconditional pair write refused for ${yamlPath}.`);
      return result;
    });
  },

  pairWriteCreateExclusive(
    yamlPath: string,
    yamlContent: string,
    sidecarPath: string,
    state: ActionRuntimeState,
    precondition?: () => boolean,
  ): PairWriteResult | null {
    try {
      return withPairWriteLock(
        yamlPath,
        () => {
          if (precondition && !precondition()) return null;
          cleanupOrphans(yamlPath, sidecarPath);
          return pairWriteImpl(
            yamlPath,
            yamlContent,
            sidecarPath,
            state,
            precondition,
            precondition,
            undefined,
            true,
          );
        },
        precondition,
      );
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION) return null;
      throw error;
    }
  },

  pairWriteConditional(
    yamlPath: string,
    yamlContent: string,
    sidecarPath: string,
    state: ActionRuntimeState,
    precondition: () => boolean,
    yamlPublicationPrecondition?: () => boolean,
    expectedYamlContent?: string,
    witnesses: readonly NativePublicationWitness[] = [],
  ): PairWriteResult | null {
    try {
      return withPairWriteLock(
        yamlPath,
        () => {
          if (!precondition()) return null;
          cleanupOrphans(yamlPath, sidecarPath);
          return pairWriteImpl(
            yamlPath,
            yamlContent,
            sidecarPath,
            state,
            precondition,
            yamlPublicationPrecondition,
            expectedYamlContent,
            false,
            witnesses,
          );
        },
        precondition,
      );
    } catch (error) {
      if (error === ACTION_WRITE_PRECONDITION) return null;
      throw error;
    }
  },
};
