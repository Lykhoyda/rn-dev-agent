# GH #262 — APP_NOT_INSTALLED Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recovery paths (`cdp_status` APP_DETACHED auto-relaunch, `cdp_restart hardReset`) detect a missing app bundle via ground truth (`simctl get_app_container`), report a distinct `APP_NOT_INSTALLED` code with shell-safe install advice (incl. a #201 snapshot hint), and `hardReset` falls back to app.json for its bundleId (closes the #194 BUG 2 residual).

**Architecture:** A new shared probe module (`cdp/app-installed-probe.ts`) classifies launch failures allowlist-only (`false` requires the documented `NSPOSIXErrorDomain code=2` signal; everything else is `null` — fail open). A snapshot finder in `tools/resolve-ios-app-file.ts` (which owns the #201 snapshot dir) supplies a best-effort reinstall hint under an explicit time/candidate budget. `recover-detached.ts` short-circuits on a confirmed missing bundle; `status.ts` and `restart.ts` render the advice.

**Tech Stack:** TypeScript (Node >= 22), `node:test` + `assert/strict` unit tests importing from `dist/`, injectable-deps pattern throughout.

**Spec:** `docs/superpowers/specs/2026-06-11-262-app-not-installed-recovery-design.md` (approved; codex-pair amendments applied).

---

## File Structure

All paths relative to `scripts/cdp-bridge/` unless noted.

| File | Action | Responsibility |
|---|---|---|
| `src/cdp/app-installed-probe.ts` | Create | `probeAppInstalled` (ground-truth tri-state probe), `posixSingleQuote`, `buildNotInstalledAdvice`, `SnapshotHint` type |
| `src/tools/resolve-ios-app-file.ts` | Modify | Add `findSnapshotForBundleId` + `snapshotHintForBundleId` (budgeted scan of `$TMPDIR/rn-appfile-snapshots`) |
| `src/cdp/recover-detached.ts` | Modify | New reason `'app-not-installed'`, short-circuit, `udid`/`appId`/`snapshotHint` on the result |
| `src/tools/status.ts` | Modify | Map `'app-not-installed'` → `APP_NOT_INSTALLED` failResult with advice |
| `src/tools/restart.ts` | Modify | bundleId chain gains `resolveBundleId()` fallback; `launch:err` step classified via the probe |
| `src/types.ts` | Modify | Add `'APP_NOT_INSTALLED'` to `ToolErrorCode` |
| `test/unit/gh-262-*.test.js` | Create | One test file per task (5 files) |
| `.changeset/gh-262-app-not-installed.md` | Create | patch changeset |

Working directory for all commands: `scripts/cdp-bridge/`. Branch: `feat/262-app-not-installed-recovery` (already created; spec committed).

---

### Task 1: Ground-truth probe module (`app-installed-probe.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/cdp/app-installed-probe.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-262-app-installed-probe.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-app-installed-probe.test.js`:

```js
// GH #262: ground-truth probe for "is the app bundle installed on the sim?".
// Classification is ALLOWLIST-only (codex-pair spec review): `false` (not
// installed) requires the documented app-missing signal (NSPOSIXErrorDomain
// code=2 / "No such file or directory"); every other failure shape — device
// errors, unknown stderr, timeouts — returns `null` (verdict unknown).
// Never claim not-installed without proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAppInstalled, buildNotInstalledAdvice, posixSingleQuote,
} from '../../dist/cdp/app-installed-probe.js';

function execFailing(stderr) {
  return async () => {
    const err = new Error(`Command failed: xcrun simctl get_app_container ...\n${stderr}`);
    err.stderr = stderr;
    throw err;
  };
}

test('probeAppInstalled: container resolves → true', async () => {
  const exec = async (cmd, args, opts) => {
    assert.equal(cmd, 'xcrun');
    assert.deepEqual(args, ['simctl', 'get_app_container', 'UDID-A', 'com.example.app', 'app']);
    assert.equal(opts.timeout, 5000);
    return { stdout: '/path/Example.app\n', stderr: '' };
  };
  assert.equal(await probeAppInstalled('UDID-A', 'com.example.app', exec), true);
});

test('probeAppInstalled: NSPOSIXErrorDomain code=2 → false (not installed)', async () => {
  const stderr =
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n'
    + 'No such file or directory';
  assert.equal(await probeAppInstalled('U', 'a', execFailing(stderr)), false);
});

test('probeAppInstalled: bare "No such file or directory" → false', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No such file or directory')), false);
});

test('probeAppInstalled: device-level error → null (fail open)', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('Invalid device: U')), null);
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No devices are booted.')), null);
});

test('probeAppInstalled: unrecognized failure shape → null (allowlist, fail open)', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('Some new simctl error nobody has seen')), null);
  // Timeout-style error without stderr:
  assert.equal(await probeAppInstalled('U', 'a', async () => { throw new Error('ETIMEDOUT'); }), null);
});

test('posixSingleQuote: inert metacharacters and embedded quotes', () => {
  assert.equal(posixSingleQuote('plain'), `'plain'`);
  assert.equal(posixSingleQuote("My App's.app"), `'My App'\\''s.app'`);
});

