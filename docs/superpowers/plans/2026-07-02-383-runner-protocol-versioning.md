# Story 02 (#383) — Runner Wire-Protocol Versioning + `/tmp` State Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the native runner `/command` wire protocol an explicit version handshake (so bridge/runner skew is detected and self-healed instead of silently misbehaving), and move runner state files off fixed shared `/tmp` paths to per-device hardened files under the app-support state dir.

**Architecture:** A new `protocol.ts` holds `RUNNER_PROTOCOL_VERSION` mirrored by constants in Swift (`RunnerProtocol.swift`) and Kotlin (`RunnerProtocol.kt`), kept in sync by a tri-file grep test. Both runners enrich `GET /health` with `{protocolVersion, runnerVersion, capabilities}` and stamp `"v"` on every response. The bridge-side liveness/reuse gates classify an incompatible runner as **stale**, which flows into the existing reap-then-restart paths; only a post-reinstall mismatch surfaces the new typed error `RUNNER_PROTOCOL_MISMATCH`. Runner state moves to `~/Library/Application Support/rn-dev-agent/runner-state/{ios-<udid>,android-<serial>}.json` via a shared `util/secure-state-file.ts` extracted from the already-hardened session-file IO.

**Tech Stack:** TypeScript (Node 22, `node --test`), Swift (XCTest rig, filesystem-synchronized Xcode project — new files need no pbxproj edit), Kotlin (NanoHTTPD instrumentation server).

**Spec:** `docs/stories/02-runner-protocol-versioning.md` (branch `limestone-malpais`, PR #381). GitHub issue: #383.

## Global Constraints

- Node.js >= 22 LTS; TS code uses explicit type imports (`import type { ... }`).
- Tests run with `cd scripts/cdp-bridge && npm test` (runs `tsc` build first, then `node --test`). Tests import from `../../dist/...` — always build before running a single test file: `npm run build && node --test test/unit/<file>.test.js`.
- `dist/` is tracked — stage rebuilt `dist/` output with every commit that touches `src/`.
- Commits are signed, small, per-task. One changeset for the whole story (Task 8).
- No unnecessary comments; where comments exist, follow the repo idiom (constraint + GH #383 reference).
- The two runner client files must contain **no `/tmp` literal** after this story (grep-enforced by the Task 4 static test). Legacy `/tmp` path literals live only in `util/secure-state-file.ts` (read-once for migration adoption + delete).
- Never delete md files from specs folders. Historical plans/specs that mention the old `/tmp` paths stay untouched.

## Design decisions (deviations from the spec — validated in the multi-LLM plan review)

1. **`runnerVersion` is a launch-time env echo, not a compile-time bake.** The bridge passes its plugin version (`.claude-plugin/plugin.json`) to the runner at launch (`RN_PLUGIN_VERSION` env on iOS xcodebuild; `-e RN_PLUGIN_VERSION` instrument arg on Android); the runner echoes it back in `/health`. This detects exactly the observed skew class (a still-running runner launched by an older bridge) with zero build-phase machinery, and cannot loop: after a reap, the relaunch always passes the current version. The compile-time `protocolVersion` constant guards actual wire-shape changes.
2. **Version-skew gating is fail-open.** If the bridge can't read its own plugin version, or the runner reports no `runnerVersion` (legacy launch), the version check is skipped — only the protocol check gates. A legitimate session must never be blocked by a missing manifest.
3. **`capabilities` ships as an empty array** — it is the negotiation hook Stories 04/05 build on; inventing capability names now would be YAGNI.
4. **`provenance` in the state schema is omitted** — it depends on Story 01 (prebuilt artifacts), which is not built.
5. **Android state is persisted only under a known serial.** `startAndroidRunner` resolves the serial up front (`deviceId ?? await resolveAndroidSerial()`); when it cannot be resolved (0 or >1 devices, no ANDROID_SERIAL) the runner state stays **in-memory only** — no `android-default.json` that two projects driving two different unspecified devices would share. The "two projects never touch the same state file" criterion therefore holds unconditionally; cross-bridge rediscovery just requires a resolvable serial. *(Amended from the multi-LLM review — the original `default`-key fallback violated the acceptance criterion.)*
6. **The spec's "integration test with a fake runner serving an old `/health`"** is realized as hermetic deps-injected classifier-matrix tests (the established `fast-runner-liveness.test.js` pattern) — same coverage, no real HTTP server.
7. **Legacy `/tmp` state is adopted once (leniently), not blindly deleted.** *(Amended from the multi-LLM review — BLOCKER.)* The pre-#383 runner's only pointer is the legacy `/tmp` file; deleting it at import would orphan a live old runner and make the transparent-upgrade acceptance criterion unreachable. Order: adopt from the new per-device path (strict, `schemaVersion:1`) → else adopt from the legacy `/tmp` file (lenient, synthesized `protocolVersion: 0`) so the health gate can classify it `legacy` → reap → relaunch; the legacy files are deleted only after a successful relaunch writes the new state file (or immediately when the legacy pid is dead — then they are garbage).
8. **Teardown and availability checks are adoption-aware.** *(Amended from the multi-LLM review — BLOCKER.)* `stopFastRunner`/`stopAndroidRunner` and the `device-interact.ts` `isFastRunnerAvailable()` fast-paths previously relied on the import-time load to see a runner after a bridge-worker respawn. They now adopt (deviceId-scoped) before acting, so session-close / restart / maestro-park never leak a live runner and exact-coordinate swipes don't false-fail `EXACT_REQUIRES_FAST_RUNNER`. Adoption is always scoped to a known deviceId — never "first live file in the dir" — so one project can never kill another project's runner.
9. **The Android mismatch reap reuses `releaseAndroidInteractionSlot()` (#237).** *(Amended from the multi-LLM review — BLOCKER.)* A single `am force-stop` of the app package does not reliably free the device-side UiAutomation slot (`release-android-slot.ts:115-128`); the battle-tested helper force-stops **both** owned packages after stopping our runner. The client reaches it via dynamic import (the helper statically imports the client — a static back-import would be a cycle).

---

### Task 1: Protocol constants + tri-file sync test

**Files:**
- Create: `scripts/cdp-bridge/src/runners/protocol.ts`
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RunnerProtocol.swift`
- Create: `scripts/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/RunnerProtocol.kt`
- Test: `scripts/cdp-bridge/test/unit/gh-383-protocol-sync.test.js`

**Interfaces:**
- Produces: `RUNNER_PROTOCOL_VERSION: number`, `MIN_SUPPORTED_RUNNER_PROTOCOL: number`, `getPluginVersion(): string | null`, `_setPluginVersionForTest(v: string | null | undefined): void`, `classifyRunnerCompatibility(health: {protocolVersion?: number; runnerVersion?: string}, pluginVersion: string | null): RunnerCompatibility`, `type RunnerIncompatibilityReason = 'legacy' | 'protocol-older' | 'protocol-newer' | 'version-skew'`, `type RunnerCompatibility = { compatible: true } | { compatible: false; reason: RunnerIncompatibilityReason }`. Swift: `RunnerProtocol.version`. Kotlin: `RunnerProtocol.VERSION`.

- [ ] **Step 1: Write the failing test**

`scripts/cdp-bridge/test/unit/gh-383-protocol-sync.test.js`:

```js
// GH #383: the /command wire protocol is versioned by a constant that exists
// in THREE files — TS bridge, Swift runner, Kotlin runner. This tri-file sync
// test is the CI guard that they agree (same style as the gh-374 static
// invariant: grep the sources, not the runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function extract(path, regex) {
  const src = readFileSync(path, 'utf8');
  const m = src.match(regex);
  assert.ok(m, `${path} must declare the protocol constant (${regex})`);
  return Number(m[1]);
}

test('gh-383: RUNNER_PROTOCOL_VERSION agrees across TS, Swift, and Kotlin', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'runners', 'protocol.ts'),
    /export const RUNNER_PROTOCOL_VERSION = (\d+);/,
  );
  const swift = extract(
    join(BRIDGE_ROOT, '..', 'rn-fast-runner', 'RnFastRunner', 'RnFastRunnerUITests', 'RunnerProtocol.swift'),
    /static let version = (\d+)/,
  );
  const kotlin = extract(
    join(BRIDGE_ROOT, '..', 'rn-android-runner', 'app', 'src', 'main', 'java', 'dev', 'lykhoyda', 'rndevagent', 'androidrunner', 'RunnerProtocol.kt'),
    /const val VERSION = (\d+)/,
  );
  assert.equal(swift, ts, 'Swift RunnerProtocol.version must match protocol.ts');
  assert.equal(kotlin, ts, 'Kotlin RunnerProtocol.VERSION must match protocol.ts');
});

test('gh-383: MIN_SUPPORTED_RUNNER_PROTOCOL <= RUNNER_PROTOCOL_VERSION', () => {
  const src = readFileSync(join(BRIDGE_ROOT, 'src', 'runners', 'protocol.ts'), 'utf8');
  const min = Number(src.match(/export const MIN_SUPPORTED_RUNNER_PROTOCOL = (\d+);/)?.[1]);
  const cur = Number(src.match(/export const RUNNER_PROTOCOL_VERSION = (\d+);/)?.[1]);
  assert.ok(Number.isInteger(min) && Number.isInteger(cur));
  assert.ok(min <= cur);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-protocol-sync.test.js`
Expected: FAIL — `protocol.ts` does not exist (ENOENT).

- [ ] **Step 3: Create the three constant files**

`scripts/cdp-bridge/src/runners/protocol.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// GH #383: the native runner /command wire protocol version. Mirrored by
// RunnerProtocol.swift (iOS) and RunnerProtocol.kt (Android); the tri-file
// sync test gh-383-protocol-sync.test.js enforces agreement. Bump when the
// wire shape changes incompatibly; raise MIN_SUPPORTED when old runners can
// no longer be driven.
export const RUNNER_PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_RUNNER_PROTOCOL = 1;

export type RunnerIncompatibilityReason =
  | 'legacy'
  | 'protocol-older'
  | 'protocol-newer'
  | 'version-skew';

export type RunnerCompatibility =
  | { compatible: true }
  | { compatible: false; reason: RunnerIncompatibilityReason };

export function classifyRunnerCompatibility(
  health: { protocolVersion?: number; runnerVersion?: string },
  pluginVersion: string | null,
): RunnerCompatibility {
  if (health.protocolVersion === undefined) return { compatible: false, reason: 'legacy' };
  if (health.protocolVersion < MIN_SUPPORTED_RUNNER_PROTOCOL) {
    return { compatible: false, reason: 'protocol-older' };
  }
  if (health.protocolVersion > RUNNER_PROTOCOL_VERSION) {
    return { compatible: false, reason: 'protocol-newer' };
  }
  if (
    pluginVersion !== null &&
    health.runnerVersion !== undefined &&
    health.runnerVersion !== pluginVersion
  ) {
    return { compatible: false, reason: 'version-skew' };
  }
  return { compatible: true };
}

// Fail-open plugin-version read: null when the manifest can't be read, which
// disables the version-skew check but never blocks a session.
let cachedPluginVersion: string | null | undefined;

export function getPluginVersion(): string | null {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion;
  try {
    const manifestPath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      '..',
      '.claude-plugin',
      'plugin.json',
    );
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string };
    cachedPluginVersion = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    cachedPluginVersion = null;
  }
  return cachedPluginVersion;
}

