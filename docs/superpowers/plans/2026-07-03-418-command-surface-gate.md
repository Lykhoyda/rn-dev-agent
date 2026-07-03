# #418 Command-Surface Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stale runner build artifact that lacks newer commands is caught by the liveness gate (`missing-commands`), auto-rebuilt at session open, refused fast mid-flow (`RUNNER_COMMANDS_STALE`), and — if a verb ever reaches a runner that doesn't know it — rejected with a typed `UNSUPPORTED_COMMAND` instead of a raw Swift decode error. Includes the root-cause fix for B235: the iOS keyboard-dismiss wire verb never matched the Swift enum.

**Architecture:** Both native runners enumerate their supported commands in `/health.commands` (iOS derives it from `CommandType.allCases`; Android from a `SUPPORTED_COMMANDS` list sync-tested against the dispatcher's `when`). The TS bridge keeps per-platform `REQUIRED_*_COMMANDS` lists in `protocol.ts`; `classifyRunnerCompatibility` gains a `missing-commands` incompatibility reason (strict when the field is absent — every pre-#418 artifact). Remediation is tiered: respawn (cheap, fixes a stale *process*), then artifact invalidation + cold rebuild at `device_snapshot action=open` only (fixes a stale *artifact*), never a silent multi-minute build mid-flow.

**Tech Stack:** TypeScript (Node 22, `node:test`), Swift (XCTest runner), Kotlin (UIAutomator2 runner), changesets.

**Spec:** `docs/superpowers/specs/2026-07-03-418-command-surface-gate-design.md` (committed on this branch).

> **Amendments applied from the multi-LLM plan review (2026-07-03, Codex + Claude Opus coordinator; Gemini CLI unavailable).** BLOCKER 1: Android remediation was non-functional as planned — `resolveAndroidInstallAction` only Gradle-builds when the APKs are ABSENT, so Task 8 now has a real APK-invalidation tier gated behind an open-only flag, and Android `missing-commands` failures surface `RUNNER_COMMANDS_STALE` (not `RUNNER_PROTOCOL_MISMATCH`). BLOCKER 2: `rmSync(DerivedData)` is plugin-checkout-scoped while the device lock is UDID-scoped — Task 7 now reaps before deleting and serializes invalidate+rebuild behind a checkout-scoped mkdir lock, plus a per-plugin-version rebuild budget so a broken checkout can't loop cold builds. SHOULD-FIXes folded in: invalidate-before-first-spawn at open (no wasted stale respawn), raw-value-aware Swift sync regex (Task 5), two additional Android fixture migrations (`runners/rn-android-runner-client.test.js`, `gh-243-android-runner-health.test.js`), stale `dismissKeyboard` reference scrub (Task 1). Rejected on cross-check: exhaustive `satisfies` completeness assertion (REQUIRED is a curated subset by design).

## Global Constraints

- Branch: `feat/418-command-surface-gate` (already checked out; spec committed).
- All TS work under `scripts/cdp-bridge/`. Tests import from `dist/`, so run `npm test` (which runs `tsc` first) — from `scripts/cdp-bridge/`.
- Full suite green after every task: `cd scripts/cdp-bridge && npm test` → ~2612+ pass, 0 fail.
- Use explicit type imports (`import type { ... }`). No unnecessary comments.
- Commits are signed (`git commit -S`), small, one per task, message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- NO protocol version bump — the `/health.commands` field is additive.
- The `capabilities` field keeps feature-flag semantics (`QUIESCENCE_BYPASS`); commands do NOT go there.
- iOS wire verbs after this plan: `tap, type, drag, longPress, pinch, snapshot, screenshot, back, keyboardDismiss`. Android: same but `dismissKeyboard` instead of `keyboardDismiss`.
- `dist/` is tracked — rebuild and stage it in the final task (Task 10), not per-task.

---

### Task 1: Fix the iOS keyboard-dismiss wire verb (B235 root cause)

The TS bridge posts `{command: "dismissKeyboard"}` to the iOS runner, but the Swift enum case has been `keyboardDismiss` since the original import — the explicit iOS keyboard-dismiss path has never decoded on ANY artifact. Fix the verb TS-side so old and new artifacts both accept it.

**Files:**
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts:331-332` (buildRunIOSArgs `case 'keyboard'`)
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:743` (RunIOSArgs command union)
- Test: `scripts/cdp-bridge/test/unit/gh-418-ios-keyboard-verb.test.js`

**Interfaces:**
- Produces: `RunIOSArgs['command']` union member `'keyboardDismiss'` (replaces `'dismissKeyboard'`). Task 2's `REQUIRED_IOS_COMMANDS` includes `'keyboardDismiss'` and is `satisfies`-tied to this union.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-418-ios-keyboard-verb.test.js`:

```js
// GH #418 (B235 root cause): the iOS keyboard-dismiss wire verb must be the
// Swift enum's `keyboardDismiss` — 'dismissKeyboard' has never decoded on any
// iOS artifact. Android's wire verb stays 'dismissKeyboard' (Kotlin when-label).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunIOSArgs, buildRunAndroidArgs } from '../../dist/agent-device-wrapper.js';

test('gh-418: iOS keyboard CLI verb maps to keyboardDismiss on the wire', () => {
  assert.equal(buildRunIOSArgs(['keyboard']).command, 'keyboardDismiss');
});

test('gh-418: Android keyboard CLI verbs keep dismissKeyboard on the wire', () => {
  assert.equal(buildRunAndroidArgs(['keyboard']).command, 'dismissKeyboard');
  assert.equal(buildRunAndroidArgs(['dismissKeyboard']).command, 'dismissKeyboard');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-ios-keyboard-verb.test.js`
Expected: FAIL — `'dismissKeyboard' !== 'keyboardDismiss'` on the first test.

- [ ] **Step 3: Fix the verb in both files**

In `scripts/cdp-bridge/src/agent-device-wrapper.ts` (the `case 'keyboard':` inside `buildRunIOSArgs`), change:

```ts
    case 'keyboard':
      return { command: 'dismissKeyboard', ...(bundleId ? { bundleId } : {}) };
```

to:

```ts
    case 'keyboard':
      // B235/#418: the Swift enum case is keyboardDismiss; 'dismissKeyboard'
      // (the Android wire verb) never decoded on iOS.
      return { command: 'keyboardDismiss', ...(bundleId ? { bundleId } : {}) };
```

In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (RunIOSArgs union), change the member `| 'dismissKeyboard'` to `| 'keyboardDismiss'`.

Leave `buildRunAndroidArgs` (`case 'keyboard': case 'dismissKeyboard':` → `'dismissKeyboard'`) untouched.

Also scrub the two stale references that would invite the bad verb back (review NICE-TO-HAVE): the historical-endpoints comment near `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:461` (change `/dismissKeyboard` to `/keyboardDismiss` in the comment) and `scripts/rn-fast-runner/IMPORT_NOTES.md:13` (annotate that the iOS wire verb is `keyboardDismiss`).

- [ ] **Step 4: Run tests to verify they pass (and nothing else broke)**

Run: `cd scripts/cdp-bridge && npm test`
Expected: all pass (the pre-existing suite has no assertion on the old iOS verb — verified via `grep -rln dismissKeyboard test/` → no matches; if `tsc` flags any other `'dismissKeyboard'` usage typed against RunIOSArgs, update it to `'keyboardDismiss'`).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/test/unit/gh-418-ios-keyboard-verb.test.js
git commit -S -m "fix(device): iOS keyboard-dismiss wire verb is keyboardDismiss, not dismissKeyboard (B235 root cause, #418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: protocol.ts — REQUIRED command lists + `missing-commands` classification + error codes

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/protocol.ts`
- Modify: `scripts/cdp-bridge/src/types.ts:214` (ToolErrorCode union)
- Test: `scripts/cdp-bridge/test/unit/gh-418-command-surface-classify.test.js`

**Interfaces:**
- Consumes: `RunIOSArgs['command']` from Task 1; `RunAndroidArgs['command']` (existing).
- Produces:
  - `export const REQUIRED_IOS_COMMANDS: readonly string[]` / `REQUIRED_ANDROID_COMMANDS` (protocol.ts)
  - `classifyRunnerCompatibility(health: { protocolVersion?: number; runnerVersion?: string; commands?: string[] }, pluginVersion: string | null, requiredCommands?: readonly string[]): RunnerCompatibility` — third param optional, so all existing call sites keep compiling.
  - `RunnerIncompatibilityReason` gains `'missing-commands'`; the `compatible: false` branch gains `missing?: string[]`.
  - `ToolErrorCode` gains `'UNSUPPORTED_COMMAND'` and `'RUNNER_COMMANDS_STALE'`.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-418-command-surface-classify.test.js`:

```js
// GH #418: classifier matrix for the command-surface check. Strict on absence:
// a runner not advertising `commands` (every pre-#418 artifact) is
// 'missing-commands' with the full required list as `missing`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRunnerCompatibility,
  REQUIRED_IOS_COMMANDS,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

const FULL = [...REQUIRED_IOS_COMMANDS];

test('gh-418 classify: commands ⊇ required → compatible', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, commands: FULL }, null, REQUIRED_IOS_COMMANDS),
    { compatible: true },
  );
});

test('gh-418 classify: extra advertised commands are fine', () => {
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, commands: [...FULL, 'rotate', 'alert'] },
      null,
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: true },
  );
});

test('gh-418 classify: one missing verb → missing-commands naming it', () => {
  const withoutKeyboard = FULL.filter((c) => c !== 'keyboardDismiss');
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, commands: withoutKeyboard },
      null,
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: false, reason: 'missing-commands', missing: ['keyboardDismiss'] },
  );
});

test('gh-418 classify: absent commands field → missing-commands with full list (strict)', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1 }, null, REQUIRED_IOS_COMMANDS),
    { compatible: false, reason: 'missing-commands', missing: FULL },
  );
});

test('gh-418 classify: no requiredCommands param → commands not enforced (back-compat)', () => {
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, null), {
    compatible: true,
  });
});

test('gh-418 classify: protocol/skew reasons win over missing-commands', () => {
  assert.deepEqual(classifyRunnerCompatibility({}, null, REQUIRED_IOS_COMMANDS), {
    compatible: false,
    reason: 'legacy',
  });
  assert.deepEqual(
    classifyRunnerCompatibility(
      { protocolVersion: 1, runnerVersion: '0.0.1' },
      '0.99.0',
      REQUIRED_IOS_COMMANDS,
    ),
    { compatible: false, reason: 'version-skew' },
  );
});

test('gh-418: REQUIRED lists cover both platforms, non-empty, keyboard verbs differ', () => {
  assert.ok(REQUIRED_IOS_COMMANDS.includes('keyboardDismiss'));
  assert.ok(!REQUIRED_IOS_COMMANDS.includes('dismissKeyboard'));
  assert.ok(REQUIRED_ANDROID_COMMANDS.includes('dismissKeyboard'));
  assert.ok(REQUIRED_IOS_COMMANDS.length >= 9 && REQUIRED_ANDROID_COMMANDS.length >= 9);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-command-surface-classify.test.js`
Expected: FAIL — build error (`REQUIRED_IOS_COMMANDS` not exported) or missing-commands cases failing.

- [ ] **Step 3: Implement in protocol.ts and types.ts**

In `scripts/cdp-bridge/src/runners/protocol.ts`, extend the reason/compat types and classifier, and add the lists (type-only imports of the client unions — safe despite the runtime import cycle direction, since `import type` is erased):

```ts
import type { RunIOSArgs } from './rn-fast-runner-client.js';
import type { RunAndroidArgs } from './rn-android-runner-client.js';

export type RunnerIncompatibilityReason =
  | 'legacy'
  | 'protocol-older'
  | 'protocol-newer'
  | 'version-skew'
  | 'missing-commands';

export type RunnerCompatibility =
  | { compatible: true }
  | { compatible: false; reason: RunnerIncompatibilityReason; missing?: string[] };

// GH #418: every wire verb the bridge can POST to each runner's /command.
// The satisfies tie makes "verb added to the client union but not here" a
// compile error; gh-418-command-surface-sync.test.js enforces the native side.
export const REQUIRED_IOS_COMMANDS = [
  'tap',
  'type',
  'drag',
  'longPress',
  'pinch',
  'snapshot',
  'screenshot',
  'back',
  'keyboardDismiss',
] as const satisfies readonly RunIOSArgs['command'][];

export const REQUIRED_ANDROID_COMMANDS = [
  'tap',
  'type',
  'drag',
  'longPress',
  'pinch',
  'snapshot',
  'screenshot',
  'back',
  'dismissKeyboard',
] as const satisfies readonly RunAndroidArgs['command'][];

export function classifyRunnerCompatibility(
  health: { protocolVersion?: number; runnerVersion?: string; commands?: string[] },
  pluginVersion: string | null,
  requiredCommands?: readonly string[],
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
  // GH #418: strict on absence — an artifact that doesn't enumerate commands
  // predates enumeration and by definition predates any newer verb.
  if (requiredCommands !== undefined) {
    const advertised = new Set(health.commands ?? []);
    const missing = requiredCommands.filter((c) => !advertised.has(c));
    if (missing.length > 0) {
      return { compatible: false, reason: 'missing-commands', missing };
    }
  }
  return { compatible: true };
}
```

(Keep `RUNNER_PROTOCOL_VERSION`, `MIN_SUPPORTED_RUNNER_PROTOCOL`, `getPluginVersion`, `_setPluginVersionForTest` unchanged.)

In `scripts/cdp-bridge/src/types.ts`, extend the ToolErrorCode union (append after the `'INVALID_APPID'` block, matching the file's comment style):

```ts
  // GH #418: command-surface gate.
  | 'UNSUPPORTED_COMMAND' // runner rejected a verb its artifact predates (typed by the runner)
  | 'RUNNER_COMMANDS_STALE' // liveness gate: artifact lacks required commands; re-open to rebuild
```

- [ ] **Step 4: Run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-command-surface-classify.test.js && node --test test/unit/gh-383-protocol-sync.test.js`
Expected: both PASS (gh-383 classify tests keep passing — the third param is optional).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/protocol.ts scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/test/unit/gh-418-command-surface-classify.test.js
git commit -S -m "feat(protocol): REQUIRED command lists + missing-commands classification + typed codes (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Swift runner — CaseIterable, /health.commands, typed UNSUPPORTED_COMMAND

**Files:**
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift` (enum + Response)
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift` (health emission + pre-decode)
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandSurfaceTests.swift` (the UITests target uses `PBXFileSystemSynchronizedRootGroup` — new files are picked up without a pbxproj edit)

**Interfaces:**
- Produces (wire): `/health` gains `commands: [String]` (= `CommandType.allCases.map(\.rawValue)`); unknown `/command` verb returns `{ok:false, error:{code:"UNSUPPORTED_COMMAND", message:"Unsupported iOS runner command: <verb> — …"}}` with HTTP 200. Tasks 5/6 consume both.

- [ ] **Step 1: Write the failing Swift test**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandSurfaceTests.swift`:

```swift
import XCTest

// GH #418: the compiled CommandType enum IS the iOS command surface. These
// pure-logic tests pin the bridge-required verbs and the alias trap (B235).
final class CommandSurfaceTests: XCTestCase {
  func testAllCasesCoverBridgeRequiredVerbs() {
    let advertised = Set(CommandType.allCases.map(\.rawValue))
    let required: Set<String> = [
      "tap", "type", "drag", "longPress", "pinch",
      "snapshot", "screenshot", "back", "keyboardDismiss",
    ]
    XCTAssertTrue(
      required.isSubset(of: advertised),
      "CommandType missing: \(required.subtracting(advertised))"
    )
  }

  func testAndroidKeyboardVerbIsNotAnIOSCase() {
    XCTAssertNil(CommandType(rawValue: "dismissKeyboard"))
    XCTAssertNil(CommandType(rawValue: "definitelyBogusVerb"))
  }
}
```

(This fails to COMPILE until `CommandType` adopts `CaseIterable` — that is the failing state.)

- [ ] **Step 2: Verify it fails to build**

Run (works without a booted simulator):
```bash
cd scripts/rn-fast-runner/RnFastRunner && xcodebuild build-for-testing \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath ../build/DerivedData-taskcheck 2>&1 | tail -5
```
Expected: BUILD FAILED — `type 'CommandType' has no member 'allCases'`.

- [ ] **Step 3: Implement the Swift changes**

In `RnFastRunnerTests+Models.swift`:

1. Enum declaration: `enum CommandType: String, Codable {` → `enum CommandType: String, Codable, CaseIterable {`
2. `Response` gains a `commands` field. Full updated struct (only `commands` lines are new):

```swift
struct Response: Codable {
  let ok: Bool
  let v: Int
  let protocolVersion: Int?
  let runnerVersion: String?
  let capabilities: [String]?
  let commands: [String]?
  let data: DataPayload?
  let error: ErrorPayload?

  init(
    ok: Bool,
    data: DataPayload? = nil,
    error: ErrorPayload? = nil,
    protocolVersion: Int? = nil,
    runnerVersion: String? = nil,
    capabilities: [String]? = nil,
    commands: [String]? = nil
  ) {
    self.ok = ok
    self.v = RunnerProtocol.version
    self.data = data
    self.error = error
    self.protocolVersion = protocolVersion
    self.runnerVersion = runnerVersion
    self.capabilities = capabilities
    self.commands = commands
  }
}
```

In `RnFastRunnerTests+Transport.swift`:

1. Health response (inside `if self.isHealthRequest(combined)`), add the `commands` argument:

```swift
        let response = self.jsonResponse(
          status: 200,
          response: Response(
            ok: true,
            protocolVersion: RunnerProtocol.version,
            runnerVersion: RunnerEnv.pluginVersion(),
            capabilities: QuiescenceStatus.current().capabilities,
            commands: CommandType.allCases.map(\.rawValue)
          )
        )
```

2. In `handleRequestBody`, pre-decode the verb before the full `Command` decode. Insert immediately before the existing `do { let command = try JSONDecoder().decode(Command.self, from: data)` block:

```swift
    struct CommandTypeProbe: Decodable { let command: String }
    if let probe = try? JSONDecoder().decode(CommandTypeProbe.self, from: data),
       CommandType(rawValue: probe.command) == nil {
      // GH #418: a verb this artifact doesn't know is a typed refusal, not a
      // dataCorrupted decode error (B235). Mirrors the Android runner's shape.
      return (
        jsonResponse(status: 200, response: Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_COMMAND",
            message: "Unsupported iOS runner command: \(probe.command) — the runner artifact predates it; re-open the device session (device_snapshot action=open) to rebuild."
          )
        )),
        false
      )
    }
```

(Any OTHER decode failure — malformed JSON, wrong field types — keeps today's 500 + raw error behavior.)

- [ ] **Step 4: Verify it builds**

Run the same `xcodebuild build-for-testing` command as Step 2.
Expected: `** TEST BUILD SUCCEEDED **`. Then remove the throwaway DerivedData: `rm -rf scripts/rn-fast-runner/build/DerivedData-taskcheck`. (Running `CommandSurfaceTests` live happens in Task 11 alongside device verification; the compile gate is the fast check here.)

- [ ] **Step 5: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Models.swift scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/CommandSurfaceTests.swift
git commit -S -m "feat(rn-fast-runner): enumerate commands in /health + typed UNSUPPORTED_COMMAND (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Kotlin runner — SUPPORTED_COMMANDS + /health.commands

**Files:**
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt`
- Modify: `scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt`

**Interfaces:**
- Produces (wire): Android `/health` gains `commands: [...]` from `CommandDispatcher.SUPPORTED_COMMANDS`. Task 5's sync test asserts the list equals the dispatch `when`-labels; Task 8 consumes the field TS-side.

- [ ] **Step 1: Add the list to CommandDispatcher**

The Android runner has no JVM unit-test source set, so the failing check for this task is the Task 5 sync test; here the compile gate is the verification. Add a companion object to `CommandDispatcher` (immediately after the class's `init` block):

```kotlin
    companion object {
        // GH #418: advertised in /health.commands. The Node sync test
        // (cdp-bridge test/unit/gh-418-command-surface-sync.test.js) enforces
        // that this list exactly matches the dispatch when-branches below.
        val SUPPORTED_COMMANDS = listOf(
            "snapshot", "tap", "press", "type", "fill", "drag", "swipe", "scroll",
            "screenshot", "back", "dismissKeyboard", "keyboard", "longPress",
            "pinch", "findText",
        )
    }
```

- [ ] **Step 2: Emit it from /health in CommandServer**

In `CommandServer.kt`, the `/health` body currently reads:

```kotlin
            val body = JSONObject()
                .put("ok", true)
                .put("protocolVersion", RunnerProtocol.VERSION)
                .put("capabilities", JSONArray())
```

Change to:

```kotlin
            val body = JSONObject()
                .put("ok", true)
                .put("protocolVersion", RunnerProtocol.VERSION)
                .put("capabilities", JSONArray())
                .put("commands", JSONArray(CommandDispatcher.SUPPORTED_COMMANDS))
```

- [ ] **Step 3: Compile check**

Run: `cd scripts/rn-android-runner && ./gradlew :app:assembleDebugAndroidTest -q`
Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt scripts/rn-android-runner/app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandServer.kt
git commit -S -m "feat(rn-android-runner): enumerate supported commands in /health (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Tri-file command-surface sync test

**Files:**
- Test (create): `scripts/cdp-bridge/test/unit/gh-418-command-surface-sync.test.js`

**Interfaces:**
- Consumes: `REQUIRED_IOS_COMMANDS` / `REQUIRED_ANDROID_COMMANDS` (Task 2), Swift enum (Task 3), Kotlin list + when-labels (Task 4).

- [ ] **Step 1: Write the test (passing if Tasks 1–4 are correct — it's the drift guard)**

```js
// GH #418: the runner command surface exists in THREE places — the Swift
// CommandType enum (iOS), the Kotlin SUPPORTED_COMMANDS list (Android, which
// must itself match the dispatcher when-branches), and the TS REQUIRED_*
// lists the liveness gate enforces. Source-parsing guard, gh-383-sync style.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_IOS_COMMANDS,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SWIFT_MODELS = join(
  BRIDGE_ROOT, '..', 'rn-fast-runner', 'RnFastRunner', 'RnFastRunnerUITests',
  'RnFastRunnerTests+Models.swift',
);
const KOTLIN_DISPATCHER = join(
  BRIDGE_ROOT, '..', 'rn-android-runner', 'app', 'src', 'androidTest', 'java',
  'dev', 'lykhoyda', 'rndevagent', 'androidrunner', 'CommandDispatcher.kt',
);

function swiftEnumRawValues() {
  const src = readFileSync(SWIFT_MODELS, 'utf8');
  const block = src.match(/enum CommandType[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'CommandType enum block not found in Models.swift');
  // Review amendment: /health advertises .rawValue, so parse explicit raw
  // values (`case foo = "bar"` → "bar"), falling back to the case name.
  return [...block[1].matchAll(/case (\w+)(?:\s*=\s*"([^"]+)")?/g)].map((m) => m[2] ?? m[1]);
}

function kotlinSupportedList() {
  const src = readFileSync(KOTLIN_DISPATCHER, 'utf8');
  const m = src.match(/val SUPPORTED_COMMANDS = listOf\(([\s\S]*?)\)/);
  assert.ok(m, 'SUPPORTED_COMMANDS not found in CommandDispatcher.kt');
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
}

function kotlinWhenLabels() {
  const src = readFileSync(KOTLIN_DISPATCHER, 'utf8');
  const labels = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*((?:"\w+",\s*)*"\w+")\s*->/);
    if (m) labels.push(...[...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));
  }
  assert.ok(labels.length > 0, 'no dispatch when-labels found in CommandDispatcher.kt');
  return labels;
}

test('gh-418 sync: Swift CommandType raw values cover REQUIRED_IOS_COMMANDS', () => {
  const rawValues = new Set(swiftEnumRawValues());
  const missing = REQUIRED_IOS_COMMANDS.filter((c) => !rawValues.has(c));
  assert.deepEqual(missing, [], `Swift enum missing: ${missing.join(', ')}`);
});

test('gh-418 sync: Kotlin SUPPORTED_COMMANDS == dispatch when-labels', () => {
  assert.deepEqual(
    [...new Set(kotlinSupportedList())].sort(),
    [...new Set(kotlinWhenLabels())].sort(),
  );
});

test('gh-418 sync: Kotlin SUPPORTED_COMMANDS covers REQUIRED_ANDROID_COMMANDS', () => {
  const supported = new Set(kotlinSupportedList());
  const missing = REQUIRED_ANDROID_COMMANDS.filter((c) => !supported.has(c));
  assert.deepEqual(missing, [], `Kotlin list missing: ${missing.join(', ')}`);
});

test('gh-418 sync: REQUIRED lists have no duplicates', () => {
  for (const list of [REQUIRED_IOS_COMMANDS, REQUIRED_ANDROID_COMMANDS]) {
    assert.equal(new Set(list).size, list.length);
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-command-surface-sync.test.js`
Expected: PASS (4 tests). Sanity-check the guard bites: temporarily remove `"pinch"` from the Kotlin `SUPPORTED_COMMANDS`, re-run, expect the `==` test to FAIL, then restore it.

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/test/unit/gh-418-command-surface-sync.test.js
git commit -S -m "test(sync): tri-file command-surface drift guard (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: iOS probe parses commands; liveness gate classifies missing-commands

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (HttpProbeResult, defaultHttpProbe, FastRunnerLivenessDetail, probeFastRunnerLivenessDetailed)
- Modify (test migration): `scripts/cdp-bridge/test/unit/fast-runner-liveness.test.js`, `scripts/cdp-bridge/test/unit/gh-383-ios-protocol-gate.test.js`, `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` — every injected `httpProbe` body that expects `'alive'` must now advertise the required commands.
- Test (create): `scripts/cdp-bridge/test/unit/gh-418-ios-command-gate.test.js`

**Interfaces:**
- Consumes: `classifyRunnerCompatibility(health, plugin, REQUIRED_IOS_COMMANDS)` and `REQUIRED_IOS_COMMANDS` (Task 2).
- Produces: `HttpProbeResult.commands?: string[]`; `FastRunnerLivenessDetail.missingCommands?: string[]` (set only when `staleReason === 'missing-commands'`). Task 7 and Task 9 consume `missingCommands`.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-418-ios-command-gate.test.js`:

```js
// GH #418: the iOS liveness gate is strict about the command surface — a
// healthy, protocol-current runner that does not advertise every
// REQUIRED_IOS_COMMANDS verb is 'stale'/'missing-commands'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeFastRunnerLivenessDetailed,
  runIOS,
  _setRunnerStateForTest,
  _setFetchForTest,
} from '../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS } from '../../dist/runners/protocol.js';

const STATE = { pid: 1, port: 22088, deviceId: 'U1', bundleId: 'com.example' };
const deps = (probeBody, plugin = '0.99.0') => ({
  getState: () => STATE,
  processAlive: () => true,
  httpProbe: async () => probeBody,
  clearState: () => {},
  pluginVersion: plugin,
});
const HEALTHY = { ok: true, status: 200, bodyOk: true, protocolVersion: 1 };

test('gh-418 gate: full command surface → alive', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ...HEALTHY, commands: [...REQUIRED_IOS_COMMANDS] }),
  );
  assert.equal(d.liveness, 'alive');
});

