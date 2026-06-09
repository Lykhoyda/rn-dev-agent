# Android Instrumentation-Slot Handoff (#237) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runFlowParked` release the single Android `UiAutomation` slot before a Maestro flow runs, so `maestro_run`/`maestro_test_all`/`cdp_auto_login` stop failing with `UIAutomator2 server not ready after 30s` on Android.

**Architecture:** New pure-core + DI module `release-android-slot.ts` (Android analog of `ensure-single-runner.ts`) that (1) stops our in-tree runner, (2) `adb shell am force-stop`s our two instrumentation packages — the decisive slot-release — and (3) optionally kills a stale legacy `agent-device` daemon by PID (guarded against self-kill). `runFlowParked` gains a merged options bag and, on `platform==='android'`, awaits the release before running the flow; iOS path is untouched. The exclusive arbiter `flow` lease (already held across the whole flow) prevents any concurrent `device_*` from re-grabbing the slot.

**Tech Stack:** TypeScript (Node ≥22, ESM), `node:test` + `node:assert/strict` unit tests importing from `dist/`, `adb`/`am`, changesets.

**Spec:** `docs/superpowers/specs/2026-06-09-237-android-instrumentation-slot-handoff-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `scripts/cdp-bridge/src/runners/release-android-slot.ts` | Pure helpers (`OWNED_PACKAGES`, `isProtectedPid`) + DI orchestrator `releaseAndroidInteractionSlot`. The only place with Android slot-release side effects. |
| **Create** `scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js` | Unit tests for the pure helpers + orchestrator (DI, no device). |
| **Modify** `scripts/cdp-bridge/src/tools/maestro-run.ts` | Extend `runFlowParked` to a merged opts bag + Android branch; pass `{platform,deviceId}` at the `maestro_run` call site. |
| **Modify** `scripts/cdp-bridge/test/unit/gh-202-maestro-flow-parks-l2.test.js` | ADD Android-branch tests (existing iOS tests stay as-is). |
| **Modify** `scripts/cdp-bridge/src/tools/maestro-test-all.ts:143` | Pass `{platform,deviceId}` to `runFlowParked`. |
| **Modify** `scripts/cdp-bridge/src/tools/auto-login.ts:223` | Pass `{platform,deviceId}` to `runFlowParked`. |
| **Create** `.changeset/gh-237-android-instrumentation-slot.md` | Patch bump + changelog entry. |
| **Modify** `CLAUDE.md` | Troubleshooting bullet for the Android UIAutomator2 conflict. |

---

## Task 1: `release-android-slot.ts` — pure helpers

**Files:**
- Create: `scripts/cdp-bridge/src/runners/release-android-slot.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWNED_PACKAGES,
  isProtectedPid,
} from '../../dist/runners/release-android-slot.js';