test('buildNotInstalledAdvice: base advice without hint; shell-quoted install line with hint', () => {
  const base = buildNotInstalledAdvice('UDID-A', 'com.example.app', null);
  assert.match(base, /com\.example\.app is not installed on simulator UDID-A/);
  assert.match(base, /npx expo run:ios/);
  assert.doesNotMatch(base, /simctl install/);

  const withHint = buildNotInstalledAdvice('UDID-A', 'com.example.app', {
    path: '/tmp/rn-appfile-snapshots/My App.app',
    ageMinutes: 42,
  });
  assert.match(withHint, /42 min ago/);
  assert.match(withHint, /may be stale/);
  assert.match(withHint, /xcrun simctl install 'UDID-A' '\/tmp\/rn-appfile-snapshots\/My App\.app'/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build 2>/dev/null; node --test test/unit/gh-262-app-installed-probe.test.js`
Expected: FAIL — `Cannot find module .../dist/cdp/app-installed-probe.js`

- [ ] **Step 3: Write the implementation**

Create `src/cdp/app-installed-probe.ts`:

```typescript
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** GH #262: a reinstallable .app snapshot (from the GH #201 bounded dir). */
export interface SnapshotHint {
  path: string;
  ageMinutes: number;
}

type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

// Allowlist classification (codex-pair spec review): `false` requires the
// documented app-missing signal — issue #262's manual diagnosis was exactly
// `get_app_container` failing with NSPOSIXErrorDomain code=2. Device-level
// errors and unrecognized shapes return null: never claim "not installed"
// without proof.
const DEVICE_ERROR = /Invalid device|No devices/i;
const APP_MISSING_POSIX = /NSPOSIXErrorDomain[\s\S]{0,40}code[^\d]{0,3}2\b/;
const APP_MISSING_ENOENT = /No such file or directory/i;

/**
 * GH #262: ground-truth "is this bundle installed?" probe.
 * true = container resolves; false = confirmed missing; null = unknown
 * (device error / unrecognized failure / timeout) — callers must treat
 * null exactly like "installed" (fail open).
 */
export async function probeAppInstalled(
  udid: string,
  appId: string,
  exec: Exec = execFile as unknown as Exec,
): Promise<boolean | null> {
  try {
    await exec('xcrun', ['simctl', 'get_app_container', udid, appId, 'app'], { timeout: 5000 });
    return true;
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    const detail = `${stderr}\n${e instanceof Error ? e.message : String(e)}`;
    if (DEVICE_ERROR.test(detail)) return null;
    if (APP_MISSING_POSIX.test(detail) || APP_MISSING_ENOENT.test(detail)) return false;
    return null;
  }
}

/**
 * POSIX single-quote (same pattern as device-deeplink.ts / device-interact.ts).
 * The advice built below is designed to be copy-pasted into a shell, and .app
 * names can contain spaces/metacharacters.
 */
export function posixSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildNotInstalledAdvice(
  udid: string,
  appId: string,
  hint: SnapshotHint | null,
): string {
  const base =
    `App ${appId} is not installed on simulator ${udid} — rebuild and install ` +
    '(npx expo run:ios / pnpm ios).';
  if (!hint) return base;
  return (
    `${base} Or reinstall the snapshot taken at the last clearState, ` +
    `${hint.ageMinutes} min ago (may be stale): ` +
    `xcrun simctl install ${posixSingleQuote(udid)} ${posixSingleQuote(hint.path)}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-262-app-installed-probe.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cdp/app-installed-probe.ts test/unit/gh-262-app-installed-probe.test.js
git commit -S -m "feat(#262): ground-truth app-installed probe + shell-safe advice builder"
```

---

### Task 2: Snapshot finder (`findSnapshotForBundleId` / `snapshotHintForBundleId`)

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/resolve-ios-app-file.ts` (add to end of file; extend the fs import on line 2)
- Test: `scripts/cdp-bridge/test/unit/gh-262-find-snapshot.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-find-snapshot.test.js`:

```js
// GH #262: best-effort lookup of a reinstallable .app snapshot in the GH #201
// bounded dir ($TMPDIR/rn-appfile-snapshots). Budgeted (≤10 candidates, ~3s
// total) and never throws — the hint must never block or delay an error report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findSnapshotForBundleId, snapshotHintForBundleId,
} from '../../dist/tools/resolve-ios-app-file.js';

const A = '/tmp/rn-appfile-snapshots/AppA.app';
const B = '/tmp/rn-appfile-snapshots/AppB.app';

test('findSnapshotForBundleId: matches CFBundleIdentifier; newest mtime wins', () => {
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: () => 'com.example.app',
    mtimeMs: (p) => (p === A ? 1000 : 2000),
    now: () => 10_000,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: B, mtimeMs: 2000 });
});

test('findSnapshotForBundleId: no bundle-id match → null', () => {
  const deps = {
    listSnapshots: () => [A],
    readBundleId: () => 'com.other.app',
    mtimeMs: () => 1000,
    now: () => 0,
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
});

test('findSnapshotForBundleId: unreadable Info.plist (readBundleId null) → candidate skipped', () => {
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: (p) => (p === A ? null : 'com.example.app'),
    mtimeMs: () => 5000,
    now: () => 0,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: B, mtimeMs: 5000 });
});

test('findSnapshotForBundleId: budget overrun → stops scanning, returns best so far', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: () => { reads += 1; return 'com.example.app'; },
    mtimeMs: () => 1000,
    // First call (deadline calc) t=0; every later call is past the 3s budget.
    now: (() => { let calls = 0; return () => (calls++ === 0 ? 0 : 10_000); })(),
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
  assert.equal(reads, 0, 'no candidate read after budget exceeded');
});

