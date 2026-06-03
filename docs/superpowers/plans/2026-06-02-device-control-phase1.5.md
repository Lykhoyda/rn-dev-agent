# Device Control Phase 1.5 — Persisted UDID Simulator-Ownership Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the multi-bridge race — two Claude Code windows (two bridge processes) targeting the *same* iOS simulator — by adding a persisted, UDID-scoped ownership lock acquired lazily at `device_snapshot action=open`, with PID-liveness + heartbeat self-healing so it can never orphan the way the original `daemon.lock` did.

**Architecture:** A new `lifecycle/device-lock.ts` mirrors the existing `lifecycle/lockfile.ts` (injectable deps, hermetic tests) but (a) keys on the simulator **UDID** instead of the project root, (b) uses an **atomic `open(path,'wx')`** create instead of read-then-write, and (c) carries a **heartbeat** that a ~30s unref'd timer refreshes — so a crashed bridge's lock becomes reclaimable once its PID is dead *or* its heartbeat goes stale (>90s). It is **additive**: the existing projectRoot bridge lock is untouched. Wired into the iOS `device_snapshot` open/close lifecycle: acquire after the UDID is resolved; on conflict, tear the session back down and return `DEVICE_BUSY`; release on close and on process exit.

**Tech Stack:** Node.js ≥22 (ESM), TypeScript, `node --test` (tests in `scripts/cdp-bridge/test/unit/`, run after `npm run build`, import compiled JS from `../../dist/`). Test style mirrors `test/unit/lockfile.test.js`: a real `mkdtempSync` temp dir + injected `clock`/`processAlive` (no fs mocking).

**Branch:** stack on Phase 1 — create `feat/202-phase1.5-device-lock` **from `feat/202-device-control-arbiter`** (PR #205's branch). This phase depends on nothing in #200/main beyond Phase 1.

**Spec:** `docs/superpowers/specs/2026-06-01-device-control-arbiter-design.md` §4.

**All commits** end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Repo rules (carry over from Phase 1):**
- Untracked `.superpowers/` and `scripts/cdp-bridge/eval/` exist — stage ONLY each task's files with explicit `git add <path>`. NEVER `git add -A`.
- **`dist/` is TRACKED** — after the final `npm run build`, also stage the recompiled `dist/` outputs for the TS files you changed.
- Commit signing (1Password SSH agent) is on; if a commit fails with a 1Password socket error, STOP and report BLOCKED.
- Explicit type imports; no unnecessary comments.

**Working directory for all commands:** `scripts/cdp-bridge/` unless stated.

---

## Task 0: Branch + baseline

**Files:** none (setup/verification)

- [ ] **Step 1: Create the stacked branch from the Phase 1 branch**

Run (from repo root):
```bash
git checkout feat/202-device-control-arbiter && git checkout -b feat/202-phase1.5-device-lock && git branch --show-current
```
Expected: `feat/202-phase1.5-device-lock`.

- [ ] **Step 2: Confirm green baseline**

Run:
```bash
cd scripts/cdp-bridge && npm run build && npm test 2>&1 | tail -6
```
Expected: build clean; suite green (1609 pass after Phase 1 + its cleanup). If red, stop and report.

---

## Task 1: `device-lock.ts` — the UDID-scoped ownership lock

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/device-lock.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-device-lock.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-202-device-lock.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceLock, isDeviceLockStale } from '../../dist/lifecycle/device-lock.js';

const UDID = '78F7D2A1-1022-4BCE-8787-C0E130EF9831';
const FIXED = 1_700_000_000_000;

function tmp() {
  return mkdtempSync(join(tmpdir(), 'device-lock-test-'));
}