export function _setPluginVersionForTest(v: string | null | undefined): void {
  cachedPluginVersion = v;
}
```

`scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RunnerProtocol.swift` (project uses filesystem-synchronized groups — no pbxproj edit needed):

```swift
// GH #383: /command wire-protocol version. Must stay in sync with
// scripts/cdp-bridge/src/runners/protocol.ts and RunnerProtocol.kt —
// enforced by cdp-bridge test/unit/gh-383-protocol-sync.test.js.
enum RunnerProtocol {
  static let version = 1
}
```

`scripts/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/RunnerProtocol.kt` (main source set, like `KeyboardGuard.kt`, so androidTest code can use it):

```kotlin
/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

// GH #383: /command wire-protocol version. Must stay in sync with
// scripts/cdp-bridge/src/runners/protocol.ts and RunnerProtocol.swift —
// enforced by cdp-bridge test/unit/gh-383-protocol-sync.test.js.
object RunnerProtocol {
    const val VERSION = 1
}
```

- [ ] **Step 4: Add classifier unit tests to the same test file**

Append to `gh-383-protocol-sync.test.js`:

```js
import { classifyRunnerCompatibility } from '../../dist/runners/protocol.js';

test('gh-383 classify: missing protocolVersion → legacy', () => {
  assert.deepEqual(classifyRunnerCompatibility({}, '0.58.0'), {
    compatible: false,
    reason: 'legacy',
  });
});

test('gh-383 classify: older / equal / newer protocol', () => {
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 0 }, null), {
    compatible: false,
    reason: 'protocol-older',
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, null), {
    compatible: true,
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 99 }, null), {
    compatible: false,
    reason: 'protocol-newer',
  });
});

test('gh-383 classify: version-skew only when both sides known', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, '0.57.3'),
    { compatible: false, reason: 'version-skew' },
  );
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.3' }, '0.57.3'),
    { compatible: true },
  );
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, '0.57.3'), {
    compatible: true,
  });
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, null),
    { compatible: true },
  );
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-protocol-sync.test.js`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/runners/protocol.ts scripts/cdp-bridge/test/unit/gh-383-protocol-sync.test.js scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RunnerProtocol.swift "scripts/rn-android-runner/app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/RunnerProtocol.kt" scripts/cdp-bridge/dist
git commit -S -m "feat(protocol): RUNNER_PROTOCOL_VERSION constants + tri-file sync test (#383)"
```

---

### Task 2: `util/secure-state-file.ts` extraction

**Files:**
- Create: `scripts/cdp-bridge/src/util/secure-state-file.ts`
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts:40-108` (replace local `getStateDir`/`readSessionSafely`/write logic with util calls)
- Test: `scripts/cdp-bridge/test/unit/gh-383-secure-state-file.test.js`

**Interfaces:**
- Produces: `getStateDir(): string`, `runnerStatePath(key: string): string`, `readJsonStateFile<T>(path: string): T | null`, `writeJsonStateFileAtomic(path: string, value: unknown): void`, `deleteStateFile(path: string): void`, `cleanupLegacyTmpState(): void`.

- [ ] **Step 1: Write the failing test**

`scripts/cdp-bridge/test/unit/gh-383-secure-state-file.test.js`:

```js
// GH #383: shared hardened state-file IO — extracted from the CDP-015 session
// file so runner state gets the same guarantees: symlink-refusing reads,
// atomic 0600 writes, best-effort deletes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  runnerStatePath,
  getStateDir,
  cleanupLegacyTmpState,
} from '../../dist/util/secure-state-file.js';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'gh383-state-'));
}

