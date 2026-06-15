# Eradicate agent-device — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the third-party `agent-device` CLI dependency entirely (iOS + Android), making the in-tree `rn-fast-runner` / `rn-android-runner` the sole device-interaction backend — proven faster + more reliable than agent-device, with hardened port-lock / conflict handling.

**Architecture:** `device_*` verbs dispatch through a platform router (`runIOS` / `runAndroid`) to in-tree HTTP `/command` runners. No daemon, no CLI, no silent fallback. A device session = runner-readiness + a state file + a serial/UDID-scoped device lock. iOS uses one host-loopback port (the runner self-assigns when the default is taken); Android separates a fixed device-listener port from a probed host port bridged by `adb forward`.

**Tech Stack:** TypeScript (Node ≥22, `tsc` build, `node:test`), Swift/XCTest (`rn-fast-runner`), Kotlin/UIAutomator2 + NanoHTTPD (`rn-android-runner`), `xcrun simctl` / `adb`.

**Spec:** `docs/superpowers/specs/2026-06-15-eradicate-agent-device-design.md`

> **Amendments applied from the multi-LLM plan review (Codex + Gemini, 2026-06-15):** fixed the Android-lock no-op (UDID_RE gates out adb serials → added `resolveAndroidSerial`); rewrote the Task 5 test to match the file's actual static source-regex style; fixed the Task 1 breakage of `gh-202-device-lock-wiring.test.js:12`; corrected/completed the Task 3 test-file list (real `runners/` path + `gh-243` + `audit-h4`) and added state-file migration; replaced the racy iOS TS-probe with "pass 0 on collision" (runner self-assigns); made `findFreePort` tests race-tolerant + guarded against resolving port 0.

---

## Phase Roadmap (stacked PRs)

