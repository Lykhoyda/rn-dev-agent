import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PROCESS_NAME_NEEDLE = 'cdp-bridge';
function defaultProjectRoot() {
    return process.env.CLAUDE_USER_CWD ?? process.cwd();
}
function defaultProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
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
export function defaultProcessName(pid) {
    try {
        const out = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 1000,
        });
        return out.trim() || null;
    }
    catch {
        return null;
    }
}
function hashProjectRoot(projectRoot) {
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
    opts;
    lockPath;
    acquired = false;
    constructor(opts = {}) {
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
            maxAgeMs: opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
            processNameNeedle: opts.processNameNeedle ?? DEFAULT_PROCESS_NAME_NEEDLE,
        };
        this.lockPath = join(tmpDir, `rn-dev-agent-cdp-${uid}-${hash}.lock`);
    }
    acquire() {
        const existing = this.readExisting();
        if (existing && this.isLockLive(existing)) {
            return {
                status: 'conflict',
                lockPath: this.lockPath,
                pid: existing.pid,
                projectRoot: existing.projectRoot,
                startedAt: existing.startedAt,
                ageMs: this.opts.clock() - existing.startedAt,
                version: existing.version,
            };
        }
        this.writeLock();
        this.acquired = true;
        return { status: 'acquired', lockPath: this.lockPath };
    }
    release() {
        if (!this.acquired)
            return;
        try {
            if (existsSync(this.lockPath)) {
                const body = this.readExisting();
                if (body?.pid === this.opts.pid) {
                    unlinkSync(this.lockPath);
                }
            }
        }
        catch {
            // Swallow: release must never fail the shutdown path.
        }
        this.acquired = false;
    }
    readExisting() {
        if (!existsSync(this.lockPath))
            return null;
        try {
            const raw = readFileSync(this.lockPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!isValidLockBody(parsed))
                return null;
            return parsed;
        }
        catch {
            return null;
        }
    }
    isLockLive(body) {
        if (!this.opts.processAlive(body.pid))
            return false;
        const age = this.ageOfLockFile();
        if (age !== null && age > this.opts.maxAgeMs)
            return false;
        const name = this.opts.processName(body.pid);
        if (name !== null && !name.toLowerCase().includes(this.opts.processNameNeedle.toLowerCase())) {
            return false;
        }
        return true;
    }
    ageOfLockFile() {
        try {
            const st = statSync(this.lockPath);
            return this.opts.clock() - st.mtimeMs;
        }
        catch {
            return null;
        }
    }
    writeLock() {
        const body = {
            pid: this.opts.pid,
            projectRoot: this.opts.projectRoot,
            startedAt: this.opts.clock(),
            version: this.opts.version || undefined,
        };
        const dir = this.opts.tmpDir;
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.lockPath, JSON.stringify(body, null, 2), { encoding: 'utf8' });
    }
}
function isValidLockBody(obj) {
    if (typeof obj !== 'object' || obj === null)
        return false;
    const o = obj;
    return (typeof o.pid === 'number' &&
        typeof o.projectRoot === 'string' &&
        typeof o.startedAt === 'number');
}
export function formatLockConflictMessage(conflict) {
    const ageSec = Math.floor(conflict.ageMs / 1000);
    const ageStr = ageSec < 60
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