test('gh-383 state: write is atomic, 0600, and round-trips', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'nested', 'state.json');
    writeJsonStateFileAtomic(p, { a: 1 });
    assert.deepEqual(readJsonStateFile(p), { a: 1 });
    const mode = statSync(p).mode & 0o777;
    assert.equal(mode, 0o600, 'state file must be user-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: read refuses to follow a symlink', () => {
  const dir = scratch();
  try {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify({ evil: true }));
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    assert.equal(readJsonStateFile(link), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: read returns null on missing or corrupt file', () => {
  const dir = scratch();
  try {
    assert.equal(readJsonStateFile(join(dir, 'absent.json')), null);
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    assert.equal(readJsonStateFile(corrupt), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: delete is idempotent', () => {
  const dir = scratch();
  try {
    const p = join(dir, 'x.json');
    writeJsonStateFileAtomic(p, {});
    deleteStateFile(p);
    deleteStateFile(p);
    assert.equal(readJsonStateFile(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh-383 state: cleanupLegacyTmpState deletes the pre-relocation /tmp files', () => {
  // Spec migration branch: legacy /tmp state is ignored and best-effort deleted.
  // These are the real fixed legacy paths — nothing reads them after #383, so
  // creating + deleting them in a test is safe.
  writeFileSync('/tmp/rn-fast-runner-state.json', '{}');
  writeFileSync('/tmp/rn-android-runner-state.json', '{}');
  cleanupLegacyTmpState();
  assert.equal(readJsonStateFile('/tmp/rn-fast-runner-state.json'), null);
  assert.equal(readJsonStateFile('/tmp/rn-android-runner-state.json'), null);
  cleanupLegacyTmpState();
});

test('gh-383 state: runnerStatePath keys under <stateDir>/runner-state and sanitizes', () => {
  const p = runnerStatePath('ios-ABCD-1234');
  assert.ok(p.startsWith(join(getStateDir(), 'runner-state')));
  assert.ok(p.endsWith('ios-ABCD-1234.json'));
  const weird = runnerStatePath('android-192.168.1.5:5555');
  assert.ok(weird.endsWith('android-192.168.1.5:5555.json'));
  // '.' is allowlisted (serials/versions contain it), so '..' survives as text —
  // the traversal-neutralizing invariant is that no '/' survives, keeping the
  // basename inside runner-state/ ('ios-../../x' → 'ios-.._.._x').
  const hostile = runnerStatePath('ios-../../etc/passwd');
  const base = hostile.slice(join(getStateDir(), 'runner-state').length + 1);
  assert.ok(!base.includes('/'), 'no path separator may survive sanitization');
  assert.ok(hostile.startsWith(join(getStateDir(), 'runner-state')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-secure-state-file.test.js`
Expected: FAIL — module `dist/util/secure-state-file.js` not found.

- [ ] **Step 3: Write the util**

`scripts/cdp-bridge/src/util/secure-state-file.ts`:

```ts
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  lstatSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// GH #383: one hardened implementation for every bridge state file (session
// file, runner state, future state) — CDP-015 guarantees: symlink-refusing
// reads, atomic tmp+rename writes with 0600, per-user app-support location.

export function getStateDir(): string {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, 'rn-dev-agent');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'rn-dev-agent');
  }
  return join(homedir(), '.rn-dev-agent');
}

export function runnerStatePath(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._:-]/g, '_');
  return join(getStateDir(), 'runner-state', `${safe}.json`);
}

export function readJsonStateFile<T>(path: string): T | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonStateFileAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmpPath, path);
}

export function deleteStateFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

// GH #383: the pre-relocation fixed shared paths. Read ONCE (leniently) so a
// live pre-upgrade runner can be discovered → classified legacy → reaped;
// deleted only after a successful relaunch persists the new per-device file.
const LEGACY_TMP_STATE_FILES: Record<'ios' | 'android', string> = {
  ios: '/tmp/rn-fast-runner-state.json',
  android: '/tmp/rn-android-runner-state.json',
};

export function readLegacyTmpState<T>(kind: 'ios' | 'android'): T | null {
  return readJsonStateFile<T>(LEGACY_TMP_STATE_FILES[kind]);
}

export function cleanupLegacyTmpState(): void {
  for (const p of Object.values(LEGACY_TMP_STATE_FILES)) deleteStateFile(p);
}
```

- [ ] **Step 4: Refactor `agent-device-wrapper.ts` to use the util**

Replace the local `getStateDir()` (lines 40-48) and `readSessionSafely()` (lines 64-73) with imports, and use `writeJsonStateFileAtomic` in `setActiveSession`. The behavior is identical; only the implementation moves:

```ts
import {
  getStateDir,
  readJsonStateFile,
  writeJsonStateFileAtomic,
} from './util/secure-state-file.js';
```

- `getSessionFilePath()` keeps its body but calls the imported `getStateDir()`.
- Delete `readSessionSafely` and replace its two call sites with `readJsonStateFile<SessionState>(SESSION_FILE)` / `readJsonStateFile<SessionState>(LEGACY_SESSION_FILE)`.
- In the legacy-migration branch and `setActiveSession`, replace the `mkdirSync` + `writeFileSync`(+`renameSync`) blocks with `writeJsonStateFileAtomic(SESSION_FILE, info)` inside the existing `try { } catch { }`.
- Remove now-unused fs imports (`lstatSync`, `renameSync`, `mkdirSync` — keep `unlinkSync`, `readFileSync`/`writeFileSync` only if still used elsewhere in the file).

- [ ] **Step 5: Run the full suite to verify no regression**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (existing session-file tests still green; new util tests green).

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/util/secure-state-file.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/gh-383-secure-state-file.test.js scripts/cdp-bridge/dist
git commit -S -m "refactor(state): extract hardened secure-state-file util from session-file IO (#383)"
```

---

### Task 3: iOS runner-state relocation (per-UDID, schema v1, legacy cleanup)

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts:318-324` (`FastRunnerState`)
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (remove `STATE_FILE` + import-time load at lines 19, 100-112; rework write/clear sites at lines 273-278, 304-307, 327-331, 468-480; add `iosStatePath`, `parsePersistedRunnerState`, `parseLegacyRunnerState`, `adoptPersistedFastRunnerState`; `stopFastRunner` gains optional `deviceId`)
- Modify (adoption-aware call sites, review amendment): `scripts/cdp-bridge/src/index.ts:2486`, `scripts/cdp-bridge/src/cdp/recover-detached.ts:234`, `scripts/cdp-bridge/src/cdp/recover-wedge.ts:96`, `scripts/cdp-bridge/src/tools/repair-action.ts:92`, `scripts/cdp-bridge/src/tools/restart.ts:224`, `scripts/cdp-bridge/src/tools/device-interact.ts:185,1034,1045,1156`, `scripts/cdp-bridge/src/tools/device-session-close.ts:49`
- Test: `scripts/cdp-bridge/test/unit/gh-383-ios-state-relocation.test.js`

**Interfaces:**
- Consumes: Task 2 util (`runnerStatePath`, `readJsonStateFile`, `writeJsonStateFileAtomic`, `deleteStateFile`, `readLegacyTmpState`, `cleanupLegacyTmpState`), Task 1 (`RUNNER_PROTOCOL_VERSION`, `getPluginVersion`).
- Produces: `iosStatePath(deviceId: string): string`, `parsePersistedRunnerState(raw: unknown, pidAlive?: (pid: number) => boolean): FastRunnerState | null`, `parseLegacyRunnerState(raw: unknown, pidAlive?: (pid: number) => boolean): FastRunnerState | null` (synthesizes `protocolVersion: 0`), `adoptPersistedFastRunnerState(deviceId: string | undefined): void`, `stopFastRunner(deviceId?: string): void`. `FastRunnerState` gains `schemaVersion: 1; protocolVersion: number; runnerVersion?: string`.

- [ ] **Step 1: Update `FastRunnerState` in `types.ts`**

```ts
export interface FastRunnerState {
  schemaVersion: 1;
  port: number;
  pid: number;
  deviceId: string;
  bundleId: string;
  startedAt: string;
  protocolVersion: number;
  runnerVersion?: string;
}
```

- [ ] **Step 2: Write the failing test**

`scripts/cdp-bridge/test/unit/gh-383-ios-state-relocation.test.js`:

```js
// GH #383: iOS runner state moves from /tmp/rn-fast-runner-state.json to a
// per-UDID hardened file under <stateDir>/runner-state/ios-<udid>.json.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  iosStatePath,
  parsePersistedRunnerState,
  parseLegacyRunnerState,
  adoptPersistedFastRunnerState,
  getFastRunnerState,
  _setRunnerStateForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { getStateDir } from '../../dist/util/secure-state-file.js';

afterEach(() => _setRunnerStateForTest(null));

const VALID = {
  schemaVersion: 1,
  port: 22088,
  pid: 4242,
  deviceId: 'UDID-1',
  bundleId: 'com.example',
  startedAt: '2026-07-02T00:00:00.000Z',
  protocolVersion: 1,
};

test('gh-383 ios: state path is per-device under runner-state/', () => {
  assert.equal(
    iosStatePath('UDID-1'),
    join(getStateDir(), 'runner-state', 'ios-UDID-1.json'),
  );
});

test('gh-383 ios: parse accepts schema v1 with a live pid', () => {
  const parsed = parsePersistedRunnerState(VALID, () => true);
  assert.deepEqual(parsed, VALID);
});

test('gh-383 ios: parse rejects dead pid, wrong schema, malformed shapes', () => {
  assert.equal(parsePersistedRunnerState(VALID, () => false), null);
  assert.equal(parsePersistedRunnerState({ ...VALID, schemaVersion: 2 }, () => true), null);
  assert.equal(parsePersistedRunnerState({ ...VALID, schemaVersion: undefined }, () => true), null);
  assert.equal(parsePersistedRunnerState(null, () => true), null);
  assert.equal(parsePersistedRunnerState('junk', () => true), null);
  assert.equal(parsePersistedRunnerState({ ...VALID, pid: 'x' }, () => true), null);
});

test('gh-383 ios: adopt is a no-op when in-memory state exists or deviceId missing', () => {
  _setRunnerStateForTest(VALID);
  adoptPersistedFastRunnerState('UDID-OTHER');
  assert.deepEqual(getFastRunnerState(), VALID);
  _setRunnerStateForTest(null);
  adoptPersistedFastRunnerState(undefined);
  assert.equal(getFastRunnerState(), null);
});

test('gh-383 ios: legacy /tmp state parses leniently with protocolVersion 0', () => {
  // Pre-#383 shape: no schemaVersion/protocolVersion. Must be adoptable so the
  // health gate can classify the live runner 'legacy' and reap it (review
  // amendment — deleting it unseen orphans the old runner).
  const legacy = { pid: 4242, port: 22088, deviceId: 'UDID-1', bundleId: 'com.example', startedAt: 'x' };
  const parsed = parseLegacyRunnerState(legacy, () => true);
  assert.equal(parsed.protocolVersion, 0);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.deviceId, 'UDID-1');
  assert.equal(parseLegacyRunnerState(legacy, () => false), null);
  assert.equal(parseLegacyRunnerState({ port: 1 }, () => true), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-ios-state-relocation.test.js`
Expected: FAIL — `iosStatePath` is not exported.

- [ ] **Step 4: Rework the client**

In `rn-fast-runner-client.ts`:

1. Delete `const STATE_FILE = '/tmp/rn-fast-runner-state.json';` and the entire import-time load block (lines 100-112). Add imports:

```ts
import {
  runnerStatePath,
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  cleanupLegacyTmpState,
} from '../util/secure-state-file.js';
import { RUNNER_PROTOCOL_VERSION, getPluginVersion } from './protocol.js';
```

2. Add (near the singleton state):

```ts
export function iosStatePath(deviceId: string): string {
  return runnerStatePath(`ios-${deviceId}`);
}

export function parsePersistedRunnerState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): FastRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<FastRunnerState>;
  if (s.schemaVersion !== 1) return null;
  if (typeof s.pid !== 'number' || typeof s.port !== 'number') return null;
  if (typeof s.deviceId !== 'string' || typeof s.bundleId !== 'string') return null;
  if (!pidAlive(s.pid)) return null;
  return s as FastRunnerState;
}

// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state. protocolVersion is synthesized to 0 ("pre-protocol") — the
// health gate then classifies the live runner 'legacy' → reap → relaunch,
// which is exactly the transparent-upgrade path. Never trusted beyond
// pid/port/deviceId.
export function parseLegacyRunnerState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): FastRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as { pid?: unknown; port?: unknown; deviceId?: unknown; bundleId?: unknown };
  if (typeof s.pid !== 'number' || typeof s.port !== 'number') return null;
  if (typeof s.deviceId !== 'string') return null;
  if (!pidAlive(s.pid)) return null;
  return {
    schemaVersion: 1,
    pid: s.pid,
    port: s.port,
    deviceId: s.deviceId,
    bundleId: typeof s.bundleId === 'string' ? s.bundleId : '',
    startedAt: '',
    protocolVersion: 0,
  };
}

// GH #383: lazy per-device adoption replaces the import-time /tmp load. A
// respawned bridge worker rediscovers a live runner the first time it knows
// which device it is talking to (ensureRunnerForCommand / session health /
// startFastRunner / stopFastRunner). Invalid or dead persisted state is
// deleted on sight. Falls back to the legacy /tmp file ONCE so a live
// pre-upgrade runner is discovered rather than orphaned (review amendment);
// a dead legacy file is garbage and is removed immediately.
export function adoptPersistedFastRunnerState(deviceId: string | undefined): void {
  if (runnerState || !deviceId) return;
  const path = iosStatePath(deviceId);
  const raw = readJsonStateFile(path);
  if (raw !== null) {
    const parsed = parsePersistedRunnerState(raw);
    if (!parsed) {
      deleteStateFile(path);
      return;
    }
    runnerState = parsed;
    return;
  }
  const legacy = readLegacyTmpState('ios');
  if (legacy === null) return;
  const parsedLegacy = parseLegacyRunnerState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (parsedLegacy.deviceId === deviceId) runnerState = parsedLegacy;
}
```

(Import `readLegacyTmpState` alongside the other util imports; there is NO module-init `cleanupLegacyTmpState()` call — deletion happens only on dead-legacy discovery above and after a successful relaunch below.)

3. `startFastRunner`: first line becomes

```ts
adoptPersistedFastRunnerState(deviceId);
if (shouldReuseRunner(runnerState, deviceId)) return runnerState!;
```

and the ready-state construction (lines 266-278) becomes:

```ts
const state: FastRunnerState = {
  schemaVersion: 1,
  port: result.port,
  pid: child.pid!,
  deviceId,
  bundleId,
  startedAt: new Date().toISOString(),
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion()! } : {}),
};
runnerState = state;
try {
  writeJsonStateFileAtomic(iosStatePath(deviceId), state);
} catch {
  /* ignore */
}
cleanupLegacyTmpState();
```

(The `cleanupLegacyTmpState()` here is the review-amended migration point: the legacy `/tmp` files are deleted only once a fresh runner has persisted its new per-device state.)

4. `clearStateFile()` (lines 468-480) captures the path before nulling:

```ts
function clearStateFile(): void {
  const path = runnerState ? iosStatePath(runnerState.deviceId) : null;
  runnerState = null;
  runnerProcess = null;
  if (path) deleteStateFile(path);
}
```

5. Replace the remaining manual `unlinkSync(STATE_FILE)` sites with `clearStateFile()`:
   - `isFastRunnerAvailable()` dead-pid branch (lines 135-140) → `clearStateFile(); return false;`
   - `stopFastRunner()` (lines 315-332) → **review amendment: adoption-aware teardown.** New signature `stopFastRunner(deviceId?: string)`; first line `adoptPersistedFastRunnerState(deviceId);` so a post-respawn stop (session close, restart, maestro park) finds the persisted runner instead of no-oping and leaking it. Then send signals as today, then `clearStateFile();` (drop the manual nulling + unlink).
   - `child.on('exit')` handler (lines 299-311) → inside the `runnerProcess === child` guard call `clearStateFile()` instead of the null+unlink block.
   - `child.on('error')` handler → same replacement inside its guard.
6. Remove `unlinkSync`/`readFileSync`/`existsSync` from the `node:fs` import if now unused (`existsSync` is still used by `hasBuiltTestProduct`/`startFastRunner`; `readdirSync` stays; `writeFileSync`/`readFileSync`/`unlinkSync` should now be unused — delete them).
7. **Review amendment — pass the deviceId at every `stopFastRunner()` call site** (each has a session/deviceId in scope; grep-verified list):
   - `src/index.ts:2486` → `stopFastRunner(getActiveSession()?.deviceId)`
   - `src/cdp/recover-detached.ts:234` and `src/cdp/recover-wedge.ts:96` → pass the udid/deviceId variable already used by the surrounding recovery logic (both operate on a resolved simulator UDID).
   - `src/tools/repair-action.ts:92` → pass the deviceId the repair flow resolved.
   - `src/tools/restart.ts:224` → pass the session deviceId in scope.
   - `src/tools/device-interact.ts:185` → pass the session deviceId (the sibling `stopAndroidRunner()` call at line 186 already takes one — pass it there too).
   - `src/tools/device-session-close.ts:49` → the injected `deps.stopFastRunner` type gains the optional param; the caller passes the closing session's deviceId.
   Where a site genuinely has no deviceId in scope, call with `undefined` — behavior degrades to the pre-amendment no-op, never to a wrong-device kill.
8. **Review amendment — adoption before the `device-interact.ts` fast-runner fast-paths.** The three `isFastRunnerAvailable()` gates at `device-interact.ts:1034`, `:1045` (`EXACT_REQUIRES_FAST_RUNNER`), and `:1156` ran against in-memory state only; after a worker respawn they false-report "unavailable". Insert `adoptPersistedFastRunnerState(getActiveSession()?.deviceId);` immediately before each check (or hoist one call at the top of the two enclosing handlers if they share scope).

- [ ] **Step 5: Run test + full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — including `fast-runner-liveness.test.js` (its deps-injected probes never touched the real state file).

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/test/unit/gh-383-ios-state-relocation.test.js scripts/cdp-bridge/dist
git commit -S -m "feat(ios-runner): per-UDID hardened state file replaces /tmp singleton (#383)"
```

