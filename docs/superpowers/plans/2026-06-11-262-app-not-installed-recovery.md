# GH #262 — APP_NOT_INSTALLED Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recovery paths (`cdp_status` APP_DETACHED auto-relaunch, `cdp_restart hardReset`) detect a missing app bundle via ground truth (`simctl get_app_container`), report a distinct `APP_NOT_INSTALLED` code with shell-safe install advice (incl. a #201 snapshot hint), and `hardReset` resolves its relaunch target through a strict chain ending at app.json (closes the #194 BUG 2 residual).

**Architecture:** A new probe module (`cdp/app-installed-probe.ts`) classifies launch failures from **simctl stderr only**, allowlist-style (`false` requires the `NSPOSIXErrorDomain` + `code=2` marker; everything else is `null` — fail open). A snapshot finder in `tools/resolve-ios-app-file.ts` (which owns the #201 snapshot dir) supplies a best-effort reinstall hint (mtime-sorted before capping, budgeted). `recover-detached.ts` serializes concurrent recoveries, short-circuits on a confirmed missing bundle, and caches that terminal diagnosis (with a cheap re-probe so reinstalls self-heal). The snapshot hint is **injected by the tool layer** (`status.ts`/`restart.ts`) — `cdp/` never imports from `tools/`.

**Tech Stack:** TypeScript (Node >= 22), `node:test` + `assert/strict` unit tests importing from `dist/`, injectable-deps pattern throughout.

**Spec:** `docs/superpowers/specs/2026-06-11-262-app-not-installed-recovery-design.md` (approved; codex-pair + multi-LLM review amendments applied).

**Multi-LLM review amendments (Antigravity + Codex, 2026-06-11):** stderr-only classification (argv-spoof defense) with case-insensitive, `code=-2`-proof regex; mtime-sort before candidate cap; deadline-clamped plutil timeouts; tool-layer hint injection (no `cdp → tools` import); in-flight serialization of concurrent recoveries; terminal not-installed cache with re-probe self-heal; strict per-platform bundleId resolver (no iOS←Android fallback) + active-session appId in the restart chain; session-UDID targeting in restart; detached-budget reset on successful hardReset; existing gh-208 throwing tests get `isAppInstalled: async () => null` so unit tests never shell out.

---

## File Structure

All paths relative to `scripts/cdp-bridge/` unless noted.

| File | Action | Responsibility |
|---|---|---|
| `src/cdp/app-installed-probe.ts` | Create | `probeAppInstalled` (stderr-only tri-state probe), `posixSingleQuote`, `buildNotInstalledAdvice`, `SnapshotHint` type |
| `src/tools/resolve-ios-app-file.ts` | Modify | Add `findSnapshotForBundleId` + `snapshotHintForBundleId` (mtime-sorted, budgeted scan of `$TMPDIR/rn-appfile-snapshots`) |
| `src/cdp/recover-detached.ts` | Modify | New reason `'app-not-installed'`, in-flight serialization, terminal-diagnosis cache, short-circuit, `udid`/`appId`/`snapshotHint` on the result |
| `src/tools/status.ts` | Modify | Inject `snapshotHintForBundleId` into recovery; map `'app-not-installed'` → `APP_NOT_INSTALLED` failResult with advice |
| `src/tools/restart.ts` | Modify | Strict bundleId chain (`arg > connectedTarget > cache > session appId > strict app.json`); session-UDID targeting; `launch:err` classification; budget reset on success |
| `src/project-config.ts` | Modify | Add `readAppIdStrict` / `resolveBundleIdStrict` (no cross-platform fallback) |
| `src/types.ts` | Modify | Add `'APP_NOT_INSTALLED'` to `ToolErrorCode` |
| `test/unit/gh-262-*.test.js` | Create | One test file per task (5 files) |
| `test/unit/gh-208-*.test.js` | Modify | Inject `isAppInstalled: async () => null` where `relaunchApp` throws (no shell-outs from unit tests) |
| `.changeset/gh-262-app-not-installed.md` | Create | patch changeset |

Working directory for all commands: `scripts/cdp-bridge/`. Branch: `feat/262-app-not-installed-recovery` (already created; spec + plan committed).

---

### Task 1: Ground-truth probe module (`app-installed-probe.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/cdp/app-installed-probe.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-262-app-installed-probe.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-app-installed-probe.test.js`:

```js
// GH #262: ground-truth probe for "is the app bundle installed on the sim?".
// Classification is ALLOWLIST-only and reads simctl STDERR ONLY (never
// Error.message, which embeds command argv — a crafted bundleId containing
// the marker text must not force a false "not installed"). `false` requires
// the NSPOSIXErrorDomain + code=2 marker (verified live: "(domain=
// NSPOSIXErrorDomain, code=2)"); every other failure shape — bare ENOENT
// text, device errors, unknown stderr, no stderr, timeouts — returns `null`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAppInstalled, buildNotInstalledAdvice, posixSingleQuote,
} from '../../dist/cdp/app-installed-probe.js';

function execFailing(stderr, message) {
  return async () => {
    const err = new Error(message ?? `Command failed: xcrun simctl get_app_container ...\n${stderr}`);
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

test('probeAppInstalled: real missing-app stderr (domain + code=2) → false', async () => {
  // Exact shape captured live on this machine (Xcode 26):
  const stderr =
    'An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=2):\n'
    + 'The operation couldn’t be completed. No such file or directory\n'
    + 'No such file or directory';
  assert.equal(await probeAppInstalled('U', 'a', execFailing(stderr)), false);
});

test('probeAppInstalled: marker is case-insensitive and separator-flexible', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('nsposixerrordomain Code: 2 oops')), false);
});

test('probeAppInstalled: code=-2 / code=20 / missing domain → null (never false)', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('domain=NSPOSIXErrorDomain, code=-2')), null);
  assert.equal(await probeAppInstalled('U', 'a', execFailing('domain=NSPOSIXErrorDomain, code=20')), null);
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No such file or directory')), null);
});

test('probeAppInstalled: marker in Error.message but NOT stderr → null (argv-spoof defense)', async () => {
  const spoof = execFailing('', 'Command failed: xcrun simctl get_app_container U NSPOSIXErrorDomain-code=2-trap app');
  assert.equal(await probeAppInstalled('U', 'NSPOSIXErrorDomain-code=2-trap', spoof), null);
});

test('probeAppInstalled: device-level error → null (fail open)', async () => {
  assert.equal(await probeAppInstalled('U', 'a', execFailing('Invalid device: U')), null);
  assert.equal(await probeAppInstalled('U', 'a', execFailing('No devices are booted.')), null);
});

test('probeAppInstalled: no stderr at all (spawn error / timeout) → null', async () => {
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

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-262-app-installed-probe.test.js`
Expected: the build PASSES (no source changes yet — if it fails, stop and fix the build first), then the test FAILS with `Cannot find module .../dist/cdp/app-installed-probe.js`

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

const DEVICE_ERROR = /Invalid device|No devices/i;

// Allowlist (codex-pair + multi-LLM plan reviews): `false` requires the
// documented app-missing signal — verified live as
// "(domain=NSPOSIXErrorDomain, code=2)". Case-insensitive and
// distance-independent (Xcode formatting may drift), but `2\b` after an
// optional '='/':'/space separator so `code=-2` / `code=20` never match.
function isAppMissingSignal(stderr: string): boolean {
  return /nsposixerrordomain/i.test(stderr) && /\bcode\s*[=:]?\s*2\b/i.test(stderr);
}

/**
 * GH #262: ground-truth "is this bundle installed?" probe.
 * true = container resolves; false = confirmed missing; null = unknown
 * (device error / unrecognized failure / no stderr / timeout) — callers must
 * treat null exactly like "installed" (fail open).
 *
 * Classifies ONLY simctl's own stderr — never Error.message, which embeds the
 * command argv: a crafted bundleId containing the marker text must not be
 * able to force a false "not installed".
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
    if (!stderr) return null;
    if (DEVICE_ERROR.test(stderr)) return null;
    if (isAppMissingSignal(stderr)) return false;
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
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/cdp/app-installed-probe.ts test/unit/gh-262-app-installed-probe.test.js
git commit -S -m "feat(#262): stderr-only app-installed probe + shell-safe advice builder"
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
// bounded dir ($TMPDIR/rn-appfile-snapshots). Candidates are mtime-sorted
// NEWEST-FIRST BEFORE the ≤10 cap (readdir order is arbitrary — capping first
// could drop the newest match), then plutil-matched under a ~3s budget with
// deadline-clamped per-read timeouts. Never throws — the hint may add at most
// the bounded scan budget to an already-failed path and must never FAIL the
// report it rides on.
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

test('findSnapshotForBundleId: sorts newest-first BEFORE the cap — newest survives a >10 dir', () => {
  // 12 decoys older than the target; readdir lists the target LAST.
  const decoys = Array.from({ length: 12 }, (_, i) => `/tmp/rn-appfile-snapshots/Decoy${i}.app`);
  const target = '/tmp/rn-appfile-snapshots/Target.app';
  const reads = [];
  const deps = {
    listSnapshots: () => [...decoys, target],
    readBundleId: (p) => { reads.push(p); return p === target ? 'com.example.app' : 'com.decoy'; },
    mtimeMs: (p) => (p === target ? 99_000 : 1000),
    now: () => 0,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: target, mtimeMs: 99_000 });
  assert.equal(reads[0], target, 'newest candidate is plutil-read first');
  assert.equal(reads.length, 1, 'first (newest) match short-circuits the scan');
});

test('findSnapshotForBundleId: no bundle-id match → null; at most 10 plutil reads', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () => Array.from({ length: 25 }, (_, i) => `/tmp/rn-appfile-snapshots/App${i}.app`),
    readBundleId: () => { reads += 1; return 'com.nomatch'; },
    mtimeMs: () => 1000,
    now: () => 0,
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
  assert.equal(reads, 10);
});

test('findSnapshotForBundleId: unreadable Info.plist (readBundleId null) → candidate skipped', () => {
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: (p) => (p === B ? null : 'com.example.app'),
    mtimeMs: (p) => (p === A ? 1000 : 2000), // B newer but unreadable
    now: () => 0,
  };
  assert.deepEqual(findSnapshotForBundleId('com.example.app', deps), { path: A, mtimeMs: 1000 });
});

test('findSnapshotForBundleId: budget overrun → stops before further plutil reads', () => {
  let reads = 0;
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: () => { reads += 1; return 'com.example.app'; },
    mtimeMs: () => 1000,
    // First call (deadline calc) t=0; every later call is past the 3s budget.
    now: (() => { let calls = 0; return () => (calls++ === 0 ? 0 : 10_000); })(),
  };
  assert.equal(findSnapshotForBundleId('com.example.app', deps), null);
  assert.equal(reads, 0, 'no plutil read after budget exceeded');
});

test('findSnapshotForBundleId: per-read timeout is clamped to the remaining deadline', () => {
  const timeouts = [];
  let t = 0;
  const deps = {
    listSnapshots: () => [A, B],
    readBundleId: (p, timeoutMs) => { timeouts.push(timeoutMs); t += 1500; return 'com.nomatch'; },
    mtimeMs: () => 1000,
    now: () => t,
  };
  findSnapshotForBundleId('com.example.app', deps);
  assert.equal(timeouts[0], 2000, 'full per-read timeout while budget is fresh');
  assert.ok(timeouts[1] < 2000, `second read clamped to remaining budget, got ${timeouts[1]}`);
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

Run: `npm run build && node --test test/unit/gh-262-find-snapshot.test.js`
Expected: build PASSES, test FAILS — `findSnapshotForBundleId` is not exported from dist (SyntaxError on import)

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
  /** CFBundleIdentifier of a candidate (within timeoutMs), or null if unreadable. */
  readBundleId?: (appPath: string, timeoutMs: number) => string | null;
  /** mtime (ms) of a candidate, or null. */
  mtimeMs?: (appPath: string) => number | null;
  now?: () => number;
}

