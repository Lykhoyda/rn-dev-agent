# Story 04 — Shared Two-Tier Settle Engine + Runner Capability Flags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**GitHub issue:** #385 · **Spec:** `docs/stories/04-settle-engine.md` (committed, PR #381)

**Goal:** Replace fixed post-action sleeps with one capability-switched `waitForSettle` invariant ("the UI is stable"), applied after every mutating `device_*` verb on both platforms, from one implementation.

**Architecture:** Two new runner probe verbs — iOS `isScreenStatic` (two screenshots ~100 ms apart, on-runner SHA-256 compare) and Android `isWindowUpdating` (`uiDevice.waitForWindowUpdate` wrapper) — advertised via `/health.capabilities` as `SCREEN_STATIC` / `WINDOW_UPDATE`. A new bridge module `lifecycle/settle.ts` runs the tiered settle loop (Android: window-gate → snapshot-hash polling; iOS: screen-static poll → snapshot-hash polling), wired into `runNative()` at the single dispatch choke point after every mutating verb. Settle snapshots reuse the normal snapshot path, so each settle also refreshes the ref-map for free (feeds Story 05).

**Tech Stack:** TypeScript (Node ≥ 22, `node:test` against compiled `dist/`), Swift (XCTest runner, iOS 15.6 target, CryptoKit), Kotlin (UIAutomator2 runner, NanoHTTPD).

## Global Constraints

- **Capability strings:** `SCREEN_STATIC` (iOS), `WINDOW_UPDATE` (Android). Wire verbs: `isScreenStatic`, `isWindowUpdating`.
- **Do NOT add the new verbs to `REQUIRED_IOS_COMMANDS` / `REQUIRED_ANDROID_COMMANDS`** (`scripts/cdp-bridge/src/runners/protocol.ts:29-51`). Doing so would make the #418 gate classify every existing runner artifact `missing-commands` and force a cold rebuild on user machines. Legacy runners must degrade to snapshot-polling.
- **No `RunnerProtocol` version bump** — additive command, not a wire-shape change (all three files stay `version = 1`).
- Env opt-out: `RN_SETTLE=0` (or `false`, case-insensitive) disables settle globally. Default is ON.
- Settle is **advisory**: it may return `settled: false, method: 'timeout'` but must NEVER turn a succeeded action into an error, and a probe/transport failure must never throw out of `runNative`.
- Settle budget defaults: total 6000 ms; iOS screen-static tier cap 3000 ms (Maestro's `SCREEN_SETTLE_TIMEOUT_MS`); snapshot-eq tier ≤ 10 iterations × 200 ms; Android window-gate probe 100 ms + 50 ms post-sleep (spec acceptance: ≤ 150 ms static-screen overhead on Android, ≤ ~250 ms on iOS).
- Every settle result surfaces `meta.settle: { method, settled }` and `meta.timings_ms.settle` (repo convention: per-step timings in `meta.timings_ms`).
- TypeScript: explicit type imports (`import type { ... }`); no unnecessary comments.
- Tests: `cd scripts/cdp-bridge && npm test` (runs `tsc` build then `node --test 'test/unit/*.test.js' 'test/unit/**/*.test.js'`). Single file: `npm run build && node --test test/unit/<file>.test.js`.
- `dist/` is tracked: every commit touching `scripts/cdp-bridge/src` must include the rebuilt `scripts/cdp-bridge/dist` (`npm run build`, then `git add dist`).
- One changeset for the feature (Task 9), `'rn-dev-agent-plugin': minor`.
- Swift/Kotlin logic is CI-verified only via TS source-parsing tests (CI runs no xcodebuild test / gradle) — so each runner task starts with a failing TS source-sync test, mirroring `test/unit/gh-418-command-surface-sync.test.js`.

## File Structure

| File | Change |
|---|---|
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift` | `case isScreenStatic` in `CommandType`; `` `static` `` Bool field in `DataPayload` |
| `.../RnFastRunnerTests+CommandExecution.swift` | `case .isScreenStatic` handler (CryptoKit SHA-256 of two screenshots) |
| `.../RnFastRunnerTests+Lifecycle.swift` | register `.isScreenStatic` as lifecycle command (skip activation preamble) |
| `.../RnFastRunnerTests+Transport.swift` | append `SCREEN_STATIC` to `/health` capabilities |
| `.../CommandSurfaceTests.swift` | pin `isScreenStatic` in the Swift-side required set |
| `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt` | `isWindowUpdating` in `SUPPORTED_COMMANDS` + `when` branch |
| `.../CommandServer.kt` | `WINDOW_UPDATE` in `/health` capabilities |
| `scripts/cdp-bridge/src/lifecycle/settle-hash.ts` | NEW — snapshot-node normalization + SHA-256 |
| `scripts/cdp-bridge/src/lifecycle/settle.ts` | NEW — `waitForSettle` engine + production probe builders + `settleEnabled` |
| `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` | `isScreenStatic` in `RunIOSArgs`; capability cache + `getFastRunnerCapabilities()`; `_setFastRunnerStateForTest` seam |
| `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` | `isWindowUpdating` + `timeoutMs` in `RunAndroidArgs`/body; `capabilities` in `AndroidHealthInfo`; capability cache + `getAndroidRunnerCapabilities()` |
| `scripts/cdp-bridge/src/agent-device-wrapper.ts` | `attachMeta` generalization; `settleAfterMutation`; `runNative` opts + wiring |
| `scripts/cdp-bridge/src/tools/device-interact.ts` | fill: skip `FOCUS_DELAY_MS` sleep when settle ran; `settleTimeoutMs` threading |
| `scripts/cdp-bridge/src/tools/device-batch.ts` | per-step `settle: false` escape hatch; `delayMs` default 0 when settle enabled |
| `scripts/cdp-bridge/src/index.ts` | `settleTimeoutMs` on `device_press`/`device_fill` schemas; batch step schema |
| `scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js` | NEW — source-sync tests for both runners |
| `scripts/cdp-bridge/test/unit/settle-hash.test.js` | NEW |
| `scripts/cdp-bridge/test/unit/settle-engine.test.js` | NEW |
| `scripts/cdp-bridge/test/unit/settle-wiring.test.js` | NEW — `settleAfterMutation` + end-to-end `runNative` fake-runner test |
| `scripts/cdp-bridge/test/unit/story-04-fill-batch-settle.test.js` | NEW |
| `.changeset/story-04-settle-engine.md` | NEW (Task 9) |

Branch: `feat/385-settle-engine` off `main`.

---

### Task 1: iOS runner — `isScreenStatic` verb + `SCREEN_STATIC` capability

**Files:**
- Test: `scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js` (create)
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+CommandExecution.swift`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Lifecycle.swift`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandSurfaceTests.swift`

**Interfaces:**
- Produces (wire): `POST /command {"command":"isScreenStatic"}` → `{"ok":true,"data":{"message":"isScreenStatic","static":<bool>},"v":1}`; `GET /health` capabilities now always contain `"SCREEN_STATIC"`.
- CI can only verify Swift by source-parsing (see Global Constraints), so the failing test asserts source shape, mirroring `gh-418-command-surface-sync.test.js`.

- [ ] **Step 1: Write the failing source-sync test**

Create `scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const swiftDir = join(repoRoot, 'scripts', 'rn-fast-runner', 'RnFastRunner', 'RnFastRunnerUITests');

function swiftEnumRawValues() {
  const src = readFileSync(join(swiftDir, 'RnFastRunnerTests+Models.swift'), 'utf-8');
  const body = src.match(/enum CommandType[^{]*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const out = [];
  for (const m of body.matchAll(/case (\w+)(?:\s*=\s*"([^"]+)")?/g)) out.push(m[2] ?? m[1]);
  return out;
}

test('story-04 iOS: CommandType enumerates isScreenStatic', () => {
  assert.ok(swiftEnumRawValues().includes('isScreenStatic'));
});

test('story-04 iOS: /health capabilities construction includes SCREEN_STATIC unconditionally', () => {
  const src = readFileSync(join(swiftDir, 'RnFastRunnerTests+Transport.swift'), 'utf-8');
  // Match SCREEN_STATIC inside the capabilities: argument (bounded window so a
  // stray token elsewhere in the file can't satisfy it), without baking in one
  // expression shape — a literal array or a concatenation both pass.
  assert.match(src, /capabilities:[\s\S]{0,200}?"SCREEN_STATIC"/);
});

test('story-04 iOS: isScreenStatic is a lifecycle command (no activation preamble)', () => {
  const src = readFileSync(join(swiftDir, 'RnFastRunnerTests+Lifecycle.swift'), 'utf-8');
  const fn = src.match(/func isRunnerLifecycleCommand[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /isScreenStatic/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/story-04-runner-surfaces.test.js`
Expected: 3 FAIL (isScreenStatic not found in any file).

- [ ] **Step 3: Add the enum case and the `static` payload field**

In `RnFastRunnerTests+Models.swift`, inside `CommandType` (lines 3-29), add before the lifecycle cases:

```swift
    case isScreenStatic
```

In `DataPayload` (lines 92-157): add a stored property alongside the other optionals, and a matching init parameter (default `nil`) in the memberwise `init`. `static` is a Swift keyword, so the property is backticked; JSONEncoder emits the property name, i.e. the wire field is exactly `"static"`:

```swift
    let `static`: Bool?
```

and in the `init` signature `` `static`: Bool? = nil `` with body `` self.`static` = `static` ``.

- [ ] **Step 4: Implement the handler**

In `RnFastRunnerTests+CommandExecution.swift`: add `import CryptoKit` at the top (deployment targets iOS 15.6 / macOS 13.0 — CryptoKit needs no availability guard). Inside the big `switch command.command` (lines 175-704), next to `case .screenshot`:

```swift
    case .isScreenStatic:
#if os(macOS)
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "isScreenStatic is iOS/tvOS-only"))
#else
      let first = XCUIScreen.main.screenshot()
      sleepFor(0.1)
      let second = XCUIScreen.main.screenshot()
      guard let firstPng = runnerPngData(for: first.image),
            let secondPng = runnerPngData(for: second.image) else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "Failed to encode screenshots for isScreenStatic"))
      }
      let isStatic = SHA256.hash(data: firstPng) == SHA256.hash(data: secondPng)
      return Response(ok: true, data: DataPayload(message: "isScreenStatic", static: isStatic))
#endif
```

(`sleepFor` is the existing helper at `RnFastRunnerTests+Lifecycle.swift:222-225`; `runnerPngData(for:)` at `RnFastRunnerTests+Lifecycle.swift:6-14`. Runs on the main thread under the existing 30 s semaphore — a 100 ms sleep matches the precedent of the screenshot case's 0.5 s macOS settle.)

- [ ] **Step 5: Register as lifecycle command + advertise capability**

`RnFastRunnerTests+Lifecycle.swift` (lines 200-207) — add `.isScreenStatic` to the `isRunnerLifecycleCommand` switch alongside `.shutdown, .screenshot`. This deliberately skips the per-request activation preamble, and that is correct — document it with this code comment (the B155/D1219 "always activate" invariant applies to interaction verbs, not reads):

```swift
// isScreenStatic skips activation like .screenshot: (1) it is a pure read of
// whatever is actually on screen — if a foreign overlay/dialog is animating,
// "not settled" is the RIGHT answer, and re-activating mid-probe would fight
// legitimate transitions; (2) it only ever runs immediately after a mutating
// command that DID run the activation preamble, so the target app is
// foregrounded by construction; (3) activate() inside a 200ms poll loop would
// dominate the probe cost and perturb the very animations being measured.
```

`RnFastRunnerTests+Transport.swift` (line ~40) — the health payload currently passes `capabilities: QuiescenceStatus.current().capabilities`. Change to:

```swift
        capabilities: QuiescenceStatus.current().capabilities + ["SCREEN_STATIC"],
```

(Keeps `QuiescenceStatus` single-purpose; `SCREEN_STATIC` is unconditional. `commands` is `CommandType.allCases.map(\.rawValue)` so the new verb is auto-advertised.)

`CommandSurfaceTests.swift` (lines 8-11) — add `"isScreenStatic"` to the local required set so the Swift-side test pins it too.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && node --test test/unit/story-04-runner-surfaces.test.js`
Expected: 3 PASS. Also run `node --test test/unit/gh-418-command-surface-sync.test.js` — still PASS (required-commands are a subset check; new case is tolerated).

- [ ] **Step 7: Compile-check the Swift (local machine only, skip on CI)**

Run: `cd scripts/rn-fast-runner/RnFastRunner && xcodebuild build -project RnFastRunner.xcodeproj -scheme RnFastRunner -destination "generic/platform=iOS Simulator" -derivedDataPath /tmp/story04-swift-check 2>&1 | tail -5`
Expected: `BUILD SUCCEEDED`.

- [ ] **Step 8: Commit**

```bash
git add scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js scripts/rn-fast-runner
git commit -m "feat(rn-fast-runner): isScreenStatic probe + SCREEN_STATIC capability (#385)"
```

---

### Task 2: Android runner — `isWindowUpdating` verb + `WINDOW_UPDATE` capability

**Files:**
- Test: `scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js` (extend)
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt`
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt`

**Interfaces:**
- Produces (wire): `POST /command {"command":"isWindowUpdating","appBundleId":"<pkg>","timeoutMs":100}` → `{"ok":true,"data":{"updating":<bool>},"v":1}`. `timeoutMs` defaults to 500 in Kotlin; the bridge pre-gate passes 100 so a static screen costs ≤ 150 ms (probe + 50 ms sleep) — this reconciles the spec's `waitForWindowUpdate(appId, 500)` wrapper with its ≤ 150 ms acceptance criterion.
- `GET /health` capabilities now contain `"WINDOW_UPDATE"`.

- [ ] **Step 1: Extend the failing source-sync test**

Append to `story-04-runner-surfaces.test.js`:

```js
const kotlinDir = join(
  repoRoot, 'scripts', 'rn-android-runner', 'app', 'src', 'androidTest',
  'java', 'dev', 'lykhoyda', 'rndevagent', 'androidrunner',
);

test('story-04 Android: SUPPORTED_COMMANDS and dispatch both know isWindowUpdating', () => {
  const src = readFileSync(join(kotlinDir, 'CommandDispatcher.kt'), 'utf-8');
  const list = src.match(/val SUPPORTED_COMMANDS = listOf\(([\s\S]*?)\)/)?.[1] ?? '';
  assert.ok(list.includes('"isWindowUpdating"'), 'missing from SUPPORTED_COMMANDS');
  assert.match(src, /"isWindowUpdating"\s*->/);
  assert.match(src, /waitForWindowUpdate/);
});

test('story-04 Android: /health capabilities construction includes WINDOW_UPDATE', () => {
  const src = readFileSync(join(kotlinDir, 'CommandServer.kt'), 'utf-8');
  // Match WINDOW_UPDATE inside the capabilities put (bounded window) without
  // baking in one JSONArray construction shape.
  assert.match(src, /put\("capabilities",[\s\S]{0,200}?"WINDOW_UPDATE"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/story-04-runner-surfaces.test.js`
Expected: the 2 new Android tests FAIL, the 3 iOS tests PASS.

- [ ] **Step 3: Implement the Kotlin command**

`CommandDispatcher.kt`: add `"isWindowUpdating"` to `SUPPORTED_COMMANDS` (companion object, lines 38-47) — the existing `gh-418-command-surface-sync.test.js` asserts this list EXACTLY equals the `when`-labels, so both edits are mandatory. Add the branch next to `"back"` (line ~76):

```kotlin
            "isWindowUpdating" -> {
                val timeoutMs = cmd.optLong("timeoutMs", 500L)
                JSONObject().put("updating", device.waitForWindowUpdate(appPackage, timeoutMs))
            }
```

(`appPackage` is the nullable `appBundleId` read at line 60; `UiDevice.waitForWindowUpdate(String?, Long)` accepts null. Do NOT add `isWindowUpdating` to the foregrounding whitelist at lines 62-68 — it is a read probe and must not steal foreground. It is itself the settle primitive, so no extra sleep inside.)

`CommandServer.kt` line 21: replace the hardcoded empty capabilities array:

```kotlin
            .put("capabilities", JSONArray(listOf("WINDOW_UPDATE")))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && node --test test/unit/story-04-runner-surfaces.test.js test/unit/gh-418-command-surface-sync.test.js`
Expected: all PASS (gh-418's exact-equality check between `SUPPORTED_COMMANDS` and when-labels is satisfied because both were updated).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/test/unit/story-04-runner-surfaces.test.js scripts/rn-android-runner
git commit -m "feat(rn-android-runner): isWindowUpdating probe + WINDOW_UPDATE capability (#385)"
```

---

### Task 3: Snapshot-hash normalization (`lifecycle/settle-hash.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/settle-hash.ts`
- Test: `scripts/cdp-bridge/test/unit/settle-hash.test.js`

**Interfaces:**
- Produces: `normalizeNodeForHash(node: FlatNode): string` and `hashSnapshotNodes(nodes: FlatNode[]): string` (hex SHA-256). `FlatNode` comes from `src/fast-runner-ref-map.ts:18-26` (`{ ref, type, label?, identifier?, rect, enabled?, hittable? }`).
- Normalization tuple per node: `(identifier, type, label, rect quantized to 4 px)`. `ref` is deliberately EXCLUDED (it is a synthetic enumeration index). Quantization: `Math.round(v / 4)` per rect component — absorbs sub-pixel/jitter animation that strict equality (Maestro's choice) would treat as motion.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cdp-bridge/test/unit/settle-hash.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';

const node = (over = {}) => ({
  ref: '@e0', type: 'Button', label: 'Save', identifier: 'save-btn',
  rect: { x: 100, y: 200, width: 120, height: 44 }, ...over,
});

test('identical node lists hash identically', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node()]));
});

test('sub-4px bounds jitter does NOT change the hash', () => {
  const jittered = node({ rect: { x: 101, y: 201, width: 120, height: 44 } });
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([jittered]));
});

test('a real transition (moved element) DOES change the hash', () => {
  const moved = node({ rect: { x: 100, y: 420, width: 120, height: 44 } });
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([moved]));
});

test('label/text change registers', () => {
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ label: 'Saving…' })]));
});

