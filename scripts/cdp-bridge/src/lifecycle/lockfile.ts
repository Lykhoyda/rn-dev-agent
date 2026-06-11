import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROCESS_NAME_NEEDLE = 'cdp-bridge';
// GH #182: heartbeat-staleness window. A healthy bridge refreshes lastHeartbeat
// well within this (index.ts touches every ~30s); a wedged bridge stops, so its
// lock becomes reclaimable. Matches device-lock.ts's 90s.
const DEFAULT_STALE_MS = 90_000;

export interface LockfileOptions {
  projectRoot?: string;
  pid?: number;
  version?: string;
  tmpDir?: string;
  uid?: number;
  clock?: () => number;
  processAlive?: (pid: number) => boolean;
  processName?: (pid: number) => string | null;
  /** GH #182: resolve a PID's parent PID (PPID). A live owner whose PPID *changed* from the one it recorded was orphaned (its CC died). */
  processParent?: (pid: number) => number | null;
  /** GH #182: our own PPID, recorded at acquire so a contender can later detect we were orphaned (parent changed). */
  selfPpid?: () => number;
  maxAgeMs?: number;
  processNameNeedle?: string;
  /** GH #182: heartbeat-staleness window in ms (a live owner past this is wedged → reclaimable). */
  staleMs?: number;
}

export interface LockAcquired {
  status: 'acquired';
  lockPath: string;
  /** GH#251: an fs infra error (not contention) made the exclusive create impossible — single-instance protection is off this session, but the bridge still starts (fail-open, mirrors DeviceLock). */
  degraded?: boolean;
}

export interface LockConflict {
  status: 'conflict';
  lockPath: string;
  pid: number;
  projectRoot: string;
  startedAt: number;
  ageMs: number;
  version?: string;
}

export type LockAcquireResult = LockAcquired | LockConflict;

interface LockFileBody {
  pid: number;
  projectRoot: string;
  startedAt: number;
  version?: string;
  /** GH #182: refreshed by Lockfile.touch() while the owner is healthy; absent on pre-0.39 locks. */
  lastHeartbeat?: number;
  /** GH #182: the owner's PPID at acquire. A contender reclaims if the owner's *live* PPID differs (parent died → reparented). Absent on pre-0.39 locks. */
  ppid?: number;
}