// Budget (codex-pair + multi-LLM plan reviews): the hint rides on an
// ALREADY-FAILED recovery path — it must never add meaningful latency. The
// dir is bounded by design (one snapshot per app basename), so these are
// insurance caps. Per-read timeouts are clamped to the remaining deadline so
// one slow plutil cannot blow the total budget.
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

function defaultReadBundleId(appPath: string, timeoutMs: number): string | null {
  try {
    const out = execFileSync(
      'plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', join(appPath, 'Info.plist')],
      { timeout: timeoutMs, encoding: 'utf8' },
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
 * snapshot dir. Cheap stat pass first, NEWEST-FIRST sort, THEN the cap —
 * readdir order is arbitrary, so capping before sorting could drop the newest
 * match. plutil (the expensive read) runs only on the capped, ordered list,
 * so the first match is the newest. Latency contract: the lookup IS awaited
 * on the already-failed error path, so it may add up to the budget (~3s worst
 * case; typically a few ms — the dir holds one snapshot per app). It can
 * never fail or abort the report it rides on (all errors → null).
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
  try {
    const candidates = listSnapshots()
      .map((path) => ({ path, m: mtimeMs(path) }))
      .filter((c): c is { path: string; m: number } => c.m !== null)
      .sort((a, b) => b.m - a.m)
      .slice(0, SNAPSHOT_SCAN_CAP);
    for (const { path, m } of candidates) {
      const remaining = deadline - now();
      if (remaining <= 0) return null;
      if (readBundleId(path, Math.min(PLUTIL_TIMEOUT_MS, remaining)) === bundleId) {
        return { path, mtimeMs: m };
      }
    }
    return null;
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
Expected: PASS (7 tests)

Also run the existing suite for this file to catch regressions:
Run: `node --test test/unit/gh-201-resolve-ios-app-file.test.js`
Expected: PASS (unchanged behavior)

- [ ] **Step 5: Commit**

```bash
git add src/tools/resolve-ios-app-file.ts test/unit/gh-262-find-snapshot.test.js
git commit -S -m "feat(#262): mtime-sorted budgeted snapshot-hint lookup in the GH#201 snapshot dir"
```

---

### Task 3: `recover-detached.ts` — `'app-not-installed'` short-circuit, serialization, terminal cache

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/recover-detached.ts`
- Modify: `scripts/cdp-bridge/test/unit/gh-208-recover-detached.test.js` and `scripts/cdp-bridge/test/unit/gh-208-review-fixes.test.js` — every deps object whose `relaunchApp` THROWS gains `isAppInstalled: async () => null` (find them with `grep -n "relaunchApp" test/unit/gh-208-*.test.js`); without it the new default probe would shell out to real `xcrun` from unit tests
- Test: `scripts/cdp-bridge/test/unit/gh-262-recover-not-installed.test.js`

**Layering rule (multi-LLM review consensus):** `recover-detached.ts` imports ONLY from `./app-installed-probe.js` (same `cdp/` layer). It does NOT import from `tools/` — `deps.snapshotHint` has NO default and stays `undefined` unless the tool layer injects it (Task 4 wires `status.ts`; `restart.ts` uses its own).

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-recover-not-installed.test.js`:

```js
// GH #262: when the cold-relaunch fails AND simctl confirms the bundle is not
// installed, recovery short-circuits with reason 'app-not-installed'
// (carrying udid/appId for advice + a best-effort injected snapshot hint)
// instead of looping on reconnect attempts that can never succeed. Probe
// verdicts true/null keep the existing still-detached behavior (fail open).
// Concurrent recoveries are serialized (followers share the leader's
// verdict); a confirmed not-installed is cached per (udid, appId) and
// re-probed cheaply so a user reinstall self-heals.
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
      relaunchApp: async () => { calls.push('relaunch'); throw new Error('FBSOpenApplicationServiceErrorDomain, code=4'); },
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

test('no snapshotHint dep injected → app-not-installed without hint (cdp layer has no default)', async () => {
  resetDetachedRecoveryCounter();
  const { deps } = baseDeps({ isAppInstalled: async () => false });
  const r = await recoverDetached({}, deps);
  assert.equal(r.reason, 'app-not-installed');
  assert.equal(r.snapshotHint, undefined);
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

test('terminal cache: second call re-probes cheaply, NO relaunch side effects, NO budget burn', async () => {
  resetDetachedRecoveryCounter();
  const first = baseDeps({ isAppInstalled: async () => false });
  assert.equal((await recoverDetached({}, first.deps)).reason, 'app-not-installed');

  const second = baseDeps({ isAppInstalled: async () => false });
  const r2 = await recoverDetached({}, second.deps);
  assert.equal(r2.reason, 'app-not-installed');
  assert.equal(r2.attempt, 1, 'cached diagnosis does not burn budget');
  assert.ok(!second.calls.includes('relaunch'), 'no terminate/launch on a cached diagnosis');
});

test('terminal cache self-heals: re-probe TRUE clears the cache and recovery proceeds', async () => {
  resetDetachedRecoveryCounter();
  const first = baseDeps({ isAppInstalled: async () => false });
  await recoverDetached({}, first.deps);

  const second = baseDeps({
    isAppInstalled: async () => true, // user reinstalled
    relaunchApp: async () => { second.calls.push('relaunch'); },
    probeAlive: async () => true,
  });
  const r2 = await recoverDetached({}, second.deps);
  assert.equal(r2.reason, 'recovered');
  assert.ok(second.calls.includes('relaunch'), 'normal recovery resumed after reinstall');
});

test('concurrent recoveries are serialized: followers share the leader verdict, one relaunch total', async () => {
  resetDetachedRecoveryCounter();
  let release;
  const gate = new Promise((r) => { release = r; });
  let relaunches = 0;
  const { deps } = baseDeps({
    relaunchApp: async () => { relaunches += 1; await gate; throw new Error('code=4'); },
    isAppInstalled: async () => false,
    snapshotHint: () => null,
  });
  const p1 = recoverDetached({}, deps);
  const p2 = recoverDetached({}, deps);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(relaunches, 1, 'follower must not run its own terminate/launch');
  assert.equal(r1.reason, 'app-not-installed');
  assert.deepEqual(r2, r1, 'follower shares the leader verdict');
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

Run: `npm run build && node --test test/unit/gh-262-recover-not-installed.test.js`
Expected: build PASSES, first test gets `reason: 'still-detached'` instead of `'app-not-installed'`

- [ ] **Step 3: Write the implementation**

In `src/cdp/recover-detached.ts`:

(a) Add the import (same `cdp/` layer only — NOT from `tools/`):

```typescript
import { probeAppInstalled } from './app-installed-probe.js';
import type { SnapshotHint } from './app-installed-probe.js';
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
  /**
   * GH #262: best-effort reinstallable-snapshot hint. NO default — the
   * implementation lives in the tools layer (resolve-ios-app-file.ts) and
   * cdp/ must not import from tools/; status.ts/restart.ts inject it.
   */
  snapshotHint?: (appId: string) => SnapshotHint | null;
}
```

(e) Replace the module-state block (`let attempts = 0; ... export function resetDetachedRecoveryCounter ...`) with:

```typescript
let attempts = 0;
/** GH #262: a CONFIRMED missing bundle, cached so follow-up recoveries
 * short-circuit (no pointless terminate/launch, no budget burn) until a
 * cheap re-probe sees it reinstalled. */
let confirmedNotInstalled: { udid: string; appId: string } | null = null;
/** GH #262: serialize concurrent recoveries — agent workflows fire cdp_status
 * in bursts; followers share the leader's verdict instead of racing their own
 * simctl terminate/launch and burning the consecutive-attempt budget. */
let inflight: Promise<DetachedRecoveryResult> | null = null;

/** Reset the per-session recovery budget (on device_snapshot open AND on a successful recovery). */
export function resetDetachedRecoveryCounter(): void {
  attempts = 0;
  confirmedNotInstalled = null;
}
```

(f) Rename the existing exported `recoverDetached` body to a private `recoverDetachedInner` and add the serializing wrapper:

```typescript
export async function recoverDetached(
  client: CDPClient,
  deps: RecoverDetachedDeps = {},
): Promise<DetachedRecoveryResult> {
  if (inflight) return inflight;
  inflight = recoverDetachedInner(client, deps);
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function recoverDetachedInner(
  client: CDPClient,
  deps: RecoverDetachedDeps = {},
): Promise<DetachedRecoveryResult> {
  // ... existing body, with the additions below ...
}
```

(g) Inside `recoverDetachedInner`, AFTER the session/platform early-returns and BEFORE the budget check, insert the terminal-cache gate (note `udid`/`appId` are already in scope there — move their `const` declarations up if needed):

```typescript
  const isAppInstalled = deps.isAppInstalled ?? probeAppInstalled;
  const buildHint = (): SnapshotHint | undefined => {
    if (!deps.snapshotHint) return undefined;
    try { return deps.snapshotHint(appId) ?? undefined; } catch { return undefined; }
  };

  // GH #262: a previously CONFIRMED missing bundle short-circuits the whole
  // attempt — but a cheap re-probe first, so a user reinstall self-heals.
  if (confirmedNotInstalled
      && confirmedNotInstalled.udid === udid
      && confirmedNotInstalled.appId === appId) {
    if ((await isAppInstalled(udid, appId)) === false) {
      const snapshotHint = buildHint();
      return {
        recovered: false,
        reason: 'app-not-installed',
        attempt: attempts,
        udid,
        appId,
        ...(snapshotHint ? { snapshotHint } : {}),
      };
    }
    confirmedNotInstalled = null;
  }
```

(h) Replace the relaunch try/catch block with:

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
    if ((await isAppInstalled(udid, appId)) === false) {
      confirmedNotInstalled = { udid, appId };
      const snapshotHint = buildHint();
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

(i) Update the existing gh-208 tests: in `test/unit/gh-208-recover-detached.test.js` and `test/unit/gh-208-review-fixes.test.js`, find every deps object whose `relaunchApp` throws and add `isAppInstalled: async () => null` to it (keeps their still-detached semantics AND prevents the default probe shelling out to real `xcrun` from unit tests).

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `npm run build && node --test test/unit/gh-262-recover-not-installed.test.js test/unit/gh-208-recover-detached.test.js test/unit/gh-208-review-fixes.test.js`
Expected: PASS — all tests in all three files

- [ ] **Step 5: Commit**

```bash
git add src/cdp/recover-detached.ts test/unit/gh-262-recover-not-installed.test.js test/unit/gh-208-recover-detached.test.js test/unit/gh-208-review-fixes.test.js
git commit -S -m "feat(#262): recover-detached app-not-installed short-circuit + serialization + terminal cache"
```

---

### Task 4: `APP_NOT_INSTALLED` error code + `cdp_status` mapping + hint injection

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (ToolErrorCode union, ~line 190)
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (deps type ~line 123, recovery call site ~line 315, APP_DETACHED catch before the `detachedHint` chain ~line 331)
- Test: `scripts/cdp-bridge/test/unit/gh-262-status-not-installed.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-status-not-installed.test.js` (harness mirrors `gh-208-status-detached-recovery.test.js`; envelope fields verified: `env.code` / `env.error`):

```js
// GH #262: when detached-recovery reports 'app-not-installed', cdp_status
// returns the distinct APP_NOT_INSTALLED code with install advice (incl. a
// shell-quoted snapshot reinstall line when a hint exists) — instead of the
// generic APP_DETACHED "relaunch manually / hardReset" advice that can never
// work for a missing bundle. status.ts also injects the tools-layer
// snapshotHint implementation into the recovery deps (layering rule).
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

function makeHandler(recovery, capture) {
  const client = makeDetachedClient();
  return createStatusHandler(() => client, () => {}, () => client, {
    recoverDetached: async (c, rdeps) => { if (capture) capture(rdeps); return recovery; },
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

test('cdp_status: injects a tools-layer snapshotHint fn into the recovery deps', async () => {
  _setHasSessionForTest(false);
  try {
    let rdeps;
    const handler = makeHandler(
      { recovered: false, reason: 'still-detached', attempt: 1 },
      (d) => { rdeps = d; },
    );
    await handler({});
    assert.equal(typeof rdeps?.snapshotHint, 'function', 'status.ts must inject snapshotHint (layering rule)');
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

Run: `npm run build && node --test test/unit/gh-262-status-not-installed.test.js`
Expected: build PASSES; first two tests get code `APP_DETACHED` instead of `APP_NOT_INSTALLED`; the injection test fails on `rdeps?.snapshotHint`

- [ ] **Step 3: Write the implementation**

(a) `src/types.ts` — extend the union directly under the `APP_DETACHED` member:

```typescript
  | 'APP_DETACHED'              // GH #208 (RC2/RC3): Metro up but 0 Hermes targets (app detached)
  | 'APP_NOT_INSTALLED'         // GH #262: relaunch failed and get_app_container confirms the bundle is missing
```

(b) `src/tools/status.ts` — add imports:

```typescript
import { buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import type { RecoverDetachedDeps } from '../cdp/recover-detached.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
```

(c) `src/tools/status.ts` — widen the injectable's type in the handler deps (where `recoverDetached` is declared, ~line 123-129) to accept the deps argument:

```typescript
  recoverDetached?: (client: CDPClient, rdeps?: RecoverDetachedDeps) => Promise<DetachedRecoveryResult>;
```

(d) `src/tools/status.ts` — at the recovery call site (~line 315), inject the tools-layer hint (layering rule: cdp/ has no default for it):

```typescript
        const recovery: DetachedRecoveryResult = callerPinnedNonIos
          ? { recovered: false, reason: 'unsupported-platform', attempt: 0 }
          : await recoverDetachedFn(getClient(), { snapshotHint: snapshotHintForBundleId });
```

(e) `src/tools/status.ts` — inside the `AppDetachedError` branch, immediately BEFORE the `const detachedHint =` chain, insert:

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

Run: `npm run build && node --test test/unit/gh-262-status-not-installed.test.js test/unit/gh-208-status-detached-recovery.test.js test/unit/gh-208-status-storm-preempt.test.js`
Expected: PASS — all tests in all three files

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/tools/status.ts test/unit/gh-262-status-not-installed.test.js
git commit -S -m "feat(#262): cdp_status maps app-not-installed to APP_NOT_INSTALLED + injects tools-layer hint"
```

---

### Task 5: `cdp_restart` — strict bundleId chain, session-UDID targeting, launch classification

**Files:**
- Modify: `scripts/cdp-bridge/src/project-config.ts` (add strict resolver)
- Modify: `scripts/cdp-bridge/src/tools/restart.ts` (deps interface ~line 12, handler header ~line 114, bundleId chain ~lines 125–130, simctl targets, launch catch ~lines 155–162, budget reset)
- Test: `scripts/cdp-bridge/test/unit/gh-262-restart-fallback.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-262-restart-fallback.test.js` (mock-client harness copied from `cdp-restart.test.js`):

```js
// GH #262 (+ #194 BUG 2 residual): hardReset must not silently degrade to a
// soft reset when the bundleId cache is empty — the chain is now
// explicit arg > connectedTarget > cache > active-session appId > STRICT
// app.json (per-platform, NO iOS←Android fallback: feeding an Android
// package to iOS simctl would misreport APP_NOT_INSTALLED). simctl targets
// the active session's UDID when one exists ('booted' otherwise), failed
// launches are probe-classified, and a successful hardReset resets the
// detached-recovery budget.
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
  return createRestartHandler(
    () => current,
    (c) => { current = c; },
    () => newClient,
    { getSession: () => null, ...deps },
  );
}

test('hardReset: empty cache + no session → strict app.json fallback, simctl on booted', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: (platform) => {
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

test('hardReset: active iOS session appId outranks app.json; simctl targets the session UDID', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    getSession: () => ({ deviceId: 'UDID-S', appId: 'com.session.app', platform: 'ios' }),
    resolveBundleIdStrict: () => 'com.fallback.app',
  });
  expectOk(await handler({ hardReset: true }));
  assert.ok(simctl.some((c) => c === 'simctl terminate UDID-S com.session.app'), `got: ${simctl}`);
  assert.ok(simctl.some((c) => c === 'simctl launch UDID-S com.session.app'));
});

test('hardReset: strict resolver also unresolvable → existing skip-simctl step (unchanged)', async () => {
  const handler = harness({
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => null,
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
    resolveBundleIdStrict: () => 'com.fallback.app',
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
    resolveBundleIdStrict: () => 'com.fallback.app',
    probeAppInstalled: async () => null,
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(data.hardResetSteps.some((s) => s.startsWith('simctl launch:err(') && !s.includes('APP_NOT_INSTALLED')));
});

test('hardReset success resets the detached-recovery budget', async () => {
  let resets = 0;
  const handler = harness({
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => 'com.fallback.app',
    resetDetachedBudget: () => { resets += 1; },
  });
  expectOk(await handler({ hardReset: true }));
  assert.equal(resets, 1, 'a successful manual hard reset is a working recovery — budget must reset');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-262-restart-fallback.test.js`
Expected: build PASSES; first test finds `skip-simctl:no-bundleId-on-connectedTarget-or-cache` (no fallback yet)

- [ ] **Step 3: Write the implementation**

(a) `src/project-config.ts` — append the strict resolver (NO cross-platform fallback; multi-LLM review: feeding an Android package to iOS simctl would misreport `APP_NOT_INSTALLED`):

```typescript
/**
 * GH #262: strict per-platform app id — NO cross-platform fallback. Used by
 * recovery paths where a wrong-platform id would produce a confidently wrong
 * diagnosis (an Android package fed to iOS simctl "is not installed").
 */
export function readAppIdStrict(projectRoot: string, platform: string): string | null {
  for (const filename of ['app.json', 'app.config.json']) {
    const p = join(projectRoot, filename);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as AppConfig;
      const expo = (raw.expo ?? raw) as AppConfig['expo'];
      if (platform === 'android') return expo?.android?.package ?? null;
      return expo?.ios?.bundleIdentifier ?? null;
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveBundleIdStrict(platform: string): string | null {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return null;
  return readAppIdStrict(projectRoot, platform);
}
```

(b) `src/tools/restart.ts` — add imports:

```typescript
import { resolveBundleIdStrict } from '../project-config.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { probeAppInstalled, buildNotInstalledAdvice } from '../cdp/app-installed-probe.js';
import type { SnapshotHint } from '../cdp/app-installed-probe.js';
import { resetDetachedRecoveryCounter } from '../cdp/recover-detached.js';
import { snapshotHintForBundleId } from './resolve-ios-app-file.js';
```

(c) Extend `RestartHandlerDeps`:

```typescript
  /** GH #262 (#194 BUG 2 residual): strict per-platform app.json fallback. */
  resolveBundleIdStrict?: (platform: string) => string | null;
  /** GH #262: active device session (appId outranks app.json; UDID targets simctl). */
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  /** GH #262: tri-state install probe for classifying launch failures. */
  probeAppInstalled?: (udid: string, appId: string) => Promise<boolean | null>;
  /** GH #262: best-effort reinstallable-snapshot hint. */
  snapshotHint?: (appId: string) => SnapshotHint | null;
  /** GH #262: a successful manual hard reset is a working recovery — reset the detached budget. */
  resetDetachedBudget?: () => void;
```

(d) Resolve the deps in the handler header (next to the existing three):

```typescript
  const resolveBundleIdStrictFn = deps.resolveBundleIdStrict ?? resolveBundleIdStrict;
  const getSessionFn = deps.getSession ?? getActiveSession;
  const probeAppInstalledFn = deps.probeAppInstalled ?? probeAppInstalled;
  const snapshotHintFn = deps.snapshotHint ?? snapshotHintForBundleId;
  const resetDetachedBudgetFn = deps.resetDetachedBudget ?? resetDetachedRecoveryCounter;
```

(e) Replace the bundleId/platform resolution block (currently `const observedBundleId ... .toLowerCase();`, ~lines 125–130) — `targetPlatform` must now be computed BEFORE `bundleId`, and the simctl target honors the active session's UDID:

```typescript
      const observedBundleId = oldClient.connectedTarget?.description ?? null;
      if (observedBundleId) lastSeenBundleId = observedBundleId;
      const targetPlatform = (oldClient.connectedTarget?.platform ?? args.platform ?? 'ios').toLowerCase();
      const session = getSessionFn();
      const sessionMatches = !!session && (session.platform ?? 'ios') === targetPlatform;
      // Resolution priority (GH #262 / #194 BUG 2): explicit arg > current
      // connectedTarget > cache > active-session appId > STRICT app.json.
      // A fresh bridge process has no cache — without the fallbacks, hardReset
      // silently degraded to a soft reset exactly when the hard path was
      // needed. STRICT: an Android package must never be fed to iOS simctl.
      const bundleId = args.bundleId
        ?? observedBundleId
        ?? lastSeenBundleId
        ?? (sessionMatches ? session?.appId ?? null : null)
        ?? resolveBundleIdStrictFn(targetPlatform);
      // simctl targets the session's simulator when one is open — 'booted' is
      // ambiguous with multiple booted sims (multi-LLM review).
      const targetUdid = (sessionMatches ? session?.deviceId : undefined) ?? 'booted';
```

(f) In the hardReset simctl block, replace the literal `'booted'` in BOTH `simctl terminate` and `simctl launch` argv with `targetUdid` (step strings keep their existing shapes).

(g) Replace the `simctl launch` catch block (currently pushes `simctl launch:err(...)`):

```typescript
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // GH #262: distinguish "launch hiccup" from "bundle not installed" —
            // the latter needs install advice, not the soft-reset retry below.
            // Probe verdict null = unknown → keep the raw error (fail open).
            if ((await probeAppInstalledFn(targetUdid, bundleId)) === false) {
              let hint: SnapshotHint | null = null;
              try { hint = snapshotHintFn(bundleId); } catch { /* best-effort */ }
              hardResetSteps.push(
                `simctl launch:err(APP_NOT_INSTALLED — ${buildNotInstalledAdvice(targetUdid, bundleId, hint)})`,
              );
            } else {
              // Fatal-ish: if launch fails, the soft reset below will likely
              // fail too. Still continue — caller sees the launch error in
              // hardResetSteps and the connectError from the autoConnect.
              hardResetSteps.push(`simctl launch:err(${msg})`);
            }
          }
```

(h) In the SUCCESS return path (after the soft-reset reconnect succeeds), reset the detached budget when this was a hard reset (Antigravity review: a working manual recovery must not leave auto-recovery reporting `budget-exhausted`):

```typescript
      if (args.hardReset && connected) resetDetachedBudgetFn();
```

(place it where `connected` (the post-autoConnect success flag, whatever it is named in the existing success path) is known, immediately before building the success result).

- [ ] **Step 4: Run tests to verify they pass (new + existing)**

Run: `npm run build && node --test test/unit/gh-262-restart-fallback.test.js test/unit/cdp-restart.test.js`
Expected: PASS — all tests in both files. (Existing `cdp-restart.test.js` cases run without a session — `getSession` defaults to the real `getActiveSession`, which returns null in unit tests, so `'booted'` behavior is preserved. If any existing hardReset case starts resolving a bundleId from THIS repo's app.json via the new strict fallback, inject `resolveBundleIdStrict: () => null` into that case to preserve its intent.)

- [ ] **Step 5: Commit**

```bash
git add src/project-config.ts src/tools/restart.ts test/unit/gh-262-restart-fallback.test.js
git commit -S -m "feat(#262): hardReset strict bundleId chain + session-UDID targeting + APP_NOT_INSTALLED classification"
```

---

### Task 6: Full verification, dist rebuild, changeset

**Files:**
- Create: `.changeset/gh-262-app-not-installed.md` (repo root)
- Modify: `scripts/cdp-bridge/dist/**` (tracked build output)

- [ ] **Step 1: Run the full suite**

Run: `cd scripts/cdp-bridge && npm run test:all`
Expected: ALL PASS (1966 baseline + ~35 new). Zero failures — fix anything red before proceeding.

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

Recovery paths now detect "app not installed" and resolve their relaunch target truthfully (GH #262, absorbs #194 BUG 2).

- `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container`'s stderr carries the `NSPOSIXErrorDomain code=2` marker (allowlist-only, stderr-only — argv-spoof-proof), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the newest matching `.app` snapshot from the last clearState (GH #201 dir, mtime-sorted budgeted scan). Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior. Concurrent recoveries are serialized, and a confirmed missing bundle is cached (with a cheap re-probe) so the diagnosis is never masked by `budget-exhausted`.
- `cdp_restart hardReset=true`: the relaunch target resolves through `explicit arg > connectedTarget > cache > active-session appId > strict per-platform app.json` (no iOS←Android fallback), simctl targets the active session's UDID when one exists, failed launches are classified the same way in `hardResetSteps`, and a successful hard reset resets the detached-recovery budget.
```

- [ ] **Step 5: Commit**

```bash
git add .changeset/gh-262-app-not-installed.md dist
git commit -S -m "chore(#262): rebuilt dist + changeset"
```

- [ ] **Step 6: Post-implementation gates (per project workflow)**

1. `/multi-review` (Antigravity + Codex) on the branch diff; address findings.
2. Live verification on the booted iOS simulator — the real escape-hatch gate:
   - Erase a booted sim (`xcrun simctl shutdown <udid> && xcrun simctl erase <udid> && xcrun simctl boot <udid>`), start Metro, call `cdp_status platform=ios` → expect `APP_NOT_INSTALLED` with advice (NOT generic APP_DETACHED), in line with the issue's repro.
   - Call `cdp_status` again → expect the cached diagnosis (fast, no relaunch attempt) — then reinstall the app and confirm recovery proceeds (cache self-heals).
   - Confirm no snapshot hint appears if `$TMPDIR/rn-appfile-snapshots` has no matching bundle; populate via a clearState flow and confirm the hint appears with a quoted path.
3. PR via `superpowers:finishing-a-development-branch`; body cites #262 with `Closes #262` and notes the #194 BUG 2 residual closure.

**No MCP tool-docs regeneration needed:** no tool was added and no input schema changed — only result codes/messages.
