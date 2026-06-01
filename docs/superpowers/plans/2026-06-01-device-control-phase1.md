# Device Control Phase 1 — Single-Runner Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the documented iOS single-runner kill-switch actually kill the stale `AgentDeviceRunner` that steals simulator foreground (scoped to the target UDID), default-on, plus close the `/tmp/rn-fast-runner-state.json` cross-project leak and ship the `#201` `--app-file` fix — without footguns.

**Architecture:** All logic lives in TypeScript in the cdp-bridge (no bash hook). A new `ensureSingleRunner()` runs **files-only** at bridge startup (UDID unknown → only remove orphaned `~/.agent-device/daemon.{json,lock}` whose PID is dead) and **scoped-kill** at `device_snapshot action=open` (UDID known → SIGTERM/SIGKILL only `AgentDeviceRunner*` processes whose argv targets that UDID). The `RN_DEVICE_KILL_LEGACY` default flips from opt-in (`=== '1'`) to default-on (`!== '0'`) **in the same change** as the real kill logic. Two independent self-contained fixes ride along: a `deviceId` guard on fast-runner state reuse, and `#201`'s `--app-file` threading + auto-resolution.

**Tech Stack:** Node.js ≥22 (ESM, `"type":"module"`), TypeScript, `node --test` (tests live in `scripts/cdp-bridge/test/unit/*.test.js`, run after `npm run build`, import compiled JS from `../../dist/` for behavior or read `../../src/*.ts` as text for wiring assertions). Established test seam pattern: pure decision helpers + an async wrapper taking an injectable `deps` object (see `probeFastRunnerLiveness` in `rn-fast-runner-client.ts`).

**Branch:** `feat/202-device-control-arbiter` (already created; the design spec is committed there as `82cc482`).

**Spec:** `docs/superpowers/specs/2026-06-01-device-control-arbiter-design.md` §3 (Phase 1).

**All commits** must end with the trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` per repo convention.

**Working directory for all commands:** `scripts/cdp-bridge/` unless stated otherwise.

---

## Task 0: Baseline — confirm green before changes

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch + clean build**

Run (from repo root):
```bash
cd scripts/cdp-bridge && npm run build
```
Expected: TypeScript compiles with no errors; `dist/` is populated.

- [ ] **Step 2: Run the existing unit suite to capture a green baseline**

Run:
```bash
cd scripts/cdp-bridge && npm test
```
Expected: all existing tests pass. If anything is already red, stop and report — do not start Phase 1 on a red baseline.

---

## Task 1: `#201` — thread `--app-file` through `buildArgs` (pure)

The maestro arg builder is hardcoded and has no way to inject `--app-file`, so any iOS flow using `clearState: true` fails. This task makes the **builder** accept an optional `appFile`; Task 2 wires resolution. Pure function → pure test.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/maestro-dispatch.ts:24-38` (interface) and `:119-148` (the two `buildArgs` impls)
- Test: `scripts/cdp-bridge/test/unit/gh-201-maestro-app-file-args.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-201-maestro-app-file-args.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMaestroDispatch,
  _resetMaestroDispatchCache,
} from '../../dist/tools/maestro-dispatch.js';

// Force the maestro-runner tier: pretend the binary exists and adb is present
// so runnerViable is true on both platforms.
function runnerDispatch(platform) {
  _resetMaestroDispatchCache();
  return chooseMaestroDispatch({
    platform,
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/bin/maestro-runner',
  });
}

test('GH#201 maestro-runner buildArgs injects --app-file before --platform when given', () => {
  const d = runnerDispatch('ios');
  assert.equal(d.runner, 'maestro-runner');
  assert.deepEqual(
    d.buildArgs('ios', '/tmp/flow.yaml', '/DerivedData/MyApp.app'),
    ['--app-file', '/DerivedData/MyApp.app', '--platform', 'ios', 'test', '/tmp/flow.yaml'],
  );
});