test('synthetic ref churn alone does NOT change the hash', () => {
  assert.equal(hashSnapshotNodes([node()]), hashSnapshotNodes([node({ ref: '@e7' })]));
});

test('node added/removed changes the hash', () => {
  assert.notEqual(hashSnapshotNodes([node()]), hashSnapshotNodes([node(), node({ identifier: 'x' })]));
});

test('empty list hashes deterministically', () => {
  assert.equal(hashSnapshotNodes([]), hashSnapshotNodes([]));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/settle-hash.test.js`
Expected: FAIL — `Cannot find module '../../dist/lifecycle/settle-hash.js'`.

- [ ] **Step 3: Implement**

Create `scripts/cdp-bridge/src/lifecycle/settle-hash.ts`:

```ts
import { createHash } from 'node:crypto';
import type { FlatNode } from '../fast-runner-ref-map.js';

// 4px quantization absorbs sub-pixel animation jitter that strict equality
// (Maestro's hierarchy compare) would treat as motion. The synthetic @eN ref
// is excluded — it is an enumeration index, not identity.
const BOUNDS_QUANTUM_PX = 4;

export function normalizeNodeForHash(node: FlatNode): string {
  const q = (v: number): number => Math.round(v / BOUNDS_QUANTUM_PX);
  return [
    node.identifier ?? '',
    node.type,
    node.label ?? '',
    q(node.rect.x),
    q(node.rect.y),
    q(node.rect.width),
    q(node.rect.height),
  ].join('\0');
}

export function hashSnapshotNodes(nodes: FlatNode[]): string {
  const h = createHash('sha256');
  for (const node of nodes) {
    h.update(normalizeNodeForHash(node));
    h.update('\x01');
  }
  return h.digest('hex');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/settle-hash.test.js`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/settle-hash.ts scripts/cdp-bridge/test/unit/settle-hash.test.js scripts/cdp-bridge/dist
git commit -m "feat(settle): snapshot-node normalization + SHA-256 hashing (#385)"
```

---

### Task 4: `waitForSettle` engine (`lifecycle/settle.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/lifecycle/settle.ts`
- Test: `scripts/cdp-bridge/test/unit/settle-engine.test.js`

**Interfaces:**
- Produces:

```ts
export type SettleMethod = 'window-gate' | 'screen-static' | 'snapshot-eq' | 'timeout';
export interface SettleOutcome {
  settled: boolean;
  method: SettleMethod;
  ms: number;
  hierarchyChanged?: boolean; // only when initialSnapshotHash was provided AND a snapshot ran
}
export interface SettleProbes {
  isScreenStatic?: () => Promise<boolean | null>;          // null = probe infra failed
  isWindowUpdating?: (timeoutMs: number) => Promise<boolean | null>;
  snapshotHash: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
export interface WaitForSettleOpts {
  platform: 'ios' | 'android';
  capabilities: readonly string[];
  probes: SettleProbes;
  budgetMs?: number;             // default 6000
  initialSnapshotHash?: string;  // pre-action hash → hierarchyChanged (Story 05 hook)
}
export function settleEnabled(env: NodeJS.ProcessEnv): boolean;
export async function waitForSettle(opts: WaitForSettleOpts): Promise<SettleOutcome>;
```

- Tier flow — Android: capability `WINDOW_UPDATE` present → `isWindowUpdating(100)`; `false` → sleep 50 ms → `{settled: true, method: 'window-gate'}`; `true`/`null`/capability absent → snapshot-eq tier. iOS: capability `SCREEN_STATIC` present → poll `isScreenStatic()` every 200 ms within `min(3000, budget)`; `true` → `{settled: true, method: 'screen-static'}`; `null` or tier exhausted → snapshot-eq tier. Snapshot-eq tier (both, also the only tier for legacy runners): poll `snapshotHash()` up to 10 iterations / 200 ms interval within remaining budget; two consecutive equal non-null hashes → `{settled: true, method: 'snapshot-eq'}`. Budget exhausted → `{settled: false, method: 'timeout'}`.

- [ ] **Step 1: Write the failing probe-matrix tests**

Create `scripts/cdp-bridge/test/unit/settle-engine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSettle, settleEnabled } from '../../dist/lifecycle/settle.js';

// Fake clock: sleep() advances time; now() reads it. No real timers.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}
function seq(values) {
  let i = 0;
  return async () => values[Math.min(i++, values.length - 1)];
}

test('android: window not updating → window-gate settles in ~150ms', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      isWindowUpdating: async (timeoutMs) => { clock.advance(timeoutMs); return false; },
      snapshotHash: async () => { throw new Error('must not reach snapshot tier'); },
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.deepEqual({ settled: out.settled, method: out.method }, { settled: true, method: 'window-gate' });
  assert.ok(out.ms <= 150, `expected ≤150ms, got ${out.ms}`);
});

test('android: window updating → falls to snapshot-eq and settles on equal hashes', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: ['WINDOW_UPDATE'],
    probes: {
      isWindowUpdating: async () => true,
      snapshotHash: seq(['h1', 'h2', 'h2']),
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
  assert.equal(out.settled, true);
});

test('android: capability absent → snapshot-eq only (legacy degrade)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    probes: { snapshotHash: seq(['a', 'a']), sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.method, 'snapshot-eq');
});

test('ios: static on second probe → screen-static', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: {
      isScreenStatic: seq([false, true]),
      snapshotHash: async () => { throw new Error('must not reach snapshot tier'); },
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.deepEqual({ settled: out.settled, method: out.method }, { settled: true, method: 'screen-static' });
});

test('ios: never static → snapshot-eq tier settles (perpetual animation, stable hierarchy)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: {
      isScreenStatic: async () => { clock.advance(300); return false; }, // each probe ≈2 screenshots
      snapshotHash: seq(['x', 'x']),
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.equal(out.method, 'snapshot-eq');
  assert.equal(out.settled, true);
});

test('ios: probe infra failure (null) skips straight to snapshot tier', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    probes: { isScreenStatic: async () => null, snapshotHash: seq(['x', 'x']), sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.method, 'snapshot-eq');
});

test('budget exhaustion → settled:false, method:timeout (never hangs)', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'ios',
    capabilities: ['SCREEN_STATIC'],
    budgetMs: 1000,
    probes: {
      isScreenStatic: async () => { clock.advance(300); return false; },
      snapshotHash: (() => { let i = 0; return async () => `h${i++}`; })(), // never repeats
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.deepEqual({ settled: out.settled, method: out.method }, { settled: false, method: 'timeout' });
});

test('snapshot tier is bounded at 10 iterations even inside a large budget', async () => {
  const clock = fakeClock();
  let calls = 0;
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    budgetMs: 60_000,
    probes: {
      snapshotHash: async () => `h${calls++}`,
      sleep: clock.sleep, now: clock.now,
    },
  });
  assert.equal(out.settled, false);
  assert.ok(calls <= 10, `snapshot polled ${calls} times`);
});

test('hierarchyChanged reflects initialSnapshotHash comparison', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    initialSnapshotHash: 'before',
    probes: { snapshotHash: seq(['after', 'after']), sleep: clock.sleep, now: clock.now },
  });
  assert.equal(out.hierarchyChanged, true);
});

test('all snapshot probes fail (null) → timeout, no throw', async () => {
  const clock = fakeClock();
  const out = await waitForSettle({
    platform: 'android',
    capabilities: [],
    probes: { snapshotHash: async () => null, sleep: clock.sleep, now: clock.now },
  });
  assert.deepEqual({ settled: out.settled, method: out.method }, { settled: false, method: 'timeout' });
});

test('settleEnabled: default on, RN_SETTLE=0/false off', () => {
  assert.equal(settleEnabled({}), true);
  assert.equal(settleEnabled({ RN_SETTLE: '1' }), true);
  assert.equal(settleEnabled({ RN_SETTLE: '0' }), false);
  assert.equal(settleEnabled({ RN_SETTLE: 'false' }), false);
  assert.equal(settleEnabled({ RN_SETTLE: 'FALSE' }), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && node --test test/unit/settle-engine.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `scripts/cdp-bridge/src/lifecycle/settle.ts` (engine part; production probe builders come in Task 5):

```ts
export type SettleMethod = 'window-gate' | 'screen-static' | 'snapshot-eq' | 'timeout';

export interface SettleOutcome {
  settled: boolean;
  method: SettleMethod;
  ms: number;
  hierarchyChanged?: boolean;
}

export interface SettleProbes {
  isScreenStatic?: () => Promise<boolean | null>;
  isWindowUpdating?: (timeoutMs: number) => Promise<boolean | null>;
  snapshotHash: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WaitForSettleOpts {
  platform: 'ios' | 'android';
  capabilities: readonly string[];
  probes: SettleProbes;
  budgetMs?: number;
  initialSnapshotHash?: string;
}

export const SETTLE_DEFAULT_BUDGET_MS = 6000;
// Maestro parity: SCREEN_SETTLE_TIMEOUT_MS=3000 (IOSDriver.kt:487-504); hierarchy
// polling bounded 10×200ms (ScreenshotUtils.kt:38-74). Window-gate probe is 100ms
// (not Maestro's 500) so the static-screen path stays inside the spec's ≤150ms
// acceptance budget: 100ms probe + 50ms post-sleep.
const SCREEN_STATIC_TIER_MS = 3000;
const SCREEN_STATIC_POLL_INTERVAL_MS = 200;
const WINDOW_GATE_TIMEOUT_MS = 100;
const WINDOW_GATE_SETTLED_SLEEP_MS = 50;
const SNAPSHOT_POLL_MAX = 10;
const SNAPSHOT_POLL_INTERVAL_MS = 200;

export function settleEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.RN_SETTLE?.trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

export async function waitForSettle(opts: WaitForSettleOpts): Promise<SettleOutcome> {
  const { platform, capabilities, probes, initialSnapshotHash } = opts;
  const budgetMs = opts.budgetMs ?? SETTLE_DEFAULT_BUDGET_MS;
  const start = probes.now();
  const elapsed = (): number => probes.now() - start;
  const remaining = (): number => budgetMs - elapsed();

  if (platform === 'android' && capabilities.includes('WINDOW_UPDATE') && probes.isWindowUpdating) {
    const updating = await safeProbe(() => probes.isWindowUpdating!(WINDOW_GATE_TIMEOUT_MS));
    if (updating === false) {
      // NB: false ≠ "our screen is static" — waitForWindowUpdate also returns
      // false immediately when the frontmost package differs (e.g. after a back
      // that left the app). Benign: nothing of ours left to settle.
      await probes.sleep(WINDOW_GATE_SETTLED_SLEEP_MS);
      return { settled: true, method: 'window-gate', ms: elapsed() };
    }
    // updating or probe failure → pay for snapshot polling below
  }

  if (platform === 'ios' && capabilities.includes('SCREEN_STATIC') && probes.isScreenStatic) {
    const tierDeadline = Math.min(SCREEN_STATIC_TIER_MS, budgetMs);
    while (elapsed() < tierDeadline) {
      const isStatic = await safeProbe(() => probes.isScreenStatic!());
      if (isStatic === true) return { settled: true, method: 'screen-static', ms: elapsed() };
      if (isStatic === null) break; // probe infra failed — don't burn the tier budget
      await probes.sleep(SCREEN_STATIC_POLL_INTERVAL_MS);
    }
  }

  let prev: string | null = null;
  let hierarchyChanged: boolean | undefined;
  for (let i = 0; i < SNAPSHOT_POLL_MAX; i++) {
    if (remaining() <= 0) break;
    const hash = await safeProbe(() => probes.snapshotHash());
    if (typeof hash === 'string') {
      if (initialSnapshotHash !== undefined) {
        hierarchyChanged = hierarchyChanged === true || hash !== initialSnapshotHash;
      }
      if (prev !== null && hash === prev) {
        return {
          settled: true,
          method: 'snapshot-eq',
          ms: elapsed(),
          ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
        };
      }
      prev = hash;
    }
    await probes.sleep(SNAPSHOT_POLL_INTERVAL_MS);
  }
  return {
    settled: false,
    method: 'timeout',
    ms: elapsed(),
    ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
  };
}

async function safeProbe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/settle-engine.test.js`
Expected: 11 PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/lifecycle/settle.ts scripts/cdp-bridge/test/unit/settle-engine.test.js scripts/cdp-bridge/dist
git commit -m "feat(settle): capability-switched two-tier waitForSettle engine (#385)"
```

---

### Task 5: Runner-client plumbing (verbs, capability caches, production probes)

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts`
- Modify: `scripts/cdp-bridge/src/lifecycle/settle.ts` (append probe builders)
- Test: `scripts/cdp-bridge/test/unit/settle-wiring.test.js` (create — client-level parts)

**Interfaces:**
- Consumes: `waitForSettle`/`SettleProbes` (Task 4), `hashSnapshotNodes` (Task 3).
- Produces:
  - `RunIOSArgs['command']` gains `'isScreenStatic'` (`rn-fast-runner-client.ts:872-889`); `RunAndroidArgs` gains `command: 'isWindowUpdating'` and `timeoutMs?: number` (`rn-android-runner-client.ts:81-111`), with `timeoutMs` forwarded onto the POST body in `runAndroid` (next to `durationMs`, line ~891).
  - `getFastRunnerCapabilities(): string[]` / `getAndroidRunnerCapabilities(): string[]` — module-level caches, refreshed on every successful `/health` probe (`probeFastRunnerLivenessDetailed` 'alive' path at `rn-fast-runner-client.ts:819-824`; `probeAndroidRunnerHealthInfo` success path at `rn-android-runner-client.ts:481-491` after adding `capabilities` parsing to `AndroidHealthInfo`). Both get `_resetCapabilitiesForTest()` seams. The caches are warm before any mutating verb: iOS `ensureRunnerForCommand` probes `/health` before every non-screenshot command; Android `startAndroidRunner` probes at reuse/readiness.
  - `_setFastRunnerStateForTest(state)` seam in `rn-fast-runner-client.ts` (mirror `_setAndroidRunnerStateForTest`, `rn-android-runner-client.ts:138-140`).
  - In `settle.ts`: `buildIosProbes(bundleId?: string): SettleProbes` and `buildAndroidProbes(bundleId?: string): SettleProbes` (Android pins the runner's forwarded host port at construction — see Step 3).

- [ ] **Step 1: Write failing tests (client-level)**

Create `scripts/cdp-bridge/test/unit/settle-wiring.test.js` with the first batch:

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  getAndroidRunnerCapabilities,
  _setFetchForTest as setAndroidFetch,
  _resetCapabilitiesForTest as resetAndroidCaps,
} from '../../dist/runners/rn-android-runner-client.js';
import { buildIosProbes, buildAndroidProbes } from '../../dist/lifecycle/settle.js';
import {
  runIOS,
  _setFetchForTest as setIosFetch,
  _setFastRunnerStateForTest,
} from '../../dist/runners/rn-fast-runner-client.js';

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => {
  setIosFetch(globalThis.fetch);
  setAndroidFetch(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  resetAndroidCaps();
});

test('android /health probe parses + caches capabilities', async () => {
  setAndroidFetch(async () =>
    jsonResponse({ ok: true, protocolVersion: 1, capabilities: ['WINDOW_UPDATE'], commands: [] }),
  );
  const info = await probeAndroidRunnerHealthInfo(12345);
  assert.deepEqual(info.capabilities, ['WINDOW_UPDATE']);
  assert.deepEqual(getAndroidRunnerCapabilities(), ['WINDOW_UPDATE']);
});

test('runIOS dispatches isScreenStatic and returns {static}', async () => {
  _setFastRunnerStateForTest({
    schemaVersion: 1, pid: process.pid, port: 22090,
    deviceId: 'TEST-UDID', bundleId: 'com.test', startedAt: '', protocolVersion: 1,
  });
  let posted;
  setIosFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { static: true }, v: 1 });
  });
  const result = await runIOS({ command: 'isScreenStatic', bundleId: 'com.test' });
  assert.equal(posted.command, 'isScreenStatic');
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.data.static, true);
});

test('buildIosProbes.isScreenStatic maps envelope → boolean, failure → null', async () => {
  _setFastRunnerStateForTest({
    schemaVersion: 1, pid: process.pid, port: 22090,
    deviceId: 'TEST-UDID', bundleId: 'com.test', startedAt: '', protocolVersion: 1,
  });
  setIosFetch(async () => jsonResponse({ ok: true, data: { static: false }, v: 1 }));
  const probes = buildIosProbes('com.test');
  assert.equal(await probes.isScreenStatic(), false);
  setIosFetch(async () => { throw new Error('boom'); });
  assert.equal(await probes.isScreenStatic(), null);
});

test('buildAndroidProbes.isWindowUpdating posts timeoutMs and maps {updating}', async () => {
  const { _setAndroidRunnerStateForTest } = await import('../../dist/runners/rn-android-runner-client.js');
  _setAndroidRunnerStateForTest({
    schemaVersion: 1, hostPort: 23456, devicePort: 7100, pid: process.pid,
    startedAt: '', protocolVersion: 1,
  });
  let posted;
  setAndroidFetch(async (_url, init) => {
    posted = JSON.parse(init.body);
    return jsonResponse({ ok: true, data: { updating: false }, v: 1 });
  });
  const probes = buildAndroidProbes('com.test');
  assert.equal(await probes.isWindowUpdating(100), false);
  assert.equal(posted.timeoutMs, 100);
  assert.equal(posted.command, 'isWindowUpdating');
  _setAndroidRunnerStateForTest(null);
});
```

Note for the implementer: `buildAndroidProbes` must reach `postCommand` WITHOUT triggering `startAndroidRunner`'s full ensure path (`runAndroid` calls `startAndroidRunner` first, which would try adb). Give the android probe a direct thin export — see Step 3.

- [ ] **Step 2: Run to verify failure**

Run: `npm run build` — expect a compile error (`isScreenStatic` not in union / missing exports). That IS the failing state; fix by implementing.

- [ ] **Step 3: Implement client plumbing**

`rn-fast-runner-client.ts`:
1. Add `'isScreenStatic'` to the `RunIOSArgs.command` union (line 873-889).
2. Module-level capability cache near `runnerState` (line ~137):

```ts
let lastKnownCapabilities: string[] = [];
export function getFastRunnerCapabilities(): string[] {
  return lastKnownCapabilities;
}
export function _resetCapabilitiesForTest(): void {
  lastKnownCapabilities = [];
}
```

In `probeFastRunnerLivenessDetailed`, in the 'alive' return branch (line 819), add before returning: `lastKnownCapabilities = res.capabilities ?? [];`
3. Test seam mirroring Android's:

```ts
export function _setFastRunnerStateForTest(state: FastRunnerState | null): void {
  runnerState = state;
}
```

`rn-android-runner-client.ts`:
1. Add `| 'isWindowUpdating'` to `RunAndroidArgs.command` and `timeoutMs?: number` to the args interface (lines 81-111); in `runAndroid`'s body builder add `if (args.timeoutMs !== undefined) body.timeoutMs = args.timeoutMs;` (next to `durationMs`, line ~891).
2. `AndroidHealthInfo` gains `capabilities?: string[]` (line 459-465); `probeAndroidRunnerHealthInfo` parses it exactly like `commands` and refreshes the cache:

```ts
let lastKnownCapabilities: string[] = [];
export function getAndroidRunnerCapabilities(): string[] {
  return lastKnownCapabilities;
}
export function _resetCapabilitiesForTest(): void {
  lastKnownCapabilities = [];
}
```

(set `lastKnownCapabilities = capabilities ?? []` whenever the probe returns `reachable: true, ok: true`).
3. Export thin probe entries that skip the ensure path (used only by settle — `runAndroid` calls `startAndroidRunner` on EVERY dispatch, and a snapshot-eq tier polling 10× must not pay 10 ensure round-trips; multi-LLM review S3):

```ts
export function getAndroidRunnerHostPort(): number | null {
  return runnerState?.hostPort ?? null;
}

// pinnedHostPort: captured by the settle-probe builder right after the mutating
// dispatch. If the live runner state has since changed (device switch, runner
// restart), the probe degrades to null instead of posting to the wrong
// forwarded port — the endpoint assumption is CHECKED, not hidden.
export async function androidIsWindowUpdatingProbe(
  timeoutMs: number,
  bundleId?: string,
  pinnedHostPort?: number,
): Promise<boolean | null> {
  if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort) return null;
  try {
    const resp = await postCommand({
      command: 'isWindowUpdating',
      timeoutMs,
      ...(bundleId ? { appBundleId: bundleId } : {}),
    });
    const updating = (resp.data as { updating?: unknown } | undefined)?.updating;
    return resp.ok && typeof updating === 'boolean' ? updating : null;
  } catch {
    return null;
  }
}

export async function androidSnapshotNodesViaProbe(
  bundleId?: string,
  pinnedHostPort?: number,
): Promise<FlatNode[] | null> {
  if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort) return null;
  try {
    const resp = await postCommand({
      command: 'snapshot',
      interactiveOnly: true,
      ...(bundleId ? { appBundleId: bundleId } : {}),
    });
    if (!resp.ok || !resp.data || typeof resp.data !== 'object') return null;
    const data = resp.data as { nodes?: RunnerSnapshotNode[] };
    if (!Array.isArray(data.nodes)) return null;
    const flat = mapRunnerNodesToFlat(data.nodes);
    updateRefMapFromFlat(flat);
    return flat;
  } catch {
    return null;
  }
}
```

(`androidSnapshotNodesViaProbe` shares `mapRunnerNodesToFlat` + `updateRefMapFromFlat` with `runAndroid`'s snapshot post-processing so the ref-map refresh side-effect is preserved. iOS needs no equivalent: `runIOS` never runs an ensure path — `postCommand` throws when no state, which `safeProbe` maps to `null`.)

`settle.ts` — append the production probe builders:

```ts
import type { ToolResult } from '../utils.js';
import { hashSnapshotNodes } from './settle-hash.js';
import type { FlatNode } from '../fast-runner-ref-map.js';

function envelopeData(result: ToolResult): unknown {
  try {
    const parsed = JSON.parse(result.content[0].text) as { ok?: boolean; data?: unknown };
    return parsed.ok === false ? null : parsed.data;
  } catch {
    return null;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function buildIosProbes(bundleId?: string): SettleProbes {
  return {
    isScreenStatic: async () => {
      const data = envelopeData(await runIOS({ command: 'isScreenStatic', ...(bundleId ? { bundleId } : {}) }));
      const s = (data as { static?: unknown } | null)?.static;
      return typeof s === 'boolean' ? s : null;
    },
    snapshotHash: async () => {
      const data = envelopeData(
        await runIOS({ command: 'snapshot', interactiveOnly: true, ...(bundleId ? { bundleId } : {}) }),
      );
      const nodes = (data as { nodes?: FlatNode[] } | null)?.nodes;
      return Array.isArray(nodes) ? hashSnapshotNodes(nodes) : null;
    },
    sleep: realSleep,
    now: () => Date.now(),
  };
}

// runIOS is a static import too (top of settle.ts): the clients never import
// settle, so there is no cycle; iOS needs no port pin — runIOS/postCommand
// throw when no runner state exists and safeProbe maps that to null.

export function buildAndroidProbes(bundleId?: string): SettleProbes {
  const pinnedHostPort = getAndroidRunnerHostPort() ?? undefined;
  return {
    isWindowUpdating: (timeoutMs) => androidIsWindowUpdatingProbe(timeoutMs, bundleId, pinnedHostPort),
    snapshotHash: async () => {
      const nodes = await androidSnapshotNodesViaProbe(bundleId, pinnedHostPort);
      return nodes ? hashSnapshotNodes(nodes) : null;
    },
    sleep: realSleep,
    now: () => Date.now(),
  };
}
```

(`getAndroidRunnerHostPort`, `androidIsWindowUpdatingProbe`, `androidSnapshotNodesViaProbe` are static imports at the top of `settle.ts` — no import cycle exists: the clients never import settle. Device scoping is explicit: `buildAndroidProbes` is constructed inside `settleAfterMutation` immediately after the mutating dispatch and pins the runner's current forwarded port; if runner state changes mid-settle (device switch, restart), the probes return `null` and the engine degrades — never posts to the wrong port.)

Design notes the implementer must preserve:
- Probes call `runIOS`/`runAndroid`/`postCommand` **directly, never `runNative`** — no recursion into settle, no double snapshot-dirty marking.
- `snapshotHash` uses `interactiveOnly: true` (deliberate deviation from Maestro's full-hierarchy hash): the interactive set is the same surface the press path targets and the ref-map serves, and full-tree serialization on iOS costs ~1.5 s/poll. The hash includes labels + 4px-quantized bounds, so most real transitions still register. Revisit if live verification shows false "settled".
- Because `runIOS('snapshot')`/`runAndroid('snapshot')` call `updateRefMapFromFlat`, **every settle refreshes the ref-map for free** — the Story 05 hook.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/settle-wiring.test.js`
Expected: 4 PASS. Also `node --test 'test/unit/*.test.js' 'test/unit/**/*.test.js'` — full unit suite green (existing client tests unaffected).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src scripts/cdp-bridge/test/unit/settle-wiring.test.js scripts/cdp-bridge/dist
git commit -m "feat(settle): runner-client probe verbs, capability caches, production probes (#385)"
```

---

### Task 6: `runNative` wiring — settle after every mutating verb

**Files:**
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (device_press/device_fill `settleTimeoutMs` schema)
- Modify: `scripts/cdp-bridge/src/tools/device-interact.ts` (thread `settleTimeoutMs` into press/fill `runNative` calls)
- Test: `scripts/cdp-bridge/test/unit/settle-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `waitForSettle`, `settleEnabled`, `buildIosProbes`, `buildAndroidProbes` (Tasks 4-5); `getFastRunnerCapabilities`/`getAndroidRunnerCapabilities` (Task 5).
- Produces:
  - `runNative(cliArgs, opts)` opts extended: `{ skipSession?: boolean; platform?: 'ios' | 'android' | null; settle?: { enabled?: boolean; timeoutMs?: number } }`.
  - `attachMeta(result: ToolResult, patch: Record<string, unknown>): ToolResult` — generalization of `attachMetaNote` (`agent-device-wrapper.ts:847-863`); merges `patch` into `envelope.meta`, deep-merging `timings_ms`. `attachMetaNote(result, note)` becomes `attachMeta(result, { note })`.
  - `settleAfterMutation(result, ctx, deps?)` — exported for tests:

```ts
export interface SettleContext {
  platform: 'ios' | 'android';
  verb: string;
  appId?: string;
  settle?: { enabled?: boolean; timeoutMs?: number };
}
export interface SettleAfterMutationDeps {
  enabled?: (env: NodeJS.ProcessEnv) => boolean;
  capabilities?: (platform: 'ios' | 'android') => string[];
  probes?: (platform: 'ios' | 'android', appId?: string) => SettleProbes;
  wait?: typeof waitForSettle;
}
export async function settleAfterMutation(
  result: ToolResult,
  ctx: SettleContext,
  deps?: SettleAfterMutationDeps,
): Promise<ToolResult>;
```

  - Behavior: returns `result` unchanged when the verb is not in `SNAPSHOT_MUTATING_VERBS`, when `result.isError`, when `ctx.settle?.enabled === false`, or when `settleEnabled(process.env)` is false. Otherwise runs `waitForSettle` and returns `attachMeta(result, { settle: { method, settled }, timings_ms: { settle: ms } })`. Any thrown error inside is swallowed (settle is advisory) — result returned unmodified.
  - Wiring: in the iOS short-circuit (line ~905-908) and Android short-circuit (after the `runAndroid` call) of `runNative`, the direct `return` is replaced by `let result = await runIOS(ios); result = await settleAfterMutation(result, { platform: 'ios', verb: cliArgs[0], appId, settle: opts.settle }); return upgradeNote ? attachMetaNote(result, upgradeNote) : result;` (Android analogous).
  - Tool surface: `device_press` and `device_fill` gain optional `settleTimeoutMs` (zod: `z.number().int().min(500).max(30000).optional()`, describe: `'Override the post-action settle budget in ms (default 6000). Settle waits for the UI to stabilize after the action; see meta.settle in the result.'`). Handlers pass `{ settle: { timeoutMs: args.settleTimeoutMs } }` as `runNative` opts when set.

- [ ] **Step 1: Write failing tests**

Append to `settle-wiring.test.js`:

```js
import { settleAfterMutation, attachMeta, runNative } from '../../dist/agent-device-wrapper.js';
import { _setPluginVersionForTest } from '../../dist/runners/protocol.js';
import { okResult } from '../../dist/utils.js';

const fakeDeps = (outcome) => ({
  enabled: () => true,
  capabilities: () => ['SCREEN_STATIC'],
  probes: () => ({ snapshotHash: async () => 'h', sleep: async () => {}, now: () => 0 }),
  wait: async () => outcome,
});

test('settleAfterMutation attaches meta.settle + timings_ms.settle on mutating success', async () => {
  const out = await settleAfterMutation(
    okResult({ tapped: true }),
    { platform: 'ios', verb: 'tap' },
    fakeDeps({ settled: true, method: 'screen-static', ms: 240 }),
  );
  const envelope = JSON.parse(out.content[0].text);
  assert.deepEqual(envelope.meta.settle, { method: 'screen-static', settled: true });
  assert.equal(envelope.meta.timings_ms.settle, 240);
});

test('settleAfterMutation skips non-mutating verbs, errors, and per-call opt-out', async () => {
  const untouched = okResult({});
  const cases = [
    ['snapshot', {}],
    ['tap', { settle: { enabled: false } }],
  ];
  for (const [verb, extra] of cases) {
    const out = await settleAfterMutation(untouched, { platform: 'ios', verb, ...extra },
      fakeDeps({ settled: true, method: 'screen-static', ms: 1 }));
    assert.equal(JSON.parse(out.content[0].text).meta?.settle, undefined, `verb=${verb}`);
  }
});

test('settleAfterMutation respects RN_SETTLE=0 via injected enabled()', async () => {
  const out = await settleAfterMutation(okResult({}), { platform: 'android', verb: 'tap' }, {
    ...fakeDeps({ settled: true, method: 'window-gate', ms: 1 }),
    enabled: () => false,
  });
  assert.equal(JSON.parse(out.content[0].text).meta?.settle, undefined);
});

test('settleAfterMutation swallows a throwing waiter (advisory, never fails the action)', async () => {
  const out = await settleAfterMutation(okResult({ tapped: true }), { platform: 'ios', verb: 'tap' }, {
    ...fakeDeps(null),
    wait: async () => { throw new Error('boom'); },
  });
  assert.equal(JSON.parse(out.content[0].text).data.tapped, true);
});

test('attachMeta merges timings_ms instead of clobbering', () => {
  const base = okResult({}, { meta: { timings_ms: { dispatch: 12 } } });
  const out = attachMeta(base, { timings_ms: { settle: 34 }, settle: { method: 'snapshot-eq', settled: true } });
  const envelope = JSON.parse(out.content[0].text);
  assert.deepEqual(envelope.meta.timings_ms, { dispatch: 12, settle: 34 });
});

test('end-to-end: runNative ios tap → runner /command + settle probe → meta.settle', async () => {
  const { _setActiveSessionForTest } = await import('../../dist/agent-device-wrapper.js');
  _setPluginVersionForTest(null); // disables version-skew gate
  // Deterministic session: without it, runNative falls back to
  // resolveBootedIosUdid() which shells `xcrun simctl` (flaky/slow on CI and
  // machine-dependent on macOS dev boxes) — multi-LLM review S2.
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  _setFastRunnerStateForTest({
    schemaVersion: 1, pid: process.pid, port: 22091,
    deviceId: 'TEST-UDID', bundleId: 'com.test', startedAt: '', protocolVersion: 1,
  });
  const REQUIRED = ['tap','type','drag','longPress','pinch','snapshot','screenshot','back','keyboardDismiss'];
  setIosFetch(async (url, init) => {
    if (String(url).includes('/health')) {
      return jsonResponse({ ok: true, protocolVersion: 1, capabilities: ['SCREEN_STATIC'], commands: REQUIRED });
    }
    const body = JSON.parse(init.body);
    if (body.command === 'tap') return jsonResponse({ ok: true, data: { tapped: true }, v: 1 });
    if (body.command === 'isScreenStatic') return jsonResponse({ ok: true, data: { static: true }, v: 1 });
    return jsonResponse({ ok: true, data: {}, v: 1 });
  });
  const result = await runNative(['tap', '100', '200'], { platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.meta.settle.settled, true);
  assert.equal(envelope.meta.settle.method, 'screen-static');
  assert.equal(typeof envelope.meta.timings_ms.settle, 'number');
  _setPluginVersionForTest(undefined);
});
```

(If the end-to-end case fights the module's test-seam fuse (`_testSeamFused`, GH #110) or `resolveBootedIosUdid` shelling on CI, keep the `settleAfterMutation`-level tests as the contract and downgrade the end-to-end case to assert only that it does not throw — note the substitution in the commit message.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build` → compile errors for missing exports; then `node --test test/unit/settle-wiring.test.js` → FAIL.

- [ ] **Step 3: Implement**

In `agent-device-wrapper.ts`:
1. Generalize `attachMetaNote` (lines 845-863):

```ts
export function attachMeta(result: ToolResult, patch: Record<string, unknown>): ToolResult {
  try {
    const first = result.content?.[0];
    if (!first || first.type !== 'text') return result;
    const envelope = JSON.parse(first.text) as { meta?: Record<string, unknown> };
    const prevTimings = (envelope.meta?.timings_ms ?? {}) as Record<string, unknown>;
    const patchTimings = (patch.timings_ms ?? {}) as Record<string, unknown>;
    envelope.meta = {
      ...envelope.meta,
      ...patch,
      ...(Object.keys(prevTimings).length + Object.keys(patchTimings).length > 0
        ? { timings_ms: { ...prevTimings, ...patchTimings } }
        : {}),
    };
    return {
      ...result,
      content: [
        { type: 'text' as const, text: JSON.stringify(envelope) },
        ...result.content.slice(1),
      ],
    };
  } catch {
    return result;
  }
}

export function attachMetaNote(result: ToolResult, note: string): ToolResult {
  return attachMeta(result, { note });
}
```

2. `settleAfterMutation` per the interface block above (imports: `waitForSettle`, `settleEnabled`, `buildIosProbes`, `buildAndroidProbes` from `./lifecycle/settle.js`; `getFastRunnerCapabilities` / `getAndroidRunnerCapabilities` from the clients — use dynamic imports inside the default deps to match the file's existing lazy-import pattern):

```ts
export async function settleAfterMutation(
  result: ToolResult,
  ctx: SettleContext,
  deps: SettleAfterMutationDeps = {},
): Promise<ToolResult> {
  if (result.isError) return result;
  if (!SNAPSHOT_MUTATING_VERBS.has(ctx.verb)) return result;
  if (ctx.settle?.enabled === false) return result;
  const enabled = deps.enabled ?? settleEnabled;
  if (!enabled(process.env)) return result;
  try {
    const capabilities = deps.capabilities
      ? deps.capabilities(ctx.platform)
      : ctx.platform === 'ios'
        ? (await import('./runners/rn-fast-runner-client.js')).getFastRunnerCapabilities()
        : (await import('./runners/rn-android-runner-client.js')).getAndroidRunnerCapabilities();
    const probes = deps.probes
      ? deps.probes(ctx.platform, ctx.appId)
      : ctx.platform === 'ios'
        ? buildIosProbes(ctx.appId)
        : buildAndroidProbes(ctx.appId);
    const wait = deps.wait ?? waitForSettle;
    const outcome = await wait({
      platform: ctx.platform,
      capabilities,
      probes,
      ...(ctx.settle?.timeoutMs !== undefined ? { budgetMs: ctx.settle.timeoutMs } : {}),
    });
    return attachMeta(result, {
      settle: { method: outcome.method, settled: outcome.settled },
      timings_ms: { settle: outcome.ms },
    });
  } catch {
    return result;
  }
}
```

3. Wire both short-circuits in `runNative` (iOS lines ~905-908, Android after its `runAndroid` call) as described in Interfaces. Extend the opts type on `runNative`'s signature.

4. Add a deterministic session seam next to `getActiveSession` (used by the end-to-end test and Task 7's handler tests — avoids `resolveBootedIosUdid()` shelling `xcrun` at test time):

```ts
export function _setActiveSessionForTest(session: SessionState | null): void {
  activeSession = session;
}
```

5. Meta-survival check: the press/fill handlers post-process `runNative` results through wrappers (`surfaceKeyboardGuard`, `tagPressIfRecovered` in `device-interact.ts`). Verify while wiring that those wrappers spread `envelope.meta` rather than replace it, and add one wiring-test assertion that a result carrying `meta.keyboardGuard` still has `meta.settle` after `surfaceKeyboardGuard` runs — `meta.settle` must survive to the tool caller.

In `device-interact.ts`: `PressArgs`/`FillArgs` gain `settleTimeoutMs?: number`; every `runNative(['press'|'longpress'|'fill'|'tap'...])` call inside the press/fill handlers passes `{ settle: args.settleTimeoutMs !== undefined ? { timeoutMs: args.settleTimeoutMs } : undefined }` — only where the handler has the args in scope; helper:

```ts
function settleOpts(args: { settleTimeoutMs?: number }): { settle?: { timeoutMs: number } } {
  return args.settleTimeoutMs !== undefined ? { settle: { timeoutMs: args.settleTimeoutMs } } : {};
}
```

In `index.ts`: add the `settleTimeoutMs` zod field to `device_press` (after `waitForFocusMs`, line ~1183) and `device_fill` (after `testID`, line ~1208) with the describe text from Interfaces.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/settle-wiring.test.js`
Expected: all PASS. Then the full suite: `npm test` — green.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src scripts/cdp-bridge/test/unit/settle-wiring.test.js scripts/cdp-bridge/dist
git commit -m "feat(settle): wire waitForSettle into runNative after every mutating verb (#385)"
```

---

### Task 7: `device_fill` adoption — settle-aware focus delay, coordinate pinning, retype opt-out

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-interact.ts:749-800` (fill pre-tap + primary fill + corrective-retype loop)
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts` (`buildRunIOSArgs`/`buildRunAndroidArgs`: `--at-x/--at-y` coordinate pin on `fill`/`type`)
- Test: `scripts/cdp-bridge/test/unit/story-04-fill-batch-settle.test.js` (create)

**Interfaces:**
- Consumes: `meta.settle` attached by Task 6 on the pre-tap `press` result; the `settleOpts(args)` helper and `_setActiveSessionForTest` seam Task 6 added (signature: `function settleOpts(args: { settleTimeoutMs?: number }): { settle?: { timeoutMs: number } }`).
- Behavior change 1 (focus delay): today the fill path always does `press → sleep(args.waitForKeyboardMs ?? 150) → fill`. New rule:
  - If `args.waitForKeyboardMs` is explicitly set → honor it exactly (caller asserted a need; B122 Pressable-wrapped inputs).
  - Else if the pre-tap's result envelope carries `meta.settle` (settle ran, regardless of outcome) → **no sleep** (settle already waited for stability; a further 150 ms adds nothing).
  - Else (settle disabled/unavailable) → legacy `sleep(FOCUS_DELAY_MS)` (150 ms) — the fallback keeps legacy runners working, satisfying "no fixed sleeps remain in the press/fill paths" for every settle-capable session.
- Behavior change 2 (coordinate pinning — multi-LLM review M2): the pre-tap's settle re-snapshots and REPLACES the positional `@ref` map (`updateRefMapFromFlat` clears + rebuilds by snapshot-order enumeration and resets the freshness clock), so a fill that re-resolves `@e3` after settle can target a different element on the post-keyboard screen. Fix: resolve `refCenter(ref)` ONCE up front (when the map is fresh); dispatch the pre-tap by those pinned numeric coords; dispatch the primary fill and every retype with `--at-x/--at-y` pin options so `buildRun*Args` skips `@ref` re-resolution entirely. When the map is not fresh (`pinned === null`), behavior is exactly today's (`press @ref` → STALE_REF path).
- Behavior change 3 (retype opt-out — multi-LLM review M1): the corrective-retype `runNative(['fill', …])` calls pass `{ settle: { enabled: false } }`. Their stability check is the existing `nativeSettle` CDP read-back that immediately follows each retype — a UI-settle there is redundant latency (worst case ~30 s per fill on an animating screen without this). The pre-tap press and the primary fill keep settle ON.
- Produces:
  - Pure helper, exported for tests: `export function focusDelayAfterPreTap(preTapEnvelopeText: string | undefined, waitForKeyboardMs: number | undefined): number; // 0 = skip sleep`
  - CLI option on the `fill`/`type` verb in BOTH arg builders: `--at-x <n> --at-y <n>` — when both present and numeric, the builder emits `{ command: 'type', x, y, text, … }` directly and never consults the ref map. (Verify `positionalArgs()` excludes option value tokens — it already must for `--delay-ms`, which coexists with positional text today.)
  - Test seam widening: `_setRunAgentDeviceOverrideForTest` callbacks now receive `(cliArgs, opts)` so tests can assert settle opts threading.

- [ ] **Step 1: Write failing tests**

Create `scripts/cdp-bridge/test/unit/story-04-fill-batch-settle.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusDelayAfterPreTap } from '../../dist/tools/device-interact.js';

const withSettle = JSON.stringify({ ok: true, data: {}, meta: { settle: { method: 'screen-static', settled: true } } });
const withTimeoutSettle = JSON.stringify({ ok: true, data: {}, meta: { settle: { method: 'timeout', settled: false } } });
const withoutSettle = JSON.stringify({ ok: true, data: {} });

test('explicit waitForKeyboardMs always wins', () => {
  assert.equal(focusDelayAfterPreTap(withSettle, 800), 800);
});

test('settle ran → skip the fixed focus delay', () => {
  assert.equal(focusDelayAfterPreTap(withSettle, undefined), 0);
  assert.equal(focusDelayAfterPreTap(withTimeoutSettle, undefined), 0);
});

test('no settle meta → legacy 150ms fallback', () => {
  assert.equal(focusDelayAfterPreTap(withoutSettle, undefined), 150);
  assert.equal(focusDelayAfterPreTap(undefined, undefined), 150);
  assert.equal(focusDelayAfterPreTap('not-json', undefined), 150);
});

test('buildRunIOSArgs fill honors --at-x/--at-y pin and skips @ref re-resolution', async () => {
  const { buildRunIOSArgs } = await import('../../dist/agent-device-wrapper.js');
  // Ref map deliberately EMPTY: without the pin this would return _staleRef.
  const args = buildRunIOSArgs(['fill', '@e3', 'hello world', '--at-x', '120', '--at-y', '240'], 'com.test');
  assert.equal(args.command, 'type');
  assert.equal(args.x, 120);
  assert.equal(args.y, 240);
  assert.equal(args.text, 'hello world');
  assert.equal(args._staleRef, undefined);
});

test('device_fill pins press and fill to pre-resolved coords; retypes disable settle', async () => {
  const { _setActiveSessionForTest, _setRunAgentDeviceOverrideForTest } =
    await import('../../dist/agent-device-wrapper.js');
  const { updateRefMapFromFlat, clearRefMap } = await import('../../dist/fast-runner-ref-map.js');
  const { createDeviceFillHandler } = await import('../../dist/tools/device-interact.js');
  const { okResult } = await import('../../dist/utils.js');
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  updateRefMapFromFlat([
    { ref: '@e3', type: 'TextField', identifier: 'email', rect: { x: 100, y: 220, width: 200, height: 40 } },
  ]);
  const calls = [];
  _setRunAgentDeviceOverrideForTest(async (cliArgs, opts) => {
    calls.push({ cliArgs, opts });
    return okResult({});
  });
  const handler = createDeviceFillHandler(() => ({ isConnected: false }));
  await handler({ ref: '@e3', text: 'hi' });
  const press = calls.find((c) => c.cliArgs[0] === 'press');
  assert.deepEqual(press.cliArgs, ['press', '200', '240']); // center of seeded rect
  const fill = calls.find((c) => c.cliArgs[0] === 'fill');
  assert.ok(fill.cliArgs.includes('--at-x') && fill.cliArgs.includes('--at-y'), 'fill not pinned');
  clearRefMap();
  _setActiveSessionForTest(null);
});
```

(The retype-path settle opt-out can't be reached with a disconnected CDP client — the retype loop is gated on `client && jsTestId`. It is a one-line opts addition covered by the pinning test's seam pattern; assert it in review, and the live-verification fill check exercises it on-device. If a cheap fake CDP client already exists in the test helpers, add the direct assertion.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run build` → export missing → implement.

- [ ] **Step 3: Implement**

**(a) Arg builders — coordinate pin.** In `agent-device-wrapper.ts`, `buildRunIOSArgs` `case 'fill': case 'type':` (lines 293-328): before the `@ref` resolution branch, add:

```ts
      const atX = optionValue(cliArgs, '--at-x');
      const atY = optionValue(cliArgs, '--at-y');
      if (atX !== undefined && atY !== undefined) {
        const px = Number(atX),
          py = Number(atY);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          return { command: 'type', x: px, y: py, text, ...extra, ...(bundleId ? { bundleId } : {}) };
        }
      }
```

Mirror in `buildRunAndroidArgs`'s fill/type case (same file). First verify `positionalArgs()` excludes `--at-x 120`-style option/value pairs from positionals — it must already do this for `--delay-ms`, which coexists with positional text today; if it uses a known-options list, add `--at-x`/`--at-y` to it.

**(b) Focus-delay helper.** In `device-interact.ts`, add next to `FOCUS_DELAY_MS` (line 576):

```ts
export function focusDelayAfterPreTap(
  preTapEnvelopeText: string | undefined,
  waitForKeyboardMs: number | undefined,
): number {
  if (waitForKeyboardMs !== undefined) return waitForKeyboardMs;
  if (preTapEnvelopeText) {
    try {
      const envelope = JSON.parse(preTapEnvelopeText) as { meta?: { settle?: unknown } };
      if (envelope.meta?.settle !== undefined) return 0;
    } catch {
      /* fall through to legacy delay */
    }
  }
  return FOCUS_DELAY_MS;
}
```

**(c) Fill handler — pin once, settle pre-tap, skip sleep when settled.** Replace the pre-tap + primary-fill block (lines 749-761):

```ts
    // M2 guard: resolve the target's coords ONCE. The pre-tap's settle
    // re-snapshots and rebuilds the @ref map (post-keyboard screen), so any
    // later @ref re-resolution inside this call could target a different
    // element. Pinning makes the settle's ref-map refresh harmless here while
    // keeping it fresh for the NEXT tool (the Story 05 hook).
    const pinned = isRefMapFresh() ? refCenter(ref) : null;
    const pinArgs = pinned ? ['--at-x', String(pinned.x), '--at-y', String(pinned.y)] : [];

    const preTap = pinned
      ? await runNative(['press', String(pinned.x), String(pinned.y)], settleOpts(args))
      : await runNative(['press', ref], settleOpts(args));
    if (!preTap.isError) {
      const delay = focusDelayAfterPreTap(preTap.content?.[0]?.text, args.waitForKeyboardMs);
      if (delay > 0) await sleep(delay);
    }

    const primary = await runNative(['fill', ref, args.text, ...pinArgs], settleOpts(args));
```

(`refCenter`/`isRefMapFresh` are already imported in this file's dependency graph — import from `../fast-runner-ref-map.js` if not present in `device-interact.ts`. When `pinned === null` — stale/absent map — every dispatch is exactly today's `@ref` path, including STALE_REF handling.)

**(d) Corrective retypes — settle off, pin on (M1).** In the retype loop (line ~796), the `runNative(['fill', ref, args.text, '--clear-first', …])` call becomes:

```ts
          await runNative(
            ['fill', ref, args.text, ...pinArgs, '--clear-first', '--delay-ms', '50'],
            { settle: { enabled: false } },
          );
```

(Keep the existing `--clear-first`/`--delay-ms` values exactly as they are in the current code — only append `pinArgs` and the settle opt-out. The `nativeSettle` read-back that follows each retype is the stability check for this path; a UI-settle here is redundant latency.)

(The old `focusWaitMs` const at line 749 is deleted. The Android-workaround path's `sleep(300)` at line 700 stays — it is upstream of settle wiring and Android-specific; note it in the PR as a candidate for Story 04 follow-up.)

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/story-04-fill-batch-settle.test.js` → PASS; then `npm test` → full suite green (existing fill tests must still pass — the legacy path is preserved when no settle meta is present).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-interact.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/story-04-fill-batch-settle.test.js scripts/cdp-bridge/dist
git commit -m "feat(settle): device_fill settle-aware delay, coord pinning, retype settle opt-out (#385)"
```

---

### Task 8: `device_batch` adoption — settle between steps, escape hatch

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-batch.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (batch step schema: `settle` boolean)
- Test: `scripts/cdp-bridge/test/unit/story-04-fill-batch-settle.test.js` (extend)

**Interfaces:**
- `BatchStep` gains `settle?: boolean` (default true). `executeStep` threads `{ settle: { enabled: step.settle !== false } }` into every `runNative` call it makes for that step (press/fill/swipe/scroll/back paths).
- Inter-step delay default becomes settle-aware: `const delayMs = args.delayMs ?? (settleEnabled(process.env) ? 0 : 300);` — when settle governs stability, the blanket 300 ms inter-step sleep is dead weight; an explicit `delayMs` from the caller is always honored. (`settleEnabled` imported from `../lifecycle/settle.js`. Note: env-gating alone is safe because the snapshot-eq tier works on ALL runners — capability flags only select the cheaper tiers.)
- Produces (pure, for tests): `export function resolveBatchDelayMs(explicit: number | undefined, env: NodeJS.ProcessEnv): number`.

- [ ] **Step 1: Write failing tests**

Append to `story-04-fill-batch-settle.test.js`:

```js
import { resolveBatchDelayMs } from '../../dist/tools/device-batch.js';

test('batch delay: explicit always wins', () => {
  assert.equal(resolveBatchDelayMs(500, {}), 500);
  assert.equal(resolveBatchDelayMs(0, { RN_SETTLE: '0' }), 0);
});

test('batch delay: settle on → 0, settle off → legacy 300', () => {
  assert.equal(resolveBatchDelayMs(undefined, {}), 0);
  assert.equal(resolveBatchDelayMs(undefined, { RN_SETTLE: '0' }), 300);
});
```

Plus a step-threading test using the `_setRunAgentDeviceOverrideForTest` seam (already widened to `(cliArgs, opts)` in Task 7): assert a `press` step with `settle: false` reaches `runNative` with `opts.settle.enabled === false`, and a default `press` step reaches it with `opts.settle.timeoutMs === 2500` (the batch-scoped budget).

- [ ] **Step 2: Run to verify failure**

Run: `npm run build` → missing export; implement.

- [ ] **Step 3: Implement**

`device-batch.ts`:

```ts
import { settleEnabled } from '../lifecycle/settle.js';

export function resolveBatchDelayMs(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
  if (explicit !== undefined) return explicit;
  return settleEnabled(env) ? 0 : 300;
}
```

- `BatchStep` interface: add `settle?: boolean` with a doc comment mirroring the spec ("per-step escape hatch; false skips the post-action settle for this step").
- In `createDeviceBatchHandler` (line 391-399): `const delayMs = resolveBatchDelayMs(args.delayMs, process.env);` replacing the `delayMs = 300` default.
- In `executeStep`: every `runNative([...])` call for press/fill/swipe/scroll/back gains a second arg `stepSettleOpts(step)`:

```ts
// Multi-LLM review S1: batch steps get a LOWER settle budget than standalone
// verbs — a 10-step walk on an animating screen at the 6000ms default would
// take up to ~60s. 2500ms still covers window-gate/screen-static and ~2
// snapshot polls; the per-step timeoutMs override remains available via the
// step's own runNative timeout, and settle:false skips entirely.
const BATCH_STEP_SETTLE_BUDGET_MS = 2500;

function stepSettleOpts(step: BatchStep): { settle: { enabled?: boolean; timeoutMs?: number } } {
  if (step.settle === false) return { settle: { enabled: false } };
  return { settle: { timeoutMs: BATCH_STEP_SETTLE_BUDGET_MS } };
}
```

`index.ts` — batch tool schema: add `settle: z.boolean().optional().describe('Default true. Set false to skip the post-action settle wait for this step (raw speed over stability).')` to the step object schema.

- [ ] **Step 4: Run to verify pass**

Run: `npm run build && node --test test/unit/story-04-fill-batch-settle.test.js` → PASS; `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src scripts/cdp-bridge/test scripts/cdp-bridge/dist
git commit -m "feat(settle): device_batch settles between steps; per-step settle:false hatch (#385)"
```

---

### Task 9: Changeset, docs, full-suite gate

**Files:**
- Create: `.changeset/story-04-settle-engine.md`
- Modify: `docs/stories/04-settle-engine.md` (status line)
- Modify: `CLAUDE.md` (troubleshooting: `RN_SETTLE`)

- [ ] **Step 1: Changeset**

Create `.changeset/story-04-settle-engine.md`:

```md
---
'rn-dev-agent-plugin': minor
---

Story 04 (#385): shared two-tier settle engine. Every mutating device_* verb now waits for the UI to actually stabilize instead of relying on fixed sleeps: Android gates on a new `isWindowUpdating` runner probe (capability `WINDOW_UPDATE`) then falls back to snapshot-hash equality polling; iOS polls a new on-runner `isScreenStatic` SHA-256 screenshot compare (capability `SCREEN_STATIC`, Maestro's 3s screen-settle budget) with the same snapshot-hash fallback. Results surface `meta.settle: {method, settled}` + `meta.timings_ms.settle`. `device_fill` drops its fixed 150ms focus delay when settle ran; `device_batch` settles between steps by default (per-step `settle: false` escape hatch) and its blanket 300ms inter-step delay defaults to 0 while settle is on. Legacy runner artifacts (no new capabilities) transparently degrade to snapshot polling — no rebuild required, the new verbs are deliberately NOT in the required-command gate. Opt out globally with `RN_SETTLE=0` or per batch step with `settle: false`; tune the per-call budget with `settleTimeoutMs` (a budget knob, not a disable switch). A perpetually-animating screen settles via hierarchy stability or returns `method: 'timeout'` at budget — bounded, never hanging.
```

- [ ] **Step 2: Story status + CLAUDE.md**

`docs/stories/04-settle-engine.md` line 3: `**Status:** Implemented (2026-07-04, #385)`.

`CLAUDE.md` Troubleshooting: add a bullet:

```md
- **Taps/fills feel slower after upgrade / want the old fixed-delay behavior** → Story 04 (#385) added a post-action settle: every mutating `device_*` verb waits until the UI is stable (window-gate/screen-static/snapshot-hash, capability-switched per runner; see `meta.settle` + `meta.timings_ms.settle`). On a static screen the overhead is ≤150 ms (Android) / ≤~250 ms (iOS). A perpetually-animating screen (spinner/shimmer) settles via hierarchy stability or returns `meta.settle.method: "timeout"` at budget (default 6 s) — bounded by design. Opt out: `RN_SETTLE=0` (global) or `settle: false` (per batch step); `settleTimeoutMs` tunes the per-call budget (it does not disable settle). Old runner artifacts need NO rebuild — they degrade to snapshot polling (`meta.settle.method: "snapshot-eq"`).
```

- [ ] **Step 3: Full gate**

Run: `cd scripts/cdp-bridge && npm run lint && npm test`
Expected: lint clean, full unit suite green.

- [ ] **Step 4: Commit**

```bash
git add .changeset docs/stories/04-settle-engine.md CLAUDE.md
git commit -m "docs(settle): changeset, story status, RN_SETTLE troubleshooting (#385)"
```

---

## Post-implementation live verification (parent session, NOT a subagent task)

Per the spec's acceptance criteria and repo workflow step 5 — run on booted iOS simulator AND Android emulator with the workspace test-app:

1. `device_snapshot action=open` → `device_press` on a navigation button → assert result `meta.settle.method` ∈ {`screen-static`,`window-gate`,`snapshot-eq`} and the target screen is fully rendered in the next `device_screenshot`.
2. Static-screen overhead: `device_press` on a no-op area ×5, read `meta.timings_ms.settle` — expect ≤150 ms Android (window-gate), ≤~250-400 ms iOS (one screen-static probe ≈ 2 screenshots + 100 ms).
3. Reanimated fixture (Story 03's looping-animation screen): `device_press` → expect `method: 'snapshot-eq'` (hierarchy stable while pixels move) or bounded `method: 'timeout'` — never a hang.
4. `device_batch` TaskWizard walk ×10 consecutive runs on both platforms, `delayMs` omitted — record pass count before/after (spec: zero step-transition races; baseline is flaky without manual waits).
5. `RN_SETTLE=0` smoke: behavior identical to pre-change (no `meta.settle`).
6. Fill-target regression (M2 on-device): `device_snapshot` → `device_fill(@ref)` on a form field where tapping it summons the keyboard (layout shift) → assert the text landed in the INTENDED field (`cdp_component_state` or read-back), and that a subsequent `device_press` on another `@ref` from the settle-refreshed map still resolves correctly.
7. False-settle watch (C2): trigger a transition that changes only non-interactive content (e.g. submit a form that shows a validation-error `Text`) → check whether settle returned before the error text rendered. If it did, file the follow-up for a wider hash node-set — do not silently widen it in this PR.
8. Record timings in the PR body; file follow-ups for any acceptance miss.

## Deferred / explicitly out of scope (log in DECISIONS.md at end-session)

- **Maestro's `adjustedToLatestInteraction` cross-tool budget arithmetic** (spec "Wiring" bullet 4): the engine already shares one budget across its own tiers; propagating "settle ate N ms" into the NEXT tool's lookup budget requires a cross-tool interaction clock — deferred to Story 05 (which adds the re-resolution loop that would consume it). The spec's acceptance criteria do not exercise it.
- **`cdp_interact` (JS-path) settling** — explicitly deferred by the spec itself (line 73).
- **Android `device_fill` clipboard-workaround `sleep(300)`** (device-interact.ts:700) — upstream of the dispatch choke point; candidate follow-up.
- **`interactiveOnly: true` snapshot hashing** — documented deviation from Maestro's full-hierarchy compare (cost); revisit if live verification shows false-settled transitions.

## Known limitations accepted by review (do not "fix" silently — they are documented trade-offs)

Multi-LLM plan review, 2026-07-04. Provenance: Gemini failed (account tier-locked), Antigravity timed out twice at the 10-min cap, Codex quota-paused — so the review was Claude-Opus-only (all findings source-verified), plus codex-pair per-edit review of the plan amendments themselves. Re-run an external cross-check at implementation review time (/multi-review of the diff).

- **C1 — the budget is soft, not hard**: the engine checks remaining budget BEFORE firing a poll, so a poll started near exhaustion still completes; worst case per settle ≈ budget + one snapshot round-trip. Accepted (bounding a live HTTP call mid-flight buys little).
- **C2 — interactive-only hash can false-settle** a transition that only changes non-interactive nodes (e.g. a validation-error `Text` appearing). Tracked in live verification step 7; the fix (full-tree hash or a `salient+static-text` node set) is a follow-up knob, not a redesign.
- **C3 — Android `window-gate: settled` after a `back` that left the app** means "nothing of ours to settle", not "our screen is static" — code comment in the engine (Task 4) covers it.
- **C5 — cold capability cache**: the first mutating verb after a bridge respawn may settle via `snapshot-eq` even on a capable runner (caches fill on the first `/health` probe). Self-corrects within one command; acceptable.
- **iOS `isScreenStatic` skips the activation preamble by design** (mirrors `.screenshot`; the probe always follows an activated mutating verb) — reasoning documented in the Swift code comment (Task 1 Step 5).