test('gh-418 gate: absent commands field (pre-#418 artifact) → stale/missing-commands, full list', async () => {
  const d = await probeFastRunnerLivenessDetailed(deps({ ...HEALTHY }));
  assert.equal(d.liveness, 'stale');
  assert.equal(d.staleReason, 'missing-commands');
  assert.deepEqual(d.missingCommands, [...REQUIRED_IOS_COMMANDS]);
});

test('gh-418 gate: one verb missing → stale naming exactly it', async () => {
  const d = await probeFastRunnerLivenessDetailed(
    deps({ ...HEALTHY, commands: REQUIRED_IOS_COMMANDS.filter((c) => c !== 'keyboardDismiss') }),
  );
  assert.equal(d.staleReason, 'missing-commands');
  assert.deepEqual(d.missingCommands, ['keyboardDismiss']);
});

test('gh-418: runIOS surfaces the runner-typed UNSUPPORTED_COMMAND (spec §4 passthrough)', async () => {
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  _setFetchForTest(async () => ({
    json: async () => ({
      ok: false,
      v: 1,
      error: {
        code: 'UNSUPPORTED_COMMAND',
        message: 'Unsupported iOS runner command: bogus — the runner artifact predates it.',
      },
    }),
  }));
  try {
    const res = await runIOS({ command: 'back' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /UNSUPPORTED_COMMAND/);
    assert.match(res.content[0].text, /artifact predates/);
  } finally {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
  }
});
```

(No production change is needed for this passthrough — `runIOS` already forwards `resp.error.code` into `failResult(message, code)`; adding `'UNSUPPORTED_COMMAND'` to ToolErrorCode in Task 2 makes it type-honest, and this test pins the behavior.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-ios-command-gate.test.js`
Expected: FAIL — absent-commands probe currently returns `'alive'`.

- [ ] **Step 3: Implement in rn-fast-runner-client.ts**

1. `HttpProbeResult` gains `commands?: string[]`.
2. `defaultHttpProbe`: mirror the existing `capabilities` parsing for `commands` — add `commands?: unknown;` to the parsed body type, then:

```ts
      let commands: string[] | undefined;
      // …inside the try after capabilities parsing:
      if (Array.isArray(body.commands)) {
        commands = body.commands.filter((c): c is string => typeof c === 'string');
      }
```
and spread `...(commands !== undefined ? { commands } : {})` into the returned object.
3. `FastRunnerLivenessDetail` gains `missingCommands?: string[]`.
4. `probeFastRunnerLivenessDetailed`: import `REQUIRED_IOS_COMMANDS` from `./protocol.js` (extend the existing import) and change the classify call + stale return:

```ts
    const compat = classifyRunnerCompatibility(
      {
        ...(res.protocolVersion !== undefined ? { protocolVersion: res.protocolVersion } : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
        ...(res.commands !== undefined ? { commands: res.commands } : {}),
      },
      plugin,
      REQUIRED_IOS_COMMANDS,
    );
    if (!compat.compatible) {
      return {
        liveness: 'stale',
        staleReason: compat.reason,
        ...(compat.missing !== undefined ? { missingCommands: compat.missing } : {}),
        ...(res.protocolVersion !== undefined
          ? { runnerProtocolVersion: res.protocolVersion }
          : {}),
        ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      };
    }
```

- [ ] **Step 4: Migrate the three probe-body test files**

Every injected probe body that the test expects to classify `'alive'` must now include the commands. In each of `fast-runner-liveness.test.js`, `gh-383-ios-protocol-gate.test.js`, `runners/gh-384-quiescence.test.js`: import `REQUIRED_IOS_COMMANDS` from `'../../dist/runners/protocol.js'` (adjust relative depth for `runners/`), and add `commands: [...REQUIRED_IOS_COMMANDS]` to those bodies (e.g. gh-383's "healthy + matching protocol + version → alive" test). Bodies that expect stale/legacy/skew outcomes stay untouched — their earlier-reason classification already wins. Where a test asserts the full detail object with `deepEqual`, extend the expectation rather than loosening the assertion.

- [ ] **Step 5: Run the full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: all pass — any remaining failure is an unmigrated probe body; fix it the same way.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts scripts/cdp-bridge/test/unit/gh-418-ios-command-gate.test.js scripts/cdp-bridge/test/unit/fast-runner-liveness.test.js scripts/cdp-bridge/test/unit/gh-383-ios-protocol-gate.test.js scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js
git commit -S -m "feat(ios-gate): classify runners missing required commands as stale (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Tiered remediation — artifact invalidation at open, RUNNER_COMMANDS_STALE mid-flow

**Files:**
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts` (PROTOCOL_STALE_REASONS, EnsureRunnerDeps, ensureRunnerForCommand)
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts:267` (pass `allowArtifactRebuild: true`)
- Test (create): `scripts/cdp-bridge/test/unit/gh-418-remediation.test.js`

**Interfaces:**
- Consumes: `FastRunnerLivenessDetail.missingCommands` (Task 6); `derivedDataPathForRunner()` (already imported in the wrapper); `'RUNNER_COMMANDS_STALE'` ToolErrorCode (Task 2).
- Produces:
  - In `rn-fast-runner-client.ts`: `acquireRunnerRebuildLock(): boolean` / `releaseRunnerRebuildLock(): void` (checkout-scoped mkdir mutex at `<FAST_RUNNER_PROJECT>/build/.rebuild-lock`, stale takeover after 15 min, fail-open on fs errors) and `runnerRebuildBudget: { alreadyRebuiltFor(v: string): boolean; recordRebuild(v: string): void }` (JSON at `<FAST_RUNNER_PROJECT>/build/commands-rebuild.json` — sibling of DerivedData, so it survives the invalidation).
  - `EnsureRunnerDeps` gains `allowArtifactRebuild?: boolean`, `invalidateArtifact?: () => void`, `reap?: () => Promise<void>`, `acquireBuildLock?: () => boolean`, `releaseBuildLock?: () => void`, `rebuildBudget?: { alreadyRebuiltFor(v: string): boolean; recordRebuild(v: string): void }`, `pluginVersion?: string | null` (test seams; production defaults are the client helpers / `getPluginVersion()`).
  - `ensureRunnerForCommand` returns `{ok:true, note:'runner artifact rebuilt (missing commands: …)'}` on the rebuild path and `{ok:false, code:'RUNNER_COMMANDS_STALE', …}` on every refusal (mid-flow, budget-spent, lock-busy, still-stale-after-rebuild). `device-session.ts` already surfaces `ready.note` as `upgradeNote` — no extra plumbing there beyond the flag.

- [ ] **Step 1: Write the failing tests**

Create `scripts/cdp-bridge/test/unit/gh-418-remediation.test.js`:

```js
// GH #418: 'missing-commands' remediation is tiered. Mid-flow callers refuse
// fast with RUNNER_COMMANDS_STALE (a respawn can't fix a stale ARTIFACT); only
// device_snapshot action=open (allowArtifactRebuild) invalidates DerivedData
// and pays the cold rebuild — reap-first, behind a checkout-scoped build lock,
// at most once per plugin version (multi-LLM review amendments).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';

const MISSING = {
  liveness: 'stale',
  staleReason: 'missing-commands',
  missingCommands: ['keyboardDismiss'],
};
const freshBudget = () => {
  const rebuilt = new Set();
  return {
    alreadyRebuiltFor: (v) => rebuilt.has(v),
    recordRebuild: (v) => rebuilt.add(v),
  };
};
const base = () => ({
  prebuilt: () => true,
  adopt: () => {},
  reap: async () => {},
  acquireBuildLock: () => true,
  releaseBuildLock: () => {},
  rebuildBudget: freshBudget(),
  pluginVersion: '0.99.0',
});

test('gh-418: mid-flow, missing-commands survives respawn → RUNNER_COMMANDS_STALE, no invalidation', async () => {
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /keyboardDismiss/);
  assert.match(res.message, /device_snapshot action=open/);
});

test('gh-418: mid-flow, respawn fixes a stale process → ok + upgrade note, no invalidation', async () => {
  const probes = [MISSING, { liveness: 'alive' }];
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => probes.shift(),
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (stale command surface)' });
});

test('gh-418: at open, invalidate FIRST (no wasted stale respawn) → single ensure + rebuilt note', async () => {
  const probes = [MISSING, { liveness: 'alive' }];
  let invalidated = 0;
  let ensured = 0;
  let reaped = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    probe: async () => probes.shift(),
    ensure: async () => {
      ensured++;
    },
    reap: async () => {
      reaped++;
    },
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(reaped, 1);
  assert.equal(invalidated, 1);
  assert.equal(ensured, 1);
  assert.deepEqual(res, {
    ok: true,
    note: 'runner artifact rebuilt (missing commands: keyboardDismiss)',
  });
});

test('gh-418: at open, rebuild budget already spent for this plugin version → refuse, no invalidation', async () => {
  const budget = freshBudget();
  budget.recordRebuild('0.99.0');
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    rebuildBudget: budget,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /already cold-rebuilt/i);
});

test('gh-418: at open, build lock held by another session → refuse, no invalidation', async () => {
  let invalidated = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    acquireBuildLock: () => false,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => invalidated++,
  });
  assert.equal(invalidated, 0);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /another session/i);
});

test('gh-418: at open, even a cold rebuild misses commands → RUNNER_COMMANDS_STALE naming plugin update', async () => {
  let released = 0;
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    allowArtifactRebuild: true,
    releaseBuildLock: () => released++,
    probe: async () => MISSING,
    ensure: async () => {},
    invalidateArtifact: () => {},
  });
  assert.equal(released, 1, 'lock must be released even on failure');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RUNNER_COMMANDS_STALE');
  assert.match(res.message, /update the plugin/i);
});

test('gh-418: protocol reasons keep the existing note and error path', async () => {
  const probes = [{ liveness: 'stale', staleReason: 'legacy' }, { liveness: 'alive' }];
  const res = await ensureRunnerForCommand('U1', 'com.example', {
    ...base(),
    probe: async () => probes.shift(),
    ensure: async () => {},
  });
  assert.deepEqual(res, { ok: true, note: 'runner upgraded (protocol/version mismatch)' });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-remediation.test.js`
Expected: FAIL — no `invalidateArtifact` support, missing-commands falls into the RUNNER_PROTOCOL_MISMATCH branch or the generic not-ready error.

- [ ] **Step 3: Implement — lock + budget helpers in the client, tiered logic in the wrapper**

1. In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`, add the checkout-scoped rebuild lock and budget (near `derivedDataPathForRunner`; `mkdirSync`/`rmSync`/`statSync`/`readFileSync`/`writeFileSync` from the existing `node:fs` imports):

```ts
// GH #418 (review amendment): DerivedData is plugin-checkout-scoped while the
// device lock is UDID-scoped, so two projects sharing this checkout could race
// invalidate-vs-build. mkdir is atomic — it is the mutex. Fail-open on fs
// errors (never block a legit session); stale takeover after 15 min.
const REBUILD_LOCK_DIR = join(FAST_RUNNER_PROJECT, 'build', '.rebuild-lock');
const REBUILD_LOCK_STALE_MS = 15 * 60_000;

export function acquireRunnerRebuildLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(REBUILD_LOCK_DIR, { recursive: false });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true; // fail-open
      try {
        const age = Date.now() - statSync(REBUILD_LOCK_DIR).mtimeMs;
        if (age < REBUILD_LOCK_STALE_MS) return false;
        rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
      } catch {
        return true; // fail-open
      }
    }
  }
  return false;
}