test('GH#237 OWNED_PACKAGES: exactly our two in-tree runner packages', () => {
  assert.deepEqual(OWNED_PACKAGES, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 isProtectedPid: true for our own pid or parent pid', () => {
  assert.equal(isProtectedPid(4242, 4242, 9), true);   // == self
  assert.equal(isProtectedPid(9, 4242, 9), true);      // == parent
  assert.equal(isProtectedPid(777, 4242, 9), false);   // unrelated
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: tsc FAILS — `Cannot find module '../../dist/runners/release-android-slot.js'` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/cdp-bridge/src/runners/release-android-slot.ts`:

```ts
// The two packages our in-tree Android runner installs (see
// rn-android-runner-client.ts:18 — INSTRUMENTATION). Force-stopping these frees
// the device-side UiAutomation slot for maestro-runner's UIAutomator2 server.
// We force-stop ONLY these — never a foreign UIAutomator2 package (that overreach
// is what killed the MCP server in the #237 repro's `pkill -f agent-device`).
export const OWNED_PACKAGES = [
  'dev.lykhoyda.rndevagent.androidrunner.test',
  'dev.lykhoyda.rndevagent.androidrunner',
];

/**
 * Self-kill guard: never SIGTERM/SIGKILL our own process or our parent. The
 * legacy daemon PID is read from ~/.agent-device/daemon.json, which can hold a
 * stale, OS-recycled PID — without this guard a recycled PID matching our own
 * tree would kill the MCP server (the exact collateral of `pkill -f agent-device`).
 */
export function isProtectedPid(pid: number, selfPid: number, parentPid: number): boolean {
  return pid === selfPid || pid === parentPid;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern="GH#237 (OWNED_PACKAGES|isProtectedPid)"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/release-android-slot.ts scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js
git commit -S -m "feat(#237): release-android-slot pure helpers (OWNED_PACKAGES, isProtectedPid)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `releaseAndroidInteractionSlot` orchestrator (DI)

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/release-android-slot.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js`:

```js
import { releaseAndroidInteractionSlot } from '../../dist/runners/release-android-slot.js';

function baseDeps(over = {}) {
  return {
    stopOwnRunner: async () => {},
    adbForceStop: async () => {},
    resolveSerial: () => [],
    readDaemonPid: () => null,
    isAlive: () => false,
    protectedPids: () => ({ selfPid: 4242, parentPid: 9 }),
    kill: () => {},
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    killLegacy: () => true,
    now: () => 0,
    ...over,
  };
}

test('GH#237 release: order is stopOwnRunner → force-stop both pkgs → daemon', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot({ deviceId: 'emulator-5554' }, baseDeps({
    stopOwnRunner: async () => { order.push('stop'); },
    adbForceStop: async (pkg) => { order.push(`force:${pkg}`); },
    readDaemonPid: () => null,
  }));
  assert.deepEqual(order, [
    'stop',
    'force:dev.lykhoyda.rndevagent.androidrunner.test',
    'force:dev.lykhoyda.rndevagent.androidrunner',
  ]);
  assert.equal(r.stoppedOwnRunner, true);
  assert.deepEqual(r.forceStoppedPackages, [
    'dev.lykhoyda.rndevagent.androidrunner.test',
    'dev.lykhoyda.rndevagent.androidrunner',
  ]);
});

test('GH#237 release: deviceId resolves to an -s serial passed to force-stop', async () => {
  const serials = [];
  await releaseAndroidInteractionSlot({ deviceId: 'emulator-5554' }, baseDeps({
    resolveSerial: (id) => (id ? ['-s', id] : []),
    adbForceStop: async (_pkg, serial) => { serials.push(serial.join(' ')); },
  }));
  assert.deepEqual(serials, ['-s emulator-5554', '-s emulator-5554']);
});

test('GH#237 release: killLegacy()=false skips daemon kill but still does steps 1+2', async () => {
  const order = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    killLegacy: () => false,
    stopOwnRunner: async () => order.push('stop'),
    adbForceStop: async () => order.push('force'),
    readDaemonPid: () => { throw new Error('daemon must not be read when killLegacy=false'); },
    kill: () => assert.fail('must not kill daemon when killLegacy=false'),
  }));
  assert.deepEqual(order, ['stop', 'force', 'force']);
  assert.equal(r.killedDaemonPids.length, 0);
});

test('GH#237 release: kills a live, non-protected legacy daemon (SIGTERM→SIGKILL)', async () => {
  const killed = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 777,
    isAlive: () => true,          // alive before + survives SIGTERM → SIGKILL
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    fileExists: () => false,
  }));
  assert.deepEqual(r.killedDaemonPids, [777]);
  assert.ok(killed.includes('777:SIGTERM'));
  assert.ok(killed.includes('777:SIGKILL'));
});

test('GH#237 release: REFUSES to kill the daemon when its PID is our own/parent', async () => {
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 4242,    // == selfPid
    isAlive: () => true,
    protectedPids: () => ({ selfPid: 4242, parentPid: 9 }),
    kill: () => assert.fail('must NOT kill our own process'),
    fileExists: () => true,
    removeFile: () => assert.fail('must keep daemon files for a live (our-own) daemon'),
  }));
  assert.equal(r.killedDaemonPids.length, 0);
  assert.ok(r.warnings.some((w) => /our own process\/parent/.test(w)));
});