function defaultProjectRoot(): string {
  return process.env.CLAUDE_USER_CWD ?? process.cwd();
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a PID to its full command line for process-identity matching.
 *
 * Uses `ps -o args=` (not `-o comm=`). Both BSD ps (macOS) and procps (Linux) honor
 * `args=` and emit the full command line — e.g. `node /path/to/cdp-bridge/dist/index.js`.
 * `comm=` would return only the executable basename (`"node"`) which never contains our
 * needle `cdp-bridge` — caught by multi-review before ship (D652 implementation notes).
 */
export function defaultProcessName(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * GH #182: resolve a PID's parent PID via `ps -p <pid> -o ppid=`. A cdp-bridge
 * whose PPID is 1 has been reparented to init/launchd — i.e. its Claude Code host
 * died and it's now a live orphan. Returns null on any failure (caller fails safe:
 * a null PPID never triggers reclaim). Mirrors defaultProcessName's `ps` usage.
 */
export function defaultProcessParent(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    const ppid = parseInt(out.trim(), 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * GH #182: our own parent PID, recorded at acquire. Compared later against the
 * owner's *live* PPID — if they differ, the owner's parent (the Claude Code host)
 * died and it was reparented, so it's a live orphan.
 * B200: Node exposes the parent pid as the `process.ppid` PROPERTY — there is
 * no process.getppid() function. The old feature-detect always fell back to 0,
 * recording ppid:0 in every lock; isLockLive's orphan check then read any live
 * holder as reparented (livePpid !== 0) and stole its lock.
 */
export function defaultSelfPpid(): number {
  return typeof process.ppid === 'number' ? process.ppid : 0;
}

function hashProjectRoot(projectRoot: string): string {
  return createHash('md5').update(resolve(projectRoot)).digest('hex').slice(0, 8);
}

/**
 * Single-instance gate for the MCP subprocess (M3 / Phase 90 Tier 1).
 *
 * Two Claude Code windows opened in the same project would spawn two MCP subprocesses,
 * both racing for the single Hermes CDP slot and producing missed events + state flicker.
 * This module writes a lock file at startup keyed on the user's uid + an 8-char hash of
 * the project root, so:
 *   - same project, two windows → conflict (exit 11)
 *   - different projects, same machine → coexist fine (different hash)
 *   - different users on the same machine → coexist fine (different uid)
 *
 * Stale lock detection has three orthogonal checks (any failure ⇒ reclaim):
 *   1. PID alive via `process.kill(pid, 0)` — catches crashed predecessors
 *   2. Process name matches `cdp-bridge` via `ps -p <pid> -o args=` — catches PID reuse after reboot
 *   3. Lock mtime < 24h — catches SIGKILL'd processes that left orphan locks
 *
 * All side effects are injectable (tmpDir, clock, processAlive, processName) so unit tests
 * run fully hermetic without touching /tmp or spawning ps.
 */
export class Lockfile {
  private readonly opts: Required<LockfileOptions>;
  readonly lockPath: string;
  private acquired = false;

  constructor(opts: LockfileOptions = {}) {
    const projectRoot = opts.projectRoot ?? defaultProjectRoot();
    const uid = opts.uid ?? userInfo().uid;
    const tmpDir = opts.tmpDir ?? tmpdir();
    const hash = hashProjectRoot(projectRoot);

    this.opts = {
      projectRoot,
      uid,
      tmpDir,
      pid: opts.pid ?? process.pid,
      version: opts.version ?? '',
      clock: opts.clock ?? Date.now,
      processAlive: opts.processAlive ?? defaultProcessAlive,
      processName: opts.processName ?? defaultProcessName,
      processParent: opts.processParent ?? defaultProcessParent,
      selfPpid: opts.selfPpid ?? defaultSelfPpid,
      maxAgeMs: opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
      processNameNeedle: opts.processNameNeedle ?? DEFAULT_PROCESS_NAME_NEEDLE,
      staleMs: opts.staleMs ?? DEFAULT_STALE_MS,
    };

    this.lockPath = join(tmpDir, `rn-dev-agent-cdp-${uid}-${hash}.lock`);
  }

  // GH#251: acquire via atomic exclusive-create (same pattern as DeviceLock).
  // The previous read-then-writeFileSync let two bridges starting in the same
  // instant both see no live lock and both "acquire" — the second silently
  // truncating the first. With 'wx' the loser gets EEXIST and evaluates the
  // winner's lock as a conflict. Infra errors (not contention) fail OPEN with
  // `degraded` so an fs hiccup never blocks a legitimate session.
  acquire(): LockAcquireResult {
    try {
      this.writeLock();
      this.acquired = true;
      return { status: 'acquired', lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        return { status: 'acquired', lockPath: this.lockPath, degraded: true };
      }
    }

    const existing = this.readExisting();
    if (existing && this.isLockLive(existing)) {
      return this.conflictOf(existing);
    }

    // Stale/dead/unreadable holder → reclaim. Narrow the steal-a-fresh-lock
    // window: re-read immediately before unlink and bail if a DIFFERENT,
    // now-live holder appeared since the staleness judgment. The post-unlink
    // race is still caught atomically — 'wx' throws EEXIST if another bridge
    // created a fresh lock in the gap.
    const before = this.readExisting();
    if (
      before &&
      (existing === null || before.pid !== existing.pid || before.startedAt !== existing.startedAt) &&
      this.isLockLive(before)
    ) {
      return this.conflictOf(before);
    }
    try { unlinkSync(this.lockPath); } catch { /* already gone */ }
    try {
      this.writeLock();
      this.acquired = true;
      return { status: 'acquired', lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        return { status: 'acquired', lockPath: this.lockPath, degraded: true };
      }
      const raced = this.readExisting();
      return raced
        ? this.conflictOf(raced)
        : { status: 'acquired', lockPath: this.lockPath, degraded: true };
    }
  }

  private conflictOf(body: LockFileBody): LockConflict {
    return {
      status: 'conflict',
      lockPath: this.lockPath,
      pid: body.pid,
      projectRoot: body.projectRoot,
      startedAt: body.startedAt,
      ageMs: this.opts.clock() - body.startedAt,
      version: body.version,
    };
  }

  release(): void {
    if (!this.acquired) return;
    try {
      if (existsSync(this.lockPath)) {
        const body = this.readExisting();
        if (body?.pid === this.opts.pid) {
          unlinkSync(this.lockPath);
        }
      }
    } catch {
      // Swallow: release must never fail the shutdown path.
    }
    this.acquired = false;
  }

  /**
   * GH #182: refresh our heartbeat so a healthy bridge's lock never looks stale.
   *
   * Returns whether we STILL own the lock. If another bridge usurped our slot — the
   * sleep/wake case: the laptop slept, our heartbeat went stale, a new session
   * reclaimed, and we just woke — `body.pid` is now foreign. We must NOT overwrite
   * (that would resurrect a lock we no longer hold and produce two live bridges on
   * one device, Gemini HIGH); we return `false` so the caller self-terminates.
   * Best-effort on I/O (a failed write returns true — we still own it, just stale).
   */
  touch(): boolean {
    if (!this.acquired) return false;
    const body = this.readExisting();
    if (!body || body.pid !== this.opts.pid) return false; // usurped → caller should exit
    body.lastHeartbeat = this.opts.clock();
    try {
      writeFileSync(this.lockPath, JSON.stringify(body, null, 2), { encoding: 'utf8' });
    } catch {
      // Best-effort: a failed heartbeat just means the lock may look stale sooner.
    }
    return true;
  }

  private readExisting(): LockFileBody | null {
    if (!existsSync(this.lockPath)) return null;
    try {
      const raw = readFileSync(this.lockPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidLockBody(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private isLockLive(body: LockFileBody): boolean {
    if (!this.opts.processAlive(body.pid)) return false;

    const age = this.ageOfLockFile();
    if (age !== null && age > this.opts.maxAgeMs) return false;

    const name = this.opts.processName(body.pid);
    if (name !== null && !name.toLowerCase().includes(this.opts.processNameNeedle.toLowerCase())) {
      return false;
    }

    // GH #182: a LIVE owner whose parent CHANGED since it acquired the lock was
    // orphaned — its Claude Code host died and it was reparented. PID-alive alone
    // can't catch a live orphan. We compare the owner's *recorded* PPID against its
    // *live* PPID rather than testing `=== 1`, because in a container where CC runs
    // as PID 1 (no init system) a healthy bridge legitimately has PPID 1 — testing
    // `=== 1` would steal a healthy lock and self-exit on every tick (Gemini HIGH).
    // A null live lookup fails safe (treated as live, never reclaimed).
    const livePpid = this.opts.processParent(body.pid);
    if (livePpid !== null) {
      if (typeof body.ppid === 'number') {
        if (livePpid !== body.ppid) return false; // parent changed → orphaned
      } else if (livePpid === 1) {
        // Pre-0.39 lock with no recorded PPID: best-effort legacy reclaim. PPID 1
        // means reparented to init. The container false-positive is bounded to the
        // upgrade window (the next acquire rewrites a ppid-bearing lock).
        return false;
      }
    }

    // GH #182: a live owner whose heartbeat went stale is wedged (event loop blocked,
    // no longer refreshing) — reclaim. Skipped for pre-0.39 locks with no
    // lastHeartbeat (they fall back to the mtime check above).
    if (
      typeof body.lastHeartbeat === 'number' &&
      this.opts.clock() - body.lastHeartbeat > this.opts.staleMs
    ) {
      return false;
    }

    return true;
  }

  private ageOfLockFile(): number | null {
    try {
      const st = statSync(this.lockPath);
      return this.opts.clock() - st.mtimeMs;
    } catch {
      return null;
    }
  }

  private writeLock(): void {
    const body: LockFileBody = {
      pid: this.opts.pid,
      projectRoot: this.opts.projectRoot,
      startedAt: this.opts.clock(),
      lastHeartbeat: this.opts.clock(),
      ppid: this.opts.selfPpid(),
      version: this.opts.version || undefined,
    };

    const dir = this.opts.tmpDir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // GH#251: atomic exclusive create — throws EEXIST if another bridge won the race.
    const fd = openSync(this.lockPath, 'wx');
    try {
      writeSync(fd, JSON.stringify(body, null, 2));
    } finally {
      closeSync(fd);
    }
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

function isValidLockBody(obj: unknown): obj is LockFileBody {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.pid === 'number' &&
    typeof o.projectRoot === 'string' &&
    typeof o.startedAt === 'number'
  );
}

export function formatLockConflictMessage(conflict: LockConflict): string {
  const ageSec = Math.floor(conflict.ageMs / 1000);
  const ageStr =
    ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)}m ago`
        : `${Math.floor(ageSec / 3600)}h ${Math.floor((ageSec % 3600) / 60)}m ago`;

  return [
    `Another rn-dev-agent MCP is running in this project.`,
    `  PID:      ${conflict.pid}`,
    `  Project:  ${conflict.projectRoot}`,
    `  Started:  ${ageStr}`,
    `  Lock:     ${conflict.lockPath}`,
    ``,
    `To resolve:`,
    `  1. Close the other Claude Code window for this project, OR`,
    `  2. Kill the other process:  kill ${conflict.pid}`,
    `  3. (If the process is dead) delete the lock file:  rm ${conflict.lockPath}`,
    ``,
    `Running two MCPs in the same project causes missed events and state flicker.`,
    `Start with --no-lock to bypass this check (advanced; expect flaky behavior).`,
  ].join('\n');
}