export function releaseRunnerRebuildLock(): void {
  try {
    rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// GH #418 (review amendment): at most ONE commands-triggered cold rebuild per
// plugin version — a genuinely-broken checkout must not loop multi-minute
// builds on every open. Lives in build/ (sibling of DerivedData) so the
// invalidation itself can't erase it.
const REBUILD_BUDGET_FILE = join(FAST_RUNNER_PROJECT, 'build', 'commands-rebuild.json');

export const runnerRebuildBudget = {
  alreadyRebuiltFor(pluginVersion: string): boolean {
    try {
      const parsed = JSON.parse(readFileSync(REBUILD_BUDGET_FILE, 'utf8')) as {
        pluginVersion?: string;
      };
      return parsed.pluginVersion === pluginVersion;
    } catch {
      return false;
    }
  },
  recordRebuild(pluginVersion: string): void {
    try {
      mkdirSync(join(FAST_RUNNER_PROJECT, 'build'), { recursive: true });
      writeFileSync(
        REBUILD_BUDGET_FILE,
        JSON.stringify({ pluginVersion, at: new Date().toISOString() }),
      );
    } catch {
      /* fail-open */
    }
  },
};
```

2. In `agent-device-wrapper.ts`: add `'missing-commands'` to `PROTOCOL_STALE_REASONS`; import `rmSync` from `node:fs` and `acquireRunnerRebuildLock`, `releaseRunnerRebuildLock`, `runnerRebuildBudget` from the client. Extend `EnsureRunnerDeps`:

```ts
export interface EnsureRunnerDeps {
  probe?: () => Promise<FastRunnerLivenessDetail>;
  ensure?: (deviceId: string, bundleId: string) => Promise<void>;
  prebuilt?: () => boolean;
  adopt?: (deviceId: string | undefined) => void;
  /** GH #418: open-path only — permits DerivedData invalidation + cold rebuild. */
  allowArtifactRebuild?: boolean;
  /** GH #418: test seams for the rebuild tier. */
  invalidateArtifact?: () => void;
  reap?: () => Promise<void>;
  acquireBuildLock?: () => boolean;
  releaseBuildLock?: () => void;
  rebuildBudget?: { alreadyRebuiltFor(v: string): boolean; recordRebuild(v: string): void };
  pluginVersion?: string | null;
}
```

3. New module-private helper in `agent-device-wrapper.ts` — the open-path rebuild tier (invalidate FIRST; a respawn launches the same stale `.xctestrun`, so it would be a wasted multi-second launch — review amendment):

```ts
async function rebuildStaleRunnerArtifact(
  first: FastRunnerLivenessDetail,
  deviceId: string,
  bundleId: string,
  deps: EnsureRunnerDeps,
): Promise<EnsureRunnerResult> {
  const missing = (first.missingCommands ?? []).join(', ') || 'unknown';
  const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
  const budget = deps.rebuildBudget ?? runnerRebuildBudget;
  if (plugin !== null && budget.alreadyRebuiltFor(plugin)) {
    return {
      ok: false,
      code: 'RUNNER_COMMANDS_STALE',
      message:
        `rn-fast-runner was already cold-rebuilt once for plugin v${plugin} and still lacks ` +
        `required commands (missing: ${missing}) — the checkout may be broken; update or ` +
        `reinstall the plugin, then re-open the device session.`,
    };
  }
  const acquire = deps.acquireBuildLock ?? acquireRunnerRebuildLock;
  if (!acquire()) {
    return {
      ok: false,
      code: 'RUNNER_COMMANDS_STALE',
      message:
        'another session is rebuilding the shared runner artifact — retry this open in a few minutes.',
    };
  }
  const release = deps.releaseBuildLock ?? releaseRunnerRebuildLock;
  try {
    const reap = deps.reap ?? reapStaleFastRunner;
    await reap();
    const invalidate =
      deps.invalidateArtifact ??
      (() => rmSync(derivedDataPathForRunner(), { recursive: true, force: true }));
    invalidate();
    if (plugin !== null) budget.recordRebuild(plugin);
    const ensure = deps.ensure ?? ensureFastRunner;
    await ensure(deviceId, bundleId);
  } finally {
    release();
  }
  const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
  const rebuilt = await probe();
  if (rebuilt.liveness === 'alive') {
    return { ok: true, note: `runner artifact rebuilt (missing commands: ${missing})` };
  }
  return {
    ok: false,
    code: 'RUNNER_COMMANDS_STALE',
    message:
      `rn-fast-runner still lacks required commands after a cold rebuild ` +
      `(missing: ${(rebuilt.missingCommands ?? first.missingCommands ?? []).join(', ') || 'unknown'}). ` +
      `The plugin checkout itself may be outdated — update the plugin, then re-open the device session.`,
  };
}
```

4. In `ensureRunnerForCommand`: short-circuit into the rebuild tier right after the first probe, and add the mid-flow refusal after the re-probe. Full amended flow (everything not shown stays as-is):

```ts
  adopt(deviceId ?? undefined);
  const first = await probe();
  // GH #418: artifact staleness at open — skip the wasted stale respawn and
  // invalidate up front. Requires a concrete deviceId to spawn against.
  if (first.staleReason === 'missing-commands' && deps.allowArtifactRebuild && deviceId) {
    return rebuildStaleRunnerArtifact(first, deviceId, bundleId, deps);
  }
  const decision = decideRunnerSpawn({ liveness: first.liveness, prebuilt: prebuilt(), deviceId });
  if (decision.action === 'proceed') return { ok: true };
  if (decision.action === 'error') return { ok: false, message: decision.message };

  await ensure(decision.deviceId, bundleId);
  const after = await probe();
  if (after.liveness === 'alive') {
    if (first.staleReason && PROTOCOL_STALE_REASONS.has(first.staleReason)) {
      return {
        ok: true,
        note:
          first.staleReason === 'missing-commands'
            ? 'runner upgraded (stale command surface)'
            : 'runner upgraded (protocol/version mismatch)',
      };
    }
    return { ok: true };
  }
  // GH #418: 'missing-commands' surviving a respawn means the ARTIFACT is
  // stale — mid-flow callers refuse fast (never a silent multi-minute build).
  if (after.staleReason === 'missing-commands') {
    const missing = (after.missingCommands ?? []).join(', ') || 'unknown';
    return {
      ok: false,
      code: 'RUNNER_COMMANDS_STALE',
      message:
        `rn-fast-runner artifact lacks required commands (missing: ${missing}). ` +
        `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) ` +
        `to rebuild it (cold build, several minutes).`,
    };
  }
  if (after.staleReason && PROTOCOL_STALE_REASONS.has(after.staleReason)) {
    // …existing RUNNER_PROTOCOL_MISMATCH error block, unchanged…
  }
  // …existing did-not-become-ready error, unchanged…
```

(Order matters twice: the open-path short-circuit precedes `decideRunnerSpawn`, and the mid-flow `missing-commands` branch MUST precede the generic `PROTOCOL_STALE_REASONS` error branch, since the set now contains it.)

5. In `scripts/cdp-bridge/src/tools/device-session.ts`, change line 267:

```ts
          const ready = await ensureRunnerForCommand(deviceId, appId, {
            allowArtifactRebuild: true,
          });
```

- [ ] **Step 4: Run the full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: all pass, including the untouched gh-383 ensure tests (their reasons still map to the protocol note).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/src/tools/device-session.ts scripts/cdp-bridge/test/unit/gh-418-remediation.test.js
git commit -S -m "feat(ios-gate): tiered missing-commands remediation — rebuild at open, refuse mid-flow (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Android — probe parses commands, gate enforces, REAL artifact-invalidation tier

> **Review amendment (BLOCKER):** the original "remediation rides the existing forceReinstall" premise was FALSE. `resolveAndroidInstallAction` (`rn-android-runner-client.ts:310-316`) returns `'reuse'` when the instrumentation is registered and `'install'` (re-install the SAME stale APK, no Gradle) when the APKs exist on disk — it only returns `'build-then-install'` when the APKs are ABSENT. So a stale-but-present APK was never rebuilt, and the fresh-open path (no live runner) never even set `forceReinstall` — post-spawn classify would reject with zero remediation. Android now mirrors iOS: delete the APKs (→ `apksExist` false → `'build-then-install'`), gated behind an open-only `allowArtifactRebuild` flag; mid-flow refuses fast with `RUNNER_COMMANDS_STALE` (never a silent Gradle build — same #210 rule).

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (AndroidHealthInfo, probeAndroidRunnerHealthInfo, classifyAndroidHealth, `AndroidCommandsStaleError`, `invalidateAndroidRunnerApks`, `StartAndroidRunnerOpts`, startAndroidRunner retry-once wrapper, ensureAndroidRunnerInstalled forceReinstall threading)
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (`startAndroidRunner(deviceId, appId, undefined, { allowArtifactRebuild: true })` at the open call ~line 282, plus a `RUNNER_COMMANDS_STALE` prefix branch in the catch ~line 312)
- Modify: `scripts/cdp-bridge/src/agent-device-wrapper.ts` (~line 842: `RUNNER_COMMANDS_STALE` prefix branch in the mid-flow Android start catch, before the `RUNNER_PROTOCOL_MISMATCH` branch)
- Modify (test migration): `scripts/cdp-bridge/test/unit/runners/rn-android-runner-client.test.js` (~line 28) and `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js` (~line 99) — their reuse-gate `/health` fixtures `{ok:true, protocolVersion:1}` have no `runnerVersion` (skew skipped) and no `commands`, so the strict gate flips them to `missing-commands` and the tests would attempt real adb/Gradle. Add `commands: [...REQUIRED_ANDROID_COMMANDS]` to every fixture the test expects to classify compatible.
- Test (create): `scripts/cdp-bridge/test/unit/gh-418-android-command-gate.test.js`

**Interfaces:**
- Consumes: `REQUIRED_ANDROID_COMMANDS` (Task 2); Android `/health.commands` (Task 4); `'RUNNER_COMMANDS_STALE'` ToolErrorCode (Task 2).
- Produces: `AndroidHealthInfo.commands?: string[]`; `export class AndroidCommandsStaleError extends Error { readonly missing: string[] }` whose message starts with `RUNNER_COMMANDS_STALE:`; `export function invalidateAndroidRunnerApks(): void`; `startAndroidRunner(deviceId?, bundleId?, devicePort?, opts?: { allowArtifactRebuild?: boolean })` — same export name, retry-once wrapper semantics at open.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-418-android-command-gate.test.js`:

```js
// GH #418: the Android health probe parses /health.commands, the classify
// helper enforces REQUIRED_ANDROID_COMMANDS, and remediation is a REAL
// invalidation tier — deleting the APKs forces resolveAndroidInstallAction
// into 'build-then-install' (review amendment: 'install' alone re-installs
// the same stale APK and never runs Gradle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAndroidRunnerHealthInfo,
  resolveAndroidInstallAction,
  AndroidCommandsStaleError,
  _setFetchForTest,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  classifyRunnerCompatibility,
  REQUIRED_ANDROID_COMMANDS,
} from '../../dist/runners/protocol.js';

test('gh-418 android: probe parses commands array (non-strings filtered)', async () => {
  _setFetchForTest(async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      protocolVersion: 1,
      commands: ['tap', 'type', 7, 'snapshot'],
    }),
  }));
  try {
    const info = await probeAndroidRunnerHealthInfo(4723);
    assert.deepEqual(info.commands, ['tap', 'type', 'snapshot']);
  } finally {
    _setFetchForTest(globalThis.fetch);
  }
});

test('gh-418 android: absent commands + required list → missing-commands', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1 }, null, REQUIRED_ANDROID_COMMANDS),
    {
      compatible: false,
      reason: 'missing-commands',
      missing: [...REQUIRED_ANDROID_COMMANDS],
    },
  );
});

test('gh-418 android: AndroidCommandsStaleError message carries the typed prefix + hint', () => {
  const err = new AndroidCommandsStaleError(['dismissKeyboard'], 'com.example');
  assert.ok(err.message.startsWith('RUNNER_COMMANDS_STALE'));
  assert.match(err.message, /dismissKeyboard/);
  assert.match(err.message, /device_snapshot action=open/);
  assert.deepEqual(err.missing, ['dismissKeyboard']);
});

test('gh-418 android: deleting the APKs flips the install action to build-then-install', () => {
  // The invalidation tier works BECAUSE of this existing pure decision:
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: true }),
    'install',
  );
  assert.equal(
    resolveAndroidInstallAction({ instrumentationRegistered: false, apksExist: false }),
    'build-then-install',
  );
});
```

(The full open-path loop — stale APK → invalidate → Gradle rebuild → healthy runner — is exercised live in Task 11 Step 5; `startAndroidRunner` spawns real adb, so its retry wrapper is deliberately not unit-mocked here.)

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-android-command-gate.test.js`
Expected: FAIL — `info.commands` is `undefined`.

- [ ] **Step 3: Implement in rn-android-runner-client.ts**

1. `AndroidHealthInfo` gains `commands?: string[]`.
2. `probeAndroidRunnerHealthInfo`: add `commands?: unknown;` to the parsed body type and:

```ts
      ...(Array.isArray(body.commands)
        ? { commands: body.commands.filter((c): c is string => typeof c === 'string') }
        : {}),
```

3. `classifyAndroidHealth` passes the commands + required list:

```ts
function classifyAndroidHealth(info: AndroidHealthInfo) {
  return classifyRunnerCompatibility(
    {
      ...(info.protocolVersion !== undefined ? { protocolVersion: info.protocolVersion } : {}),
      ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
      ...(info.commands !== undefined ? { commands: info.commands } : {}),
    },
    getPluginVersion(),
    REQUIRED_ANDROID_COMMANDS,
  );
}
```

(import `REQUIRED_ANDROID_COMMANDS` alongside the existing protocol imports.)

4. Add the typed error and the invalidation helper (near `reapMismatchedAndroidRunner`):

```ts
// GH #418: mid-flow refusal + retry-once signal. The message prefix is the
// wire contract — device-session.ts and agent-device-wrapper.ts map it to the
// RUNNER_COMMANDS_STALE ToolErrorCode by startsWith, mirroring
// RUNNER_PROTOCOL_MISMATCH.
export class AndroidCommandsStaleError extends Error {
  constructor(
    readonly missing: string[],
    bundleId?: string,
  ) {
    super(
      `RUNNER_COMMANDS_STALE: installed rn-android-runner lacks required commands ` +
        `(missing: ${missing.join(', ') || 'unknown'}). Re-open the device session ` +
        `(device_snapshot action=open appId=${bundleId ?? '<your.app.id>'} platform=android) to rebuild it.`,
    );
  }
}

// GH #418: deleting the APKs is the artifact invalidation — apksExist flips
// false, so resolveAndroidInstallAction returns 'build-then-install' (Gradle).
export function invalidateAndroidRunnerApks(): void {
  for (const apk of [APK_APP, APK_TEST]) {
    try {
      rmSync(apk, { force: true });
    } catch {
      /* best-effort; the install action check re-reads existsSync */
    }
  }
}
```

5. Thread a force flag through `ensureAndroidRunnerInstalled` (the retry after invalidation must not short-circuit on `instrumentationRegistered` → `'reuse'`): the call at ~line 550 becomes `await ensureAndroidRunnerInstalled(deviceId, { forceReinstall: forceReinstall || opts._forceReinstall === true });`.

6. Rename the current exported `startAndroidRunner` body to module-private `startAndroidRunnerAttempt(deviceId?, bundleId?, devicePort, opts)` and amend two spots inside it:

   a. Reuse path (reachable-but-incompatible, ~lines 537-544):

```ts
      const compat = classifyAndroidHealth(info);
      if (compat.compatible) return runnerState!;
      if (compat.reason === 'missing-commands') {
        // GH #418: reinstalling the SAME APK can't add commands — this is
        // artifact staleness. Open invalidates + rebuilds; mid-flow refuses.
        if (!opts.allowArtifactRebuild) {
          throw new AndroidCommandsStaleError(compat.missing ?? [], bundleId);
        }
        invalidateAndroidRunnerApks();
        pendingUpgradeNote = `runner artifact rebuilt (missing commands: ${(compat.missing ?? []).join(', ') || 'unknown'})`;
      } else {
        pendingUpgradeNote = 'runner upgraded (protocol/version mismatch)';
      }
      forceReinstall = true;
      await reapMismatchedAndroidRunner(deviceId);
```

   b. Post-install verify (the `waitForAndroidRunnerHealth` callback): reject with the typed error for `missing-commands`, keep `RUNNER_PROTOCOL_MISMATCH` for protocol reasons:

```ts
        const compat = classifyAndroidHealth(info);
        if (!compat.compatible) {
          resolved = true;
          pendingUpgradeNote = undefined; // never report an upgrade that failed
          child.kill('SIGTERM');
          if (compat.reason === 'missing-commands') {
            reject(new AndroidCommandsStaleError(compat.missing ?? [], bundleId));
            return;
          }
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
```

7. New exported `startAndroidRunner` — retry-once wrapper covering the fresh-open case (stale APK already installed, no live runner: the attempt spawns it, post-install verify throws the typed error, the wrapper invalidates and retries with a forced build):

```ts
export interface StartAndroidRunnerOpts {
  /** GH #418: open-path only — permits APK invalidation + Gradle rebuild. */
  allowArtifactRebuild?: boolean;
  /** Internal: set by the rebuild retry so the install action can't 'reuse'. */
  _forceReinstall?: boolean;
}

export async function startAndroidRunner(
  deviceId?: string,
  bundleId?: string,
  devicePort = DEFAULT_PORT,
  opts: StartAndroidRunnerOpts = {},
): Promise<AndroidRunnerState> {
  try {
    return await startAndroidRunnerAttempt(deviceId, bundleId, devicePort, opts);
  } catch (err) {
    if (opts.allowArtifactRebuild && err instanceof AndroidCommandsStaleError) {
      invalidateAndroidRunnerApks();
      const state = await startAndroidRunnerAttempt(deviceId, bundleId, devicePort, {
        _forceReinstall: true,
      });
      pendingUpgradeNote = `runner artifact rebuilt (missing commands: ${err.missing.join(', ') || 'unknown'})`;
      return state;
    }
    throw err;
  }
}
```

8. Map the new prefix at both consumers (BEFORE their `RUNNER_PROTOCOL_MISMATCH` branches):
   - `scripts/cdp-bridge/src/agent-device-wrapper.ts` ~line 842 (mid-flow Android start catch):

```ts
        if (msg.startsWith('RUNNER_COMMANDS_STALE')) {
          return failResult(msg, 'RUNNER_COMMANDS_STALE');
        }
```

   - `scripts/cdp-bridge/src/tools/device-session.ts` catch (~line 312): same two-line branch.

9. `scripts/cdp-bridge/src/tools/device-session.ts` ~line 282 (the open path is the ONLY caller that opts in):

```ts
          await startAndroidRunner(deviceId, appId, undefined, { allowArtifactRebuild: true });
```

- [ ] **Step 4: Migrate the Android fixture tests, then run the full suite**

Add `commands: [...REQUIRED_ANDROID_COMMANDS]` (importing from `'../../dist/runners/protocol.js'`, depth-adjusted) to every `/health` fixture expected to classify compatible in:
- `test/unit/runners/rn-android-runner-client.test.js` (~line 28 reuse-gate body `{ok:true, protocolVersion:1}`)
- `test/unit/gh-243-android-runner-health.test.js` (~line 99 same shape)
- `gh-383-android-protocol-gate.test.js` / android state-relocation tests IF any of their compatible-path bodies lack `commands` (check by running the suite).

Run: `cd scripts/cdp-bridge && npm test`
Expected: all pass — any remaining failure is an unmigrated Android fixture; fix it the same way.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts scripts/cdp-bridge/src/tools/device-session.ts scripts/cdp-bridge/src/agent-device-wrapper.ts scripts/cdp-bridge/test/unit/gh-418-android-command-gate.test.js scripts/cdp-bridge/test/unit/runners/rn-android-runner-client.test.js scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js
git commit -S -m "feat(android-gate): command-surface gate + real APK-invalidation rebuild tier (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Include any additionally migrated gh-383 android test files in the `git add`.)

---

### Task 9: cdp_status surfaces missingCommands

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-session-health.ts`
- Test (create): `scripts/cdp-bridge/test/unit/gh-418-status-missing-commands.test.js`

**Interfaces:**
- Consumes: `FastRunnerLivenessDetail.missingCommands` (Task 6).
- Produces: `DeviceSessionHealth.runnerProtocol.missingCommands?: string[]` — present only when the runner is stale for that reason.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-418-status-missing-commands.test.js`:

```js
// GH #418: cdp_status.deviceSession.runnerProtocol names the missing verbs so
// a stale artifact is diagnosable before any device_* call fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceSessionHealth } from '../../dist/tools/device-session-health.js';

const SESSION = { platform: 'ios', appId: 'com.example', deviceId: 'U1' };

test('gh-418 status: stale/missing-commands surfaces missingCommands', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => SESSION,
    adopt: () => {},
    probeLiveness: async () => ({
      liveness: 'stale',
      staleReason: 'missing-commands',
      missingCommands: ['keyboardDismiss'],
      runnerProtocolVersion: 1,
    }),
  });
  assert.equal(h.rnFastRunner, 'stale');
  assert.deepEqual(h.runnerProtocol?.missingCommands, ['keyboardDismiss']);
  assert.equal(h.runnerProtocol?.compatible, false);
});