This plan details **Phase 1** in full TDD. Phases 0/2/3/4 get their own plans authored when reached (each depends on the prior phase's concrete API/outcomes). Dependency graph:

```
Phase 1 (hardening) ─┐
                     ├─► Phase 2 (cutover) ─► Phase 3 (cleanup/docs) ─► Phase 4 (verify)
Phase 0 (benchmark) ─┘
```

| Phase | Title | Shape | Depends on | Status |
|---|---|---|---|---|
| **1** | Port/conflict hardening | Pure TS, unit-TDD | — | **DETAILED BELOW** |
| **0** | Head-to-head benchmark (both sims) | Device session + harness | — (must finish before Phase 2) | Own plan |
| **2** | Hard cutover (remove daemon+CLI tiers, residual verbs → native, lock-before-side-effects) | TS + device verify | Phase 1 API, Phase 0 data | Own plan |
| **3** | Cleanup + docs (install script, hook, ~522 refs, /setup, /doctor) | TS + docs | Phase 2 | Own plan |
| **4** | Final dual-platform verification + ours-only re-benchmark | Device session | Phases 1–3 | Own plan |

**Execution order:** Phase 1 first (pure code, no device gating, de-risks everything). Phase 0 (benchmark) runs as a device session before the Phase 2 cutover. Phases 0 and 1 have no interdependency.

**Per-task workflow (all tasks):** edit `src/*.ts` → **build** → **run test**. Tests import compiled `dist/`, so the build is mandatory:
```bash
cd scripts/cdp-bridge && npm run build            # tsc → dist/
node --test test/unit/<file>.test.js              # run one test file (after build)
```
> **`.js` tests are NOT type-checked** (`tsconfig.json` includes only `src`). A renamed required field on `AndroidRunnerState` therefore produces NO compile error — stale fixtures fail only at runtime under the phase-end full-suite `**` glob. Migrate every fixture in the same task that renames the field.

Full suite gate at phase end: `cd scripts/cdp-bridge && npm test` (builds + all unit files, including the `test/unit/**` subdirs). Commits are signed, per-task; add a changeset for user-facing behavior.

---

## Phase 1 — Port/Conflict Hardening

**Outcome of this PR:** an Android serial-scoped device lock that **actually engages on a normal single emulator** (parity with the iOS UDID lock), collision-tolerant runner ports (probed host port on Android via `adb forward`; runner self-assigns on iOS when 22088 is taken), and robust forward/cleanup — with no behavior change for the common single-simulator case.

### File Structure (Phase 1)

| File | Responsibility | Change |
|---|---|---|
| `scripts/cdp-bridge/src/lifecycle/device-lock.ts` | Persisted per-device ownership lock | **Modify** — widen `'ios'`-only → `'ios' \| 'android'`, rename `udid`→`deviceId` |
| `scripts/cdp-bridge/src/runners/free-port.ts` | Port probing (`findFreePort`, `isPortFree`) | **Create** |
| `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` | Android runner lifecycle + HTTP client | **Modify** — split `hostPort`/`devicePort`, probe host port, add `resolveAndroidSerial`/`parseAdbDevicesSerials`, state-file migration |
| `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` | iOS runner lifecycle | **Modify** — pass `0` (runner self-assigns) when 22088 is taken |
| `scripts/cdp-bridge/src/tools/device-session.ts` | Session open/close + lock wiring | **Modify** — generalize `acquireDeviceLockForSession`, wire Android lock on the resolved serial |
| `test/unit/gh-202-device-lock.test.js` | Lock unit tests | **Modify** — cover both platforms |
| `test/unit/gh-202-device-lock-wiring.test.js` | Lock wiring (static source-regex) | **Modify** — fix line 12 + add Android-branch assertions |
| `test/unit/free-port.test.js` | Port-probe unit tests | **Create** |
| `test/unit/android-runner-ports.test.js` | Android port-split + serial-parse tests | **Create** |
| `test/unit/runners/rn-android-runner-client.test.js`, `gh-243-android-runner-health.test.js`, `audit-h4-android-runner-deviceid.test.js` | Existing state fixtures | **Modify** — `{ port }` → `{ hostPort, devicePort }` |

---

### Task 1: Generalize `DeviceLock` to iOS + Android

**Files:**
- Modify: `scripts/cdp-bridge/src/lifecycle/device-lock.ts`
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts:40-60` (`acquireDeviceLockForSession`) + its iOS call site (`:235`)
- Test: `test/unit/gh-202-device-lock.test.js`, and **fix** `test/unit/gh-202-device-lock-wiring.test.js:12`

- [ ] **Step 1: Update the lock test to the generalized API + add Android cases (failing).**

In `test/unit/gh-202-device-lock.test.js`, change `makeLock` to pass `platform` + `deviceId` (replacing `udid`), update body/path assertions (`body.udid`→`body.deviceId`, `r.holder.udid`→`r.holder.deviceId`, and the inline `isDeviceLockStale` fixture `udid:`→`deviceId:`; keep the iOS path assertion `device-501-ios-${UDID}` — format is `${platform}-${deviceId}`). Then add:

```js
function makeLock(dir, over = {}) {
  return new DeviceLock({
    platform: over.platform ?? 'ios',
    deviceId: over.deviceId ?? UDID,
    projectRoot: over.projectRoot ?? '/proj/a',
    appId: over.appId ?? 'com.example.app',
    pid: over.pid ?? 4242,
    uid: 501, tmpDir: dir, version: '0-test',
    clock: over.clock ?? (() => FIXED),
    processAlive: over.processAlive ?? (() => true),
    staleMs: over.staleMs ?? 90_000,
  });
}

test('GH#202 DeviceLock: Android serial-scoped lock keys path + body on platform+serial', () => {
  const dir = tmp();
  try {
    const r = makeLock(dir, { platform: 'android', deviceId: 'emulator-5554' }).acquire();
    assert.equal(r.status, 'acquired');
    const lock = makeLock(dir, { platform: 'android', deviceId: 'emulator-5554' });
    assert.ok(lock.lockPath.includes('device-501-android-emulator-5554'));
    const body = JSON.parse(readFileSync(lock.lockPath, 'utf8'));
    assert.equal(body.platform, 'android');
    assert.equal(body.deviceId, 'emulator-5554');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('GH#202 DeviceLock: same id on different platforms do NOT collide', () => {
  const dir = tmp();
  try {
    const ios = makeLock(dir, { platform: 'ios', deviceId: 'shared-id', pid: 1 }).acquire();
    const and = makeLock(dir, { platform: 'android', deviceId: 'shared-id', pid: 2 }).acquire();
    assert.equal(ios.status, 'acquired');
    assert.equal(and.status, 'acquired');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Build + run to verify failure.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock.test.js
```
Expected: FAIL — constructor still expects `udid`; `body.deviceId`/`platform`/path assertions fail.

- [ ] **Step 3: Generalize `device-lock.ts`.** Replace the body interface, options, path, body writer, foreign-body guard, and validity check:

```ts
export interface DeviceLockBody {
  pid: number; projectRoot: string;
  platform: 'ios' | 'android';
  deviceId: string;            // iOS UDID or Android adb serial
  appId?: string; startedAt: number; lastHeartbeat: number; version?: string;
}
export interface DeviceLockOptions {
  platform: 'ios' | 'android';
  deviceId: string;
  projectRoot?: string; appId?: string; pid?: number; uid?: number;
  tmpDir?: string; version?: string; clock?: () => number;
  processAlive?: (pid: number) => boolean; staleMs?: number;
}
```
Constructor (replace the `udid` field + path):
```ts
    this.platform = opts.platform;
    this.deviceId = opts.deviceId;
    this.lockPath = join(this.tmpDir, `rn-dev-agent-device-${uid}-${this.platform}-${this.deviceId}.lock`);
```
(declare `private readonly platform: 'ios' | 'android';` + `private readonly deviceId: string;`; remove `udid`.) In `create()` the body uses `platform: this.platform, deviceId: this.deviceId`. In `readExisting()`:
```ts
      if (parsed.deviceId !== this.deviceId || parsed.platform !== this.platform) return null;
```
In `isValidBody()` (replace the two iOS-specific lines):
```ts
    (b.platform === 'ios' || b.platform === 'android') &&
    typeof b.deviceId === 'string' && b.deviceId.length > 0 &&
```

- [ ] **Step 4: Update the caller + fix the wiring-test regex.**

In `device-session.ts`, change `acquireDeviceLockForSession` to `(platform: 'ios' | 'android', deviceId: string, appId: string)` and `new DeviceLock({ platform, deviceId, appId })`; update its iOS call site to `acquireDeviceLockForSession('ios', deviceId, appId)`.

Then fix `test/unit/gh-202-device-lock-wiring.test.js:12` — it asserts the OLD signature and would go red:
```js
  assert.match(sessionSrc, /acquireDeviceLockForSession\('ios', deviceId, appId\)/);
```
(Leave lines 16-27 as-is; the close→clear→DEVICE_BUSY and `releaseDeviceLockForSession() … new DeviceLock` orderings are preserved by the edits below in Task 5.)

- [ ] **Step 5: Build + run to verify pass.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-device-lock.test.js test/unit/gh-202-device-lock-wiring.test.js
```
Expected: PASS (iOS cases + the two new Android cases; wiring regex now matches).

- [ ] **Step 6: Commit.**

```bash
git add scripts/cdp-bridge/src/lifecycle/device-lock.ts scripts/cdp-bridge/src/tools/device-session.ts scripts/cdp-bridge/test/unit/gh-202-device-lock.test.js scripts/cdp-bridge/test/unit/gh-202-device-lock-wiring.test.js scripts/cdp-bridge/dist
git commit -m "feat(rn-device): generalize DeviceLock to iOS+Android (deviceId/platform)"
```

---

### Task 2: `free-port.ts` (`findFreePort` + `isPortFree`)

**Files:**
- Create: `scripts/cdp-bridge/src/runners/free-port.ts`
- Test: `scripts/cdp-bridge/test/unit/free-port.test.js`

- [ ] **Step 1: Write the failing test (race-tolerant — no hard-coded ports).**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findFreePort, isPortFree } from '../../dist/runners/free-port.js';

// Bind :0 to obtain a guaranteed-free port number, then close it.
function knownFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen({ port: 0, host: '127.0.0.1' }, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('findFreePort: returns the preferred port when it is free', async () => {
  const p = await knownFreePort();
  assert.equal(await findFreePort(p), p);
});

test('findFreePort: returns a different, valid port when preferred is occupied', async () => {
  const blocker = createServer();
  const held = await new Promise((r) => blocker.listen({ port: 0, host: '127.0.0.1' }, () => r(blocker.address().port)));
  try {
    const p = await findFreePort(held);
    assert.notEqual(p, held);
    assert.ok(p > 0 && p < 65536);
  } finally { await new Promise((r) => blocker.close(r)); }
});

test('isPortFree: true for a free port, false for an occupied one', async () => {
  const blocker = createServer();
  const held = await new Promise((r) => blocker.listen({ port: 0, host: '127.0.0.1' }, () => r(blocker.address().port)));
  try { assert.equal(await isPortFree(held), false); }
  finally { await new Promise((r) => blocker.close(r)); }
});
```

- [ ] **Step 2: Build + run to verify failure.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/free-port.test.js
```
Expected: FAIL — `Cannot find module '../../dist/runners/free-port.js'`.

- [ ] **Step 3: Implement `free-port.ts`.**

```ts
import { createServer } from 'node:net';

export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '127.0.0.1' }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Resolve a bindable TCP port on 127.0.0.1: `preferred` if free, else an
 * OS-assigned ephemeral free port. Rejects on unexpected bind errors or if the
 * OS hands back an unusable port 0. Note: there is an inherent TOCTOU window
 * between this probe and the caller's real bind — callers that bind a SPECIFIC
 * number (e.g. adb forward) must handle a late EADDRINUSE; the iOS runner avoids
 * the window entirely by self-assigning (port 0).
 */
export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, fallbackToAny: boolean): void => {
      const srv = createServer();
      srv.once('error', (err: NodeJS.ErrnoException) => {
        if (fallbackToAny && err.code === 'EADDRINUSE') tryListen(0, false);
        else reject(err);
      });
      srv.listen({ port, host: '127.0.0.1' }, () => {
        const addr = srv.address();
        const chosen = typeof addr === 'object' && addr ? addr.port : 0;
        if (!chosen) { srv.close(() => reject(new Error('findFreePort: OS returned port 0'))); return; }
        srv.close(() => resolve(chosen));
      });
    };
    tryListen(preferred, true);
  });
}
```

- [ ] **Step 4: Build + run to verify pass.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/free-port.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit.**

```bash
git add scripts/cdp-bridge/src/runners/free-port.ts scripts/cdp-bridge/test/unit/free-port.test.js scripts/cdp-bridge/dist
git commit -m "feat(rn-device): add findFreePort/isPortFree port-probe helpers"
```

---

### Task 3: Split Android runner host/device ports (+ state migration)

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts`
- Test: create `test/unit/android-runner-ports.test.js`; migrate fixtures in `test/unit/runners/rn-android-runner-client.test.js`, `test/unit/gh-243-android-runner-health.test.js`, `test/unit/audit-h4-android-runner-deviceid.test.js`

- [ ] **Step 1: Write the failing test (all three builders imported up front).**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdbForwardArgs, buildAdbForwardRemoveArgs, buildInstrumentPortArgs,
} from '../../dist/runners/rn-android-runner-client.js';

test('Android ports: adb forward maps probed hostPort → fixed devicePort', () => {
  assert.deepEqual(buildAdbForwardArgs('emulator-5554', 41001, 22089),
    ['-s', 'emulator-5554', 'forward', 'tcp:41001', 'tcp:22089']);
});
test('Android ports: instrumentation receives the DEVICE port, not the host port', () => {
  assert.deepEqual(buildInstrumentPortArgs(22089), ['-e', 'RN_ANDROID_RUNNER_PORT', '22089']);
});
test('Android ports: forward --remove targets the host port', () => {
  assert.deepEqual(buildAdbForwardRemoveArgs('emulator-5554', 41001),
    ['-s', 'emulator-5554', 'forward', '--remove', 'tcp:41001']);
});
```

- [ ] **Step 2: Build + run to verify failure.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/android-runner-ports.test.js
```
Expected: FAIL — builders not exported.

- [ ] **Step 3: Implement the port split + state migration.**

Replace `AndroidRunnerState`:
```ts
interface AndroidRunnerState {
  hostPort: number;   // 127.0.0.1 port the TS client connects to (probed; globally contended)
  devicePort: number; // NanoHTTPD listener inside the emulator (fixed; emulator-namespaced)
  pid: number; deviceId?: string; bundleId?: string; startedAt: string;
}
```
Harden the state-file rehydration block (currently ~lines 83-95) so a stale old-shape file (`{ port }`, no `hostPort`) is discarded, not adopted:
```ts
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as Partial<AndroidRunnerState>;
    if (typeof raw.hostPort !== 'number' || typeof raw.devicePort !== 'number') {
      unlinkSync(STATE_FILE);                 // pre-split state shape → ignore + clear
    } else {
      try { process.kill(raw.pid, 0); runnerState = raw as AndroidRunnerState; }
      catch { unlinkSync(STATE_FILE); }
    }
```
Add pure, testable builders near `adbSerialArgs`:
```ts
export function buildAdbForwardArgs(deviceId: string | undefined, hostPort: number, devicePort: number): string[] {
  return [...adbSerialArgs(deviceId), 'forward', `tcp:${hostPort}`, `tcp:${devicePort}`];
}
export function buildAdbForwardRemoveArgs(deviceId: string | undefined, hostPort: number): string[] {
  return [...adbSerialArgs(deviceId), 'forward', '--remove', `tcp:${hostPort}`];
}
export function buildInstrumentPortArgs(devicePort: number): string[] {
  return ['-e', 'RN_ANDROID_RUNNER_PORT', String(devicePort)];
}
```
Rewrite `startAndroidRunner` to probe the host port (import `findFreePort` from `./free-port.js`), keep `devicePort` fixed, and retry the forward once if the probed host port raced:
```ts
export async function startAndroidRunner(deviceId?: string, bundleId?: string, devicePort = DEFAULT_PORT): Promise<AndroidRunnerState> {
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId)) return runnerState!;

  let hostPort = await findFreePort(devicePort);
  try {
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
  } catch {
    hostPort = await findFreePort(0);          // host port raced between probe and forward → re-probe once
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
  }
  // spawn: ...am instrument args use buildInstrumentPortArgs(devicePort)...
  // readiness: await waitForAndroidRunnerHealth(hostPort, ...)
  // state: runnerState = { hostPort, devicePort, pid: child.pid, deviceId, bundleId, startedAt: new Date().toISOString() }
}
```
Replace every remaining `runnerState.port` / `state.port` read with `runnerState.hostPort` (the `/command` + `/health` URLs become `http://127.0.0.1:${hostPort}`). In `stopAndroidRunner`, change the forward removal to `buildAdbForwardRemoveArgs(state.deviceId, state.hostPort)`.

- [ ] **Step 4: Build + run new test; then migrate the existing fixtures.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/android-runner-ports.test.js
```
Expected: PASS (3). Then migrate every `_setAndroidRunnerStateForTest({ port: N, ... })` and `stateFor` fixture to `{ hostPort: N, devicePort: 22089, ... }`, and any `state.port` assertion to `state.hostPort`, in **exactly these files** (verified to set the old shape):
- `test/unit/runners/rn-android-runner-client.test.js`  ← note the `runners/` subdir
- `test/unit/gh-243-android-runner-health.test.js`
- `test/unit/audit-h4-android-runner-deviceid.test.js`

```bash
node --test test/unit/runners/rn-android-runner-client.test.js test/unit/gh-243-android-runner-health.test.js test/unit/audit-h4-android-runner-deviceid.test.js
```
Expected: PASS after the rename. (Do NOT touch `android-runner-short-circuit.test.js` — it is a static source-regex test that sets no state.)

- [ ] **Step 5: Commit.**

```bash
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/test/unit scripts/cdp-bridge/dist
git commit -m "feat(rn-device): separate Android host vs device ports (probe host, fix device) + migrate stale state"
```

---

### Task 4: iOS — runner self-assigns when 22088 is taken

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (`startFastRunner`)

> No Swift change needed: `makeRunnerListener` already binds an OS-assigned port via `NWListener(using: .tcp)` when `desiredPort == 0`, and echoes the actual port back as `RN_FAST_RUNNER_PORT=<n>` (the TS parser already reads `result.port`). So we just pass `0` instead of a contended fixed number — eliminating the probe→bind TOCTOU.

- [ ] **Step 1: Implement the fallback.**

`startFastRunner` currently always uses `port = DEFAULT_PORT` (22088). Use 22088 when free, else `0` (import `isPortFree` from `./free-port.js`):
```ts
export async function startFastRunner(deviceId: string, bundleId: string, port?: number): Promise<FastRunnerState> {
  const desired = port ?? (await isPortFree(DEFAULT_PORT) ? DEFAULT_PORT : 0);
  // ...existing body, using `desired` where `port` was used:
  //   env: { ...process.env, RN_FAST_RUNNER_PORT: String(desired) }
  //   the runner binds 22088 (or OS-assigns when desired===0) and echoes the actual
  //   port; result.port stays authoritative and flows into FastRunnerState.port.
}
```
Reuse is unaffected: `shouldReuseRunner` keys on `deviceId`, and the cached-state early-return happens before this computes a port. Residual risk: the narrow 22088-freed-then-retaken window is the SAME as today (today blindly binds 22088); the collision case is now graceful instead of `LISTENER_FAILED`.

- [ ] **Step 2: Build + verify the full unit suite stays green.**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -20
```
Expected: all unit tests pass (additive; fast-runner tests passing an explicit `port` are unaffected). The spawn path is device-verified in Phase 4.

- [ ] **Step 3: Commit.**

```bash
git add scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/dist
git commit -m "feat(rn-device): iOS runner self-assigns a free port when 22088 is taken"
```

---

### Task 5: Resolve the Android serial + wire the device lock at open

This is the fix for the review's #1 blocker: the open path derives `deviceId` via `UDID_RE = /^[0-9A-Fa-f-]{25,}$/`, which an adb serial (`emulator-5554`) never matches — so the lock must key on a **separately-resolved adb serial**, not on `deviceId`.

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (add `parseAdbDevicesSerials` + `resolveAndroidSerial`)
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (Android lock branch in the `action==='open'` success path)
- Test: extend `test/unit/android-runner-ports.test.js` (serial parse) + `test/unit/gh-202-device-lock-wiring.test.js` (source-regex)

- [ ] **Step 1: Write the failing tests.**

Serial-parse (pure, in `android-runner-ports.test.js`):
```js
import { parseAdbDevicesSerials } from '../../dist/runners/rn-android-runner-client.js';

test('parseAdbDevicesSerials: extracts only online device serials', () => {
  const out = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\n\n';
  assert.deepEqual(parseAdbDevicesSerials(out), ['emulator-5554']);
});
```
Wiring (source-regex, matching this file's existing style — it `readFileSync`s `device-session.ts` and runs `assert.match`):
```js
test('GH#202 Android open resolves the adb serial and acquires the device lock', () => {
  assert.match(sessionSrc, /resolveAndroidSerial/);
  assert.match(sessionSrc, /acquireDeviceLockForSession\('android', /);
});
test('GH#202 Android conflict teardown stops the android runner', () => {
  assert.match(sessionSrc, /stopAndroidRunner\(\)/);
});
```

- [ ] **Step 2: Build + run to verify failure.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/android-runner-ports.test.js test/unit/gh-202-device-lock-wiring.test.js
```
Expected: FAIL — `parseAdbDevicesSerials` not exported; the Android wiring regexes don't match.

- [ ] **Step 3: Implement serial resolution + the Android lock branch.**

In `rn-android-runner-client.ts`:
```ts
export function parseAdbDevicesSerials(stdout: string): string[] {
  return stdout.split('\n').slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0]);
}
export async function resolveAndroidSerial(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const serials = parseAdbDevicesSerials(stdout);
    return serials.length === 1 ? serials[0] : undefined; // ambiguous if 0 or >1 → fail-open
  } catch { return undefined; }
}
```
In `device-session.ts` `action==='open'` success branch, generalize the iOS-only lock block to cover both platforms (import `stopAndroidRunner`, `resolveAndroidSerial`):
```ts
        const lockPlatform: 'ios' | 'android' = platform === 'android' ? 'android' : 'ios';
        const lockDeviceId = lockPlatform === 'android'
          ? await resolveAndroidSerial(deviceId)         // adb serial, NOT the UDID_RE-gated deviceId
          : deviceId;
        if (lockDeviceId) {
          const lockResult = acquireDeviceLockForSession(lockPlatform, lockDeviceId, appId);
          if (lockResult.status === 'conflict') {
            await runAgentDevice(['close']).catch(() => { /* best-effort teardown */ });
            clearActiveSession();
            if (lockPlatform === 'ios') stopFastRunner(); else stopAndroidRunner();
            return failResult(deviceBusyMessage(lockDeviceId, lockResult.holder), { code: 'DEVICE_BUSY', holder: lockResult.holder });
          }
          if (lockResult.degraded) {
            logger.warn('rn-device', `Device-ownership lock unavailable (fs error) for ${lockDeviceId} — cross-bridge contention protection is off this session.`);
          }
        }
```
(Replace the old `if (platform === 'ios' && deviceId)` lock block. Add a `// TODO(phase2): acquire the lock BEFORE the open side-effect once 'open' is resolved via simctl/adb instead of agent-device — spec D-e.`)

> **Scope honesty:** when `resolveAndroidSerial` returns `undefined` (no device / multiple ambiguous devices), the lock fails open — no regression, but no protection that session. The common single-emulator case now resolves one serial and DOES acquire the lock — this is the fix for the no-op the review caught. Multi-emulator serial disambiguation is finished in Phase 2 (explicit device targeting).

- [ ] **Step 4: Build + run to verify pass.**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/android-runner-ports.test.js test/unit/gh-202-device-lock-wiring.test.js
```
Expected: PASS (serial parse + both Android wiring regexes match; iOS wiring still green).

- [ ] **Step 5: Phase gate — full suite + changeset, then commit.**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -20
```
Expected: all unit files green (including `test/unit/**`).
```bash
cat > .changeset/android-device-lock-port-hardening.md <<'EOF'
---
"rn-dev-agent": minor
---

Harden device-control conflicts: add an Android serial-scoped device lock (parity with iOS) that engages on a normal emulator, separate the Android runner's probed host port from its fixed device-listener port (`adb forward`), and let the iOS runner self-assign a free port when 22088 is taken.
EOF
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/src/tools/device-session.ts scripts/cdp-bridge/test/unit scripts/cdp-bridge/dist .changeset/android-device-lock-port-hardening.md
git commit -m "feat(rn-device): resolve adb serial + acquire Android device lock at session open"
```

---

## Self-Review (Phase 1)

**1. Spec coverage:** G4 (conflict hardening) → Tasks 1 (lock), 3 (Android ports), 4 (iOS port), 5 (serial + wiring). D-d (host/device split) → Task 3. D-e (Android lock) → Tasks 1+5; the **lock-before-side-effects ordering** is explicitly deferred to Phase 2 (marked `TODO(phase2)`) because `open` still uses agent-device here — recorded, not lost.

**2. Placeholder scan:** `startAndroidRunner` / `startFastRunner` bodies show the changed lines with `// ...existing...` markers for the unchanged spawn/readiness scaffolding (the executor edits in place, not rewrites). All new code (builders, helpers, lock branch, tests) is complete.

**3. Type consistency:** `DeviceLock({platform, deviceId})` ↔ `acquireDeviceLockForSession(platform, deviceId, appId)` ↔ tests. `AndroidRunnerState.{hostPort,devicePort}` ↔ builders ↔ migrated fixtures ↔ `stopAndroidRunner`. `findFreePort(preferred)`/`isPortFree(port)` ↔ callers (Tasks 3, 4). `resolveAndroidSerial(explicit?)`/`parseAdbDevicesSerials(stdout)` ↔ Task 5 wiring + test.

**4. Review findings closed:** Android lock no-op → `resolveAndroidSerial` (Task 5); Task 5 dynamic-harness mismatch → source-regex test; Task 1 wiring line-12 breakage → fixed in Task 1 Step 4; Task 3 wrong/incomplete test list → corrected to the 3 real files; state-file migration → Task 3 Step 3; iOS TOCTOU → "pass 0" via the runner's existing self-assign; `findFreePort` flake/port-0 → race-tolerant tests + guard.