test('findSnapshotForBundleId: candidate cap — at most 10 scanned', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () => Array.from({ length: 25 }, (_, i) => `/tmp/rn-appfile-snapshots/App${i}.app`),
    readBundleId: () => { reads += 1; return 'com.nomatch'; },
    mtimeMs: () => 1000,
    now: () => 0,
  };
  findSnapshotForBundleId('com.example.app', deps);
  assert.equal(reads, 10);
});

test('snapshotHintForBundleId: converts mtime to ageMinutes (rounded, never negative)', () => {
  const deps = {
    listSnapshots: () => [A],
    readBundleId: () => 'com.example.app',
    mtimeMs: () => 0,
    now: () => 300_000, // 5 min later
  };
  assert.deepEqual(snapshotHintForBundleId('com.example.app', deps), { path: A, ageMinutes: 5 });
  assert.equal(snapshotHintForBundleId('com.missing', deps), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gh-262-find-snapshot.test.js`
Expected: FAIL — `findSnapshotForBundleId` is not exported from dist (SyntaxError on import)

- [ ] **Step 3: Write the implementation**

In `src/tools/resolve-ios-app-file.ts`, extend the imports (top of file):

```typescript
import { execFileSync } from 'node:child_process';
import { existsSync, cpSync, rmSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { SnapshotHint } from '../cdp/app-installed-probe.js';
```

Append at the end of the file:

```typescript
/** GH #262: injectable deps for the snapshot-hint lookup. */
export interface FindSnapshotDeps {
  /** Absolute paths of candidate .app dirs in the snapshot dir. */
  listSnapshots?: () => string[];
  /** CFBundleIdentifier of a candidate, or null if unreadable. */
  readBundleId?: (appPath: string) => string | null;
  /** mtime (ms) of a candidate, or null. */
  mtimeMs?: (appPath: string) => number | null;
  now?: () => number;
}

// Budget (codex-pair spec review): the hint rides on an ALREADY-FAILED
// recovery path — it must never add meaningful latency. The dir is bounded
// by design (one snapshot per app basename), so these are insurance caps.
const SNAPSHOT_SCAN_CAP = 10;
const SNAPSHOT_SCAN_BUDGET_MS = 3000;
const PLUTIL_TIMEOUT_MS = 2000;

function defaultListSnapshots(): string[] {
  const dir = join(tmpdir(), 'rn-appfile-snapshots');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.app'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function defaultReadBundleId(appPath: string): string | null {
  try {
    const out = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Info.plist')],
      { timeout: PLUTIL_TIMEOUT_MS, encoding: 'utf8' },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function defaultMtimeMs(appPath: string): number | null {
  try {
    return statSync(appPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * GH #262: find a reinstallable .app snapshot for a bundle id in the GH #201
 * snapshot dir. Best-effort under an explicit budget; returns null on any
 * error or budget overrun — the hint never blocks the error report it rides on.
 */
export function findSnapshotForBundleId(
  bundleId: string,
  deps: FindSnapshotDeps = {},
): { path: string; mtimeMs: number } | null {
  const listSnapshots = deps.listSnapshots ?? defaultListSnapshots;
  const readBundleId = deps.readBundleId ?? defaultReadBundleId;
  const mtimeMs = deps.mtimeMs ?? defaultMtimeMs;
  const now = deps.now ?? Date.now;
  const deadline = now() + SNAPSHOT_SCAN_BUDGET_MS;
  let best: { path: string; mtimeMs: number } | null = null;
  try {
    for (const candidate of listSnapshots().slice(0, SNAPSHOT_SCAN_CAP)) {
      if (now() > deadline) return best;
      if (readBundleId(candidate) !== bundleId) continue;
      const m = mtimeMs(candidate);
      if (m === null) continue;
      if (!best || m > best.mtimeMs) best = { path: candidate, mtimeMs: m };
    }
    return best;
  } catch {
    return null;
  }
}

/** GH #262: `findSnapshotForBundleId` formatted as advice input. */
export function snapshotHintForBundleId(
  bundleId: string,
  deps: FindSnapshotDeps = {},
): SnapshotHint | null {
  const now = deps.now ?? Date.now;
  const snap = findSnapshotForBundleId(bundleId, deps);
  if (!snap) return null;
  return {
    path: snap.path,
    ageMinutes: Math.max(0, Math.round((now() - snap.mtimeMs) / 60_000)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-262-find-snapshot.test.js`
Expected: PASS (6 tests)

Also run the existing suite for this file to catch regressions:
Run: `node --test test/unit/gh-201-resolve-ios-app-file.test.js`
Expected: PASS (unchanged behavior)

- [ ] **Step 5: Commit**

```bash
git add src/tools/resolve-ios-app-file.ts test/unit/gh-262-find-snapshot.test.js
git commit -S -m "feat(#262): budgeted snapshot-hint lookup in the GH#201 snapshot dir"
```

---

### Task 3: `recover-detached.ts` — `'app-not-installed'` short-circuit

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/recover-detached.ts` (reason union ~line 13, result interface ~line 22, deps interface ~line 60, relaunch catch ~line 125)
- Test: `scripts/cdp-bridge/test/unit/gh-262-recover-not-installed.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-recover-not-installed.test.js`:

```js
// GH #262: when the cold-relaunch fails AND simctl confirms the bundle is not
// installed, recovery short-circuits with reason 'app-not-installed' (carrying
// udid/appId for advice + a best-effort snapshot hint) instead of looping on
// reconnect attempts that can never succeed. Probe verdicts true/null keep the
// existing still-detached behavior (fail open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recoverDetached, resetDetachedRecoveryCounter,
} from '../../dist/cdp/recover-detached.js';

function baseDeps(over = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      getSession: () => ({ deviceId: 'UDID-A', appId: 'com.example.app', platform: 'ios' }),
      isFlowActive: () => false,
      isOptedOut: () => false,
      relaunchApp: async () => { throw new Error('FBSOpenApplicationServiceErrorDomain, code=4'); },
      stopFastRunner: () => calls.push('stop'),
      reconnect: async () => { calls.push('reconnect'); },
      probeAlive: async () => false,
      sleep: async () => { calls.push('sleep'); },
      maxPerSession: 3,
      ...over,
    },
  };
}

test('launch fails + probe FALSE → app-not-installed, short-circuits settle/reconnect', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({
    isAppInstalled: async (udid, appId) => {
      calls.push(`probe:${udid}:${appId}`);
      return false;
    },
    snapshotHint: () => ({ path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 }),
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.recovered, false);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.attempt, 1);
  assert.equal(r.udid, 'UDID-A');
  assert.equal(r.appId, 'com.example.app');
  assert.match(r.error, /code=4/);
  assert.deepEqual(r.snapshotHint, { path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 });
  assert.ok(calls.includes('probe:UDID-A:com.example.app'));
  assert.ok(!calls.includes('sleep'), 'short-circuit: no settle wait');
  assert.ok(!calls.includes('reconnect'), 'short-circuit: no reconnect attempt');
});

test('launch fails + probe NULL (ambiguous) → still-detached with raw error (fail open)', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isAppInstalled: async () => null });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'still-detached');
  assert.match(r.error, /code=4/);
  assert.equal(r.snapshotHint, undefined);
  assert.ok(calls.includes('reconnect'), 'normal path still attempts reconnect');
});

test('launch fails + probe TRUE (installed) → existing behavior unchanged', async () => {
  resetDetachedRecoveryCounter();
  const { calls, deps } = baseDeps({ isAppInstalled: async () => true });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'still-detached');
  assert.ok(calls.includes('reconnect'));
});

test('snapshot hint THROWS → app-not-installed without hint (hint is best-effort)', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({
    isAppInstalled: async () => false,
    snapshotHint: () => { throw new Error('plist exploded'); },
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.snapshotHint, undefined);
});

test('app-not-installed consumes its attempt (side effects happened)', async () => {
  resetDetachedRecoveryCounter();
  const mk = () => baseDeps({ isAppInstalled: async () => false, snapshotHint: () => null }).deps;
  assert.equal((await recoverDetached({}, mk())).attempt, 1);
  assert.equal((await recoverDetached({}, mk())).attempt, 2);
});

test('relaunch SUCCEEDS → probe never called (cost lands only on the failed path)', async () => {
  resetDetachedRecoveryCounter();
  let probed = false;
  const { deps } = baseDeps({
    relaunchApp: async () => {},
    probeAlive: async () => true,
    isAppInstalled: async () => { probed = true; return false; },
  });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'recovered');
  assert.equal(probed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gh-262-recover-not-installed.test.js`
Expected: FAIL — first test gets `reason: 'still-detached'` instead of `'app-not-installed'`

- [ ] **Step 3: Write the implementation**

In `src/cdp/recover-detached.ts`:

(a) Add imports after the existing ones:

```typescript
import { probeAppInstalled } from './app-installed-probe.js';
import type { SnapshotHint } from './app-installed-probe.js';
import { snapshotHintForBundleId } from '../tools/resolve-ios-app-file.js';
```

(b) Extend the reason union:

```typescript
export type DetachedReason =
  | 'recovered'
  | 'still-detached'
  | 'app-not-installed'
  | 'no-session'
  | 'flow-active'
  | 'opted-out'
  | 'unsupported-platform'
  | 'budget-exhausted';
```

(c) Extend the result interface:

```typescript
export interface DetachedRecoveryResult {
  recovered: boolean;
  reason: DetachedReason;
  attempt: number;
  /** GH #208 review (Codex F3): a `simctl launch` failure message, surfaced instead of hidden. */
  error?: string;
  /** GH #262: set on 'app-not-installed' so the caller can build install advice. */
  udid?: string;
  appId?: string;
  snapshotHint?: SnapshotHint;
}
```

(d) Extend the deps interface:

```typescript
export interface RecoverDetachedDeps {
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  isFlowActive?: () => boolean;
  isOptedOut?: () => boolean;
  relaunchApp?: (udid: string, appId: string) => Promise<void>;
  stopFastRunner?: () => void;
  reconnect?: () => Promise<void>;
  probeAlive?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPerSession?: number;
  /** GH #262: tri-state install probe (true/false/null=unknown). */
  isAppInstalled?: (udid: string, appId: string) => Promise<boolean | null>;
  /** GH #262: best-effort reinstallable-snapshot hint. */
  snapshotHint?: (appId: string) => SnapshotHint | null;
}
```

(e) Replace the relaunch try/catch block (currently `let relaunchError ... }` around lines 125–133) with:

```typescript
  let relaunchError: string | undefined;
  try {
    await relaunchApp(udid, appId);
  } catch (e) {
    // The terminate step is already swallowed inside defaultRelaunchApp, so a throw
    // here is a real `simctl launch` failure (bad UDID/bundleId, sim unavailable).
    // Capture it (Codex F3) so the verdict is actionable, not a bare "still-detached".
    relaunchError = e instanceof Error ? e.message : String(e);
    // GH #262: a failed launch is ambiguous — a transient hiccup and a missing
    // bundle look identical here, but the second makes every retry (and the
    // "relaunch manually" advice) pointless. Ask simctl for ground truth; on a
    // CONFIRMED missing bundle, short-circuit — settle/reconnect/liveness below
    // cannot succeed. Probe verdict null = unknown → fall through (fail open).
    const isAppInstalled = deps.isAppInstalled ?? probeAppInstalled;
    if ((await isAppInstalled(udid, appId)) === false) {
      const hintFor = deps.snapshotHint ?? snapshotHintForBundleId;
      let snapshotHint: SnapshotHint | null = null;
      try { snapshotHint = hintFor(appId); } catch { /* hint is best-effort */ }
      return {
        recovered: false,
        reason: 'app-not-installed',
        attempt,
        error: relaunchError,
        udid,
        appId,
        ...(snapshotHint ? { snapshotHint } : {}),
      };
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `npm run build && node --test test/unit/gh-262-recover-not-installed.test.js test/unit/gh-208-recover-detached.test.js`
Expected: PASS — all tests in both files

- [ ] **Step 5: Commit**

```bash
git add src/cdp/recover-detached.ts test/unit/gh-262-recover-not-installed.test.js
git commit -S -m "feat(#262): recover-detached short-circuits on confirmed app-not-installed"
```

---

### Task 4: `APP_NOT_INSTALLED` error code + `cdp_status` mapping

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (ToolErrorCode union, ~line 190)
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (APP_DETACHED catch, before the `detachedHint` chain ~line 331)
- Test: `scripts/cdp-bridge/test/unit/gh-262-status-not-installed.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-status-not-installed.test.js` (harness mirrors `gh-208-status-detached-recovery.test.js` — if envelope field names differ, align assertions with the APP_DETACHED refusal tests in that file):

```js
// GH #262: when detached-recovery reports 'app-not-installed', cdp_status
// returns the distinct APP_NOT_INSTALLED code with install advice (incl. a
// shell-quoted snapshot reinstall line when a hint exists) — instead of the
// generic APP_DETACHED "relaunch manually / hardReset" advice that can never
// work for a missing bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { AppDetachedError } from '../../dist/cdp/discovery.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeDetachedClient() {
  return createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => { throw new AppDetachedError(8081); },
  });
}

function makeHandler(recovery) {
  const client = makeDetachedClient();
  return createStatusHandler(() => client, () => {}, () => client, {
    recoverDetached: async () => recovery,
  });
}

test('cdp_status: app-not-installed → APP_NOT_INSTALLED with quoted snapshot advice', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({
      recovered: false,
      reason: 'app-not-installed',
      attempt: 1,
      error: 'FBSOpenApplicationServiceErrorDomain, code=4',
      udid: 'UDID-A',
      appId: 'com.example.app',
      snapshotHint: { path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 },
    });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.ok, false);
    assert.equal(env.code, 'APP_NOT_INSTALLED');
    assert.match(env.error, /com\.example\.app is not installed on simulator UDID-A/);
    assert.match(env.error, /7 min ago/);
    assert.match(env.error, /xcrun simctl install 'UDID-A' '\/tmp\/rn-appfile-snapshots\/My App\.app'/);
    assert.equal(env.meta.recovery.reason, 'app-not-installed');
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: app-not-installed without hint → rebuild advice, no install line', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({
      recovered: false,
      reason: 'app-not-installed',
      attempt: 1,
      udid: 'UDID-A',
      appId: 'com.example.app',
    });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.code, 'APP_NOT_INSTALLED');
    assert.match(env.error, /npx expo run:ios/);
    assert.doesNotMatch(env.error, /simctl install/);
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: still-detached keeps the existing APP_DETACHED code (no regression)', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({ recovered: false, reason: 'still-detached', attempt: 1 });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.code, 'APP_DETACHED');
  } finally {
    _resetHasSessionForTest();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gh-262-status-not-installed.test.js`
Expected: FAIL — first two tests get code `APP_DETACHED` instead of `APP_NOT_INSTALLED`

- [ ] **Step 3: Write the implementation**

(a) `src/types.ts` — extend the union directly under the `APP_DETACHED` member:

```typescript
  | 'APP_DETACHED'              // GH #208 (RC2/RC3): Metro up but 0 Hermes targets (app detached)
  | 'APP_NOT_INSTALLED'         // GH #262: relaunch failed and get_app_container confirms the bundle is missing
```

(b) `src/tools/status.ts` — add the import:

```typescript
import { buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
```

(c) `src/tools/status.ts` — inside the `AppDetachedError` branch, immediately BEFORE the `const detachedHint =` chain, insert:

```typescript
        // GH #262: the bundle is CONFIRMED missing (e.g. simulator erased) —
        // the generic "relaunch manually / hardReset" hints below can never
        // work. Return the distinct code with install advice instead.
        if (recovery.reason === 'app-not-installed') {
          return failResult(
            `${message} ${buildNotInstalledAdvice(
              recovery.udid ?? 'booted',
              recovery.appId ?? 'the app',
              recovery.snapshotHint ?? null,
            )}`,
            'APP_NOT_INSTALLED',
            {
              reconnect: getClient().reconnectState,
              autoConnect: getClient().autoConnectState,
              bridge: bridgeEnvState(process.env),
              recovery,
            },
          );
        }
```

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `npm run build && node --test test/unit/gh-262-status-not-installed.test.js test/unit/gh-208-status-detached-recovery.test.js`
Expected: PASS — all tests in both files

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/tools/status.ts test/unit/gh-262-status-not-installed.test.js
git commit -S -m "feat(#262): cdp_status maps app-not-installed to APP_NOT_INSTALLED with install advice"
```

---

### Task 5: `cdp_restart` — app.json bundleId fallback + launch:err classification

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/restart.ts` (deps interface ~line 12, handler header ~line 114, bundleId chain ~lines 125–129, launch catch ~lines 155–162)
- Test: `scripts/cdp-bridge/test/unit/gh-262-restart-fallback.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-restart-fallback.test.js` (mock-client harness copied from `cdp-restart.test.js`):

```js
// GH #262 (+ #194 BUG 2 residual): hardReset must not silently degrade to a
// soft reset when the bundleId cache is empty — it now falls back to app.json
// (resolveBundleId). And a failed `simctl launch` is classified: a CONFIRMED
// missing bundle yields an APP_NOT_INSTALLED step with install advice instead
// of a raw OS error.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestartHandler, _resetRestartHandlerStateForTest,
} from '../../dist/tools/restart.js';
import { expectOk } from '../helpers/result-helpers.js';

beforeEach(() => {
  _resetRestartHandlerStateForTest();
});

function makeMockClient({ port = 8081 } = {}) {
  let connected = false;
  return {
    get metroPort() { return port; },
    get isConnected() { return connected; },
    // connectedTarget intentionally undefined: the fresh-process case.
    disconnect: async () => {},
    autoConnect: async () => { connected = true; return 'Connected to test'; },
  };
}

function harness(deps) {
  const oldClient = makeMockClient();
  const newClient = makeMockClient();
  let current = oldClient;
  const handler = createRestartHandler(
    () => current,
    (c) => { current = c; },
    () => newClient,
    deps,
  );
  return handler;
}

test('hardReset: empty cache + no connectedTarget → falls back to resolveBundleId (app.json)', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleId: (platform) => {
      assert.equal(platform, 'ios');
      return 'com.fallback.app';
    },
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(simctl.some((c) => c === 'simctl terminate booted com.fallback.app'));
  assert.ok(simctl.some((c) => c === 'simctl launch booted com.fallback.app'));
  assert.ok(data.hardResetSteps.includes('simctl launch com.fallback.app:ok'));
  assert.ok(!data.hardResetSteps.some((s) => s.startsWith('skip-simctl')));
});

test('hardReset: app.json also unresolvable → existing skip-simctl step (unchanged)', async () => {
  const handler = harness({
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleId: () => null,
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(data.hardResetSteps.includes('skip-simctl:no-bundleId-on-connectedTarget-or-cache'));
});

test('hardReset: launch fails + probe FALSE → APP_NOT_INSTALLED step with quoted advice', async () => {
  const handler = harness({
    execFile: async (cmd, args) => {
      if (args.includes('launch')) throw new Error('FBSOpenApplicationServiceErrorDomain, code=4');
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleId: () => 'com.fallback.app',
    probeAppInstalled: async (udid, appId) => {
      assert.equal(udid, 'booted');
      assert.equal(appId, 'com.fallback.app');
      return false;
    },
    snapshotHint: () => ({ path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 3 }),
  });
  const data = expectOk(await handler({ hardReset: true }));
  const step = data.hardResetSteps.find((s) => s.includes('APP_NOT_INSTALLED'));
  assert.ok(step, `expected an APP_NOT_INSTALLED step, got: ${JSON.stringify(data.hardResetSteps)}`);
  assert.match(step, /com\.fallback\.app is not installed/);
  assert.match(step, /xcrun simctl install 'booted' '\/tmp\/rn-appfile-snapshots\/My App\.app'/);
});

test('hardReset: launch fails + probe NULL → raw launch:err step (fail open, unchanged)', async () => {
  const handler = harness({
    execFile: async (cmd, args) => {
      if (args.includes('launch')) throw new Error('some transient failure');
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleId: () => 'com.fallback.app',
    probeAppInstalled: async () => null,
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(data.hardResetSteps.some((s) => s.startsWith('simctl launch:err(') && !s.includes('APP_NOT_INSTALLED')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/unit/gh-262-restart-fallback.test.js`
Expected: FAIL — first test finds `skip-simctl:no-bundleId-on-connectedTarget-or-cache` (no fallback yet)

- [ ] **Step 3: Write the implementation**

In `src/tools/restart.ts`:

(a) Add imports:

```typescript
import { resolveBundleId } from '../project-config.js';
import { probeAppInstalled, buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import type { SnapshotHint } from '../cdp/app-installed-probe.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
```

(b) Extend `RestartHandlerDeps`:

```typescript
  /** GH #262 (#194 BUG 2 residual): app.json fallback for the relaunch target. */
  resolveBundleId?: (platform: string) => string | null;
  /** GH #262: tri-state install probe for classifying launch failures. */
  probeAppInstalled?: (udid: string, appId: string) => Promise<boolean | null>;
  /** GH #262: best-effort reinstallable-snapshot hint. */
  snapshotHint?: (appId: string) => SnapshotHint | null;
```

(c) Resolve the deps in the handler header (next to the existing three):

```typescript
  const resolveBundleIdFn = deps.resolveBundleId ?? resolveBundleId;
  const probeAppInstalledFn = deps.probeAppInstalled ?? probeAppInstalled;
  const snapshotHintFn = deps.snapshotHint ?? snapshotHintForBundleId;
```

(d) Replace the bundleId/platform resolution block (currently `const observedBundleId ... .toLowerCase();`, ~lines 125–130) — `targetPlatform` must now be computed BEFORE `bundleId`:

```typescript
      const observedBundleId = oldClient.connectedTarget?.description ?? null;
      if (observedBundleId) lastSeenBundleId = observedBundleId;
      const targetPlatform = (oldClient.connectedTarget?.platform ?? args.platform ?? 'ios').toLowerCase();
      // Resolution priority: explicit arg > current connectedTarget > cache >
      // app.json (GH #262 / #194 BUG 2: a fresh bridge process has no cache —
      // without the app.json fallback, hardReset silently degraded to a soft
      // reset exactly when the hard path was needed).
      const bundleId = args.bundleId ?? observedBundleId ?? lastSeenBundleId ?? resolveBundleIdFn(targetPlatform);
```

(e) Replace the `simctl launch` catch block (currently pushes `simctl launch:err(...)`, ~lines 155–162):

```typescript
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // GH #262: distinguish "launch hiccup" from "bundle not installed" —
            // the latter needs install advice, not the soft-reset retry below.
            // Probe verdict null = unknown → keep the raw error (fail open).
            if ((await probeAppInstalledFn('booted', bundleId)) === false) {
              let hint: SnapshotHint | null = null;
              try { hint = snapshotHintFn(bundleId); } catch { /* best-effort */ }
              hardResetSteps.push(
                `simctl launch:err(APP_NOT_INSTALLED — ${buildNotInstalledAdvice('booted', bundleId, hint)})`,
              );
            } else {
              // Fatal-ish: if launch fails, the soft reset below will likely
              // fail too. Still continue — caller sees the launch error in
              // hardResetSteps and the connectError from the autoConnect.
              hardResetSteps.push(`simctl launch:err(${msg})`);
            }
          }
```

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `npm run build && node --test test/unit/gh-262-restart-fallback.test.js test/unit/cdp-restart.test.js`
Expected: PASS — all tests in both files. (If an existing `cdp-restart.test.js` case asserted the old skip-simctl behavior while app.json IS resolvable in the test env, inject `resolveBundleId: () => null` into that case to preserve its intent — the real default reads the project's app.json.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/restart.ts test/unit/gh-262-restart-fallback.test.js
git commit -S -m "feat(#262): hardReset app.json bundleId fallback + APP_NOT_INSTALLED launch classification"
```

---

### Task 6: Full verification, dist rebuild, changeset

**Files:**
- Create: `.changeset/gh-262-app-not-installed.md` (repo root)
- Modify: `scripts/cdp-bridge/dist/**` (tracked build output)

- [ ] **Step 1: Run the full suite**

Run: `cd scripts/cdp-bridge && npm run test:all`
Expected: ALL PASS (1966 baseline + ~22 new). Zero failures — fix anything red before proceeding.

- [ ] **Step 2: Lint (if configured)**

Run: `npm run lint --if-present`
Expected: clean (or script absent — fine).

- [ ] **Step 3: Stage rebuilt dist**

`npm run test:all` already ran `tsc`. Stage the tracked outputs:

```bash
git add dist
git status --short  # expect: new dist/cdp/app-installed-probe.js + modified dist files only
```

- [ ] **Step 4: Write the changeset**

Create `.changeset/gh-262-app-not-installed.md` (repo root):

```markdown
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Recovery paths now detect "app not installed" and resolve their relaunch target (GH #262, absorbs #194 BUG 2).

- `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container` confirms the bundle is missing (allowlist: `NSPOSIXErrorDomain code=2`), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the reinstallable `.app` snapshot from the last clearState (GH #201 dir) when one matches. Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior.
- `cdp_restart hardReset=true`: the bundleId resolution chain gains an app.json fallback (`resolveBundleId`), so a fresh bridge process no longer silently degrades to a soft reset; failed launches are classified the same way in `hardResetSteps`.
```

- [ ] **Step 5: Commit**

```bash
git add .changeset/gh-262-app-not-installed.md dist
git commit -S -m "chore(#262): rebuilt dist + changeset"
```

- [ ] **Step 6: Post-implementation gates (per project workflow)**

1. `/multi-review` (Gemini + Codex) on the branch diff; address findings.
2. Live verification on the booted iOS simulator — the real escape-hatch gate:
   - Erase a booted sim (`xcrun simctl erase <udid>` while booted requires shutdown first: `xcrun simctl shutdown <udid> && xcrun simctl erase <udid> && xcrun simctl boot <udid>`), start Metro, call `cdp_status platform=ios` → expect `APP_NOT_INSTALLED` with advice (NOT generic APP_DETACHED), in line with the issue's repro.
   - Confirm no snapshot hint appears if `$TMPDIR/rn-appfile-snapshots` has no matching bundle; populate via a clearState flow and confirm the hint appears with a quoted path.
3. PR via `superpowers:finishing-a-development-branch`; body cites #262 with `Closes #262` and notes the #194 BUG 2 residual closure.

**No MCP tool-docs regeneration needed:** no tool was added and no input schema changed — only result codes/messages.