---

### Task 4: Android runner-state relocation + grep-enforced no-/tmp invariant

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (remove `STATE_FILE` at line 20 + import-time load at lines 116-132; rework write/clear at lines 430-435, 445-463, 493-514; screenshot default outPath at line 656; add `androidStatePath`, `parsePersistedAndroidState`, `adoptPersistedAndroidState`)
- Test: `scripts/cdp-bridge/test/unit/gh-383-android-state-relocation.test.js`
- Test: `scripts/cdp-bridge/test/unit/gh-383-no-tmp-state.test.js`

**Interfaces:**
- Consumes: Task 2 util (incl. `readLegacyTmpState`); Task 1 constants.
- Produces: `androidStatePath(serial: string): string` (key `android-<serial>`; unknown serial ⇒ no persistence), `parsePersistedAndroidState(raw: unknown, pidAlive?: (pid: number) => boolean): AndroidRunnerState | null`, `parseLegacyAndroidState(raw: unknown, pidAlive?: (pid: number) => boolean): AndroidRunnerState | null` (synthesizes `protocolVersion: 0`), `adoptPersistedAndroidState(serial?: string): void`. `AndroidRunnerState` gains `schemaVersion: 1; protocolVersion: number; runnerVersion?: string`.

- [ ] **Step 1: Write the failing tests**

`scripts/cdp-bridge/test/unit/gh-383-android-state-relocation.test.js` (mirror of the iOS test):

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  androidStatePath,
  parsePersistedAndroidState,
  parseLegacyAndroidState,
  adoptPersistedAndroidState,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import { getStateDir } from '../../dist/util/secure-state-file.js';

afterEach(() => _setAndroidRunnerStateForTest(null));

const VALID = {
  schemaVersion: 1,
  hostPort: 22089,
  devicePort: 22089,
  pid: 999,
  deviceId: 'emulator-5554',
  startedAt: '2026-07-02T00:00:00.000Z',
  protocolVersion: 1,
};

test('gh-383 android: per-serial path (no default key — review amendment)', () => {
  assert.equal(
    androidStatePath('emulator-5554'),
    join(getStateDir(), 'runner-state', 'android-emulator-5554.json'),
  );
});

test('gh-383 android: parse accepts schema v1 live pid, rejects everything else', () => {
  assert.deepEqual(parsePersistedAndroidState(VALID, () => true), VALID);
  assert.equal(parsePersistedAndroidState(VALID, () => false), null);
  assert.equal(parsePersistedAndroidState({ ...VALID, schemaVersion: 0 }, () => true), null);
  assert.equal(parsePersistedAndroidState({ ...VALID, hostPort: 'x' }, () => true), null);
  assert.equal(parsePersistedAndroidState(null, () => true), null);
});

test('gh-383 android: legacy /tmp state parses leniently with protocolVersion 0', () => {
  const legacy = { hostPort: 22089, devicePort: 22089, pid: 999, deviceId: 'emulator-5554', startedAt: 'x' };
  const parsed = parseLegacyAndroidState(legacy, () => true);
  assert.equal(parsed.protocolVersion, 0);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parseLegacyAndroidState(legacy, () => false), null);
  assert.equal(parseLegacyAndroidState({ hostPort: 1 }, () => true), null);
});
```

`scripts/cdp-bridge/test/unit/gh-383-no-tmp-state.test.js`:

```js
// GH #383 acceptance criterion: no file under /tmp is read or written by
// either runner client. Grep-enforced static invariant (gh-374 pattern, per
// D1288) — the runtime never exercises every path, the source scan does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const CLIENTS = [
  join(SRC, 'runners', 'rn-fast-runner-client.ts'),
  join(SRC, 'runners', 'rn-android-runner-client.ts'),
];