test('gh-418 status: alive runner has no missingCommands key', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => SESSION,
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1 }),
  });
  assert.equal('missingCommands' in (h.runnerProtocol ?? {}), false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-418-status-missing-commands.test.js`
Expected: FAIL — `missingCommands` undefined on the stale case.

- [ ] **Step 3: Implement**

In `device-session-health.ts`: the `runnerProtocol` interface member gains `missingCommands?: string[]`, and the population block gains one spread:

```ts
        health.runnerProtocol = {
          expected: RUNNER_PROTOCOL_VERSION,
          ...(detail.runnerProtocolVersion !== undefined
            ? { runner: detail.runnerProtocolVersion }
            : {}),
          ...(detail.runnerVersion !== undefined ? { runnerVersion: detail.runnerVersion } : {}),
          ...(plugin !== null ? { pluginVersion: plugin } : {}),
          ...(detail.missingCommands !== undefined
            ? { missingCommands: detail.missingCommands }
            : {}),
          compatible: detail.liveness === 'alive',
        };
```

- [ ] **Step 4: Run tests**

Run: `cd scripts/cdp-bridge && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-session-health.ts scripts/cdp-bridge/test/unit/gh-418-status-missing-commands.test.js
git commit -S -m "feat(status): surface missing runner commands in deviceSession.runnerProtocol (#418)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, changeset, dist rebuild, full gates

**Files:**
- Modify: `CLAUDE.md` (Troubleshooting section)
- Create: `.changeset/gh-418-command-surface-gate.md`
- Modify: `scripts/cdp-bridge/dist/**` (rebuilt, staged — dist is tracked)

- [ ] **Step 1: CLAUDE.md troubleshooting entry**

In the Troubleshooting list, immediately after the existing `RUNNER_PROTOCOL_MISMATCH` bullet, add:

```markdown
- **`RUNNER_COMMANDS_STALE` / `UNSUPPORTED_COMMAND` on device_* tools** → The runner build artifact predates a newer command verb (#418). Protocol versions only bump on wire-shape changes, so an old artifact can pass the protocol gate while lacking verbs — both runners now enumerate their commands in `/health.commands` and the liveness gate classifies a missing verb as stale. Self-heals: re-open the device session (`device_snapshot action=open`) — iOS deletes the stale DerivedData and cold-rebuilds (one multi-minute build, `meta.note: "runner artifact rebuilt (missing commands: …)"`, at most once per plugin version and serialized across sessions sharing the checkout), Android deletes the runner APKs and Gradle-rebuilds via self-install. Mid-flow tools refuse fast instead of silently building. `cdp_status` → `deviceSession.runnerProtocol.missingCommands` names the gap. If a COLD build still reports missing commands, the plugin checkout itself is outdated.
```

- [ ] **Step 2: Changeset**

Create `.changeset/gh-418-command-surface-gate.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Command-surface gate (#418, B235): both native runners enumerate their supported
commands in `/health.commands` (iOS derives it from `CommandType.allCases`, Android
from a sync-tested `SUPPORTED_COMMANDS` list) and the liveness gate classifies a
runner missing any bridge-required verb as stale (`missing-commands`). Remediation
is tiered: `device_snapshot action=open` auto-invalidates the stale artifact and
rebuilds — iOS deletes DerivedData and cold-builds (once per plugin version, behind a
checkout-scoped build lock), Android deletes the runner APKs so self-install
Gradle-rebuilds; mid-flow device tools refuse fast with `RUNNER_COMMANDS_STALE`
instead of silently building.
An unknown verb reaching the iOS runner now returns a typed `UNSUPPORTED_COMMAND`
error instead of a raw Swift decode failure. Root cause of B235 fixed: the explicit
iOS keyboard-dismiss path posted `dismissKeyboard`, which no Swift artifact ever
accepted — the wire verb is now `keyboardDismiss`. `cdp_status` surfaces
`deviceSession.runnerProtocol.missingCommands`.
```

- [ ] **Step 3: Rebuild dist + full gates**

```bash
cd scripts/cdp-bridge && npm test        # tsc build + full unit suite
cd ../.. && git add scripts/cdp-bridge/dist
```
Expected: suite fully green. Also run the repo's lint/format if configured (`npx oxlint` per the OXC setup) and fix anything it flags in touched files.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md .changeset/gh-418-command-surface-gate.md scripts/cdp-bridge/dist
git commit -S -m "docs+chore: #418 troubleshooting entry, changeset, rebuilt dist

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Device verification (live — iOS simulator AND Android emulator)

No code — this is the workflow's step-5 live pass. Prereqs: Metro running from the workspace (`cd ../rn-dev-agent-workspace/test-app && npx expo start`), booted iOS simulator + Android emulator with the test app.

- [ ] **Step 1: iOS upgrade-migration path (the real pre-#418 artifact!)**

The existing DerivedData prebuild on this machine predates #418 → it advertises no `commands`. Open a session: `device_snapshot action=open appId=com.rndevagent.testapp platform=ios`.
Expected: the open succeeds after a cold rebuild with `meta.note: "runner artifact rebuilt (missing commands: tap, type, …)"` (full list — the field was absent). This validates the strict-absence policy end-to-end on the genuine migration artifact. Budget several minutes for the cold build.

- [ ] **Step 2: Steady state**

`cdp_status` → expect `deviceSession.rnFastRunner: 'alive'`, `runnerProtocol.compatible: true`, NO `missingCommands`. Run `device_find` + `device_press` on a visible element — normal behavior, no new notes.

- [ ] **Step 3: B235 regression — the keyboard verb**

Focus a text field (`device_press` on an input), then drive the explicit dismissal path (`device_batch` with a hideKeyboard/keyboard step — the exact B235 shape).
Expected: succeeds (wire verb `keyboardDismiss` decodes); NO `dataCorrupted` error. Also run the Swift unit tests live while the sim is booted:
```bash
cd scripts/rn-fast-runner/RnFastRunner && xcodebuild test \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "platform=iOS Simulator,id=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; print(list(json.load(sys.stdin)["devices"].values())[0][0]["udid"])' 2>/dev/null || echo BOOTED_UDID)" \
  -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/CommandSurfaceTests
```
Expected: both CommandSurfaceTests pass.

- [ ] **Step 4: Typed-error path (defense-in-depth)**

With the session open, POST a bogus verb straight at the runner:
```bash
curl -s -X POST http://127.0.0.1:22088/command -H 'content-type: application/json' -d '{"command":"definitelyBogusVerb"}'
```
Expected: `{"ok":false,…"error":{"code":"UNSUPPORTED_COMMAND","message":"Unsupported iOS runner command: definitelyBogusVerb — …"}}` — not a `dataCorrupted` string. Also confirm `/health` now includes the full `commands` array: `curl -s http://127.0.0.1:22088/health`.

- [ ] **Step 5: Android pass**

`device_snapshot action=open appId=com.rndevagent.testapp platform=android` against the emulator with the previously-installed (pre-#418) runner APK.
Expected: open succeeds with `meta.note: "runner artifact rebuilt (missing commands: …)"` — the attempt spawns the stale APK, the post-install verify throws the typed error, and the retry wrapper deletes the APKs and Gradle-rebuilds (budget a few minutes). Then `curl -s http://127.0.0.1:<hostPort>/health` shows `commands`, a `device_press`/`device_fill` round-trip works, and a mid-flow simulation (call a `device_*` tool after manually re-installing a stale APK, if time permits) returns `RUNNER_COMMANDS_STALE` rather than triggering a silent Gradle build.

- [ ] **Step 6: Record evidence**

Capture the open-result notes, cdp_status output, and the curl outputs into `../rn-dev-agent-workspace/docs/proof/2026-07-XX-418-command-surface-gate/` (dated folder) for the PR body.

---

## Execution notes

- Tasks 1→2 are TS-ordered (the union rename feeds the `satisfies` tie). Tasks 3 and 4 are independent of each other. Task 5 needs 2+3+4. Tasks 6→7 are sequential; 8 and 9 only need 2/6 respectively.
- After the plan lands, run the multi-LLM plan review (`/brainstorm gemini,codex`) BEFORE starting Task 1, per the repo workflow, and apply amendments to this plan.
- Cold-build warning: Task 11 Step 1 intentionally destroys the local prebuilt DerivedData — that's the migration test. Don't pre-build it away.