test('GH#201 maestro-runner buildArgs unchanged when appFile omitted', () => {
  const d = runnerDispatch('ios');
  assert.deepEqual(
    d.buildArgs('ios', '/tmp/flow.yaml'),
    ['--platform', 'ios', 'test', '/tmp/flow.yaml'],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-201-maestro-app-file-args.test.js
```
Expected: FAIL — the first test's `buildArgs` ignores the 3rd arg and returns the 4-element array, so `deepEqual` against the 6-element array fails.

- [ ] **Step 3: Change the interface signature**

In `src/tools/maestro-dispatch.ts`, update the `MaestroDispatch.buildArgs` signature (around line 32):
```ts
  /**
   * Builds the argv for `execFile(binPath, argv)` to run a single flow.
   * Both runners accept `<flow.yaml>` as the last positional but their
   * platform-targeting flags differ. `appFile` (GH#201) is the path to a
   * built `.app`/`.ipa`; maestro-runner needs it to reinstall on iOS
   * `clearState`. The Maestro CLI fallback does not accept it and ignores it.
   */
  buildArgs(platform: 'ios' | 'android', flowFile: string, appFile?: string): string[];
```

- [ ] **Step 4: Update the maestro-runner impl**

In `chooseMaestroDispatch`, replace the maestro-runner `buildArgs` (around line 123):
```ts
      buildArgs: (platform, flowFile, appFile) =>
        appFile
          ? ['--app-file', appFile, '--platform', platform, 'test', flowFile]
          : ['--platform', platform, 'test', flowFile],
```

- [ ] **Step 5: Update the Maestro CLI fallback impl (accept but ignore appFile)**

Replace the CLI fallback `buildArgs` (around line 145). The Maestro CLI has no `--app-file` flag (it reinstalls from the appId in the flow header), so it deliberately ignores the param:
```ts
      // The Maestro CLI handles clearState reinstall from the flow's appId
      // header and exposes no --app-file flag, so appFile is intentionally ignored here.
      buildArgs: (platform, flowFile, _appFile) => ['test', '--platform', platform, flowFile],
```

- [ ] **Step 6: Run test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-201-maestro-app-file-args.test.js
```
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
cd scripts/cdp-bridge && git add src/tools/maestro-dispatch.ts test/unit/gh-201-maestro-app-file-args.test.js
git commit -m "feat(maestro): thread optional --app-file through buildArgs (#201)"
```

---

## Task 2: `#201` — auto-resolve `.app` + clearState detection + `appFile` param

Wire the builder change into `maestro_run`: a new optional `appFile` param, auto-resolution when an iOS flow uses `clearState` and no `appFile` was given, and an actionable error when nothing can be resolved (instead of the raw maestro-runner usage string).

**Files:**
- Create: `scripts/cdp-bridge/src/tools/resolve-ios-app-file.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-201-resolve-ios-app-file.test.js`
- Modify: `scripts/cdp-bridge/src/tools/maestro-run.ts` (handler args type + body around `:144-158`)
- Modify: `scripts/cdp-bridge/src/index.ts` (the `maestro_run` zod schema, ~`:864-875`)

- [ ] **Step 1: Write the failing test for the resolver**

Create `test/unit/gh-201-resolve-ios-app-file.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowUsesClearState,
  resolveIosAppFile,
} from '../../dist/tools/resolve-ios-app-file.js';

test('GH#201 flowUsesClearState detects clearState: true', () => {
  assert.equal(flowUsesClearState('- launchApp:\n    clearState: true\n'), true);
  assert.equal(flowUsesClearState('- launchApp:\n    clearState:   true'), true);
  assert.equal(flowUsesClearState('- tapOn: Login\n'), false);
  assert.equal(flowUsesClearState('clearState: false'), false);
});

test('GH#201 resolveIosAppFile returns the simctl container path when it exists', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: (id) => (id === 'com.example.app' ? '/sim/MyApp.app' : null),
    exists: (p) => p === '/sim/MyApp.app',
    newestDerivedDataApp: () => assert.fail('should not fall back when container resolves'),
  });
  assert.equal(got, '/sim/MyApp.app');
});

test('GH#201 resolveIosAppFile falls back to newest DerivedData .app', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
    exists: (p) => p === '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
  });
  assert.equal(got, '/dd/Build/Products/Debug-iphonesimulator/MyApp.app');
});

test('GH#201 resolveIosAppFile returns null when nothing is found', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => null,
    exists: () => false,
  });
  assert.equal(got, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-201-resolve-ios-app-file.test.js
```
Expected: FAIL — module `dist/tools/resolve-ios-app-file.js` does not exist (import error).

- [ ] **Step 3: Implement the resolver**

Create `src/tools/resolve-ios-app-file.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** GH#201: true when the flow text contains a `clearState: true` directive. */
export function flowUsesClearState(flowText: string): boolean {
  return /clearState:\s*true\b/.test(flowText);
}

export interface ResolveAppFileDeps {
  /** Returns the installed `.app` container path for a bundle id, or null. */
  getAppContainer?: (bundleId: string) => string | null;
  /** Returns the newest built `.app` under DerivedData, or null. */
  newestDerivedDataApp?: () => string | null;
  /** Existence check (injectable for tests). */
  exists?: (path: string) => boolean;
}

/**
 * GH#201: locate a built `.app` to pass to `maestro-runner --app-file` so an
 * iOS `clearState` flow can reinstall after uninstall. Tries the simulator's
 * installed container first (cheapest, always current), then the newest
 * DerivedData product. Returns null when neither resolves.
 */
export function resolveIosAppFile(bundleId: string, deps: ResolveAppFileDeps = {}): string | null {
  const exists = deps.exists ?? existsSync;
  const getAppContainer = deps.getAppContainer ?? defaultGetAppContainer;
  const fromContainer = getAppContainer(bundleId);
  if (fromContainer && exists(fromContainer)) return fromContainer;
  const fromDerived = (deps.newestDerivedDataApp ?? (() => null))();
  if (fromDerived && exists(fromDerived)) return fromDerived;
  return null;
}

function defaultGetAppContainer(bundleId: string): string | null {
  try {
    const out = execFileSync(
      'xcrun',
      ['simctl', 'get_app_container', 'booted', bundleId, 'app'],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run resolver test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-201-resolve-ios-app-file.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Add `appFile` to the `maestro_run` zod schema**

In `src/index.ts`, find the `maestro_run` registration (search for `'maestro_run'`, ~line 864) and add `appFile` to its schema object, alongside the existing `appId`:
```ts
    appFile: z.string().optional().describe('iOS only — path to a built .app/.ipa for maestro-runner to reinstall on clearState. Auto-resolved from the flow appId when omitted (GH#201).'),
```

- [ ] **Step 6: Add `appFile` to the handler args type + auto-resolve in the body**

In `src/tools/maestro-run.ts`:

(a) Add `appFile?: string;` to the handler's args interface (the object type whose other fields include `flowPath`, `inlineYaml`, `platform`, `appId`, `timeoutMs`, `params` — near the top of the file).

(b) Import the resolver at the top:
```ts
import { flowUsesClearState, resolveIosAppFile } from './resolve-ios-app-file.js';
```

(c) Replace the `baseArgs` line (currently `:151`) with auto-resolution. The block goes **after** `headerAppId` is computed (`:126`) and the `validatedContent`/`flowFile` are written (`:136`), and **before** `dispatch.buildArgs` is called:
```ts
    let appFile = args.appFile;
    if (!appFile && platform === 'ios' && flowUsesClearState(validatedContent)) {
      if (!headerAppId) {
        return failResult(
          'Flow uses clearState on iOS but no appId is known to locate the .app. ' +
          'Add `appId:` to the flow header or pass appFile=<path-to-.app>.',
        );
      }
      appFile = resolveIosAppFile(headerAppId) ?? undefined;
      if (!appFile) {
        return failResult(
          `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. ` +
          'Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).',
        );
      }
    }
    const baseArgs = dispatch.buildArgs(platform, flowFile, appFile);
```

- [ ] **Step 7: Write a wiring assertion test (source-grep — no live simulator)**

Create `test/unit/gh-201-maestro-run-app-file-wiring.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runSrc = readFileSync(resolve(__dirname, '../../src/tools/maestro-run.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#201 maestro-run auto-resolves appFile for iOS clearState flows', () => {
  assert.match(runSrc, /flowUsesClearState\(validatedContent\)/);
  assert.match(runSrc, /resolveIosAppFile\(headerAppId\)/);
  assert.match(runSrc, /dispatch\.buildArgs\(platform, flowFile, appFile\)/);
});

test('GH#201 maestro_run exposes an appFile param', () => {
  assert.match(indexSrc, /appFile:\s*z\.string\(\)\.optional\(\)/);
});
```

- [ ] **Step 8: Build, run both new test files**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-201-resolve-ios-app-file.test.js test/unit/gh-201-maestro-run-app-file-wiring.test.js
```
Expected: PASS (all 6 tests). If the build fails on the `args.appFile` type, ensure Step 6(a) added `appFile?: string` to the handler args interface.

- [ ] **Step 9: Commit**

```bash
cd scripts/cdp-bridge && git add src/tools/resolve-ios-app-file.ts src/tools/maestro-run.ts src/index.ts test/unit/gh-201-resolve-ios-app-file.test.js test/unit/gh-201-maestro-run-app-file-wiring.test.js
git commit -m "feat(maestro): auto-resolve --app-file for iOS clearState flows (#201)"
```

---

## Task 3: `deviceId` guard on fast-runner state reuse (the second leak)

`startFastRunner()` early-returns on **any** existing runner state with no `deviceId` comparison (`:174`), so a second project's bridge can adopt a runner bound to a different simulator. Extract a pure decision helper and use it.

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:173-174`
- Test: `scripts/cdp-bridge/test/unit/gh-202-runner-reuse-guard.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-202-runner-reuse-guard.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReuseRunner } from '../../dist/runners/rn-fast-runner-client.js';

const state = { pid: 1, port: 22088, deviceId: 'UDID-A', bundleId: 'com.x', startedAt: 'now' };

test('GH#202 shouldReuseRunner: reuse only when deviceId matches', () => {
  assert.equal(shouldReuseRunner(state, 'UDID-A'), true);
});

test('GH#202 shouldReuseRunner: never reuse a runner bound to another simulator', () => {
  assert.equal(shouldReuseRunner(state, 'UDID-B'), false);
});

test('GH#202 shouldReuseRunner: never reuse null state', () => {
  assert.equal(shouldReuseRunner(null, 'UDID-A'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-runner-reuse-guard.test.js
```
Expected: FAIL — `shouldReuseRunner` is not exported (import is undefined → call throws).

- [ ] **Step 3: Add the helper and use it**

In `src/runners/rn-fast-runner-client.ts`, add the exported helper just above `startFastRunner` (before line 173):
```ts
/**
 * GH#202: only adopt an existing runner when it is bound to the SAME
 * simulator. The state file path is a fixed constant shared across projects,
 * so a stale state from another project (different deviceId) must never be
 * reused — that would drive the wrong simulator.
 */
export function shouldReuseRunner(state: FastRunnerState | null, deviceId: string): boolean {
  return state !== null && state.deviceId === deviceId;
}
```

Then replace the early-return at line 174:
```ts
  if (shouldReuseRunner(runnerState, deviceId)) return Promise.resolve(runnerState!);
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-runner-reuse-guard.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd scripts/cdp-bridge && git add src/runners/rn-fast-runner-client.ts test/unit/gh-202-runner-reuse-guard.test.js
git commit -m "fix(runner): never adopt fast-runner state bound to another simulator (#202)"
```

---

## Task 4: `ensureSingleRunner()` module

The core of Phase 1: a files-only startup pass + a UDID-scoped kill pass, built from pure decision helpers plus an async wrapper that takes an injectable `deps` object (mirroring `probeFastRunnerLiveness`). No code path touches a live process unless a UDID is supplied AND the process argv targets that UDID.

**Files:**
- Create: `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-ensure-single-runner.test.js`

> **Note on the UDID-in-argv assumption (spec §10 risk):** `selectLegacyRunnerPids` only kills `AgentDeviceRunner*` lines that *also* contain the target UDID. If a real leak's argv omits the UDID, the matcher safely kills nothing (no false kill) rather than guessing. Before relying on this in the field, capture a real leak's format with `ps -A -o pid=,args= | grep AgentDeviceRunner` and, if it differs, update the test fixture in Step 1 to match — the matcher logic stays the same.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gh-202-ensure-single-runner.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectLegacyRunnerPids,
  shouldRemoveDaemonFiles,
  ensureSingleRunner,
} from '../../dist/runners/ensure-single-runner.js';

// Realistic `ps -A -o pid=,args=` lines (synthetic; see field-verification note).
const PS = [
  '  501 /Users/x/Library/.../AgentDeviceRunner.app/AgentDeviceRunner -udid UDID-A',
  '  502 /Users/x/Library/.../AgentDeviceRunnerUITests-Runner.app/... -udid UDID-A',
  '  777 /Users/x/Library/.../AgentDeviceRunner.app/AgentDeviceRunner -udid UDID-OTHER',
  '  900 /Users/x/.../RnFastRunnerUITests-Runner.app/... -udid UDID-A',
  '  123 /usr/bin/node /some/unrelated/process',
].join('\n');

test('GH#202 selectLegacyRunnerPids: only AgentDeviceRunner procs on the target UDID', () => {
  assert.deepEqual(selectLegacyRunnerPids(PS, 'UDID-A').sort(), [501, 502]);
});

test('GH#202 selectLegacyRunnerPids: skips other simulators and never our RnFastRunner', () => {
  assert.deepEqual(selectLegacyRunnerPids(PS, 'UDID-OTHER'), [777]);
  assert.ok(!selectLegacyRunnerPids(PS, 'UDID-A').includes(900));
});

test('GH#202 shouldRemoveDaemonFiles: remove only when daemon PID is dead or absent', () => {
  assert.equal(shouldRemoveDaemonFiles(4242, () => true), false);  // alive → keep
  assert.equal(shouldRemoveDaemonFiles(4242, () => false), true);  // dead → remove
  assert.equal(shouldRemoveDaemonFiles(null, () => true), true);   // no pid → orphan → remove
});

function baseDeps(over = {}) {
  return {
    listProcesses: () => PS,
    kill: () => {},
    isAlive: () => false,
    readDaemonPid: () => null,
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    ...over,
  };
}

test('GH#202 ensureSingleRunner (device-open): SIGTERMs scoped legacy pids', async () => {
  const killed = [];
  const r = await ensureSingleRunner({ udid: 'UDID-A' }, baseDeps({
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    isAlive: () => false, // dead after SIGTERM → no SIGKILL escalation
  }));
  assert.deepEqual(r.killedPids.sort(), [501, 502]);
  assert.ok(killed.includes('501:SIGTERM'));
  assert.ok(!killed.some((k) => k.endsWith('SIGKILL')));
});

test('GH#202 ensureSingleRunner (device-open): escalates to SIGKILL when still alive', async () => {
  const killed = [];
  await ensureSingleRunner({ udid: 'UDID-OTHER' }, baseDeps({
    kill: (pid, sig) => killed.push(`${pid}:${sig}`),
    isAlive: () => true, // survives SIGTERM → SIGKILL
  }));
  assert.ok(killed.includes('777:SIGTERM'));
  assert.ok(killed.includes('777:SIGKILL'));
});

test('GH#202 ensureSingleRunner (startup, no udid): never scans/kills processes; only dead-pid file cleanup', async () => {
  const removed = [];
  const r = await ensureSingleRunner({}, baseDeps({
    listProcesses: () => assert.fail('startup pass must not scan processes'),
    readDaemonPid: () => 4242,
    isAlive: () => false, // daemon dead → orphan
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(r.killedPids.length, 0);
  assert.equal(removed.length, 2); // daemon.json + daemon.lock
  assert.equal(r.removedFiles.length, 2);
});

test('GH#202 ensureSingleRunner: keeps daemon files when the daemon PID is alive', async () => {
  const removed = [];
  const r = await ensureSingleRunner({}, baseDeps({
    readDaemonPid: () => 4242,
    isAlive: () => true, // alive → may belong to another project → keep
    fileExists: () => true,
    removeFile: (p) => removed.push(p),
  }));
  assert.equal(removed.length, 0);
  assert.ok(r.warnings.some((w) => /alive/.test(w)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-ensure-single-runner.test.js
```
Expected: FAIL — `dist/runners/ensure-single-runner.js` does not exist (import error).

- [ ] **Step 3: Implement the module**

Create `src/runners/ensure-single-runner.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAEMON_JSON = join(homedir(), '.agent-device', 'daemon.json');
const DAEMON_LOCK = join(homedir(), '.agent-device', 'daemon.lock');
const DAEMON_FILES = [DAEMON_JSON, DAEMON_LOCK];
const SIGKILL_GRACE_MS = 500;

/**
 * GH#202: parse `ps -A -o pid=,args=` output and return the PIDs of stale
 * legacy `AgentDeviceRunner*` processes bound to `udid`. Conservative by
 * design: a line must reference both the legacy runner AND the target UDID,
 * and must NOT be our own RnFastRunner. A leak whose argv omits the UDID
 * matches nothing here (no false kill) rather than being guessed at.
 */
export function selectLegacyRunnerPids(psOutput: string, udid: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    if (!line.includes('AgentDeviceRunner')) continue;
    if (line.includes('RnFastRunner')) continue;
    if (!udid || !line.includes(udid)) continue;
    const m = line.trim().match(/^(\d+)\b/);
    if (m) pids.push(Number(m[1]));
  }
  return pids;
}

/** GH#202: remove orphaned daemon files only when their PID is dead or absent. */
export function shouldRemoveDaemonFiles(
  daemonPid: number | null,
  isAlive: (pid: number) => boolean,
): boolean {
  if (daemonPid === null) return true;
  return !isAlive(daemonPid);
}

export interface EnsureSingleRunnerResult {
  killedPids: number[];
  removedFiles: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}

export interface EnsureSingleRunnerDeps {
  listProcesses: () => string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  readDaemonPid: () => number | null;
  fileExists: (path: string) => boolean;
  removeFile: (path: string) => void;
  delay: (ms: number) => Promise<void>;
}

function defaultDeps(): EnsureSingleRunnerDeps {
  return {
    listProcesses: () => {
      try {
        return execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 3_000 });
      } catch {
        return '';
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
    readDaemonPid: () => {
      try {
        const parsed = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')) as { pid?: unknown };
        return typeof parsed.pid === 'number' ? parsed.pid : null;
      } catch {
        return null;
      }
    },
    fileExists: (path) => existsSync(path),
    removeFile: (path) => unlinkSync(path),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * GH#202 Phase 1: enforce a single iOS interaction runner.
 *  - With `udid` (device-open): SIGTERM/SIGKILL stale AgentDeviceRunner procs
 *    scoped to that simulator.
 *  - Always: remove orphaned ~/.agent-device/daemon.{json,lock} when the
 *    daemon PID is dead. A live daemon is left alone (it may belong to a
 *    different project's Android session).
 * Never touches a live process at startup (no udid → no process scan).
 */
export async function ensureSingleRunner(
  opts: { udid?: string } = {},
  deps: EnsureSingleRunnerDeps = defaultDeps(),
): Promise<EnsureSingleRunnerResult> {
  const timings: Record<string, number> = {};
  const killedPids: number[] = [];
  const removedFiles: string[] = [];
  const warnings: string[] = [];

  if (opts.udid) {
    const t = Date.now();
    let psOut = '';
    try { psOut = deps.listProcesses(); } catch (err) { warnings.push(`ps failed: ${msg(err)}`); }
    for (const pid of selectLegacyRunnerPids(psOut, opts.udid)) {
      try {
        deps.kill(pid, 'SIGTERM');
        await deps.delay(SIGKILL_GRACE_MS);
        if (deps.isAlive(pid)) deps.kill(pid, 'SIGKILL');
        killedPids.push(pid);
      } catch (err) {
        warnings.push(`kill ${pid} failed: ${msg(err)}`);
      }
    }
    timings.scopedKill = Date.now() - t;
  }

  const tFiles = Date.now();
  if (DAEMON_FILES.some((f) => deps.fileExists(f))) {
    let daemonPid: number | null = null;
    try { daemonPid = deps.readDaemonPid(); } catch { daemonPid = null; }
    if (shouldRemoveDaemonFiles(daemonPid, deps.isAlive)) {
      for (const f of DAEMON_FILES) {
        if (!deps.fileExists(f)) continue;
        try { deps.removeFile(f); removedFiles.push(f); }
        catch (err) { warnings.push(`rm ${f} failed: ${msg(err)}`); }
      }
    } else {
      warnings.push(`Left ${DAEMON_JSON} in place — daemon PID ${daemonPid} is alive (may belong to another project).`);
    }
  }
  timings.fileCleanup = Date.now() - tFiles;

  return { killedPids, removedFiles, warnings, meta: { timings_ms: timings } };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-ensure-single-runner.test.js
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd scripts/cdp-bridge && git add src/runners/ensure-single-runner.ts test/unit/gh-202-ensure-single-runner.test.js
git commit -m "feat(runner): ensureSingleRunner — files-only boot + UDID-scoped kill (#202)"
```

---

## Task 5: Wire `ensureSingleRunner` + flip `RN_DEVICE_KILL_LEGACY` default-on

Call the files-only pass at bridge startup, and the scoped-kill pass at iOS `device_snapshot action=open` — replacing the old opt-in `detectLegacyAgentDevice` block. The default-on flip (`!== '0'`) ships **here**, with the real logic, never before.

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts` (after lock acquisition, ~`:115`)
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (imports + the block at `:188-207`)
- Test: `scripts/cdp-bridge/test/unit/gh-202-kill-legacy-wiring.test.js`

- [ ] **Step 1: Write the failing wiring test (source-grep)**

Create `test/unit/gh-202-kill-legacy-wiring.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#202 device-open calls UDID-scoped ensureSingleRunner, default-on', () => {
  assert.match(sessionSrc, /ensureSingleRunner\(\{\s*udid:\s*deviceId\s*\}\)/);
  assert.match(sessionSrc, /RN_DEVICE_KILL_LEGACY !== '0'/);
});

test('GH#202 the opt-in default-off behavior is gone', () => {
  assert.ok(!sessionSrc.includes("RN_DEVICE_KILL_LEGACY === '1'"),
    "old opt-in guard must be removed");
});

test('GH#202 bridge startup runs the files-only ensureSingleRunner pass', () => {
  assert.match(indexSrc, /ensureSingleRunner\(\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-kill-legacy-wiring.test.js
```
Expected: FAIL — none of the new strings are present yet; the old `=== '1'` guard still exists.

- [ ] **Step 3: Wire the startup files-only pass in `index.ts`**

Add the import near the other runner imports at the top of `src/index.ts`:
```ts
import { ensureSingleRunner } from './runners/ensure-single-runner.js';
```
Then, immediately after the lock-acquisition block (after `:115`, the `}` closing `if (!noLock)`), add:
```ts
// GH#202 Phase 1: at boot the simulator UDID is unknown, so only the
// files-only pass runs — remove orphaned ~/.agent-device/daemon.{json,lock}
// when their daemon PID is dead. Never touches a live process at startup.
// Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
if (process.env.RN_DEVICE_KILL_LEGACY !== '0') {
  void ensureSingleRunner()
    .then((r) => {
      if (r.removedFiles.length) {
        logger.info('rn-device', `ensureSingleRunner(boot): removed ${r.removedFiles.join(', ')}`);
      }
    })
    .catch(() => { /* non-fatal */ });
}
```

- [ ] **Step 4: Replace the opt-in block in `device-session.ts`**

In `src/tools/device-session.ts`, update the imports: add `ensureSingleRunner` and remove `detectLegacyAgentDevice` (it is no longer used in this file — verify with a search; if another call site exists, keep the import):
```ts
import { ensureSingleRunner } from '../runners/ensure-single-runner.js';
```
Then replace the entire `detectLegacyAgentDevice().then(...)` block (lines 188-207) with:
```ts
        // GH#202 Phase 1: enforce a single iOS interaction runner. The UDID is
        // known here (device-open), so scope-kill any stale AgentDeviceRunner
        // targeting THIS simulator and clear orphaned daemon lock files.
        // Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
        if (process.env.RN_DEVICE_KILL_LEGACY !== '0' && args.platform === 'ios' && deviceId) {
          ensureSingleRunner({ udid: deviceId })
            .then((r) => {
              if (r.killedPids.length) {
                logger.info('rn-device', `ensureSingleRunner: killed stale runner PID(s) ${r.killedPids.join(', ')} on ${deviceId}`);
              }
              if (r.removedFiles.length) {
                logger.info('rn-device', `ensureSingleRunner: removed ${r.removedFiles.join(', ')}`);
              }
              for (const w of r.warnings) logger.warn('rn-device', w);
            })
            .catch((err) => {
              logger.warn('rn-device', `ensureSingleRunner failed: ${err instanceof Error ? err.message : String(err)}`);
            });
        }
```
Leave the Android `detectAndroidExternalRunner` block (currently ~`:213-223`) untouched.

- [ ] **Step 5: Run the wiring test to verify it passes**

Run:
```bash
cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-kill-legacy-wiring.test.js
```
Expected: PASS (3 tests). If the build fails on an unused-import error for `detectLegacyAgentDevice`, confirm Step 4 removed it from the import list.

- [ ] **Step 6: Commit**

```bash
cd scripts/cdp-bridge && git add src/index.ts src/tools/device-session.ts test/unit/gh-202-kill-legacy-wiring.test.js
git commit -m "feat(device): wire ensureSingleRunner + flip RN_DEVICE_KILL_LEGACY default-on (#202)"
```

---

## Task 6: Docs, changeset, full-suite green

**Files:**
- Modify: `CLAUDE.md` (the `RN_DEVICE_KILL_LEGACY` mentions in Troubleshooting + Architecture)
- Create: `.changeset/<short-name>.md`
- Verify: full `npm test`

- [ ] **Step 1: Update `CLAUDE.md` to reflect default-on**

In `CLAUDE.md`, find the Troubleshooting bullet beginning "Legacy `AgentDeviceRunner` re-appears on the simulator" and update the guidance so the kill is **default-on, opt-out** rather than opt-in. Replace the parenthetical:
```
(the plugin terminates stale runners at session-open by default since #202 — scoped to the target simulator; set `RN_DEVICE_KILL_LEGACY=0` to opt out)
```
Also update the Architecture-section sentence that reads "warned about (`RN_DEVICE_KILL_LEGACY=1` opts into termination)" to:
```
killed by default, scoped to the target UDID (`RN_DEVICE_KILL_LEGACY=0` opts out) — D-202
```

- [ ] **Step 2: Create the changeset**

Check the package name first:
```bash
cat .changeset/config.json | grep -A2 '"' | head; cat package.json | grep '"name"' | head -1
```
Create `.changeset/device-single-runner-202.md` (use the name from `package.json`, e.g. `rn-dev-agent`):
```markdown
---
"rn-dev-agent": patch
---

Phase 1 of device-control hardening (#202): `ensureSingleRunner()` now kills stale `AgentDeviceRunner` processes scoped to the target simulator and clears orphaned `~/.agent-device/daemon.{json,lock}` (default-on; opt out with `RN_DEVICE_KILL_LEGACY=0`). Fast-runner state is no longer reused across simulators. `maestro_run` auto-resolves `--app-file` for iOS `clearState` flows (#201).
```

- [ ] **Step 3: Run the full unit suite**

Run:
```bash
cd scripts/cdp-bridge && npm test
```
Expected: the entire suite passes, including all five new test files (`gh-201-*` ×3, `gh-202-*` ×3 — note `gh-202-runner-reuse-guard`, `gh-202-ensure-single-runner`, `gh-202-kill-legacy-wiring`). If anything fails, fix before committing.

- [ ] **Step 4: Type-check / lint if the repo has them**

Run (only if these scripts exist in `package.json`):
```bash
cd scripts/cdp-bridge && npm run lint --if-present && npm run typecheck --if-present
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md scripts/cdp-bridge/.changeset 2>/dev/null; git add .changeset 2>/dev/null
git add CLAUDE.md .changeset
git commit -m "docs(202): default-on legacy kill in CLAUDE.md + changeset"
```

---

## Self-Review (completed by plan author)

**Spec coverage (spec §3 Phase 1):**
- §3.1 `ensureSingleRunner` (files-only startup + UDID-scoped device-open kill) → Task 4 (module) + Task 5 (wiring). ✅
- §3.2 wiring + default-on flip shipped together → Task 5. ✅
- §3.3 rn-fast-runner-state `deviceId` guard → Task 3. ✅
- §3.4 `#201` `--app-file` for `clearState` → Task 1 (builder) + Task 2 (resolve/wire). ✅
- Telemetry `meta.timings_ms` (spec §9) → emitted by `ensureSingleRunner`. ✅

**Placeholder scan:** No TBD/TODO. The one field-verification item (UDID-in-argv) is an explicit, bounded note with a conservative no-false-kill default — not a blocking gap. ✅

**Type consistency:** `ensureSingleRunner(opts, deps)` signature, `EnsureSingleRunnerResult` ({ killedPids, removedFiles, warnings, meta }), `selectLegacyRunnerPids(psOutput, udid)`, `shouldRemoveDaemonFiles(daemonPid, isAlive)`, `shouldReuseRunner(state, deviceId)`, `flowUsesClearState(text)`, `resolveIosAppFile(bundleId, deps)`, and `buildArgs(platform, flowFile, appFile?)` are used identically in every task and test that references them. ✅

**Out of Phase 1 scope (do NOT build here):** the persisted UDID simulator-ownership lock (Phase 1.5), the `DeviceSessionArbiter` / leases / `recoverWedge` (Phase 2), and the Maestro-surface consolidation (Phase 3). See the spec.