test('gh-383: runner clients contain no /tmp path literal', () => {
  for (const file of CLIENTS) {
    const src = readFileSync(file, 'utf8');
    assert.ok(
      !/['"`]\/tmp\//.test(src),
      `${file} must not reference /tmp — use util/secure-state-file.ts (state) or os.tmpdir() (scratch)`,
    );
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-android-state-relocation.test.js test/unit/gh-383-no-tmp-state.test.js`
Expected: FAIL — missing exports; `/tmp` literals still present in both clients (relocation test fails on import, grep test fails on both files).

- [ ] **Step 3: Rework the Android client**

In `rn-android-runner-client.ts`:

1. Delete `const STATE_FILE = '/tmp/rn-android-runner-state.json';` and the import-time load (lines 116-132). Add imports:

```ts
import { tmpdir } from 'node:os';
import {
  runnerStatePath,
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  cleanupLegacyTmpState,
} from '../util/secure-state-file.js';
import { RUNNER_PROTOCOL_VERSION, getPluginVersion } from './protocol.js';
```

2. Extend the state interface:

```ts
interface AndroidRunnerState {
  schemaVersion: 1;
  hostPort: number;
  devicePort: number;
  pid: number;
  deviceId?: string;
  bundleId?: string;
  startedAt: string;
  protocolVersion: number;
  runnerVersion?: string;
}
```

3. Add near the singletons:

```ts
export function androidStatePath(serial: string): string {
  return runnerStatePath(`android-${serial}`);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parsePersistedAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AndroidRunnerState>;
  if (s.schemaVersion !== 1) return null;
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return s as AndroidRunnerState;
}

// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state — mirrors parseLegacyRunnerState on iOS. protocolVersion 0 makes
// the reuse-time health gate classify the live runner 'legacy' → reap.
export function parseLegacyAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as { hostPort?: unknown; devicePort?: unknown; pid?: unknown; deviceId?: unknown; bundleId?: unknown };
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return {
    schemaVersion: 1,
    hostPort: s.hostPort,
    devicePort: s.devicePort,
    pid: s.pid,
    ...(typeof s.deviceId === 'string' ? { deviceId: s.deviceId } : {}),
    ...(typeof s.bundleId === 'string' ? { bundleId: s.bundleId } : {}),
    startedAt: '',
    protocolVersion: 0,
  };
}

// Serial-scoped adoption (review amendment: NO 'default' key — an unknown
// serial means no persistence, so two projects driving two different
// unspecified devices can never share a state file).
export function adoptPersistedAndroidState(serial?: string): void {
  if (runnerState) return;
  if (serial) {
    const path = androidStatePath(serial);
    const raw = readJsonStateFile(path);
    if (raw !== null) {
      const parsed = parsePersistedAndroidState(raw);
      if (!parsed) {
        deleteStateFile(path);
        return;
      }
      runnerState = parsed;
      return;
    }
  }
  const legacy = readLegacyTmpState('android');
  if (legacy === null) return;
  const parsedLegacy = parseLegacyAndroidState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (!serial || !parsedLegacy.deviceId || parsedLegacy.deviceId === serial) {
    runnerState = parsedLegacy;
  }
}

function clearAndroidStateFile(): void {
  const path = runnerState?.deviceId ? androidStatePath(runnerState.deviceId) : null;
  runnerState = null;
  runnerProcess = null;
  if (path) deleteStateFile(path);
}
```

(Import `readLegacyTmpState` alongside the other util imports; NO module-init `cleanupLegacyTmpState()` call.)

4. `startAndroidRunner` head becomes (review amendment: resolve the serial FIRST so adoption and persistence are always serial-scoped):

```ts
const serial = deviceId ?? (await resolveAndroidSerial());
adoptPersistedAndroidState(serial);
if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId))
  return runnerState!;
```

(Use `serial` — not the raw `deviceId` param — for the state write in step 5. `stopAndroidRunner` likewise adopts at the top: `adoptPersistedAndroidState(deviceId ?? undefined);` before the kill/forward-removal, so a post-respawn stop finds the persisted runner — review amendment, mirrors iOS.)

5. `finishReady` state construction gains the new fields and the per-device write (persist only when the serial is known):

```ts
const state: AndroidRunnerState = {
  schemaVersion: 1,
  hostPort,
  devicePort,
  pid: child.pid!,
  ...(serial ? { deviceId: serial } : {}),
  ...(bundleId ? { bundleId } : {}),
  startedAt: new Date().toISOString(),
  protocolVersion: RUNNER_PROTOCOL_VERSION,
  ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion()! } : {}),
};
runnerState = state;
if (serial) {
  try {
    writeJsonStateFileAtomic(androidStatePath(serial), state);
  } catch {
    /* non-fatal */
  }
}
cleanupLegacyTmpState();
```

6. Replace unlink sites:
   - `isAndroidRunnerAvailable()` dead-pid branch → `clearAndroidStateFile(); return false;`
   - `child.on('exit')` handler: keep the `exitState` capture + forward-removal logic, but replace the null+unlink block with `clearAndroidStateFile();` **before** using `exitState` (capture `const exitState = runnerState;` first, as today).
   - `stopAndroidRunner()` → capture `const stoppedState = runnerState;` (as today), then `runnerProcess?.kill('SIGTERM'); clearAndroidStateFile();` and keep the forward removal on `stoppedState`.
7. Screenshot default path (line 656): `const outPath = args.outPath ?? join(tmpdir(), \`rn-android-screenshot-${Date.now()}.png\`);`

- [ ] **Step 4: Run tests + full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — both new gh-383 test files green, plus `android-runner-*.test.js` and `gh-243-android-runner-health.test.js` still green (they inject state/fetch, not the state file).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/test/unit/gh-383-android-state-relocation.test.js scripts/cdp-bridge/test/unit/gh-383-no-tmp-state.test.js scripts/cdp-bridge/dist
git commit -S -m "feat(android-runner): per-serial hardened state file + no-/tmp static invariant (#383)"
```

---

### Task 5: Native `/health` enrichment + `"v"` stamp (Swift + Kotlin) + launch plumbing (TS)

**Files:**
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift:62-72` (`Response` struct)
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift:33-37` (health branch)
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Environment.swift` (add `pluginVersion()`)
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt`
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/RnAndroidRunnerInstrumentedTest.kt` (pass plugin version into `CommandServer`)
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:236-242` (spawn env)
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (new `buildInstrumentVersionArgs` + spawn args)
- Test: `scripts/cdp-bridge/test/unit/gh-383-launch-plumbing.test.js`

**Interfaces:**
- Consumes: Task 1 constants (`RunnerProtocol.version` / `RunnerProtocol.VERSION` / `getPluginVersion`).
- Produces: `/health` body `{"ok":true,"v":1,"protocolVersion":1,"runnerVersion":"<pluginVersion>","capabilities":[]}` (runnerVersion omitted when unknown); every `/command` response body carries `"v":1`. TS: `buildInstrumentVersionArgs(pluginVersion: string | null): string[]`.

- [ ] **Step 1: Write the failing TS test (the native side is asserted by device verification + the Task 1 sync test)**

`scripts/cdp-bridge/test/unit/gh-383-launch-plumbing.test.js`:

```js
// GH #383: the bridge passes its plugin version to the runner at launch so the
// runner can echo it in /health (runnerVersion). Pure-builder test — the env
// half (iOS xcodebuild spawn) is a one-line spread checked by review + device
// verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstrumentVersionArgs } from '../../dist/runners/rn-android-runner-client.js';

test('gh-383: buildInstrumentVersionArgs emits -e RN_PLUGIN_VERSION when known', () => {
  assert.deepEqual(buildInstrumentVersionArgs('0.58.0'), ['-e', 'RN_PLUGIN_VERSION', '0.58.0']);
});

test('gh-383: buildInstrumentVersionArgs is empty when version unknown (fail-open)', () => {
  assert.deepEqual(buildInstrumentVersionArgs(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-launch-plumbing.test.js`
Expected: FAIL — `buildInstrumentVersionArgs` is not exported.

- [ ] **Step 3: Swift changes**

`RnFastRunnerTests+Models.swift` — extend `Response` (encode-only struct; `JSONEncoder` omits nil optionals, so command responses stay lean):

```swift
struct Response: Codable {
  let ok: Bool
  let v: Int
  let protocolVersion: Int?
  let runnerVersion: String?
  let capabilities: [String]?
  let data: DataPayload?
  let error: ErrorPayload?

  init(
    ok: Bool,
    data: DataPayload? = nil,
    error: ErrorPayload? = nil,
    protocolVersion: Int? = nil,
    runnerVersion: String? = nil,
    capabilities: [String]? = nil
  ) {
    self.ok = ok
    self.v = RunnerProtocol.version
    self.data = data
    self.error = error
    self.protocolVersion = protocolVersion
    self.runnerVersion = runnerVersion
    self.capabilities = capabilities
  }
}
```

`RnFastRunnerTests+Transport.swift` health branch (lines 33-37):

```swift
if self.isHealthRequest(combined) {
  let response = self.jsonResponse(
    status: 200,
    response: Response(
      ok: true,
      protocolVersion: RunnerProtocol.version,
      runnerVersion: RunnerEnv.pluginVersion(),
      capabilities: []
    )
  )
  self.sendResponse(response, over: connection)
  return
}
```

`RnFastRunnerTests+Environment.swift` — add to `RunnerEnv` (same env-then-argv resolution as `resolvePort`):

```swift
static func pluginVersion() -> String? {
  if let env = ProcessInfo.processInfo.environment["RN_PLUGIN_VERSION"], !env.isEmpty {
    return env
  }
  for arg in CommandLine.arguments where arg.hasPrefix("RN_PLUGIN_VERSION=") {
    let value = String(arg.dropFirst("RN_PLUGIN_VERSION=".count))
    if !value.isEmpty { return value }
  }
  return nil
}
```

- [ ] **Step 4: Kotlin changes**

`CommandServer.kt` — constructor gains the version, health gains the fields, every response gains `"v"`:

```kotlin
import org.json.JSONArray
import org.json.JSONObject

class CommandServer(port: Int, private val pluginVersion: String? = null) : NanoHTTPD(port) {
    override fun serve(session: IHTTPSession): Response {
        if (session.method == Method.GET && session.uri == "/health") {
            val body = JSONObject()
                .put("ok", true)
                .put("protocolVersion", RunnerProtocol.VERSION)
                .put("capabilities", JSONArray())
            if (pluginVersion != null) body.put("runnerVersion", pluginVersion)
            return json(Response.Status.OK, body)
        }
        // ... existing /command handling unchanged ...
    }

    private fun json(status: Response.Status, body: JSONObject): Response {
        if (!body.has("v")) body.put("v", RunnerProtocol.VERSION)
        return newFixedLengthResponse(status, "application/json", body.toString())
    }
}
```

`RnAndroidRunnerInstrumentedTest.kt` `startServer()`:

```kotlin
val port = args.getString("RN_ANDROID_RUNNER_PORT")?.toIntOrNull() ?: 22089
val pluginVersion = args.getString("RN_PLUGIN_VERSION")
// ...
server = CommandServer(port, pluginVersion)
```

- [ ] **Step 5: TS launch plumbing**

`rn-fast-runner-client.ts` spawn env (lines 236-242):

```ts
const child = spawn('xcodebuild', args, {
  env: {
    ...process.env,
    RN_FAST_RUNNER_PORT: String(desired),
    ...(getPluginVersion() !== null ? { RN_PLUGIN_VERSION: getPluginVersion()! } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

`rn-android-runner-client.ts` — add next to `buildInstrumentPortArgs`:

```ts
export function buildInstrumentVersionArgs(pluginVersion: string | null): string[] {
  return pluginVersion ? ['-e', 'RN_PLUGIN_VERSION', pluginVersion] : [];
}
```

and in the `spawn('adb', [...])` args of `startAndroidRunner`, after `...buildInstrumentPortArgs(devicePort),` insert `...buildInstrumentVersionArgs(getPluginVersion()),`.

- [ ] **Step 6: Run test + full suite; sanity-build the Android runner if SDK available**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS.
Optionally (Kotlin compile check, skip if no SDK): `cd scripts/rn-android-runner && ./gradlew :app:compileDebugAndroidTestKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Environment.swift scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/RnAndroidRunnerInstrumentedTest.kt scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/test/unit/gh-383-launch-plumbing.test.js scripts/cdp-bridge/dist
git commit -S -m "feat(runners): /health protocolVersion+runnerVersion+capabilities, v stamp on every response (#383)"
```

---

### Task 6: iOS protocol gate — detailed liveness classifier + `RUNNER_PROTOCOL_MISMATCH` + `meta.note`

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (`ToolErrorCode` += `'RUNNER_PROTOCOL_MISMATCH'`)
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:398-533` (probe), `:629-657` (postCommand v-check), `:684+` (runIOS wrap)
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts:606-658` (`ensureRunnerForCommand`), `:726-738` (runNative iOS branch)
- Modify: `scripts/cdp-bridge/test/unit/fast-runner-liveness.test.js`, `scripts/cdp-bridge/test/unit/audit-m3-ensure-fast-runner-liveness.test.js`, `scripts/cdp-bridge/test/unit/gh-210-ios-autospawn.test.js` (fixtures: alive now requires `protocolVersion`; `ensureRunnerForCommand` deps.probe returns detail objects)
- Test: `scripts/cdp-bridge/test/unit/gh-383-ios-protocol-gate.test.js`

**Interfaces:**
- Consumes: Task 1 `classifyRunnerCompatibility`/`getPluginVersion`; Task 3 `adoptPersistedFastRunnerState`.
- Produces:
  - `HttpProbeResult` += `protocolVersion?: number; runnerVersion?: string`.
  - `type FastRunnerStaleReason = 'health' | RunnerIncompatibilityReason`.
  - `interface FastRunnerLivenessDetail { liveness: FastRunnerLiveness; staleReason?: FastRunnerStaleReason; runnerProtocolVersion?: number; runnerVersion?: string }`.
  - `probeFastRunnerLivenessDetailed(deps?: LivenessProbeDeps): Promise<FastRunnerLivenessDetail>` (`LivenessProbeDeps` += `pluginVersion?: string | null`).
  - `probeFastRunnerLiveness` keeps its exact signature (thin wrapper) — `ensureFastRunner`, `device-session-health`, and old tests keep working.
  - `ensureRunnerForCommand` returns `{ ok: true; note?: string } | { ok: false; message: string; code?: ToolErrorCode }`; `EnsureRunnerDeps.probe` becomes `() => Promise<FastRunnerLivenessDetail>`; new `EnsureRunnerDeps.adopt?: (deviceId: string | undefined) => void`.
  - `attachMetaNote(result: ToolResult, note: string): ToolResult` (agent-device-wrapper, exported for tests).

- [ ] **Step 1: Write the failing test**

`scripts/cdp-bridge/test/unit/gh-383-ios-protocol-gate.test.js`:

```js
// GH #383: classifier matrix — a reachable runner with a missing/older/newer
// protocol or a skewed runnerVersion is 'stale' (reap-and-restart path);
// post-reinstall mismatch surfaces RUNNER_PROTOCOL_MISMATCH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeFastRunnerLivenessDetailed } from '../../dist/runners/rn-fast-runner-client.js';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.58.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});

test('gh-383 gate: healthy + matching protocol + version → alive', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 1, runnerVersion: '0.58.0' }),
  );
  assert.deepEqual(d, {
    liveness: 'alive',
    runnerProtocolVersion: 1,
    runnerVersion: '0.58.0',
  });
});

test('gh-383 gate: healthy but NO protocolVersion (legacy runner) → stale/legacy', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true }),
  );
  assert.equal(d.liveness, 'stale');
  assert.equal(d.staleReason, 'legacy');
});

test('gh-383 gate: newer protocol → stale/protocol-newer; version skew → stale/version-skew', async () => {
  const newer = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 99 }),
  );
  assert.equal(newer.staleReason, 'protocol-newer');
  const skew = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 1, runnerVersion: '0.0.1' }),
  );
  assert.equal(skew.staleReason, 'version-skew');
});

test('gh-383 gate: version check is fail-open when plugin version unknown', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ok: true, status: 200, bodyOk: true, protocolVersion: 1, runnerVersion: '0.0.1' }, null),
  );
  assert.equal(d.liveness, 'alive');
});

test('gh-383 gate: health failure stays stale/health', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ok: false, status: 500 }),
  );
  assert.deepEqual(d, { liveness: 'stale', staleReason: 'health' });
});

test('gh-383 ensure: transparent upgrade returns ok + note', async () => {
  const probes = [
    { liveness: 'stale', staleReason: 'legacy' },
    { liveness: 'alive' },
  ];
  let ensured = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(ensured, 1);
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (protocol/version mismatch)' });
});

test('gh-383 ensure: mismatch surviving reinstall → RUNNER_PROTOCOL_MISMATCH', async () => {
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => ({ liveness: 'stale', staleReason: 'protocol-older' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_PROTOCOL_MISMATCH');
  assert.match(res.message, /build-for-testing|rebuild/i);
});

test('gh-383 ensure: plain spawn failure keeps the existing untyped message', async () => {
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    probe: async () => ({ liveness: 'stale', staleReason: 'health' }),
    ensure: async () => {},
    prebuilt: () => true,
    adopt: () => {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-ios-protocol-gate.test.js`
Expected: FAIL — `probeFastRunnerLivenessDetailed` not exported.

- [ ] **Step 3: Implement the detailed probe in `rn-fast-runner-client.ts`**

1. `ToolErrorCode` in `types.ts` gains (after the `RUNNER_DISABLED` entry):

```ts
  // GH #383: runner speaks an incompatible wire protocol even after the
  // reap-and-reinstall path ran — stale prebuilt artifacts need a rebuild.
  | 'RUNNER_PROTOCOL_MISMATCH'
```

2. `HttpProbeResult` and deps:

```ts
export interface HttpProbeResult {
  ok: boolean;
  status: number;
  bodyOk?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
}
```

`LivenessProbeDeps` gains `/** GH #383: injected plugin version for hermetic tests; undefined → getPluginVersion(). */ pluginVersion?: string | null;`

3. `defaultHttpProbe` body-parse block becomes:

```ts
let bodyOk: boolean | undefined;
let protocolVersion: number | undefined;
let runnerVersion: string | undefined;
try {
  const body = (await res.json()) as {
    ok?: boolean;
    protocolVersion?: number;
    runnerVersion?: string;
  };
  bodyOk = body.ok === true;
  if (typeof body.protocolVersion === 'number') protocolVersion = body.protocolVersion;
  if (typeof body.runnerVersion === 'string') runnerVersion = body.runnerVersion;
} catch {
  bodyOk = false;
}
return {
  ok: true,
  status: res.status,
  bodyOk,
  ...(protocolVersion !== undefined ? { protocolVersion } : {}),
  ...(runnerVersion !== undefined ? { runnerVersion } : {}),
};
```

4. Replace `probeFastRunnerLiveness` with the detailed variant + thin wrapper:

```ts
export type FastRunnerStaleReason = 'health' | RunnerIncompatibilityReason;

export interface FastRunnerLivenessDetail {
  liveness: FastRunnerLiveness;
  staleReason?: FastRunnerStaleReason;
  runnerProtocolVersion?: number;
  runnerVersion?: string;
}

export async function probeFastRunnerLivenessDetailed(
  deps: LivenessProbeDeps = {},
): Promise<FastRunnerLivenessDetail> {
  const getState = deps.getState ?? (() => runnerState);
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const httpProbe = deps.httpProbe ?? defaultHttpProbe;
  const clearState = deps.clearState ?? clearStateFile;
  const timeoutMs = deps.timeoutMs ?? 2000;

  const state = getState();
  if (!state) return { liveness: 'dead' };

  if (!processAlive(state.pid)) {
    clearState();
    return { liveness: 'dead' };
  }

  try {
    const res = await httpProbe(state.port, timeoutMs);
    if (!(res.ok && res.status === 200 && res.bodyOk === true)) {
      return { liveness: 'stale', staleReason: 'health' };
    }
    const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
    const compat = classifyRunnerCompatibility(
      {
        ...(res.protocolVersion !== undefined ? { protocolVersion: res.protocolVersion } : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      },
      plugin,
    );
    if (!compat.compatible) {
      return {
        liveness: 'stale',
        staleReason: compat.reason,
        ...(res.protocolVersion !== undefined
          ? { runnerProtocolVersion: res.protocolVersion }
          : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      };
    }
    return {
      liveness: 'alive',
      ...(res.protocolVersion !== undefined
        ? { runnerProtocolVersion: res.protocolVersion }
        : {}),
      ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
    };
  } catch {
    return { liveness: 'stale', staleReason: 'health' };
  }
}

export async function probeFastRunnerLiveness(
  deps: LivenessProbeDeps = {},
): Promise<FastRunnerLiveness> {
  return (await probeFastRunnerLivenessDetailed(deps)).liveness;
}
```

Add `import { classifyRunnerCompatibility } from './protocol.js';` and `import type { RunnerIncompatibilityReason } from './protocol.js';` (merge with the Task 3/5 imports).

5. `postCommand` defense-in-depth: `RunnerResponse` gains `v?: number`; after `resp.json()` resolves (assign to a local `parsed` before returning):

```ts
if (typeof parsed.v === 'number' && parsed.v !== RUNNER_PROTOCOL_VERSION) {
  throw new Error(
    `RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge expects v${RUNNER_PROTOCOL_VERSION}`,
  );
}
```

In `runIOS`, wrap the `postCommand` call so this specific throw becomes a typed failure:

```ts
let resp: RunnerResponse;
try {
  resp = await postCommand(
    withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
  );
} catch (err) {
  const m = err instanceof Error ? err.message : String(err);
  if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
    return failResult(m, 'RUNNER_PROTOCOL_MISMATCH');
  }
  throw err;
}
```

- [ ] **Step 4: Rework `ensureRunnerForCommand` + runNative note in `agent-device-wrapper.ts`**

```ts
export interface EnsureRunnerDeps {
  probe?: () => Promise<FastRunnerLivenessDetail>;
  ensure?: (deviceId: string, bundleId: string) => Promise<void>;
  prebuilt?: () => boolean;
  adopt?: (deviceId: string | undefined) => void;
}

export type EnsureRunnerResult =
  | { ok: true; note?: string }
  | { ok: false; message: string; code?: ToolErrorCode };

const PROTOCOL_STALE_REASONS = new Set([
  'legacy',
  'protocol-older',
  'protocol-newer',
  'version-skew',
]);

export async function ensureRunnerForCommand(
  deviceId: string | null,
  bundleId: string,
  deps: EnsureRunnerDeps = {},
): Promise<EnsureRunnerResult> {
  const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
  const ensure = deps.ensure ?? ensureFastRunner;
  const prebuilt = deps.prebuilt ?? (() => hasBuiltTestProduct(derivedDataPathForRunner()));
  const adopt = deps.adopt ?? adoptPersistedFastRunnerState;

  adopt(deviceId ?? undefined);
  const first = await probe();
  const decision = decideRunnerSpawn({ liveness: first.liveness, prebuilt: prebuilt(), deviceId });
  if (decision.action === 'proceed') return { ok: true };
  if (decision.action === 'error') return { ok: false, message: decision.message };

  await ensure(decision.deviceId, bundleId);
  const after = await probe();
  if (after.liveness === 'alive') {
    if (first.staleReason && PROTOCOL_STALE_REASONS.has(first.staleReason)) {
      return { ok: true, note: 'runner upgraded (protocol/version mismatch)' };
    }
    return { ok: true };
  }
  if (after.staleReason && PROTOCOL_STALE_REASONS.has(after.staleReason)) {
    return {
      ok: false,
      code: 'RUNNER_PROTOCOL_MISMATCH',
      message:
        `rn-fast-runner still speaks an incompatible wire protocol after reinstall ` +
        `(runner protocol ${after.runnerProtocolVersion ?? 'none'}, runnerVersion ${after.runnerVersion ?? 'unknown'}). ` +
        `The prebuilt XCUITest artifact is stale — rebuild it: delete scripts/rn-fast-runner/build/DerivedData ` +
        `and re-open the device session (cold build), or run xcodebuild build-for-testing (see plugin Prerequisites).`,
    };
  }
  return {
    ok: false,
    message:
      'rn-fast-runner did not become ready after auto-spawn. Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
  };
}
```

Imports: swap `probeFastRunnerLiveness` for `probeFastRunnerLivenessDetailed, adoptPersistedFastRunnerState` and `import type { FastRunnerLivenessDetail }`; add `import type { ToolErrorCode } from './types.js';`.

Add the note helper (near `runNative`), exported for tests:

```ts
// GH #383: tool results are MCP envelopes (JSON text in content[0]) — attach
// a meta.note by re-encoding, defensively.
export function attachMetaNote(result: ToolResult, note: string): ToolResult {
  try {
    const first = result.content?.[0];
    if (!first || first.type !== 'text') return result;
    const envelope = JSON.parse(first.text) as { meta?: Record<string, unknown> };
    envelope.meta = { ...(envelope.meta ?? {}), note };
    return {
      ...result,
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }, ...result.content.slice(1)],
    };
  } catch {
    return result;
  }
}
```

runNative iOS branch (lines 726-738):

```ts
let upgradeNote: string | undefined;
if (cliArgs[0] !== 'screenshot') {
  const deviceId = activeSession?.deviceId ?? (await resolveBootedIosUdid());
  const ready = await ensureRunnerForCommand(deviceId ?? null, appId ?? '');
  if (!ready.ok) return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN');
  upgradeNote = ready.note;
}
const { runIOS } = await import('./runners/rn-fast-runner-client.js');
const ios = buildRunIOSArgs(cliArgs, appId);
const result = await runIOS(ios);
return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
```

- [ ] **Step 5: Update existing fixtures**

- `fast-runner-liveness.test.js`: every alive-path `httpProbe` fixture (`{ok:true, status:200, bodyOk:true}`) gains `protocolVersion: 1` (import nothing — literal `1` matches `RUNNER_PROTOCOL_VERSION` and the tri-file test guards drift) and the probe deps gain `pluginVersion: null` where no version assertion is intended.
- `audit-m3-ensure-fast-runner-liveness.test.js` + `gh-210-ios-autospawn.test.js`: any injected `probe: async () => 'alive'` (string) becomes `probe: async () => ({ liveness: 'alive' })` (and `'stale'`/`'dead'` likewise); injected `ensureRunnerForCommand` deps gain `adopt: () => {}` so tests never touch the real state dir.

- [ ] **Step 6: Run full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/gh-383-ios-protocol-gate.test.js scripts/cdp-bridge/test/unit/fast-runner-liveness.test.js scripts/cdp-bridge/test/unit/audit-m3-ensure-fast-runner-liveness.test.js scripts/cdp-bridge/test/unit/gh-210-ios-autospawn.test.js scripts/cdp-bridge/dist
git commit -S -m "feat(ios-gate): protocol/version-aware liveness -> stale -> reap; RUNNER_PROTOCOL_MISMATCH after failed reinstall (#383)"
```

---

### Task 7: Android protocol gate — reuse-time verify, forced reinstall, post-start verify

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (`startAndroidRunner` reuse branch + post-health verify; `ensureAndroidRunnerInstalled(deviceId, opts?)`; new `probeAndroidRunnerHealthInfo`, `consumePendingAndroidUpgradeNote`; `runAndroid` error mapping)
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts` (runNative Android branch: attach pending note)
- Modify: `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js`, `scripts/cdp-bridge/test/unit/android-runner-short-circuit.test.js`, `scripts/cdp-bridge/test/unit/android-shortcircuit-ensure.test.js`, `scripts/cdp-bridge/test/unit/runners/rn-android-runner-client.test.js` (health fixtures gain `protocolVersion: 1`; the last file also needs its catch-all fetch mock branched on `/health` vs `/command` — review amendment)
- Test: `scripts/cdp-bridge/test/unit/gh-383-android-protocol-gate.test.js`

**Interfaces:**
- Consumes: Task 1 (`classifyRunnerCompatibility`, `getPluginVersion`, `RUNNER_PROTOCOL_VERSION`), Task 4 (`adoptPersistedAndroidState`, `clearAndroidStateFile`), Task 6 (`attachMetaNote`, `'RUNNER_PROTOCOL_MISMATCH'`).
- Produces: `probeAndroidRunnerHealthInfo(port: number): Promise<{ reachable: boolean; ok?: boolean; protocolVersion?: number; runnerVersion?: string }>`, `consumePendingAndroidUpgradeNote(): string | undefined`.

- [ ] **Step 1: Write the failing test**

`scripts/cdp-bridge/test/unit/gh-383-android-protocol-gate.test.js`:

```js
// GH #383: Android reuse gate — a reachable runner with an incompatible
// protocol is reaped (force-stop + state clear) and restarted; a fresh start
// that still reports a mismatch rejects with RUNNER_PROTOCOL_MISMATCH.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  consumePendingAndroidUpgradeNote,
  _setFetchForTest,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';

afterEach(() => {
  _setAndroidRunnerStateForTest(null);
  _setFetchForTest(globalThis.fetch);
  consumePendingAndroidUpgradeNote();
});

function fakeHealth(body) {
  _setFetchForTest(async () => ({
    ok: true,
    json: async () => body,
  }));
}

test('gh-383 android probe: parses protocol fields from /health', async () => {
  fakeHealth({ ok: true, protocolVersion: 1, runnerVersion: '0.58.0' });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, {
    reachable: true,
    ok: true,
    protocolVersion: 1,
    runnerVersion: '0.58.0',
  });
});

test('gh-383 android probe: legacy health has no protocol fields', async () => {
  fakeHealth({ ok: true });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, { reachable: true, ok: true });
});

test('gh-383 android probe: unreachable → reachable:false', async () => {
  _setFetchForTest(async () => {
    throw new Error('ECONNREFUSED');
  });
  const info = await probeAndroidRunnerHealthInfo(22089);
  assert.deepEqual(info, { reachable: false });
});

test('gh-383 android note: consume returns the note exactly once', () => {
  assert.equal(consumePendingAndroidUpgradeNote(), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-383-android-protocol-gate.test.js`
Expected: FAIL — `probeAndroidRunnerHealthInfo` not exported.

- [ ] **Step 3: Implement in `rn-android-runner-client.ts`**

1. Health-info probe + note plumbing:

```ts
export interface AndroidHealthInfo {
  reachable: boolean;
  ok?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
}

export async function probeAndroidRunnerHealthInfo(port: number): Promise<AndroidHealthInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!resp.ok) return { reachable: false };
    const body = (await resp.json()) as {
      ok?: boolean;
      protocolVersion?: number;
      runnerVersion?: string;
    };
    return {
      reachable: true,
      ok: body.ok === true,
      ...(typeof body.protocolVersion === 'number'
        ? { protocolVersion: body.protocolVersion }
        : {}),
      ...(typeof body.runnerVersion === 'string' ? { runnerVersion: body.runnerVersion } : {}),
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

// GH #383: set when a mismatched runner was transparently reaped; consumed by
// runNative so the triggering tool result carries meta.note. MUST be cleared
// on the mismatch-reject path too (review amendment) or a later successful
// call would attach a stale "runner upgraded" note.
let pendingUpgradeNote: string | undefined;

export function consumePendingAndroidUpgradeNote(): string | undefined {
  const note = pendingUpgradeNote;
  pendingUpgradeNote = undefined;
  return note;
}

// Review amendment (BLOCKER): a single `am force-stop` of the app package does
// NOT reliably free the device-side UiAutomation slot (#237 — system_server
// keeps it; see release-android-slot.ts:115-128). Reuse the battle-tested
// helper, which stops our runner then force-stops BOTH owned packages.
// Dynamic import because release-android-slot.ts statically imports this
// module — a static back-import would be a cycle.
async function reapMismatchedAndroidRunner(deviceId?: string): Promise<void> {
  const { releaseAndroidInteractionSlot } = await import('./release-android-slot.js');
  await releaseAndroidInteractionSlot({ ...(deviceId ? { deviceId } : {}) });
}
```

2. `ensureAndroidRunnerInstalled` gains a force flag — signature `async function ensureAndroidRunnerInstalled(deviceId?: string, opts: { forceReinstall?: boolean } = {}): Promise<void>` and the action resolution becomes:

```ts
const action = resolveAndroidInstallAction({
  instrumentationRegistered:
    !opts.forceReinstall && isInstrumentationRegistered(pmOut, INSTRUMENTATION),
  apksExist: existsSync(APK_APP) && existsSync(APK_TEST),
});
```

3. `startAndroidRunner` reuse branch becomes (note the serial-first head from Task 4):

```ts
export async function startAndroidRunner(
  deviceId?: string,
  bundleId?: string,
  devicePort = DEFAULT_PORT,
): Promise<AndroidRunnerState> {
  const serial = deviceId ?? (await resolveAndroidSerial());
  adoptPersistedAndroidState(serial);
  let forceReinstall = false;
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId)) {
    const info = await probeAndroidRunnerHealthInfo(runnerState!.hostPort);
    if (info.reachable && info.ok) {
      const compat = classifyRunnerCompatibility(
        {
          ...(info.protocolVersion !== undefined
            ? { protocolVersion: info.protocolVersion }
            : {}),
          ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
        },
        getPluginVersion(),
      );
      if (compat.compatible) return runnerState!;
      pendingUpgradeNote = 'runner upgraded (protocol/version mismatch)';
      forceReinstall = true;
      await reapMismatchedAndroidRunner(deviceId);
    }
    // unreachable/unhealthy: fall through — the fresh start below supersedes it.
  }

  await ensureAndroidRunnerInstalled(deviceId, { forceReinstall });
  // ... rest unchanged ...
```

4. Post-start protocol verify — the readiness `.then` becomes:

```ts
void waitForAndroidRunnerHealth(hostPort).then(async (healthy) => {
  if (resolved) return;
  if (healthy) {
    const info = await probeAndroidRunnerHealthInfo(hostPort);
    const compat = classifyRunnerCompatibility(
      {
        ...(info.protocolVersion !== undefined
          ? { protocolVersion: info.protocolVersion }
          : {}),
        ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
      },
      getPluginVersion(),
    );
    if (!compat.compatible) {
      resolved = true;
      pendingUpgradeNote = undefined; // review amendment: never report an upgrade that failed
      child.kill('SIGTERM');
      reject(
        new Error(
          `RUNNER_PROTOCOL_MISMATCH: installed rn-android-runner speaks protocol ` +
            `${info.protocolVersion ?? 'none'} (bridge expects ${RUNNER_PROTOCOL_VERSION}). ` +
            `Rebuild + reinstall the runner APKs: cd ${RN_ANDROID_RUNNER_DIR} && ` +
            `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest, then adb install -r both APKs.`,
        ),
      );
      return;
    }
    finishReady();
    return;
  }
  // ... existing timeout rejection unchanged ...
});
```

5. `runAndroid` catch block — before the connection-failure mapping:

```ts
if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
  return failResult(m, 'RUNNER_PROTOCOL_MISMATCH', {
    hint: 'The installed runner APK predates this plugin version. Rebuild + reinstall (command in the error), then retry.',
  });
}
```

Also mirror the iOS postCommand v-check: `RunnerResponse` gains `v?: number` and `postCommand` throws `RUNNER_PROTOCOL_MISMATCH: ...` on a non-matching stamp (the catch above maps it).

6. `agent-device-wrapper.ts` runNative Android branch — the current tail (lines 805-807) is:

```ts
const { runAndroid } = await import('./runners/rn-android-runner-client.js');
const android = buildRunAndroidArgs(cliArgs, appId);
return runAndroid({ ...android, deviceId: activeSession?.deviceId });
```

It becomes:

```ts
const { runAndroid, consumePendingAndroidUpgradeNote } = await import(
  './runners/rn-android-runner-client.js'
);
const android = buildRunAndroidArgs(cliArgs, appId);
const result = await runAndroid({ ...android, deviceId: activeSession?.deviceId });
const note = consumePendingAndroidUpgradeNote();
return note ? attachMetaNote(result, note) : result;
```

Also map the mismatch throw in the `startAndroidRunner` pre-flight (lines 796-803): before wrapping the error as `RN_ANDROID_RUNNER_DOWN`, check `err.message.startsWith('RUNNER_PROTOCOL_MISMATCH')` and return `failResult(err.message, 'RUNNER_PROTOCOL_MISMATCH')` instead.

- [ ] **Step 4: Update existing fixtures**

`gh-243-android-runner-health.test.js`, `android-runner-short-circuit.test.js`, `android-shortcircuit-ensure.test.js`: every fake `/health` body `{ok: true}` used on a startup/reuse path gains `protocolVersion: 1` so the new post-start verify passes. Where a test intends a LEGACY runner, leave the body as `{ok: true}` and assert the new mismatch behavior instead.

**Review amendment — also `test/unit/runners/rn-android-runner-client.test.js`:** it injects a live-pid in-memory state (`pid: process.pid`) plus a catch-all `_setFetchForTest` mock whose body has no `protocolVersion`, so the new reuse-time gate would classify it legacy and try to REAP (adb force-stop) inside a unit test. Branch the mock on the URL: `GET /health` → `{ok: true, protocolVersion: 1}`; `POST /command` → the existing command body.

- [ ] **Step 5: Run full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/gh-383-android-protocol-gate.test.js scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js scripts/cdp-bridge/test/unit/android-runner-short-circuit.test.js scripts/cdp-bridge/test/unit/android-shortcircuit-ensure.test.js scripts/cdp-bridge/test/unit/runners/rn-android-runner-client.test.js scripts/cdp-bridge/dist
git commit -S -m "feat(android-gate): protocol verify on reuse + post-start; forced reinstall on mismatch (#383)"
```

---

### Task 8: Surfacing (`cdp_status` + doctor), docs, changeset

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-session-health.ts` (add `runnerProtocol` block)
- Modify: `scripts/cdp-bridge/test/unit/gh-210-device-session-health.test.js` (probe deps now detailed; new assertion)
- Modify: `commands/doctor.md` (one sentence: RUNNER_PROTOCOL_MISMATCH → stale artifacts, rebuild commands)
- Modify: `CLAUDE.md` (Troubleshooting bullet for `RUNNER_PROTOCOL_MISMATCH`)
- Create: `.changeset/383-runner-protocol-versioning.md`

**Interfaces:**
- Consumes: Task 6 `probeFastRunnerLivenessDetailed` + `adoptPersistedFastRunnerState`, Task 1 constants.
- Produces: `DeviceSessionHealth` += `runnerProtocol?: { expected: number; runner?: number; runnerVersion?: string; pluginVersion?: string; compatible: boolean }`.

- [ ] **Step 1: Write the failing test** (extend `gh-210-device-session-health.test.js`)

```js
test('gh-383: iOS session health reports runnerProtocol from the detailed probe', async () => {
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      name: 's',
      platform: 'ios',
      deviceId: 'U1',
      appId: 'com.example',
      openedAt: 'now',
    }),
    probeLiveness: async () => ({
      liveness: 'stale',
      staleReason: 'version-skew',
      runnerProtocolVersion: 1,
      runnerVersion: '0.57.1',
    }),
    adopt: () => {},
  });
  assert.equal(health.rnFastRunner, 'stale');
  assert.deepEqual(health.runnerProtocol, {
    expected: 1,
    runner: 1,
    runnerVersion: '0.57.1',
    compatible: false,
  });
});
```

(Also update this file's existing fixtures: `probeLiveness: async () => 'alive'` → `async () => ({ liveness: 'alive' })`, and inject `adopt: () => {}` everywhere.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-210-device-session-health.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement `device-session-health.ts`**

```ts
import type {
  FastRunnerLiveness,
  FastRunnerLivenessDetail,
} from '../runners/rn-fast-runner-client.js';
import type { SessionState } from '../types.js';
import { getActiveSession as defaultGetActiveSession } from '../agent-device-wrapper.js';
import {
  probeFastRunnerLivenessDetailed,
  adoptPersistedFastRunnerState,
} from '../runners/rn-fast-runner-client.js';
import { RUNNER_PROTOCOL_VERSION, getPluginVersion } from '../runners/protocol.js';

export interface DeviceSessionHealth {
  sessionOpen: boolean;
  rnFastRunner: FastRunnerLiveness;
  appId?: string;
  deviceId?: string;
  foreignRunner?: { detected: true };
  runnerProtocol?: {
    expected: number;
    runner?: number;
    runnerVersion?: string;
    pluginVersion?: string;
    compatible: boolean;
  };
}

export interface DeviceSessionHealthDeps {
  getActiveSession?: () => SessionState | null;
  probeLiveness?: () => Promise<FastRunnerLivenessDetail>;
  detectForeign?: (udid?: string) => Promise<{ detected: true } | null>;
  adopt?: (deviceId: string | undefined) => void;
}
```

and in the iOS branch:

```ts
if (session.platform === 'ios') {
  const adopt = deps.adopt ?? adoptPersistedFastRunnerState;
  adopt(session.deviceId);
  try {
    const detail = await probe();
    health.rnFastRunner = detail.liveness;
    if (detail.liveness !== 'dead') {
      const plugin = getPluginVersion();
      health.runnerProtocol = {
        expected: RUNNER_PROTOCOL_VERSION,
        ...(detail.runnerProtocolVersion !== undefined
          ? { runner: detail.runnerProtocolVersion }
          : {}),
        ...(detail.runnerVersion !== undefined ? { runnerVersion: detail.runnerVersion } : {}),
        ...(plugin !== null ? { pluginVersion: plugin } : {}),
        compatible: detail.liveness === 'alive',
      };
    }
  } catch {
    health.rnFastRunner = 'dead';
  }
  // ... foreign detection unchanged ...
}
```

(`const probe = deps.probeLiveness ?? probeFastRunnerLivenessDetailed;` replaces the old default.)

- [ ] **Step 4: Docs**

`commands/doctor.md` — append to the runner paragraph (line 9): `If a device tool fails with RUNNER_PROTOCOL_MISMATCH, the installed/prebuilt runner artifact predates the plugin's wire protocol: on iOS delete scripts/rn-fast-runner/build/DerivedData and re-open the device session (or re-run xcodebuild build-for-testing); on Android re-run ./gradlew :app:assembleDebug :app:assembleDebugAndroidTest and adb install -r both APKs.`

`CLAUDE.md` Troubleshooting — add bullet:

```md
- **`RUNNER_PROTOCOL_MISMATCH` on device_* tools** → The bridge and the native runner disagree on the /command wire protocol (#383) even after the automatic reap+reinstall. The prebuilt runner artifact is stale: iOS — delete `scripts/rn-fast-runner/build/DerivedData` and re-open the device session (cold rebuild); Android — rebuild + reinstall the runner APKs (`./gradlew :app:assembleDebug :app:assembleDebugAndroidTest`). Normal upgrades never hit this: an old-but-rebuildable runner is transparently restarted (the first device tool call after a plugin upgrade pays one runner restart, `meta.note: "runner upgraded (protocol/version mismatch)"`).
```

- [ ] **Step 5: Changeset**

`.changeset/383-runner-protocol-versioning.md`:

```md
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

feat(protocol): version the native runner /command wire protocol + move runner state out of /tmp (#383). Both runners' `GET /health` now reports `{protocolVersion, runnerVersion, capabilities}` and every response carries a `"v"` stamp; the bridge classifies a reachable runner with a missing/older/newer protocol or a skewed `runnerVersion` as stale and transparently reaps + reinstalls it (the first device tool call after upgrading from a pre-protocol plugin pays one runner restart — `meta.note: "runner upgraded (protocol/version mismatch)"`). Only a mismatch that survives reinstall surfaces the new typed error `RUNNER_PROTOCOL_MISMATCH` with exact rebuild commands. Runner state files move from fixed shared `/tmp` paths to per-device hardened files (0600, symlink-refusing, atomic) under the app-support state dir (`runner-state/ios-<udid>.json`, `android-<serial>.json`; Android persists only under a resolved serial) via a shared `util/secure-state-file.ts` also adopted by the session file; a live pre-upgrade runner pointed at by the legacy `/tmp` state is adopted once, reaped, and relaunched before the `/tmp` files are deleted, and a grep-enforced test keeps `/tmp` out of the runner clients. `cdp_status` → `deviceSession.runnerProtocol` surfaces the handshake.
```

- [ ] **Step 6: Run the FULL suite one last time**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS (entire suite).

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-session-health.ts scripts/cdp-bridge/test/unit/gh-210-device-session-health.test.js commands/doctor.md CLAUDE.md .changeset/383-runner-protocol-versioning.md scripts/cdp-bridge/dist
git commit -S -m "feat(surface): deviceSession.runnerProtocol in cdp_status; doctor + docs + changeset (#383)"
```

---

## Device verification (after all tasks — repo workflow step 5)

On the booted iOS simulator + Android emulator with the workspace test-app (`cd ../rn-dev-agent-workspace/test-app && npx expo start`):

1. **Transparent upgrade (the acceptance criterion):** with a runner started by the PRE-change dist still running (start one before checking out the branch, or launch the released plugin's runner), run a `device_find` — expect success, one visible runner restart, and `meta.note: "runner upgraded (protocol/version mismatch)"` in the result.
2. `curl http://127.0.0.1:22088/health` (iOS) and the forwarded Android port — expect `{"ok":true,"v":1,"protocolVersion":1,"runnerVersion":"<version>","capabilities":[]}`.
3. `cdp_status` → `deviceSession.runnerProtocol.compatible === true`.
4. `ls -l ~/Library/Application\ Support/rn-dev-agent/runner-state/` — per-device files, mode `-rw-------`; `ls /tmp/rn-*-runner-state.json` — gone.
5. Second `device_find` — no restart (warm reuse still works), `meta.timings_ms` comparable to pre-change.

## Acceptance-criteria map

| Spec criterion | Where |
|---|---|
| vN+1 bridge vs vN runner → transparent reap+reinstall + `meta.note` | Tasks 6/7 + legacy `/tmp` adoption (Tasks 3/4, review amendment) + device verification step 1 |
| No `/tmp` read/write in either runner client (grep-enforced) | Task 4 `gh-383-no-tmp-state.test.js` (legacy paths live only in the util, read-once + delete) |
| Two projects / two devices never share a state file | Tasks 3/4 per-device keying; Android persists only under a resolved serial (review amendment) |
| Legacy `/tmp` files adopted once → reaped → deleted after relaunch (dead ⇒ deleted immediately) | Task 2 `readLegacyTmpState`/`cleanupLegacyTmpState` + Tasks 3/4 adoption |
| Tri-file constant-sync test | Task 1 |
| Classifier matrix (missing/older/equal/newer × health) | Tasks 1/6 tests |
| Symlink refusal + 0600 | Task 2 tests |
| `RUNNER_PROTOCOL_MISMATCH` in `ToolErrorCode` + doctor surfacing | Tasks 6/8 |