function makeLock(dir, over = {}) {
  return new DeviceLock({
    udid: UDID,
    projectRoot: over.projectRoot ?? '/proj/a',
    appId: over.appId ?? 'com.example.app',
    pid: over.pid ?? 4242,
    uid: 501,
    tmpDir: dir,
    version: '0-test',
    clock: over.clock ?? (() => FIXED),
    processAlive: over.processAlive ?? (() => true),
    staleMs: over.staleMs ?? 90_000,
  });
}

test('GH#202 isDeviceLockStale: stale when PID dead OR heartbeat too old, fresh otherwise', () => {
  const body = { pid: 1, projectRoot: '/p', platform: 'ios', udid: UDID, startedAt: FIXED, lastHeartbeat: FIXED };
  assert.equal(isDeviceLockStale(body, FIXED, () => false, 90_000), true);            // dead PID
  assert.equal(isDeviceLockStale(body, FIXED + 91_000, () => true, 90_000), true);    // stale heartbeat
  assert.equal(isDeviceLockStale(body, FIXED + 1_000, () => true, 90_000), false);    // alive + fresh
});

test('GH#202 DeviceLock.acquire: clean state → acquired, writes body keyed on UDID', () => {
  const dir = tmp();
  try {
    const lock = makeLock(dir);
    const r = lock.acquire();
    assert.equal(r.status, 'acquired');
    assert.ok(lock.lockPath.includes(`device-501-ios-${UDID}`));
    assert.ok(existsSync(lock.lockPath));
    const body = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    assert.equal(body.udid, UDID);
    assert.equal(body.pid, 4242);
    assert.equal(body.platform, 'ios');
    assert.equal(body.startedAt, FIXED);
    assert.equal(body.lastHeartbeat, FIXED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: conflict when a LIVE holder owns the UDID', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111 }).acquire();                       // holder writes the file
    const r = makeLock(dir, { pid: 2222, processAlive: () => true, clock: () => FIXED + 1_000 }).acquire();
    assert.equal(r.status, 'conflict');
    assert.equal(r.holder.pid, 1111);
    assert.equal(r.holder.udid, UDID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: reclaims when holder PID is dead', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111 }).acquire();
    const r = makeLock(dir, { pid: 2222, processAlive: () => false }).acquire();      // holder dead
    assert.equal(r.status, 'acquired');
    assert.equal(JSON.parse(readFileSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`), 'utf8')).pid, 2222);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.acquire: reclaims when holder heartbeat is stale', () => {
  const dir = tmp();
  try {
    makeLock(dir, { pid: 1111, clock: () => FIXED }).acquire();   // heartbeat = FIXED
    const r = makeLock(dir, { pid: 2222, processAlive: () => true, clock: () => FIXED + 91_000 }).acquire();
    assert.equal(r.status, 'acquired');                           // 91s > 90s staleMs
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.touch: refreshes lastHeartbeat for the owner', () => {
  const dir = tmp();
  try {
    let t = FIXED;
    const lock = makeLock(dir, { pid: 7, clock: () => t });
    lock.acquire();
    t = FIXED + 30_000;
    lock.touch();
    assert.equal(JSON.parse(readFileSync(lock.lockPath, 'utf8')).lastHeartbeat, FIXED + 30_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.release: unlinks only when we are the owner', () => {
  const dir = tmp();
  try {
    const owner = makeLock(dir, { pid: 7 });
    owner.acquire();
    assert.ok(existsSync(owner.lockPath));
    owner.release();
    assert.ok(!existsSync(owner.lockPath));

    // A non-owner that never acquired must not delete someone else's lock.
    writeFileSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`),
      JSON.stringify({ pid: 999, projectRoot: '/p', platform: 'ios', udid: UDID, startedAt: FIXED, lastHeartbeat: FIXED }), 'utf8');
    makeLock(dir, { pid: 8 }).release();   // never acquired → no-op
    assert.ok(existsSync(join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock.touch: does NOT resurrect a lock another bridge reclaimed (pid changed)', () => {
  const dir = tmp();
  try {
    const owner = makeLock(dir, { pid: 7 });
    owner.acquire();
    // Simulate another bridge legitimately reclaiming (writes its own pid).
    writeFileSync(owner.lockPath,
      JSON.stringify({ pid: 999, projectRoot: '/proj/b', platform: 'ios', udid: UDID, startedAt: 1, lastHeartbeat: 1 }), 'utf8');
    owner.touch();   // we no longer own it → must NOT overwrite
    assert.equal(JSON.parse(readFileSync(owner.lockPath, 'utf8')).pid, 999);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock: a foreign/corrupt body is treated as reclaimable', () => {
  const dir = tmp();
  try {
    const lockPath = join(dir, `rn-dev-agent-device-501-ios-${UDID}.lock`);
    // Wrong platform → invalid → reclaimable even though the PID looks alive.
    writeFileSync(lockPath, JSON.stringify({ pid: 1, projectRoot: '/p', platform: 'android', udid: UDID, startedAt: 1, lastHeartbeat: 9_999_999_999_999 }), 'utf8');
    const r = makeLock(dir, { pid: 2222, processAlive: () => true }).acquire();
    assert.equal(r.status, 'acquired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock.test.js
```
Expected: FAIL — `dist/lifecycle/device-lock.js` does not exist (import error).

- [ ] **Step 3: Implement the module**

Create `src/lifecycle/device-lock.ts`:
```ts
import {
  existsSync, mkdirSync, openSync, writeSync, closeSync,
  readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const DEFAULT_STALE_MS = 90_000;

export interface DeviceLockBody {
  pid: number;
  projectRoot: string;
  platform: 'ios';
  udid: string;
  appId?: string;
  startedAt: number;
  lastHeartbeat: number;
  version?: string;
}

export interface DeviceLockAcquired { status: 'acquired'; lockPath: string; degraded?: boolean }
export interface DeviceLockConflict { status: 'conflict'; lockPath: string; holder: DeviceLockBody }
export type DeviceLockResult = DeviceLockAcquired | DeviceLockConflict;

export interface DeviceLockOptions {
  udid: string;
  projectRoot?: string;
  appId?: string;
  pid?: number;
  uid?: number;
  tmpDir?: string;
  version?: string;
  clock?: () => number;
  processAlive?: (pid: number) => boolean;
  staleMs?: number;
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * GH#202 Phase 1.5: a holder is reclaimable when its process is dead OR its
 * heartbeat has gone stale (a crashed bridge stops refreshing the file). This
 * is the liveness check the original daemon.lock lacked — which is why it
 * orphaned and caused #202.
 */
export function isDeviceLockStale(
  body: DeviceLockBody,
  now: number,
  processAlive: (pid: number) => boolean,
  staleMs: number,
): boolean {
  if (!processAlive(body.pid)) return true;
  return now - body.lastHeartbeat > staleMs;
}

/**
 * Persisted, UDID-scoped ownership lock for one iOS simulator. Additive to the
 * projectRoot bridge lock (lifecycle/lockfile.ts) — that one stops two windows
 * of the SAME project; this one stops two DIFFERENT projects' bridges driving
 * the SAME simulator. Acquired lazily at device_snapshot action=open once the
 * UDID is known (it is not known at bridge startup).
 */
export class DeviceLock {
  readonly lockPath: string;
  private acquired = false;
  private readonly pid: number;
  private readonly udid: string;
  private readonly projectRoot: string;
  private readonly appId?: string;
  private readonly version?: string;
  private readonly clock: () => number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly staleMs: number;
  private readonly tmpDir: string;

  constructor(opts: DeviceLockOptions) {
    this.udid = opts.udid;
    this.projectRoot = opts.projectRoot ?? (process.env.CLAUDE_USER_CWD ?? process.cwd());
    const uid = opts.uid ?? userInfo().uid;
    this.tmpDir = opts.tmpDir ?? tmpdir();
    this.pid = opts.pid ?? process.pid;
    this.appId = opts.appId;
    this.version = opts.version;
    this.clock = opts.clock ?? Date.now;
    this.processAlive = opts.processAlive ?? defaultProcessAlive;
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.lockPath = join(this.tmpDir, `rn-dev-agent-device-${uid}-ios-${this.udid}.lock`);
  }

  acquire(): DeviceLockResult {
    try {
      this.create();
      return { status: 'acquired', lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        // Infra error (not ownership contention) → fail-open, UNMANAGED.
        // `acquired` stays false so touch()/release() no-op; the caller is
        // told via `degraded` that cross-bridge protection is off this session.
        return { status: 'acquired', lockPath: this.lockPath, degraded: true };
      }
    }
    const holder = this.readExisting();
    if (holder && !isDeviceLockStale(holder, this.clock(), this.processAlive, this.staleMs)) {
      return { status: 'conflict', lockPath: this.lockPath, holder };
    }
    // Stale/dead/unreadable holder → reclaim. Narrow the steal-a-fresh-lock
    // window (#202 review): re-read immediately before unlink and bail if a
    // DIFFERENT, now-live holder appeared since our staleness judgment. The
    // post-unlink race is still caught atomically — create('wx') throws EEXIST
    // if another bridge created a fresh lock in the gap → surfaced as conflict.
    const before = this.readExisting();
    if (
      before &&
      (holder === null || before.pid !== holder.pid || before.startedAt !== holder.startedAt) &&
      !isDeviceLockStale(before, this.clock(), this.processAlive, this.staleMs)
    ) {
      return { status: 'conflict', lockPath: this.lockPath, holder: before };
    }
    try { unlinkSync(this.lockPath); } catch { /* already gone */ }
    try {
      this.create();
      return { status: 'acquired', lockPath: this.lockPath };
    } catch (err) {
      if (!isEexist(err)) {
        return { status: 'acquired', lockPath: this.lockPath, degraded: true };
      }
      const raced = this.readExisting();
      return raced
        ? { status: 'conflict', lockPath: this.lockPath, holder: raced }
        : { status: 'acquired', lockPath: this.lockPath, degraded: true };
    }
  }

  touch(): void {
    if (!this.acquired) return;
    const holder = this.readExisting();
    if (!holder || holder.pid !== this.pid) return;
    holder.lastHeartbeat = this.clock();
    try { writeFileSync(this.lockPath, JSON.stringify(holder, null, 2), 'utf8'); } catch { /* best-effort */ }
  }

  release(): void {
    if (!this.acquired) return;
    try {
      const holder = this.readExisting();
      if (holder?.pid === this.pid) unlinkSync(this.lockPath);
    } catch { /* release must never fail shutdown */ }
    this.acquired = false;
  }

  private create(): void {
    if (!existsSync(this.tmpDir)) mkdirSync(this.tmpDir, { recursive: true });
    const fd = openSync(this.lockPath, 'wx'); // atomic exclusive create — throws EEXIST if present
    try {
      const now = this.clock();
      const body: DeviceLockBody = {
        pid: this.pid,
        projectRoot: this.projectRoot,
        platform: 'ios',
        udid: this.udid,
        appId: this.appId,
        startedAt: now,
        lastHeartbeat: now,
        version: this.version,
      };
      writeSync(fd, JSON.stringify(body, null, 2));
    } finally {
      closeSync(fd);
    }
    this.acquired = true;
  }

  private readExisting(): DeviceLockBody | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, 'utf8')) as unknown;
      if (!isValidBody(parsed)) return null;
      // A body for a different UDID on our path is foreign/corrupt → reclaimable.
      if (parsed.udid !== this.udid) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EEXIST';
}

function isValidBody(o: unknown): o is DeviceLockBody {
  if (typeof o !== 'object' || o === null) return false;
  const b = o as Record<string, unknown>;
  return (
    typeof b.pid === 'number' && Number.isFinite(b.pid) &&
    typeof b.udid === 'string' && b.udid.length > 0 &&
    typeof b.projectRoot === 'string' &&
    b.platform === 'ios' &&
    typeof b.startedAt === 'number' && Number.isFinite(b.startedAt) &&
    typeof b.lastHeartbeat === 'number' && Number.isFinite(b.lastHeartbeat)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock.test.js
```
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd scripts/cdp-bridge && git add src/lifecycle/device-lock.ts test/unit/gh-202-device-lock.test.js dist/lifecycle/device-lock.js
git commit -m "feat(device-lock): UDID-scoped simulator ownership lock with heartbeat (#202 Phase 1.5)"
```
(Co-Authored-By trailer; verify `git diff --cached --name-only` is only these 3 files.)

---

## Task 2: Wire the lock into the iOS `device_snapshot` open/close lifecycle

Acquire after the UDID resolves; on conflict, tear the just-opened session back down and return `DEVICE_BUSY`; start a heartbeat while held; release on close and on process exit.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (imports + module singletons + open path after `setActiveSession` + close path)
- Modify: `scripts/cdp-bridge/src/index.ts` (release on process exit)
- Test: `scripts/cdp-bridge/test/unit/gh-202-device-lock-wiring.test.js`

- [ ] **Step 1: Write the failing wiring test (source-grep — the handler needs a live sim, so the lock SEMANTICS are unit-tested in Task 1; here we assert the wiring exists)**

Create `test/unit/gh-202-device-lock-wiring.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#202 device-open acquires the UDID lock and refuses on conflict', () => {
  assert.match(sessionSrc, /acquireDeviceLockForSession\(deviceId, appId\)/);
  assert.match(sessionSrc, /DEVICE_BUSY/);
});

test('GH#202 conflict teardown closes BEFORE clearing the session (order matters)', () => {
  // runAgentDevice(['close']) must precede clearActiveSession() in the conflict path.
  assert.match(
    sessionSrc,
    /runAgentDevice\(\['close'\]\)[\s\S]{0,200}clearActiveSession\(\)[\s\S]{0,300}DEVICE_BUSY/,
  );
});

test('GH#202 acquire helper is single-owner (releases prior lock first)', () => {
  // releaseDeviceLockForSession() must run at the top of the acquire helper
  // (before `new DeviceLock`) so a second open cannot leak the heartbeat timer.
  assert.match(
    sessionSrc,
    /function acquireDeviceLockForSession[\s\S]{0,260}releaseDeviceLockForSession\(\)[\s\S]{0,160}new DeviceLock/,
  );
});

test('GH#202 a degraded (fs-error) lock acquire is surfaced as a warning', () => {
  assert.match(sessionSrc, /lockResult\.degraded/);
});

test('GH#202 device-close releases the UDID lock', () => {
  assert.match(sessionSrc, /releaseDeviceLockForSession\(\)/);
});

test('GH#202 process exit releases the UDID lock', () => {
  assert.match(indexSrc, /releaseDeviceLockForSession/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock-wiring.test.js
```
Expected: FAIL — none of those symbols exist yet.

- [ ] **Step 3: Add the session-lock helpers + imports in `device-session.ts`**

At the top of `src/tools/device-session.ts`, add to the imports:
```ts
import { DeviceLock } from '../lifecycle/device-lock.js';
import type { DeviceLockResult } from '../lifecycle/device-lock.js';
```
Then, just below the existing top-level `const execFile = promisify(execFileCb);` (line ~27), add the module singletons + helpers:
```ts
const HEARTBEAT_MS = 30_000;
let activeDeviceLock: DeviceLock | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function acquireDeviceLockForSession(udid: string, appId: string): DeviceLockResult {
  // Single-owner: drop any prior lock + heartbeat before taking a new one, so a
  // second open without an intervening close can't leak a timer or orphan a
  // lock (release is null-safe). (#202 plan review — blocker fix.)
  releaseDeviceLockForSession();
  const lock = new DeviceLock({ udid, appId });
  const result = lock.acquire();
  // Only manage a heartbeat for a REAL exclusive lock — a degraded (fs-error)
  // acquire is unmanaged, so there is nothing to refresh or release.
  if (result.status === 'acquired' && !result.degraded) {
    activeDeviceLock = lock;
    heartbeatTimer = setInterval(() => lock.touch(), HEARTBEAT_MS);
    // Don't keep the event loop alive solely for the heartbeat (mirrors bgPoll).
    heartbeatTimer.unref();
  }
  return result;
}

export function releaseDeviceLockForSession(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (activeDeviceLock) { activeDeviceLock.release(); activeDeviceLock = null; }
}
```

- [ ] **Step 4: Acquire in the open success path (iOS only), refuse on conflict**

In `src/tools/device-session.ts`, in the `action === 'open'` success branch, immediately AFTER the `setActiveSession({ ... })` call (~line 183) and BEFORE the `ensureSingleRunner` block, insert the block below.

**First** ensure a normalized iOS check is in scope: read the open branch and find/introduce `const platform = (args.platform ?? 'ios').toLowerCase();`. A `device_snapshot action=open` with `appId` set but `platform` OMITTED still opens an iOS session (agent-device picks the booted sim), so gating the lock on the raw `args.platform === 'ios'` would silently skip it (#202 plan review — blocker fix). Gate on the normalized `platform === 'ios'`. (If a normalized `platform` already exists in this scope, reuse it; do not shadow.)

```ts
        // GH#202 Phase 1.5: claim exclusive ownership of THIS simulator across
        // bridge processes. The UDID is only known now (post-open). On conflict
        // another project's bridge owns the sim — tear our just-opened session
        // back down and refuse, rather than fight for foreground.
        if (platform === 'ios' && deviceId) {
          const lockResult = acquireDeviceLockForSession(deviceId, appId);
          if (lockResult.status === 'conflict') {
            // Close FIRST — runAgentDevice derives `--session` from the active
            // session, so clearing before closing would close the wrong (or no)
            // session and leak the one we just opened (#202 plan review — blocker).
            await runAgentDevice(['close']).catch(() => { /* best-effort teardown */ });
            clearActiveSession();
            stopFastRunner();
            const h = lockResult.holder;
            return failResult(
              `Simulator ${deviceId} is already owned by another rn-dev-agent bridge ` +
              `(PID ${h.pid}, project ${h.projectRoot}${h.appId ? `, app ${h.appId}` : ''}). ` +
              `Close that session or target a different simulator.`,
              { code: 'DEVICE_BUSY', holder: h },
            );
          }
          if (lockResult.degraded) {
            logger.warn(
              'rn-device',
              `Device-ownership lock unavailable (fs error) for ${deviceId} — ` +
              `cross-bridge contention protection is off this session.`,
            );
          }
        }
```

- [ ] **Step 5: Release in the close path**

In the `action === 'close'` branch, alongside the existing `stopFastRunner();` call (~line 249, inside the `if (!result.isError)` block), add `releaseDeviceLockForSession();` so a clean close frees the lock:
```ts
      if (!result.isError) {
        clearActiveSession();
        stopFastRunner();
        releaseDeviceLockForSession();
      }
```
(Read the exact current block first; insert `releaseDeviceLockForSession();` immediately after `stopFastRunner();`, preserving the surrounding code.)

- [ ] **Step 6: Release on process exit in `index.ts`**

In `src/index.ts`, add the import near the other tool imports at the top:
```ts
import { releaseDeviceLockForSession } from './tools/device-session.js';
```
Then, right after the existing `process.on('exit', () => lockfile.release());` line (~line 114), add:
```ts
  process.on('exit', () => { try { releaseDeviceLockForSession(); } catch { /* never fail exit */ } });
```
(If `device_snapshot` is registered through a handler factory rather than a direct import, add the import anyway — `releaseDeviceLockForSession` is a plain named export from `tools/device-session.ts`. Confirm the path resolves with a build.)

- [ ] **Step 7: Run the wiring test + a regression check**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock-wiring.test.js test/unit/device-session-parsing.test.js test/unit/gh-202-device-lock.test.js
```
Expected: PASS (6 wiring + the parsing suite + 9 lock tests). If the build fails on the `index.ts` import path, confirm `tools/device-session.js` exports `releaseDeviceLockForSession`.

- [ ] **Step 8: Commit**

```bash
cd scripts/cdp-bridge && git add src/tools/device-session.ts src/index.ts test/unit/gh-202-device-lock-wiring.test.js
git status --short dist   # confirm, then stage the rebuilt outputs:
git add dist/tools/device-session.js dist/index.js
git commit -m "feat(device): acquire/release UDID lock across the iOS session lifecycle (#202 Phase 1.5)"
```
(Co-Authored-By trailer; verify `git diff --cached --name-only` is only src/test/dist for this task.)

---

## Task 3: Docs + changeset + full-suite green

**Files:**
- Modify: `CLAUDE.md` (Architecture section — note the additive UDID lock)
- Create: `.changeset/device-udid-lock-202-phase15.md`
- Verify: full `npm test`

- [ ] **Step 1: Document the lock in `CLAUDE.md`**

In `CLAUDE.md`, in the Architecture section near the existing lockfile / single-instance discussion (search for `cdp-bridge` lock or the `RN_DEVICE_KILL_LEGACY` Architecture sentence ~line 116), add a sentence:
```
Since #202 Phase 1.5, iOS sessions also take a persisted, UDID-scoped ownership lock (`${TMPDIR}/rn-dev-agent-device-<uid>-ios-<udid>.lock`) at `device_snapshot action=open` — additive to the projectRoot bridge lock. It stops two *different* projects' bridges from driving the *same* simulator: the second gets `DEVICE_BUSY`. It self-heals (PID-liveness + a 30s heartbeat; a holder is reclaimable once its PID is dead or its heartbeat is >90s stale), so it cannot orphan the way the legacy `daemon.lock` did.
```

- [ ] **Step 2: Create the changeset**

Create `.changeset/device-udid-lock-202-phase15.md` (package name `rn-dev-agent-plugin`, matching the sibling changesets):
```markdown
---
"rn-dev-agent-plugin": patch
---

#202 Phase 1.5: iOS `device_snapshot action=open` now takes a persisted, UDID-scoped simulator-ownership lock — closing the multi-bridge race where two Claude Code windows (two bridge processes) could drive the same simulator. The second bridge gets a `DEVICE_BUSY` error. The lock self-heals via PID-liveness + a 30s heartbeat (reclaimable once the holder PID is dead or its heartbeat is >90s stale), so it cannot orphan like the legacy `daemon.lock`.
```

- [ ] **Step 3: Run the full unit suite**

Run:
```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -8
```
Expected: entire suite green (≈1609 + 10 new = ~1619 pass, 0 fail). Report the tally. If anything fails, investigate (docs-only changes can't affect it); do not patch source in this docs task — report BLOCKED with details if a pre-existing failure surfaces.

- [ ] **Step 4: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add CLAUDE.md .changeset/device-udid-lock-202-phase15.md
git commit -m "docs(202): document the UDID simulator-ownership lock + changeset (Phase 1.5)"
```
(Co-Authored-By trailer; verify only CLAUDE.md + the changeset are staged.)

---

## Self-Review (completed by plan author)

**Spec coverage (spec §4):**
- Path `${tmpdir}/rn-dev-agent-device-${uid}-ios-${udid}.lock`, UDID-scoped, additive to the projectRoot lock → Task 1 (`lockPath`), unchanged `lockfile.ts`. ✅
- Schema `{ pid, projectRoot, platform, udid, appId, startedAt, lastHeartbeat, version }` → Task 1 `DeviceLockBody`. ✅
- Atomic `open(...,'wx')`, lazy at `device_snapshot action=open` → Task 1 `create()` (`openSync(..,'wx')`); Task 2 acquire after `setActiveSession`. ✅
- Reclaim iff holder PID dead OR heartbeat stale (>90s), else refuse `DEVICE_BUSY` → Task 1 `isDeviceLockStale` + acquire; Task 2 conflict → `DEVICE_BUSY`. ✅
- Heartbeat ~30s; drop naive 24h-age reclaim → Task 2 `setInterval(touch, 30_000).unref()`; Task 1 uses heartbeat staleness, no age check. ✅
- Release at `close` and on process exit → Task 2 close path + `index.ts` exit handler. ✅
- Restart-safety (crash → stale heartbeat + dead PID → next bridge reclaims) → Task 1 reclaim tests (dead PID, stale heartbeat). ✅

**Placeholder scan:** none. The fail-open-on-infra-error and the `.unref()` heartbeat are concrete, deliberate behaviors, not gaps. ✅

**Type consistency:** `DeviceLock`, `DeviceLockOptions`, `DeviceLockBody`, `DeviceLockResult` (`{status:'acquired'|'conflict'}`), `isDeviceLockStale(body, now, processAlive, staleMs)`, `acquireDeviceLockForSession(udid, appId)`, `releaseDeviceLockForSession()` are used identically across every task and test. ✅

**Out of scope (do NOT build here):** Android device locking (Phase 1.5 is iOS-only — the observed contention is the iOS simulator); the in-memory `DeviceSessionArbiter` / leases / `recoverWedge` (Phase 2); Maestro-surface consolidation (Phase 3).

**Notable design decisions (worth logging in DECISIONS.md):**
- **Fail-open on non-EEXIST acquire errors** — a `/tmp` fs hiccup must never block a legitimate session; only a genuine *live* holder yields `DEVICE_BUSY`. `degraded` (unmanaged) acquires are surfaced as a `logger.warn` so the user knows protection is off.
- **Conflict tears the just-opened session back down, close-FIRST** — the UDID is only knowable post-open, so we open, discover ownership, then `runAgentDevice(['close'])` *before* `clearActiveSession()` (the close derives `--session` from the active session) and refuse with `DEVICE_BUSY`.
- **Heartbeat timer is `.unref()`'d** — it must not keep the bridge process alive on its own (mirrors the bgPoll interval).
- **Acquire helper is single-owner** — `releaseDeviceLockForSession()` runs first, so a second open without a close can't leak a timer or orphan a lock.

**Amendments applied from the multi-LLM plan review (Gemini + Codex + Claude, 2026-06-02) — all source-verified before implementation:**
- **[blocker] heartbeat-timer leak** → `acquireDeviceLockForSession` releases the prior lock first (Task 2 Step 3).
- **[blocker] conflict teardown order** → close before clear (Task 2 Step 4); `runAgentDevice` derives `--session` from the active session, so order is load-bearing.
- **[blocker] default-iOS opens skipped the lock** → gate on normalized `(args.platform ?? 'ios').toLowerCase()` (Task 2 Step 4).
- **[should-fix] reclaim race** → re-read + identity-compare immediately before `unlink`; `create('wx')` still catches the post-unlink race (Task 1 Step 3).
- **[should-fix] `touch()` resurrection** → owner-pid re-check bails if another bridge reclaimed; regression-tested (Task 1).
- **[should-fix] `degraded` consistency** → degraded acquires stay unmanaged (`acquired` false) and are warned about (Tasks 1 + 2).
- **[nice-to-have] `isValidBody` tightened** (platform/udid/finite checks) + `readExisting` rejects foreign-UDID bodies (Task 1 Step 3).