test('GH#237 release: removes orphaned daemon files when the daemon PID is dead', async () => {
  const removed = [];
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    readDaemonPid: () => 4242,
    isAlive: () => false,         // dead → orphan
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(removed.length, 2); // daemon.json + daemon.lock
  assert.deepEqual(r.removedFiles.length, 2);
});

test('GH#237 release: never throws when stopOwnRunner fails (idempotent/best-effort)', async () => {
  const r = await releaseAndroidInteractionSlot({}, baseDeps({
    stopOwnRunner: async () => { throw new Error('runner already stopped'); },
  }));
  assert.equal(r.stoppedOwnRunner, false);
  assert.ok(r.warnings.some((w) => /stopAndroidRunner failed/.test(w)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: tsc FAILS — `release-android-slot.js has no exported member 'releaseAndroidInteractionSlot'`.

- [ ] **Step 3: Write the implementation**

Replace the full contents of `scripts/cdp-bridge/src/runners/release-android-slot.ts` with:

```ts
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stopAndroidRunner } from './rn-android-runner-client.js';
import { getAdbSerial } from '../agent-device-wrapper.js';

const execFile = promisify(execFileCb);

const DAEMON_JSON = join(homedir(), '.agent-device', 'daemon.json');
const DAEMON_LOCK = join(homedir(), '.agent-device', 'daemon.lock');
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;
const ADB_TIMEOUT_MS = 5_000;

// The two packages our in-tree Android runner installs (see
// rn-android-runner-client.ts:18 — INSTRUMENTATION). Force-stopping these frees
// the device-side UiAutomation slot for maestro-runner's UIAutomator2 server.
// We force-stop ONLY these — never a foreign UIAutomator2 package (that overreach
// is what killed the MCP server in the #237 repro's `pkill -f agent-device`).
export const OWNED_PACKAGES = [
  'dev.lykhoyda.rndevagent.androidrunner.test',
  'dev.lykhoyda.rndevagent.androidrunner',
];

/**
 * Self-kill guard: never SIGTERM/SIGKILL our own process or our parent. The
 * legacy daemon PID is read from ~/.agent-device/daemon.json, which can hold a
 * stale, OS-recycled PID — without this guard a recycled PID matching our own
 * tree would kill the MCP server (the exact collateral of `pkill -f agent-device`).
 */
export function isProtectedPid(pid: number, selfPid: number, parentPid: number): boolean {
  return pid === selfPid || pid === parentPid;
}

export interface ReleaseAndroidSlotResult {
  stoppedOwnRunner: boolean;
  forceStoppedPackages: string[];
  killedDaemonPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface ReleaseAndroidSlotDeps {
  stopOwnRunner: (deviceId?: string) => Promise<void>;
  adbForceStop: (pkg: string, serial: string[]) => Promise<void>;
  resolveSerial: (deviceId?: string) => string[];
  readDaemonPid: () => number | null;
  isAlive: (pid: number) => boolean;
  protectedPids: () => { selfPid: number; parentPid: number };
  kill: (pid: number, sig: NodeJS.Signals) => void;
  fileExists: (p: string) => boolean;
  removeFile: (p: string) => void;
  delay: (ms: number) => Promise<void>;
  killLegacy: () => boolean;
  now: () => number;
}

function defaultDeps(): ReleaseAndroidSlotDeps {
  return {
    stopOwnRunner: (deviceId) => stopAndroidRunner(deviceId),
    adbForceStop: async (pkg, serial) => {
      await execFile('adb', [...serial, 'shell', 'am', 'force-stop', pkg], {
        timeout: ADB_TIMEOUT_MS,
        encoding: 'utf8',
      });
    },
    resolveSerial: (deviceId) => (deviceId ? ['-s', deviceId] : getAdbSerial()),
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    protectedPids: () => ({ selfPid: process.pid, parentPid: process.ppid }),
    kill: (pid, sig) => process.kill(pid, sig),
    fileExists: (p) => existsSync(p),
    removeFile: (p) => unlinkSync(p),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    killLegacy: () => process.env.RN_DEVICE_KILL_LEGACY !== '0',
    now: () => Date.now(),
  };
}

/**
 * GH#237: release the single Android UiAutomation slot before an L3 Maestro flow.
 * Best-effort and idempotent — every step records a warning on failure and never
 * throws, so a flow is never blocked by a cleanup hiccup (and the auto-repair
 * re-entrancy path can call it again safely). MUST run inside the held arbiter
 * `flow` lease (no concurrent device_* can re-grab the slot between release and bind).
 */
export async function releaseAndroidInteractionSlot(
  opts: { deviceId?: string } = {},
  deps: ReleaseAndroidSlotDeps = defaultDeps(),
): Promise<ReleaseAndroidSlotResult> {
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const forceStoppedPackages: string[] = [];
  const killedDaemonPids: number[] = [];
  const removedFiles: string[] = [];
  let stoppedOwnRunner = false;

  // Step 1 — our own runner (always; it is our resource). Secondary cleanup:
  // kills the host `am instrument` handle + removes the adb forward. Does NOT
  // reliably free the device-side slot on its own (system_server keeps it).
  const t1 = deps.now();
  try {
    await deps.stopOwnRunner(opts.deviceId);
    stoppedOwnRunner = true;
  } catch (err) {
    warnings.push(`stopAndroidRunner failed: ${msg(err)}`);
  }
  timings.stopOwnRunner = deps.now() - t1;

  // Step 2 — force-stop OUR instrumentation packages. THE decisive slot-release:
  // tears down the device-side instrumentation the SIGTERM left alive.
  const t2 = deps.now();
  const serial = deps.resolveSerial(opts.deviceId);
  for (const pkg of OWNED_PACKAGES) {
    try {
      await deps.adbForceStop(pkg, serial);
      forceStoppedPackages.push(pkg);
    } catch (err) {
      warnings.push(`am force-stop ${pkg} failed: ${msg(err)}`);
    }
  }
  timings.forceStop = deps.now() - t2;

  // Step 3 — legacy agent-device daemon (gated by RN_DEVICE_KILL_LEGACY; may
  // belong to another project, so kill by SPECIFIC pid, never pkill, guarded
  // against our own process tree).
  const t3 = deps.now();
  if (deps.killLegacy()) {
    const pid = deps.readDaemonPid();
    let keepFiles = false;
    if (pid !== null && deps.isAlive(pid)) {
      const { selfPid, parentPid } = deps.protectedPids();
      if (isProtectedPid(pid, selfPid, parentPid)) {
        warnings.push(`Refusing to kill agent-device daemon PID ${pid} — it is our own process/parent.`);
        keepFiles = true;
      } else {
        try {
          deps.kill(pid, 'SIGTERM');
          await deps.delay(SIGKILL_GRACE_MS);
          if (deps.isAlive(pid)) deps.kill(pid, 'SIGKILL');
          killedDaemonPids.push(pid);
        } catch (err) {
          warnings.push(`kill daemon ${pid} failed: ${msg(err)}`);
        }
      }
    }
    if (!keepFiles) {
      for (const f of DAEMON_FILES) {
        if (!deps.fileExists(f)) continue;
        try { deps.removeFile(f); removedFiles.push(f); }
        catch (err) { warnings.push(`rm ${f} failed: ${msg(err)}`); }
      }
    }
  }
  timings.legacyDaemon = deps.now() - t3;

  return { stoppedOwnRunner, forceStoppedPackages, killedDaemonPids, removedFiles, warnings, meta: { timings_ms: timings } };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern="GH#237"`
Expected: PASS (all Task 1 + Task 2 tests — 9 total).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/release-android-slot.ts scripts/cdp-bridge/test/unit/gh-237-release-android-slot.test.js
git commit -S -m "feat(#237): releaseAndroidInteractionSlot — stop runner + am force-stop + guarded daemon kill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `runFlowParked` — merged opts bag + Android branch

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts:23-43`
- Test: `scripts/cdp-bridge/test/unit/gh-202-maestro-flow-parks-l2.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/cdp-bridge/test/unit/gh-202-maestro-flow-parks-l2.test.js` (leave the two existing iOS tests unchanged):

```js
test('GH#237 runFlowParked: android releases the slot before the flow, marks stale after', async () => {
  const calls = [];
  const out = await runFlowParked(
    async () => { calls.push('flow'); return 'OK'; },
    {
      platform: 'android',
      deviceId: 'emulator-5554',
      releaseAndroidSlot: async () => { calls.push('release'); },
      markCdpStale: () => calls.push('stale'),
    },
  );
  assert.equal(out, 'OK');
  assert.deepEqual(calls, ['release', 'flow', 'stale']);
});

test('GH#237 runFlowParked: android does NOT call stopFastRunner (iOS-only)', async () => {
  const calls = [];
  await runFlowParked(
    async () => 'OK',
    {
      platform: 'android',
      releaseAndroidSlot: async () => calls.push('release'),
      stopFastRunner: () => calls.push('stopFast'),
      markCdpStale: () => {},
    },
  );
  assert.ok(calls.includes('release'));
  assert.ok(!calls.includes('stopFast'));
});

test('GH#237 runFlowParked: android still marks stale when the flow throws', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => { throw new Error('boom'); },
      {
        platform: 'android',
        releaseAndroidSlot: async () => calls.push('release'),
        markCdpStale: () => calls.push('stale'),
      },
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['release', 'stale']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern="GH#237 runFlowParked"`
Expected: FAIL — android tests call `stopFastRunner` (iOS path) instead of `releaseAndroidSlot`; `calls` is `['flow','stale']`, assertion mismatch. (Existing iOS tests still PASS.)

- [ ] **Step 3: Write the implementation**

In `scripts/cdp-bridge/src/tools/maestro-run.ts`, add the import near the other runner import (after line 18):

```ts
import { releaseAndroidInteractionSlot } from '../runners/release-android-slot.js';
```

Replace the `FlowParkDeps` interface + `runFlowParked` function (lines 23-43) with:

```ts
export interface FlowParkOpts {
  platform?: 'ios' | 'android';
  deviceId?: string;
  stopFastRunner?: () => void;
  markCdpStale?: () => void;
  releaseAndroidSlot?: (opts: { deviceId?: string }) => Promise<void>;
}

async function defaultReleaseAndroidSlot(opts: { deviceId?: string }): Promise<void> {
  await releaseAndroidInteractionSlot(opts);
}

/**
 * GH#202 Phase 2a + GH#237: run a Maestro flow with L2 parked. iOS stops the
 * fast-runner (XCTest); Android releases the single UiAutomation slot (our
 * runner's instrumentation would otherwise block maestro-runner's UIAutomator2
 * server — #237). Mark CDP stale afterward (always — even on failure) so the
 * next read reconnects to post-flow state. The L2 runner lazily restarts on the
 * next device_* call. MUST run inside the held arbiter `flow` lease.
 */
export async function runFlowParked<T>(run: () => Promise<T>, opts: FlowParkOpts = {}): Promise<T> {
  const stale = opts.markCdpStale ?? defaultMarkCdpStale;
  if (opts.platform === 'android') {
    const release = opts.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
    await release({ deviceId: opts.deviceId });
  } else {
    (opts.stopFastRunner ?? defaultStopFastRunner)();
  }
  try {
    return await run();
  } finally {
    stale();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern="runFlowParked"`
Expected: PASS — both original iOS tests (unchanged) AND the 3 new Android tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/maestro-run.ts scripts/cdp-bridge/test/unit/gh-202-maestro-flow-parks-l2.test.js
git commit -S -m "feat(#237): runFlowParked releases the Android slot on the android branch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `{platform, deviceId}` into the 3 flow-tool call sites

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts` (the `runFlowParked` call ~line 193)
- Modify: `scripts/cdp-bridge/src/tools/maestro-test-all.ts:143`
- Modify: `scripts/cdp-bridge/src/tools/auto-login.ts:223`

> Pure wiring — behavior is covered by Task 3's tests. Verified by full build + full suite + a grep that every call site passes `platform`.

- [ ] **Step 1: maestro-run.ts** — change the call (currently `await runFlowParked(() => execFile(...))`) to pass platform + the active session's deviceId. `platform` is already in scope (line 103); `getActiveSession` is already imported (line 8):

```ts
      const { stdout, stderr } = await runFlowParked(
        () =>
          execFile(
            dispatch.binPath,
            finalArgs,
            { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
          ),
        { platform, deviceId: getActiveSession()?.deviceId },
      );
```

- [ ] **Step 2: maestro-test-all.ts:143** — `platform` is in scope (line 66); `getActiveSession` is imported (line 16). Change the call to:

```ts
        const { stdout, stderr } = await runFlowParked(
          () =>
            execFile(
              dispatch.binPath,
              dispatch.buildArgs(platform, safeFlowFile, appFile),
              { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
            ),
          { platform, deviceId: getActiveSession()?.deviceId },
        );
```

(Preserve the exact existing `execFile` args/options on this line — only ADD the second `runFlowParked` argument.)

- [ ] **Step 3: auto-login.ts:223** — `platform` here is typed `string` (line 130). Do NOT cast it (`as 'ios'|'android'` is unsound — an unexpected string would silently take the iOS branch). NARROW it with a runtime guard. `getActiveSession` is imported. Change the call to:

```ts
    await runFlowParked(
      () =>
        execFile(runnerPath, ['--platform', platform, 'test', wrapperPath], {
          timeout,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        }),
      { platform: platform === 'android' ? 'android' : 'ios', deviceId: getActiveSession()?.deviceId },
    );
```

(Preserve the exact existing `execFile` args/options — only ADD the second `runFlowParked` argument. If the existing `execFile` options differ from the snippet above, keep the existing ones and only append the `runFlowParked` opts arg.)

- [ ] **Step 4: Verify build, full suite, and wiring**

Run: `cd scripts/cdp-bridge && npm test`
Expected: build PASSES (tsc clean) and the FULL unit suite is green (the pre-existing total + the new GH#237 tests; 0 failures).

Run: `grep -n "runFlowParked(" src/tools/maestro-run.ts src/tools/maestro-test-all.ts src/tools/auto-login.ts`
Expected: each call site is followed (within a few lines) by `{ platform`.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/maestro-run.ts scripts/cdp-bridge/src/tools/maestro-test-all.ts scripts/cdp-bridge/src/tools/auto-login.ts
git commit -S -m "feat(#237): pass platform+deviceId to runFlowParked at all 3 flow-tool call sites

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Changeset + CLAUDE.md troubleshooting note

**Files:**
- Create: `.changeset/gh-237-android-instrumentation-slot.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create the changeset**

Create `.changeset/gh-237-android-instrumentation-slot.md`:

```md
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#237): Android instrumentation-slot handoff — `runFlowParked` now releases the single Android `UiAutomation` slot before a Maestro flow (`maestro_run`/`maestro_test_all`/`cdp_auto_login`), fixing `UIAutomator2 server not ready after 30s`. It stops the in-tree `rn-android-runner`, `am force-stop`s our two instrumentation packages (the decisive device-side release), and — gated by `RN_DEVICE_KILL_LEGACY` — kills a stale legacy `agent-device` daemon by its specific PID (never `pkill`, guarded against our own process tree so the MCP server is never collateral). Best-effort and idempotent; iOS behavior is unchanged.
```

- [ ] **Step 2: Add the troubleshooting bullet to CLAUDE.md**

In `CLAUDE.md`, under `### Troubleshooting`, immediately AFTER the `- **"agent-device not installed"** …` bullet, add:

```md
- **Android: `maestro_run` fails "UIAutomator2 server not ready after 30s"** → Android allows one UiAutomator connection at a time; an interaction runner (the in-tree `rn-android-runner`, or a stale `agent-device` daemon) held it. Since #237 the flow tools auto-release the slot before a Maestro flow (`am force-stop` our own instrumentation + a guarded legacy-daemon kill). If it recurs, ensure no foreign UIAutomator2 server is bound (`adb shell ps -A | grep uiautomator`); opt out of the legacy-daemon kill with `RN_DEVICE_KILL_LEGACY=0`.
```

- [ ] **Step 3: Verify the changeset is well-formed**

Run: `cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin && npx changeset status --since main`
Expected: lists `rn-dev-agent-cdp` and `rn-dev-agent-plugin` as patch bumps (no error).

- [ ] **Step 4: Commit**

```bash
git add .changeset/gh-237-android-instrumentation-slot.md CLAUDE.md
git commit -S -m "docs(#237): changeset + Android UIAutomator2 troubleshooting bullet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Live-emulator validation (GATE — the decisive-step experiment)

> Not a code task — the spec's empirical gate. Requires a booted Android emulator + Metro running (`cd ../rn-dev-agent-workspace/test-app && npx expo start`) + the test-app loaded. The unit suite proves the orchestration; this proves the *mechanism* (which step frees the slot).

- [ ] **Step 1: Build the working-tree dist the live MCP server uses**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: clean tsc build.

- [ ] **Step 2: Reproduce the bug pre-fix is unnecessary — verify the fix directly**

Boot the emulator + open a session, exercise the in-tree runner, then run a flow:
1. `device_snapshot action=open appId=<test-app id> platform=android` — starts `rn-android-runner` (holds the slot).
2. `device_find` / `device_snapshot action=snapshot` — confirm the runner is live.
3. `maestro_run` a trivial inline flow (e.g. `- launchApp` + `- assertVisible` of a known testID).
Expected: the flow PASSES — UIAutomator2 binds (no "server not ready after 30s").

- [ ] **Step 3: Decisive-step experiment (record which step frees the slot)**

With a manual `dist`-level probe (or env toggles), determine empirically:
- After **step 2 only** (`am force-stop` of `dev.lykhoyda.rndevagent.androidrunner.test`): is the slot free for maestro? (expected: YES — the decisive step)
- After **step 1 only** (`stopAndroidRunner`'s SIGTERM, NO force-stop): is the device-side instrumentation still alive (`adb shell ps -A | grep androidrunner`) and the slot still held? (expected: still held — confirms force-stop is required)
- **Which owned package is the slot-holder?** force-stop `…androidrunner.test` ALONE vs the app package `…androidrunner` ALONE — confirm whether only the `.test` instrumentation package frees the slot or the app package also matters (plan-review open question (a); no static analysis can settle it). If only `.test` matters, note it for a possible follow-up simplification — do NOT remove the app-package force-stop in this PR.

Record the outcome in the workspace ROADMAP/PROOF. **If step 1 alone unexpectedly frees the slot**, note it — step 2 could be simplified in a follow-up (do NOT remove it in this PR; it is the documented decisive path).

- [ ] **Step 4: Legacy-daemon path (if reproducible)**

With `RN_ANDROID_RUNNER=0` (forces the legacy `agent-device` daemon) + a live daemon: `device_*` then `maestro_run`. Expected: the gated step-3 daemon kill frees the slot; `RN_DEVICE_KILL_LEGACY=0` reproduces the original failure (opt-out works as documented).

- [ ] **Step 5: Record proof** in `../rn-dev-agent-workspace/docs/proof/` and note results for the PR body. No commit in the plugin repo for this task (proof lives in the workspace).

---

## Self-Review

**1. Spec coverage:**
- §3 new module → Tasks 1-2. ✓
- §3 `runFlowParked` signature + 3 call sites → Tasks 3-4. ✓
- §4 release algorithm (steps 1/2/3, `RN_DEVICE_KILL_LEGACY` gates only step 3, foreign-not-killed, hard adb timeout) → Task 2 impl (`ADB_TIMEOUT_MS`, `killLegacy` gate, `OWNED_PACKAGES` only). ✓
- §5 self-heal (no explicit restart) → no task needed (relies on existing `startAndroidRunner`); noted in Task 3 comment. ✓
- §6 edge cases (iOS untouched, self-kill guard, idempotency, `=0` skips step 3) → Tasks 2-3 tests. ✓
- §7 arbiter lease (release MUST stay inside `runFlowParked`) → documented in Task 2/3 comments; no arbiter change. ✓
- §8 testing (unit + live gate) → Tasks 1-3 (unit) + Task 6 (live gate). ✓
- §9 amendments 1-7 → all realized (force-stop primary; own packages only; merged opts bag [refinement of the 3-arg sketch — strictly additive, see plan insight]; 5s timeout; keep step 3; gate only step 3; idempotency test). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected output. ✓

**3. Type consistency:** `releaseAndroidInteractionSlot(opts, deps)` signature identical across Task 2 def, Task 3 `defaultReleaseAndroidSlot` caller, and tests. `FlowParkOpts` fields (`platform`/`deviceId`/`stopFastRunner`/`markCdpStale`/`releaseAndroidSlot`) consistent across Task 3 def, tests, and Task 4 call sites. `OWNED_PACKAGES` order (`.test` then app) consistent between impl and the order-assertion test. ✓

> **Deviation from spec §3 noted:** the spec sketched `runFlowParked(run, {platform,deviceId}, deps)` (3 args); the plan merges into one `FlowParkOpts` bag (2 args) so the existing iOS tests pass untouched and the change is strictly additive. Same behavior, lower risk.

---

## Amendments applied from the multi-LLM plan review

`/brainstorm gemini,codex` (2026-06-09) — verdict **GO, no surviving blocker**. Codex was unavailable (usage cap until Jun 11); Gemini + Claude-verified. Both of Gemini's proposed blockers were rejected against source:
- *"deviceId → adb-serial mismatch"* — REJECTED: on Android the session `deviceId` IS the adb serial (`rn-android-runner-client.ts:104-108`, `agent-device-wrapper.ts:285`); no logical-vs-hardware indirection exists in this codebase.
- *"drop Step 3 (legacy-daemon kill)"* — REJECTED: with `RN_ANDROID_RUNNER=0` (and for `device_deeplink`/`permission`/`reset_state`) Android dispatch falls through to the legacy `agent-device` daemon (`agent-device-wrapper.ts:761-788`), which holds its own UIAutomator2 connection — so the host-daemon kill genuinely frees a device slot. Step 3 stays (spec §9.5).

**Applied:**
1. **Task 4 Step 3 — replaced the unsound `platform as 'ios'|'android'` cast with a runtime narrowing guard** (`platform === 'android' ? 'android' : 'ios'`), so an unexpected string can't silently take the iOS branch.
2. **Task 6 Step 3 — added the "which owned package is the slot-holder?" experiment** (`.test` alone vs the app package alone) — plan-review open question (a), live-only.

**Noted, not changed:** `isProtectedPid` (self/parent) is deliberately narrower than the spec's "ancestor" wording — the realistic recycled-PID collateral is self/parent; accepted. Gemini's optional "explicit `if android … else if ios`" hardening was declined — the `undefined → iOS` default is intentional and is exactly what the existing `gh-202` test asserts; keeping the merged-bag `else` avoids churning that test.
