# GH #384 — Quiescence Bypass in rn-fast-runner (RNQuiescence swizzle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make XCTest's `waitForQuiescenceIncludingAnimationsIdle:` a no-op inside the rn-fast-runner process (default ON, `RN_QUIESCENCE_BYPASS=0` opt-out), so device tools stop hanging on React Native apps that never report idle — eliminating the flake class the runner-timeout shim, HID-synthesis scroll, and 35s budgets each patch per-symptom.

**Architecture:** Vendor a minimal adaptation of Maestro's WebDriverAgent-lineage ObjC swizzle into the RnFastRunnerUITests target (`+load`-time `method_setImplementation`, probing both selector variants, degrading loudly if neither resolves). A Swift shim resolves the tri-state status (`active`/`disabled`/`unavailable`), logs a startup marker that the existing TS ready-signal parser captures into `FastRunnerState`, and reports `QUIESCENCE_BYPASS` in `/health.capabilities`. The TS client threads the env toggle at spawn (`TEST_RUNNER_`-prefixed — xcodebuild strips that prefix when forwarding to the XCUITest process), announces `meta.quiescenceBypass` on the first command after boot, and surfaces capabilities in `cdp_status.deviceSession`.

**Tech Stack:** Objective-C (runtime swizzle), Swift (XCTest runner), TypeScript (cdp-bridge, Node 22, `node:test`), React Native/Reanimated (workspace test-app fixture).

**Spec:** `docs/stories/03-quiescence-bypass.md`. Deviations from spec (both grounded in code reality, flag them in the PR body):
- Env threading uses `TEST_RUNNER_RN_QUIESCENCE_BYPASS` (+ plain form), NOT `SIMCTL_CHILD_…` — this runner is launched by `xcodebuild test`, which only forwards `TEST_RUNNER_`-prefixed vars (prefix stripped) to the XCUITest process; #383 hit the identical trap with `RN_PLUGIN_VERSION` (see `rn-fast-runner-client.ts:274-284`).
- `meta.quiescenceBypass` is the string `'active' | 'disabled' | 'unavailable'` rather than the spec's bare `true` — matches the `meta.keyboardGuard` string-enum precedent and makes the negative states auditable too.

**Amendments applied from the multi-LLM plan review (2026-07-02, Claude+Codex; Gemini CLI unavailable — tier error).** No blockers. Key corrections folded in below:
1. Task 9's fill check was a false positive: `device_fill` is JS-first (D1250) and never exercises the native `typeText` path the bypass targets → replaced with a direct `/command type` exercise (with `appBundleId` + focus tap).
2. Expectation tempered: the swizzle **guarantees** snapshot-speed and non-HID-scroll wins; `typeText` has its own internal sync (`rn-fast-runner-client.ts:873-891`, Maestro types via HID `RunnerDaemonProxy`, not the swizzle), so the type-shim count reaching zero is a hoped-for bonus, NOT a PR gate.
3. Bypass-OFF curl gained `appBundleId` — without it the runner types into its own host app (`executeOnMain` falls back to `app.activate()`).
4. "No-ops both variants" overclaim fixed: exactly ONE variant is swizzled (classic preferred — upstream Maestro's order); the ACTIVE startup marker now records which (`=classic`/`=preEvent`), and live snapshot-<2s is the proof the effective variant was swizzled.
5. `RN_QUIESCENCE_FORCE_UNAVAILABLE=1` fault-injection hook added so the spec's UNAVAILABLE-degrade acceptance criterion is actually testable (Task 9 Step 3).
6. Task 9 now re-runs the other UITests classes with the swizzle compiled in (the `+load` swizzle affects the whole bundle, incl. `SnapshotForegroundRegressionTest`).
7. Task 9's state-file lookup corrected to `~/Library/Application Support/rn-dev-agent/runner-state/ios-<UDID>.json` (verified against `util/secure-state-file.ts`).
Plus: `runnerCapabilities` omitted when empty (no `[]` noise), persisted `quiescence` validated against the union before announcing, unused `bundleID` dropped from the vendored header.

**Execution-time deviations (recorded post-implementation):** (a) CLAUDE.md is gitignored in this repo (local-only since #331), so Task 7's committable troubleshooting entry landed as a README.md `## Troubleshooting` table row instead; CLAUDE.md was still edited locally. (b) The final whole-branch review corrected the opt-out instruction in both docs: a live runner survives session reopen by design (#383 adoption), so flipping `RN_QUIESCENCE_BYPASS` requires killing the runner (`pkill -f RnFastRunnerUITests`) before reopening the session.

## Global Constraints

- Node.js >= 22 LTS; cdp-bridge is TypeScript compiled by `tsc` (`npm run build` inside `scripts/cdp-bridge`).
- `dist/` is tracked — every TS change must rebuild and stage `scripts/cdp-bridge/dist/`.
- Use explicit type imports (`import type { ... }`).
- No unnecessary comments in code (comments only for constraints code can't show).
- Lint/format: `npm run lint` (oxlint) and `npm run format` (oxfmt) at repo root.
- Commits are signed, small, per-task; add a changeset before the PR (Task 7).
- The `/command` wire protocol does NOT change (health `capabilities` field already exists as optional) — `RUNNER_PROTOCOL_VERSION` stays 1. Do not bump it.
- Swift test runs need a **booted iOS simulator**; get its UDID via `xcrun simctl list devices booted`.
- The workspace repo (`../rn-dev-agent-workspace`) is a separate git repo — Task 8 commits there, not here.

## File Structure

**Plugin repo (this repo):**

| File | Responsibility |
|---|---|
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/XCUIApplicationProcess.h` (new) | Minimal private-API declaration (trimmed class-dump header) |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.h` (new) | Public surface: probe enum, pure decide/parse fns, bypass query |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.m` (new) | `+load` swizzle, env-cached bypass decision |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerUITests-Bridging-Header.h` (modify) | Expose RNQuiescence to Swift |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceStatus.swift` (new) | Tri-state resolve, startup marker strings, capabilities list |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift` (new) | Swift unit tests (probe decision, env parse, status/marker/capabilities) |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests.swift` (modify) | Log startup marker in `testCommand` |
| `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift` (modify) | `/health` capabilities |
| `scripts/rn-fast-runner/IMPORT_NOTES.md` (modify) | Third-party provenance/attribution |
| `scripts/cdp-bridge/src/runners/quiescence.ts` (new) | `resolveQuiescenceBypass`, `buildRunnerQuiescenceEnv`, `QuiescenceStatus` type |
| `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (modify) | Parser capture, spawn env, state field, first-command meta announcement, health-probe capabilities |
| `scripts/cdp-bridge/src/types.ts` (modify) | `FastRunnerState.quiescence?` |
| `scripts/cdp-bridge/src/tools/device-session-health.ts` (modify) | `runnerCapabilities` in `cdp_status.deviceSession` |
| `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` (new) | All TS unit tests for this feature |
| `CLAUDE.md` (modify) | Troubleshooting + architecture notes |
| `.changeset/384-quiescence-bypass.md` (new) | Release note |

**Workspace repo (`../rn-dev-agent-workspace`):**

| File | Responsibility |
|---|---|
| `test-app/src/screens/ReanimatedLoopScreen.tsx` (new) | Infinite Reanimated loop + counter + input + scrollable rows |
| `test-app/src/navigation/types.ts` (modify) | `ReanimatedLoop` route in `HomeStackParams` |
| `test-app/src/navigation/RootNavigator.tsx` (modify) | Register the screen |

---

### Task 1: Vendor the RNQuiescence ObjC swizzle + Swift unit tests + attribution

**Files:**
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/XCUIApplicationProcess.h`
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.h`
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.m`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerUITests-Bridging-Header.h`
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift`
- Modify: `scripts/rn-fast-runner/IMPORT_NOTES.md`
- Test: `QuiescenceBypassTests.swift` (runs on a booted simulator via xcodebuild)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by Task 2's Swift code via the bridging header):
  - `RNQuiescenceProbe` C enum → imported into Swift as `RNQuiescenceProbe` with cases `.classic`, `.preEvent`, `.unavailable`
  - `RNQuiescenceProbe RNQuiescenceDecideProbe(BOOL hasClassic, BOOL hasPreEvent)`
  - `RNQuiescenceProbe RNQuiescenceGetProbeResult(void)`
  - `BOOL RNQuiescenceParseBypass(NSString * _Nullable raw)`
  - `BOOL RNQuiescenceBypassEnabled(void)` — reads env `RN_QUIESCENCE_BYPASS` once (default YES)

**Background you need:** The UITests target is a `PBXFileSystemSynchronizedRootGroup` (see `project.pbxproj` lines 24-35) — any file created under `RnFastRunnerUITests/` (including subdirectories) is automatically a member of the target. No Xcode project edits are required. The target already compiles ObjC (`RunnerObjCExceptionCatcher.m`) through the bridging header at `RnFastRunnerUITests/RnFastRunnerUITests-Bridging-Header.h`.

- [ ] **Step 1: Write the failing Swift tests**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift`:

```swift
import XCTest

final class QuiescenceBypassTests: XCTestCase {
  // MARK: - Probe decision (pure)

  func testDecideProbePrefersClassicWhenBothExist() {
    XCTAssertEqual(RNQuiescenceDecideProbe(true, true), .classic)
  }

  func testDecideProbeFallsBackToPreEvent() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, true), .preEvent)
  }

  func testDecideProbeUnavailableWhenNeitherExists() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, false), .unavailable)
  }

  // MARK: - Env parse (pure)

  func testParseBypassDefaultsOnWhenAbsent() {
    XCTAssertTrue(RNQuiescenceParseBypass(nil))
  }

  func testParseBypassStaysOnForOtherValues() {
    XCTAssertTrue(RNQuiescenceParseBypass("1"))
    XCTAssertTrue(RNQuiescenceParseBypass("true"))
    XCTAssertTrue(RNQuiescenceParseBypass("unexpected"))
  }

  func testParseBypassOptOut() {
    XCTAssertFalse(RNQuiescenceParseBypass("0"))
    XCTAssertFalse(RNQuiescenceParseBypass("false"))
    XCTAssertFalse(RNQuiescenceParseBypass(" FALSE "))
  }

  // MARK: - Live probe (drift detector)

  func testProbeResolvedAtBundleLoad() {
    // +load ran when this test bundle loaded. On every Xcode/iOS we support,
    // one of the two private selectors must resolve — if this fails, Apple
    // renamed the API and the bypass silently degraded (spec: degrade loudly).
    XCTAssertNotEqual(RNQuiescenceGetProbeResult(), .unavailable)
  }
}
```

- [ ] **Step 2: Run the tests to verify they fail (compile error — symbols don't exist yet)**

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
cd scripts/rn-fast-runner/RnFastRunner && xcodebuild test \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/QuiescenceBypassTests 2>&1 | tail -20
```

Expected: **BUILD FAILED** — `cannot find 'RNQuiescenceDecideProbe' in scope` (and friends). A compile failure is the RED state here.

- [ ] **Step 3: Create the minimal private header**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/XCUIApplicationProcess.h`:

```objc
/**
 * Minimal private-API declaration for XCTest's XCUIApplicationProcess,
 * trimmed to the members the RNQuiescence swizzle touches.
 *
 * Provenance: class-dump header vendored by facebookarchive/WebDriverAgent
 * (BSD-3-Clause) and mobile-dev-inc/maestro (Apache-2.0) at
 * maestro-ios-xctest-runner/maestro-driver-iosUITests/PrivateHeaders/XCTest/
 * XCUIApplicationProcess.h. See scripts/rn-fast-runner/IMPORT_NOTES.md.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface XCUIApplicationProcess : NSObject

// Before Xcode 16 beta 5
- (void)waitForQuiescenceIncludingAnimationsIdle:(BOOL)includingAnimations;
// Since Xcode 16 beta 5
- (void)waitForQuiescenceIncludingAnimationsIdle:(BOOL)includingAnimations isPreEvent:(BOOL)isPreEvent;

@end

NS_ASSUME_NONNULL_END
```

- [ ] **Step 4: Create RNQuiescence.h**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.h`:

```objc
/**
 * RNQuiescence — XCTest quiescence bypass for rn-fast-runner (GH #384, Story 03).
 *
 * Adapted from mobile-dev-inc/maestro (Apache-2.0):
 *   maestro-ios-xctest-runner/maestro-driver-iosUITests/Categories/
 *   XCUIApplicationProcess+FBQuiescence.m
 * which derives from facebookarchive/WebDriverAgent (BSD-3-Clause).
 *
 * Changes from upstream (see IMPORT_NOTES.md):
 * - bypass is a process-wide env decision (RN_QUIESCENCE_BYPASS, default ON)
 *   instead of FBConfiguration.waitForIdleTimeout + a per-app associated object
 * - the non-bypass path calls the original implementation unmodified
 *   (no _XCTSetApplicationStateTimeout bounding — keeps stock behavior intact)
 * - FBLogger dropped; startup markers are logged by the Swift runner instead
 */

#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, RNQuiescenceProbe) {
  RNQuiescenceProbeClassic = 0,
  RNQuiescenceProbePreEvent = 1,
  RNQuiescenceProbeUnavailable = 2,
};

NS_ASSUME_NONNULL_BEGIN

/// Pure decision: which selector variant to swizzle. Classic wins when both
/// resolve (Maestro's probe order). Exposed for unit tests.
RNQuiescenceProbe RNQuiescenceDecideProbe(BOOL hasClassic, BOOL hasPreEvent);

/// Probe outcome recorded by +load. Unavailable until +load has run.
RNQuiescenceProbe RNQuiescenceGetProbeResult(void);

/// Pure parse of an RN_QUIESCENCE_BYPASS value: nil → YES (default ON);
/// "0"/"false" (trimmed, case-insensitive) → NO; anything else → YES.
/// Exposed for unit tests.
BOOL RNQuiescenceParseBypass(NSString *_Nullable raw);

/// Cached process-wide decision read once from the environment.
BOOL RNQuiescenceBypassEnabled(void);

NS_ASSUME_NONNULL_END
```

(Test-only fault injection: `RN_QUIESCENCE_FORCE_UNAVAILABLE=1` forces the probe to
`unavailable` at `+load` so the degrade path is exercisable on demand — spec
acceptance criterion 3. It is read directly in `+load`, not part of the public API.)

- [ ] **Step 5: Create RNQuiescence.m**

Create `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty/FBQuiescence/RNQuiescence.m`:

```objc
#import "RNQuiescence.h"
#import "XCUIApplicationProcess.h"

#import <objc/runtime.h>

RNQuiescenceProbe RNQuiescenceDecideProbe(BOOL hasClassic, BOOL hasPreEvent)
{
  if (hasClassic) {
    return RNQuiescenceProbeClassic;
  }
  if (hasPreEvent) {
    return RNQuiescenceProbePreEvent;
  }
  return RNQuiescenceProbeUnavailable;
}

static RNQuiescenceProbe gProbeResult = RNQuiescenceProbeUnavailable;

RNQuiescenceProbe RNQuiescenceGetProbeResult(void)
{
  return gProbeResult;
}

BOOL RNQuiescenceParseBypass(NSString *_Nullable raw)
{
  if (raw == nil) {
    return YES;
  }
  NSString *v = [[raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] lowercaseString];
  return !([v isEqualToString:@"0"] || [v isEqualToString:@"false"]);
}

BOOL RNQuiescenceBypassEnabled(void)
{
  static BOOL enabled;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    enabled = RNQuiescenceParseBypass(NSProcessInfo.processInfo.environment[@"RN_QUIESCENCE_BYPASS"]);
  });
  return enabled;
}

static void (*original_waitClassic)(id, SEL, BOOL);
static void (*original_waitPreEvent)(id, SEL, BOOL, BOOL);

static void rnq_swizzledWaitClassic(id self, SEL _cmd, BOOL includingAnimations)
{
  if (RNQuiescenceBypassEnabled()) {
    return; // make XCTest believe the app is idling
  }
  original_waitClassic(self, _cmd, includingAnimations);
}

static void rnq_swizzledWaitPreEvent(id self, SEL _cmd, BOOL includingAnimations, BOOL isPreEvent)
{
  if (RNQuiescenceBypassEnabled()) {
    return; // make XCTest believe the app is idling
  }
  original_waitPreEvent(self, _cmd, includingAnimations, isPreEvent);
}

@interface XCUIApplicationProcess (RNQuiescence)
@end

@implementation XCUIApplicationProcess (RNQuiescence)

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wobjc-load-method"
#pragma clang diagnostic ignored "-Wcast-function-type-strict"

+ (void)load
{
  // Test-only fault injection for the UNAVAILABLE degrade path (Task 9 Step 3).
  NSString *force = NSProcessInfo.processInfo.environment[@"RN_QUIESCENCE_FORCE_UNAVAILABLE"];
  if (force != nil && [force isEqualToString:@"1"]) {
    gProbeResult = RNQuiescenceProbeUnavailable;
    return;
  }
  Method classic = class_getInstanceMethod(self.class, @selector(waitForQuiescenceIncludingAnimationsIdle:));
  Method preEvent = class_getInstanceMethod(self.class, @selector(waitForQuiescenceIncludingAnimationsIdle:isPreEvent:));
  gProbeResult = RNQuiescenceDecideProbe(classic != NULL, preEvent != NULL);
  switch (gProbeResult) {
    case RNQuiescenceProbeClassic:
      original_waitClassic = (void (*)(id, SEL, BOOL))method_setImplementation(classic, (IMP)rnq_swizzledWaitClassic);
      break;
    case RNQuiescenceProbePreEvent:
      original_waitPreEvent = (void (*)(id, SEL, BOOL, BOOL))method_setImplementation(preEvent, (IMP)rnq_swizzledWaitPreEvent);
      break;
    case RNQuiescenceProbeUnavailable:
      break; // Swift logs RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE at startup (Task 2)
  }
}

#pragma clang diagnostic pop

@end
```

- [ ] **Step 6: Expose to Swift via the bridging header**

Modify `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerUITests-Bridging-Header.h` to:

```objc
#import "RunnerObjCExceptionCatcher.h"
#import "ThirdParty/FBQuiescence/RNQuiescence.h"
```

- [ ] **Step 7: Run the tests to verify they pass**

Same command as Step 2. Expected: **TEST SUCCEEDED**, 7 tests pass — including `testProbeResolvedAtBundleLoad` proving the swizzle installed against the real XCTest on this Xcode.

If `testProbeResolvedAtBundleLoad` fails on your Xcode version: STOP and report — that means the private selector pair has drifted and the story's core assumption needs re-validation. Do not delete or weaken the test to get to green.

- [ ] **Step 8: Record provenance in IMPORT_NOTES.md**

Append to `scripts/rn-fast-runner/IMPORT_NOTES.md`:

```markdown

## Third-party: ThirdParty/FBQuiescence (added 2026-07-02, GH #384)

`RnFastRunnerUITests/ThirdParty/FBQuiescence/` vendors an adapted quiescence
bypass:

- `RNQuiescence.{h,m}` — adapted from mobile-dev-inc/maestro (Apache-2.0),
  `maestro-ios-xctest-runner/maestro-driver-iosUITests/Categories/XCUIApplicationProcess+FBQuiescence.m`,
  which itself derives from facebookarchive/WebDriverAgent (BSD-3-Clause,
  Copyright (c) 2015-present, Facebook, Inc.).
- `XCUIApplicationProcess.h` — trimmed from the class-dump private header
  vendored by the same projects.

Adaptation differences: process-wide `RN_QUIESCENCE_BYPASS` env toggle
(default ON) replaces `FBConfiguration.waitForIdleTimeout` + the per-app
`fb_shouldWaitForQuiescence` associated object; the non-bypass path calls the
original implementation unmodified (no `_XCTSetApplicationStateTimeout`
bounding); `FBLogger` dropped in favor of Swift-side startup markers.
No upstream-sync relationship is maintained.
```

- [ ] **Step 9: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/ThirdParty \
  scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift \
  scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerUITests-Bridging-Header.h \
  scripts/rn-fast-runner/IMPORT_NOTES.md
git commit -m "feat(rn-fast-runner): vendor RNQuiescence swizzle with probe + env toggle (#384)"
```

---

### Task 2: Startup markers + /health capabilities (Swift)

**Files:**
- Create: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceStatus.swift`
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests.swift:90` (testCommand)
- Modify: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift:40`
- Test: `scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift` (extend)

**Interfaces:**
- Consumes (Task 1): `RNQuiescenceGetProbeResult()`, `RNQuiescenceBypassEnabled()`, `RNQuiescenceProbe` (`.classic`/`.preEvent`/`.unavailable`).
- Produces:
  - `enum QuiescenceStatus: String` with cases `.active`, `.disabled`, `.unavailable`
  - `QuiescenceStatus.resolve(probe:bypassEnabled:) -> QuiescenceStatus` (pure)
  - `QuiescenceStatus.current() -> QuiescenceStatus`
  - `.startupMarker: String` — one of `RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE`, `RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED`, `RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE` (Task 3's TS parser matches these EXACT strings)
  - `.capabilities: [String]` — `["QUIESCENCE_BYPASS"]` iff `.active` (Task 6's TS reads this from `/health`)

- [ ] **Step 1: Extend the Swift tests (failing)**

Append to `QuiescenceBypassTests.swift` inside the class:

```swift
  // MARK: - Status resolution (Task 2)

  func testResolveStatusActive() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .classic, bypassEnabled: true), .active)
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .preEvent, bypassEnabled: true), .active)
  }

  func testResolveStatusDisabledWhenOptedOut() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .classic, bypassEnabled: false), .disabled)
  }

  func testResolveStatusUnavailableTrumpsBypass() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .unavailable, bypassEnabled: true), .unavailable)
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .unavailable, bypassEnabled: false), .unavailable)
  }

  func testStartupMarkers() {
    XCTAssertEqual(QuiescenceStatus.active.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE")
    XCTAssertEqual(QuiescenceStatus.disabled.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED")
    XCTAssertEqual(QuiescenceStatus.unavailable.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE")
  }

  func testCapabilitiesOnlyWhenActive() {
    XCTAssertEqual(QuiescenceStatus.active.capabilities, ["QUIESCENCE_BYPASS"])
    XCTAssertEqual(QuiescenceStatus.disabled.capabilities, [])
    XCTAssertEqual(QuiescenceStatus.unavailable.capabilities, [])
  }
```

- [ ] **Step 2: Run tests to verify the new ones fail (compile error: `QuiescenceStatus` unknown)**

Same xcodebuild command as Task 1 Step 2. Expected: **BUILD FAILED** — `cannot find 'QuiescenceStatus' in scope`.

- [ ] **Step 3: Create QuiescenceStatus.swift**

```swift
import Foundation

// GH #384 (Story 03): resolved quiescence-bypass state for this runner process.
enum QuiescenceStatus: String {
  case active
  case disabled
  case unavailable

  static func resolve(probe: RNQuiescenceProbe, bypassEnabled: Bool) -> QuiescenceStatus {
    if probe == .unavailable {
      return .unavailable
    }
    return bypassEnabled ? .active : .disabled
  }

  static func current() -> QuiescenceStatus {
    resolve(probe: RNQuiescenceGetProbeResult(), bypassEnabled: RNQuiescenceBypassEnabled())
  }

  var startupMarker: String {
    switch self {
    case .active: return "RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE"
    case .disabled: return "RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED"
    case .unavailable: return "RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE"
    }
  }

  var capabilities: [String] {
    self == .active ? ["QUIESCENCE_BYPASS"] : []
  }
}
```

- [ ] **Step 4: Log the startup marker in testCommand**

In `RnFastRunnerTests.swift`, `testCommand()`, directly after the line `NSLog("RN_FAST_RUNNER_DESIRED_PORT=%d", desiredPort)` (currently line 90), add:

```swift
    let quiescence = QuiescenceStatus.current()
    if quiescence == .active {
      let variant = RNQuiescenceGetProbeResult() == .preEvent ? "preEvent" : "classic"
      NSLog("%@=%@", quiescence.startupMarker, variant)
    } else {
      NSLog("%@", quiescence.startupMarker)
    }
```

(This runs before `listener?.start(...)`, so the marker always precedes `RN_FAST_RUNNER_LISTENER_READY` in xcodebuild stdout — Task 3's parser depends on that ordering. The `=classic`/`=preEvent` suffix records WHICH private selector got swizzled — exactly one is, classic preferred, mirroring upstream Maestro's probe order — and the TS parser's `includes()` match is unaffected by the suffix. Task 9 records the variant in the PR evidence.)

- [ ] **Step 5: Report capabilities from /health**

In `RnFastRunnerTests+Transport.swift`, change the health response (currently line 40, `capabilities: []`) to:

```swift
        let response = self.jsonResponse(
          status: 200,
          response: Response(
            ok: true,
            protocolVersion: RunnerProtocol.version,
            runnerVersion: RunnerEnv.pluginVersion(),
            capabilities: QuiescenceStatus.current().capabilities
          )
        )
```

- [ ] **Step 6: Run the full Swift quiescence suite to verify green**

Same xcodebuild command. Expected: **TEST SUCCEEDED**, 12 tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceStatus.swift \
  scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/QuiescenceBypassTests.swift \
  scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests.swift \
  scripts/rn-fast-runner/RnFastRunner/RnFastRunnerUITests/RnFastRunnerTests+Transport.swift
git commit -m "feat(rn-fast-runner): quiescence startup markers + QUIESCENCE_BYPASS health capability (#384)"
```

---

### Task 3: TS ready-signal parser captures the quiescence marker

**Files:**
- Create: `scripts/cdp-bridge/src/runners/quiescence.ts` (type only in this task; functions come in Task 4)
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts:50-106` (parser)
- Test: `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` (new)

**Interfaces:**
- Consumes (Task 2): the three exact marker strings.
- Produces:
  - `export type QuiescenceStatus = 'active' | 'disabled' | 'unavailable'` (in `runners/quiescence.ts`)
  - `ReadySignalResult` ready-variant gains `quiescence?: QuiescenceStatus` (Task 4 stores it in `FastRunnerState`)

- [ ] **Step 1: Create the type module**

Create `scripts/cdp-bridge/src/runners/quiescence.ts`:

```ts
// GH #384 (Story 03): tri-state quiescence-bypass status reported by the
// iOS rn-fast-runner at startup (see QuiescenceStatus.swift).
export type QuiescenceStatus = 'active' | 'disabled' | 'unavailable';
```

- [ ] **Step 2: Write the failing parser tests**

Create `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReadySignalParser,
  parseReadySignal,
} from '../../../dist/runners/rn-fast-runner-client.js';

const READY = 'RN_FAST_RUNNER_LISTENER_READY\nRN_FAST_RUNNER_PORT=22088\n';

test('parser captures QUIESCENCE_BYPASS_ACTIVE marker before READY', () => {
  const result = parseReadySignal(
    `2026-07-02 10:00:00 Runner[1:2] RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\n${READY}`,
  );
  assert.deepEqual(result, { ready: true, port: 22088, quiescence: 'active' });
});

test('parser captures DISABLED and UNAVAILABLE markers', () => {
  assert.deepEqual(
    parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED\n${READY}`),
    { ready: true, port: 22088, quiescence: 'disabled' },
  );
  assert.deepEqual(
    parseReadySignal(`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE\n${READY}`),
    { ready: true, port: 22088, quiescence: 'unavailable' },
  );
});

test('parser omits quiescence when no marker seen (old runner binary)', () => {
  assert.deepEqual(parseReadySignal(READY), { ready: true, port: 22088 });
});

test('parser handles marker split across chunk boundaries', () => {
  const parser = createReadySignalParser();
  assert.equal(parser.feed('RN_FAST_RUNNER_QUIESCENCE_BYPASS_AC'), null);
  assert.equal(parser.feed('TIVE\nRN_FAST_RUNNER_LISTENER_READY\n'), null);
  assert.deepEqual(parser.feed('RN_FAST_RUNNER_PORT=9999\n'), {
    ready: true,
    port: 9999,
    quiescence: 'active',
  });
});

test('failure markers still win over quiescence markers', () => {
  const result = parseReadySignal(
    'RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE\nRN_FAST_RUNNER_LISTENER_FAILED\n',
  );
  assert.deepEqual(result, { error: 'RN_FAST_RUNNER_LISTENER_FAILED' });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | grep -A 3 "gh-384"
```

Expected: FAIL — the ready results lack the `quiescence` key (`deepEqual` mismatch).

- [ ] **Step 4: Extend the parser**

In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`:

Add to the imports block near the top:

```ts
import type { QuiescenceStatus } from './quiescence.js';
```

Change the result type (line 50):

```ts
export type ReadySignalResult =
  | { ready: true; port: number; quiescence?: QuiescenceStatus }
  | { error: string };
```

In `createReadySignalParser()`, add a `quiescence` variable and marker matching. The full updated function body:

```ts
export function createReadySignalParser(): ReadySignalParser {
  let pending = '';
  let seenReady = false;
  let quiescence: QuiescenceStatus | undefined;
  return {
    feed(chunk: string): ReadySignalResult | null {
      pending += chunk;
      // Process complete lines only; keep the trailing partial line buffered.
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        // Failure markers may appear anywhere — check first.
        if (line.includes('RN_FAST_RUNNER_LISTENER_FAILED')) {
          return { error: 'RN_FAST_RUNNER_LISTENER_FAILED' };
        }
        if (line.includes('RN_FAST_RUNNER_PORT_NOT_SET')) {
          return { error: 'RN_FAST_RUNNER_PORT_NOT_SET' };
        }
        // GH #384: quiescence startup marker precedes LISTENER_READY.
        if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE')) {
          quiescence = 'active';
        } else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED')) {
          quiescence = 'disabled';
        } else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE')) {
          quiescence = 'unavailable';
        }
        if (!seenReady) {
          if (line.includes('RN_FAST_RUNNER_LISTENER_READY')) {
            seenReady = true;
          }
          continue;
        }
        // After READY, scan for the port. NSLog wraps the marker in a
        // timestamp + process prefix, so match anywhere in the line.
        const portMatch = line.match(/RN_FAST_RUNNER_PORT=(\d+)/);
        if (portMatch) {
          return {
            ready: true,
            port: Number(portMatch[1]),
            ...(quiescence !== undefined ? { quiescence } : {}),
          };
        }
      }
      return null;
    },
  };
}
```

- [ ] **Step 5: Run tests to verify pass, plus the full suite**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -5
```

Expected: all tests pass (the 5 new ones included), no regressions.

- [ ] **Step 6: Commit (rebuild is part of `npm test`; stage dist)**

```bash
git add scripts/cdp-bridge/src/runners/quiescence.ts \
  scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts \
  scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js \
  scripts/cdp-bridge/dist
git commit -m "feat(cdp-bridge): parse quiescence startup markers from runner stdout (#384)"
```

---

### Task 4: TS env threading + FastRunnerState.quiescence

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/quiescence.ts`
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (`startFastRunner`, ~line 315-364)
- Modify: `scripts/cdp-bridge/src/types.ts:328-337` (`FastRunnerState`)
- Test: `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` (extend)

**Interfaces:**
- Consumes (Task 3): `QuiescenceStatus`, `ReadySignalResult.quiescence`.
- Produces:
  - `resolveQuiescenceBypass(env: NodeJS.ProcessEnv): boolean` — absent → `true`; `'0'`/`'false'` → `false`
  - `buildRunnerQuiescenceEnv(env: NodeJS.ProcessEnv): Record<string, string>` — `{ RN_QUIESCENCE_BYPASS, TEST_RUNNER_RN_QUIESCENCE_BYPASS }`, both `'1'` or `'0'`
  - `FastRunnerState.quiescence?: 'active' | 'disabled' | 'unavailable'` (Task 5 reads it for the meta announcement; it round-trips through the persisted state file automatically since `parsePersistedRunnerState` casts the whole object)

- [ ] **Step 1: Write the failing tests**

Append to `gh-384-quiescence.test.js`:

```js
import {
  resolveQuiescenceBypass,
  buildRunnerQuiescenceEnv,
} from '../../../dist/runners/quiescence.js';

test('resolveQuiescenceBypass defaults ON and honors 0/false opt-out', () => {
  assert.equal(resolveQuiescenceBypass({}), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: '1' }), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: 'weird' }), true);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: '0' }), false);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: 'false' }), false);
  assert.equal(resolveQuiescenceBypass({ RN_QUIESCENCE_BYPASS: ' FALSE ' }), false);
});

test('buildRunnerQuiescenceEnv emits both plain and TEST_RUNNER_ forms', () => {
  assert.deepEqual(buildRunnerQuiescenceEnv({}), {
    RN_QUIESCENCE_BYPASS: '1',
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: '1',
  });
  assert.deepEqual(buildRunnerQuiescenceEnv({ RN_QUIESCENCE_BYPASS: '0' }), {
    RN_QUIESCENCE_BYPASS: '0',
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: '0',
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | grep -B 2 -A 5 "quiescence"  | head -30
```

Expected: FAIL — `resolveQuiescenceBypass` is not exported.

- [ ] **Step 3: Implement quiescence.ts functions**

Replace the content of `scripts/cdp-bridge/src/runners/quiescence.ts` with:

```ts
// GH #384 (Story 03): tri-state quiescence-bypass status reported by the
// iOS rn-fast-runner at startup (see QuiescenceStatus.swift).
export type QuiescenceStatus = 'active' | 'disabled' | 'unavailable';

// Same rollout shape as the keyboard guard (runners/keyboard-guard.ts):
// default ON, opt out with RN_QUIESCENCE_BYPASS=0|false. Unlike the guard
// this is resolved once at runner SPAWN, not per command — the swizzle
// decision is process-wide inside the XCUITest runner.
export function resolveQuiescenceBypass(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.RN_QUIESCENCE_BYPASS ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

// xcodebuild only forwards TEST_RUNNER_-prefixed env vars to the XCUITest
// process (prefix stripped) — same lesson as buildRunnerVersionEnv (GH #383).
// The plain form covers any direct launch path.
export function buildRunnerQuiescenceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = resolveQuiescenceBypass(env) ? '1' : '0';
  return {
    RN_QUIESCENCE_BYPASS: value,
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: value,
  };
}
```

- [ ] **Step 4: Thread the env at spawn + store the parsed status**

In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`:

Extend the quiescence import (from Task 3) to:

```ts
import type { QuiescenceStatus } from './quiescence.js';
import { buildRunnerQuiescenceEnv } from './quiescence.js';
```

In `startFastRunner`, extend the spawn env (currently lines 315-322):

```ts
    const child = spawn('xcodebuild', args, {
      env: {
        ...process.env,
        RN_FAST_RUNNER_PORT: String(desired),
        ...buildRunnerVersionEnv(getPluginVersion()),
        ...buildRunnerQuiescenceEnv(process.env),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
```

In `handleChunk`, extend the state construction (currently lines 346-355):

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
        ...(result.quiescence !== undefined ? { quiescence: result.quiescence } : {}),
      };
```

- [ ] **Step 5: Add the state field to types.ts**

In `scripts/cdp-bridge/src/types.ts`, extend `FastRunnerState` (line 328):

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
  quiescence?: 'active' | 'disabled' | 'unavailable';
}
```

(Union inlined rather than imported from `runners/quiescence.ts` — `types.ts` must not import from `runners/` to avoid a dependency cycle.)

- [ ] **Step 6: Run tests to verify pass, plus the full suite**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src/runners/quiescence.ts \
  scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts \
  scripts/cdp-bridge/src/types.ts \
  scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js \
  scripts/cdp-bridge/dist
git commit -m "feat(cdp-bridge): thread RN_QUIESCENCE_BYPASS to the runner + persist quiescence state (#384)"
```

---

### Task 5: `meta.quiescenceBypass` on the first command after boot

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (`startFastRunner`, `adoptPersistedFastRunnerState`, `runIOS`)
- Test: `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` (extend)

**Interfaces:**
- Consumes (Task 4): `FastRunnerState.quiescence`, the test seams `_setRunnerStateForTest` / `_setFetchForTest` (already exported).
- Produces: successful `runIOS` results carry `meta.quiescenceBypass: 'active' | 'disabled' | 'unavailable'` exactly once per state acquisition (fresh start or adoption). Also exports `_resetQuiescenceAnnouncementForTest(pending: boolean): void` as a test seam.

- [ ] **Step 1: Write the failing tests**

Append to `gh-384-quiescence.test.js`:

```js
import {
  _setRunnerStateForTest,
  _setFetchForTest,
  _resetQuiescenceAnnouncementForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';

function fakeState(quiescence) {
  return {
    schemaVersion: 1,
    port: 12345,
    pid: process.pid,
    deviceId: 'UDID-TEST',
    bundleId: 'com.example.app',
    startedAt: '2026-07-02T00:00:00.000Z',
    protocolVersion: 1,
    ...(quiescence !== undefined ? { quiescence } : {}),
  };
}

function okFetch() {
  return async () =>
    new Response(JSON.stringify({ ok: true, v: 1, data: { message: 'done' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

test('runIOS announces meta.quiescenceBypass exactly once after boot', async () => {
  _setRunnerStateForTest(fakeState('active'));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, 'active');

  const second = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(second.meta?.quiescenceBypass, undefined);

  _setRunnerStateForTest(null);
});

test('runIOS announces disabled status too', async () => {
  _setRunnerStateForTest(fakeState('disabled'));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, 'disabled');

  _setRunnerStateForTest(null);
});

test('runIOS announces nothing when the runner reported no marker (old binary)', async () => {
  _setRunnerStateForTest(fakeState(undefined));
  _setFetchForTest(okFetch());
  _resetQuiescenceAnnouncementForTest(true);

  const first = JSON.parse((await runIOS({ command: 'tap', x: 1, y: 1 })).content[0].text);
  assert.equal(first.meta?.quiescenceBypass, undefined);

  _setRunnerStateForTest(null);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | grep -B 2 -A 5 "announces" | head -30
```

Expected: FAIL — `_resetQuiescenceAnnouncementForTest` is not exported.

- [ ] **Step 3: Implement the announcement**

In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`:

Below the singleton state declarations (`let runnerProcess ... let runnerState ...`, ~line 110), add:

```ts
// GH #384: announce the runner's quiescence-bypass status on the FIRST
// successful /command after a state acquisition (fresh spawn or adoption),
// so sessions are auditable without polling /health. Consumed by every
// success return in runIOS — currently the type-shim return, the snapshot
// return + its defensive fallback, and the final default return; a new
// success return site must also attach it. A shimmed `type` (resp.ok=false
// at the wire level) defers the announcement to the next command by design.
let quiescenceAnnouncementPending = false;

const QUIESCENCE_STATUSES = new Set(['active', 'disabled', 'unavailable']);

export function _resetQuiescenceAnnouncementForTest(pending: boolean): void {
  quiescenceAnnouncementPending = pending;
}

function takeQuiescenceAnnouncement(): Record<string, unknown> | null {
  if (!quiescenceAnnouncementPending) return null;
  quiescenceAnnouncementPending = false;
  // Persisted state is cast, not validated field-by-field — guard against a
  // tampered/corrupt local state file surfacing an arbitrary string.
  if (!runnerState?.quiescence || !QUIESCENCE_STATUSES.has(runnerState.quiescence)) return null;
  return { quiescenceBypass: runnerState.quiescence };
}
```

In `adoptPersistedFastRunnerState`, set the flag on BOTH successful adoption paths (after `runnerState = parsed;` and after `if (parsedLegacy.deviceId === deviceId) runnerState = parsedLegacy;`):

```ts
    runnerState = parsed;
    quiescenceAnnouncementPending = true;
    return;
```

```ts
  if (parsedLegacy.deviceId === deviceId) {
    runnerState = parsedLegacy;
    quiescenceAnnouncementPending = true;
  }
```

In `startFastRunner`'s `handleChunk`, after `runnerState = state;`:

```ts
      runnerState = state;
      quiescenceAnnouncementPending = true;
```

In `runIOS`, merge the announcement into every success return. After the `postCommand` try/catch (i.e. once `resp` is known), insert:

```ts
  const announce = resp.ok ? takeQuiescenceAnnouncement() : null;
```

Then change the three success returns:

1. The runner-timeout shim return:

```ts
      return okResult(
        { typed: true, text: args.text },
        { meta: { sideEffectSucceeded: true, runnerTimeoutShim: true, ...(announce ?? {}) } },
      );
```

Note: the shim fires on `resp.ok === false`, so `announce` is `null` there by the rule above — but the spread keeps the code uniform and correct if the rule ever changes. Keep `announce` computed before this block.

2. The snapshot return:

```ts
      return okResult({ nodes: flat }, announce ? { meta: announce } : undefined);
```

and the defensive fallback right below it:

```ts
    return okResult(resp.data, announce ? { meta: announce } : undefined);
```

3. The final default return:

```ts
  return okResult(resp.data ?? {}, announce ? { meta: announce } : undefined);
```

- [ ] **Step 4: Run tests to verify pass, plus the full suite**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -5
```

Expected: all pass. Watch specifically for regressions in `rn-fast-runner-client.test.js` (existing runIOS tests must not see an unexpected `meta` — the flag defaults to `false` in a fresh process, so they won't).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts \
  scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js \
  scripts/cdp-bridge/dist
git commit -m "feat(cdp-bridge): announce meta.quiescenceBypass on first command after boot (#384)"
```

---

### Task 6: Surface runner capabilities in the health probe and `cdp_status.deviceSession`

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts` (`HttpProbeResult`, `defaultHttpProbe`, `FastRunnerLivenessDetail`, `probeFastRunnerLivenessDetailed`)
- Modify: `scripts/cdp-bridge/src/tools/device-session-health.ts` (`DeviceSessionHealth`, `getDeviceSessionHealth`)
- Test: `scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js` (extend)

**Interfaces:**
- Consumes (Task 2): `/health` body `capabilities: string[]`.
- Produces:
  - `HttpProbeResult.capabilities?: string[]`
  - `FastRunnerLivenessDetail.capabilities?: string[]`
  - `DeviceSessionHealth.runnerCapabilities?: string[]` — flows into `cdp_status` → `deviceSession.runnerCapabilities` automatically (status.ts embeds the whole object at `tools/status.ts:96,166`)

- [ ] **Step 1: Write the failing tests**

Append to `gh-384-quiescence.test.js`:

```js
import { probeFastRunnerLivenessDetailed } from '../../../dist/runners/rn-fast-runner-client.js';
import { getDeviceSessionHealth } from '../../../dist/tools/device-session-health.js';

test('liveness detail carries capabilities from /health', async () => {
  const detail = await probeFastRunnerLivenessDetailed({
    getState: () => ({ pid: 1, port: 1, deviceId: 'D', bundleId: 'B' }),
    processAlive: () => true,
    httpProbe: async () => ({
      ok: true,
      status: 200,
      bodyOk: true,
      protocolVersion: 1,
      capabilities: ['QUIESCENCE_BYPASS'],
    }),
    pluginVersion: null,
  });
  assert.equal(detail.liveness, 'alive');
  assert.deepEqual(detail.capabilities, ['QUIESCENCE_BYPASS']);
});

test('deviceSession health surfaces runnerCapabilities', async () => {
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({
      liveness: 'alive',
      runnerProtocolVersion: 1,
      capabilities: ['QUIESCENCE_BYPASS'],
    }),
  });
  assert.deepEqual(health.runnerCapabilities, ['QUIESCENCE_BYPASS']);
});

test('deviceSession health omits runnerCapabilities when probe has none', async () => {
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1 }),
  });
  assert.equal(health.runnerCapabilities, undefined);
});

test('deviceSession health omits runnerCapabilities when the list is empty', async () => {
  // Every pre-#384 runner (and a disabled/unavailable one) reports [] from
  // /health — an empty list must not add noise to cdp_status.
  const health = await getDeviceSessionHealth({
    getActiveSession: () => ({
      platform: 'ios',
      appId: 'com.example.app',
      deviceId: 'UDID-TEST',
    }),
    adopt: () => {},
    probeLiveness: async () => ({ liveness: 'alive', runnerProtocolVersion: 1, capabilities: [] }),
  });
  assert.equal(health.runnerCapabilities, undefined);
});
```

(`getDeviceSessionHealth`'s `getActiveSession` seam is typed as `SessionState | null`; the object literal above matches the fields the function reads — `platform`, `appId`, `deviceId`. If tsc-typed tests complain, this is plain JS `node:test`, so it won't.)

- [ ] **Step 2: Run to verify failure**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | grep -B 2 -A 5 "capabilities" | head -40
```

Expected: FAIL — `detail.capabilities` and `health.runnerCapabilities` are `undefined`.

- [ ] **Step 3: Implement the plumbing**

In `scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts`:

Extend `HttpProbeResult` (line ~483):

```ts
export interface HttpProbeResult {
  ok: boolean;
  status: number;
  bodyOk?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
  capabilities?: string[];
}
```

In `defaultHttpProbe`, parse capabilities. The updated body-parsing section:

```ts
    let bodyOk: boolean | undefined;
    let protocolVersion: number | undefined;
    let runnerVersion: string | undefined;
    let capabilities: string[] | undefined;
    try {
      const body = (await res.json()) as {
        ok?: boolean;
        protocolVersion?: number;
        runnerVersion?: string;
        capabilities?: unknown;
      };
      bodyOk = body.ok === true;
      if (typeof body.protocolVersion === 'number') protocolVersion = body.protocolVersion;
      if (typeof body.runnerVersion === 'string') runnerVersion = body.runnerVersion;
      if (Array.isArray(body.capabilities)) {
        capabilities = body.capabilities.filter((c): c is string => typeof c === 'string');
      }
    } catch {
      bodyOk = false;
    }
    return {
      ok: true,
      status: res.status,
      bodyOk,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      ...(runnerVersion !== undefined ? { runnerVersion } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
```

Extend `FastRunnerLivenessDetail` (line ~577):

```ts
export interface FastRunnerLivenessDetail {
  liveness: FastRunnerLiveness;
  staleReason?: FastRunnerStaleReason;
  runnerProtocolVersion?: number;
  runnerVersion?: string;
  capabilities?: string[];
}
```

In `probeFastRunnerLivenessDetailed`, extend the final `alive` return:

```ts
    return {
      liveness: 'alive',
      ...(res.protocolVersion !== undefined ? { runnerProtocolVersion: res.protocolVersion } : {}),
      ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
      ...(res.capabilities !== undefined ? { capabilities: res.capabilities } : {}),
    };
```

In `scripts/cdp-bridge/src/tools/device-session-health.ts`:

Extend the interface:

```ts
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
  runnerCapabilities?: string[];
}
```

In `getDeviceSessionHealth`, inside the `detail.liveness !== 'dead'` block, after the `health.runnerProtocol = {...}` assignment:

```ts
        if (detail.capabilities !== undefined && detail.capabilities.length > 0) {
          health.runnerCapabilities = detail.capabilities;
        }
```

(Empty arrays are omitted on purpose: every pre-#384 runner already reports
`capabilities: []`, so surfacing `[]` would add noise to every `cdp_status` call.
Absence of `runnerCapabilities` = "runner alive, no capabilities active".)

- [ ] **Step 4: Run tests to verify pass, plus the full suite**

```bash
cd scripts/cdp-bridge && npm test 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/rn-fast-runner-client.ts \
  scripts/cdp-bridge/src/tools/device-session-health.ts \
  scripts/cdp-bridge/test/unit/runners/gh-384-quiescence.test.js \
  scripts/cdp-bridge/dist
git commit -m "feat(cdp-bridge): surface runner capabilities (QUIESCENCE_BYPASS) in cdp_status.deviceSession (#384)"
```

---

### Task 7: Docs + changeset

**Files:**
- Modify: `CLAUDE.md` (Troubleshooting list + "iOS-only quirks" list)
- Create: `.changeset/384-quiescence-bypass.md`

**Interfaces:** none — documentation of Tasks 1-6 behavior.

- [ ] **Step 1: Add the troubleshooting entry**

In `CLAUDE.md`, in the `### Troubleshooting` section, add this bullet after the `RUNNER_PROTOCOL_MISMATCH` bullet:

```markdown
- **Suspect XCTest is snapshotting mid-animation / want stock idle-waits back** → Since #384 the iOS runner swizzles XCTest's `waitForQuiescenceIncludingAnimationsIdle:` into a no-op (default ON) so Reanimated/looping-animation apps can't hang queries — this is the same WebDriverAgent-lineage bypass Maestro uses. Opt out with `RN_QUIESCENCE_BYPASS=0` (resolved when the runner SPAWNS, not per command — restart the device session after changing it). Status is auditable three ways: the first `device_*` command after boot returns `meta.quiescenceBypass: "active"|"disabled"|"unavailable"`, `cdp_status` → `deviceSession.runnerCapabilities` contains `QUIESCENCE_BYPASS` while active, and the runner logs `RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE`/`_DISABLED`/`_UNAVAILABLE` at startup. `unavailable` means Apple renamed the private selector on this Xcode (the runner still works, just without the bypass — file an issue).
```

- [ ] **Step 2: Add the architecture quirk note**

In `CLAUDE.md`, in the "iOS-only quirks worth knowing" list (Architecture section), add a bullet after the `device_fill` runner-timeout-shim bullet:

```markdown
- Quiescence bypass (#384): the runner process makes XCTest's private quiescence wait a no-op via a `+load` swizzle vendored from Maestro/WebDriverAgent (`scripts/rn-fast-runner/.../ThirdParty/FBQuiescence/`, provenance in `IMPORT_NOTES.md`). It probes both private selectors — `-[XCUIApplicationProcess waitForQuiescenceIncludingAnimationsIdle:]` and the Xcode-16 `:isPreEvent:` variant — and swizzles exactly ONE (classic preferred, upstream Maestro's order); the ACTIVE startup marker records which (`=classic`/`=preEvent`). If neither resolves the runner boots normally without the bypass and reports `unavailable`. Scope of the win: snapshot/query/scroll idle-waits are eliminated; `XCUIElement.typeText` has its own internal synchronization, so the runner-timeout shim (`meta.runnerTimeoutShim`) stays in place as the safety net — its firing count trending down is a trailing telemetry signal, not a guarantee. Story 04's settle engine is the correctness layer for mid-animation reads.
```

- [ ] **Step 3: Create the changeset**

Create `.changeset/384-quiescence-bypass.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

feat(rn-fast-runner): quiescence bypass — make XCTest's private quiescence wait a no-op inside the iOS runner (#384, Story 03). RN apps with Reanimated worklets/looping animations never report idle, so XCTest queries and snapshots stalled until per-symptom patches (runner-timeout shim, HID-synthesis scroll, 35s budgets) caught them; the bypass removes the idle-wait at the root — the same WebDriverAgent-lineage approach Maestro uses. Probes both private selector variants (`waitForQuiescenceIncludingAnimationsIdle:` and the Xcode-16 `:isPreEvent:` form), swizzles exactly one (classic preferred), and degrades loudly (`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`) when Apple drifts the API — the runner keeps working without the bypass. Default ON; opt out with `RN_QUIESCENCE_BYPASS=0` (resolved at runner spawn; threaded as `TEST_RUNNER_RN_QUIESCENCE_BYPASS` because xcodebuild only forwards `TEST_RUNNER_`-prefixed vars). Note: `XCUIElement.typeText` runs its own internal sync, so the type-timeout shim remains as a safety net. Auditable via `meta.quiescenceBypass` on the first command after boot, `QUIESCENCE_BYPASS` in `/health.capabilities`, and `cdp_status.deviceSession.runnerCapabilities`.
```

- [ ] **Step 4: Lint + format + full test pass**

```bash
npm run lint && npm run format && cd scripts/cdp-bridge && npm test 2>&1 | tail -3
```

Expected: lint/format clean (stage any formatting diffs), tests pass.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .changeset/384-quiescence-bypass.md
git commit -m "docs: quiescence bypass troubleshooting + architecture notes + changeset (#384)"
```

---

### Task 8: Reanimated fixture screen in the workspace test-app

**Files (all in `../rn-dev-agent-workspace` — a SEPARATE git repo):**
- Create: `test-app/src/screens/ReanimatedLoopScreen.tsx`
- Modify: `test-app/src/navigation/types.ts:3-8` (`HomeStackParams`)
- Modify: `test-app/src/navigation/RootNavigator.tsx` (HomeStack registration)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: route `ReanimatedLoop` (reachable via `cdp_navigate`), testIDs `reanimated-loop-screen`, `loop-box`, `loop-counter`, `loop-input`, `loop-row-<0..29>` — Task 9's verification matrix drives these.

**Note:** no unit-test cycle here (the workspace test-app has no test harness for screens); verification is Task 9's live matrix. Keep the screen minimal and deterministic.

- [ ] **Step 1: Create the screen**

Create `../rn-dev-agent-workspace/test-app/src/screens/ReanimatedLoopScreen.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

// GH #384 fixture: an infinite Reanimated loop keeps the app permanently
// non-quiescent so XCTest idle-waits hang without the quiescence bypass.
export default function ReanimatedLoopScreen() {
  const progress = useSharedValue(0);
  const [ticks, setTicks] = useState(0);
  const [text, setText] = useState('');

  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 800 }), -1, true);
    const interval = setInterval(() => setTicks((t) => t + 1), 500);
    return () => clearInterval(interval);
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * 200 }],
  }));

  return (
    <ScrollView style={styles.container} testID="reanimated-loop-screen">
      <Animated.View style={[styles.box, animatedStyle]} testID="loop-box" />
      <Text style={styles.counter} testID="loop-counter">
        ticks: {ticks}
      </Text>
      <TextInput
        style={styles.input}
        testID="loop-input"
        value={text}
        onChangeText={setText}
        placeholder="type here"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {Array.from({ length: 30 }, (_, i) => (
        <Text key={i} style={styles.row} testID={`loop-row-${i}`}>
          row {i}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  box: { width: 48, height: 48, borderRadius: 8, backgroundColor: '#e91e63', marginBottom: 16 },
  counter: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, marginBottom: 16 },
  row: { paddingVertical: 12, fontSize: 16 },
});
```

- [ ] **Step 2: Register the route type**

In `../rn-dev-agent-workspace/test-app/src/navigation/types.ts`, extend `HomeStackParams`:

```ts
export type HomeStackParams = {
  HomeMain: undefined;
  Feed: undefined;
  Dashboard: undefined;
  Diagnostics: undefined;
  ReanimatedLoop: undefined;
};
```

- [ ] **Step 3: Register the screen**

In `../rn-dev-agent-workspace/test-app/src/navigation/RootNavigator.tsx`:

Add the import alongside the other screen imports:

```tsx
import ReanimatedLoopScreen from '../screens/ReanimatedLoopScreen';
```

Add the screen inside `HomeStackNavigator`'s `<HomeStack.Navigator>`, after the `Diagnostics` screen:

```tsx
        <HomeStack.Screen
          name="ReanimatedLoop"
          component={ReanimatedLoopScreen}
          options={{ title: 'Reanimated Loop' }}
        />
```

- [ ] **Step 4: Smoke-check it loads**

With Metro running from the workspace (`cd ../rn-dev-agent-workspace/test-app && npx expo start`) and the app booted on the simulator:

```
cdp_status                     → connected
cdp_navigate route=ReanimatedLoop
cdp_component_tree filter=reanimated-loop-screen
```

Expected: the screen renders, `loop-counter` is in the tree, and the counter value advances between two `cdp_component_tree` reads (proves the loop is live).

- [ ] **Step 5: Commit (workspace repo)**

```bash
cd ../rn-dev-agent-workspace
git add test-app/src/screens/ReanimatedLoopScreen.tsx \
  test-app/src/navigation/types.ts \
  test-app/src/navigation/RootNavigator.tsx
git commit -m "feat(test-app): ReanimatedLoop fixture screen for quiescence-bypass verification (rn-dev-agent#384)"
```

---

### Task 9: Live device verification matrix (manual — gates the PR)

**Files:** none (evidence recorded in the PR body; telemetry noted for the dogfooding follow-up).

**Interfaces:**
- Consumes: everything above, running against the booted iOS simulator + workspace test-app.

**Precondition:** the runner binary on the simulator must be REBUILT so it contains the swizzle — a stale prebuilt `.xctestrun` will silently test the old behavior:

```bash
rm -rf scripts/rn-fast-runner/build/DerivedData
```

Then `device_snapshot action=open appId=com.rndevagent.testapp platform=ios` cold-builds it (several minutes, one time).

- [ ] **Step 1: Bypass ON (default) on the fixture screen**

Navigate: `cdp_navigate route=ReanimatedLoop`. Resolve the runner port once (path verified against `util/secure-state-file.ts` — `getStateDir()` + `runner-state/ios-<UDID>.json`):

```bash
STATE_DIR="${XDG_STATE_HOME:+$XDG_STATE_HOME/rn-dev-agent}"
STATE_DIR="${STATE_DIR:-$HOME/Library/Application Support/rn-dev-agent}"
PORT=$(python3 -c 'import json,glob,sys; print(json.load(open(glob.glob(sys.argv[1]+"/runner-state/ios-*.json")[0]))["port"])' "$STATE_DIR")
```

Then verify each acceptance criterion from the spec:

1. **[PR GATE]** `device_snapshot action=snapshot` — completes **< 2 s** (check `meta.timings_ms` / wall clock; before this change a busy app could sit near the 35 s budget). This is also the proof that the *effective* selector variant was swizzled on this OS — the drift-detector unit test only proves *a* selector resolved.
2. **[EVIDENCE, not a gate]** Native type path, exercised DIRECTLY against the runner — `device_fill` is JS-first (D1250) and would never touch `XCUIElement.typeText`, so it cannot exercise the bypass. Get `loop-input`'s center from `device_snapshot`, then:
   ```bash
   curl -s -X POST "http://127.0.0.1:$PORT/command" -H 'content-type: application/json' \
     -d '{"command":"tap","appBundleId":"com.rndevagent.testapp","x":<inputCenterX>,"y":<inputCenterY>}'
   curl -s -X POST "http://127.0.0.1:$PORT/command" -H 'content-type: application/json' \
     -d '{"command":"type","appBundleId":"com.rndevagent.testapp","text":"quiescence"}'
   ```
   Record whether the type returns `ok:true` promptly or still hits the "main thread execution timed out" shape: `typeText` runs its own internal synchronization distinct from the swizzled wait (`rn-fast-runner-client.ts:873-891`), so a persisting timeout here is EXPECTED-POSSIBLE, not a failure — the shim stays as the safety net. Either way the text must land in the field (`cdp_component_tree` on `loop-input`).
3. **[PR GATE]** Non-HID scroll (the XCTest scroll path — `device_scroll` routes through HID synthesis, so hit the runner directly):
   ```bash
   curl -s -X POST "http://127.0.0.1:$PORT/command" -H 'content-type: application/json' \
     -d '{"command":"scroll","appBundleId":"com.rndevagent.testapp","direction":"down"}'
   ```
   Expected: returns `ok:true` within a few seconds — no deadlock.
4. First command after boot carried `meta.quiescenceBypass: "active"` (check the first `device_*` result of the session).
5. `cdp_status` → `deviceSession.runnerCapabilities` contains `"QUIESCENCE_BYPASS"`. Also record which variant the startup marker reported (`RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE=classic|preEvent` in the xcodebuild/bridge log) — the OTHER variant's swizzle path is code-review-only on this OS.

- [ ] **Step 2: Bypass OFF — prove the toggle isolates the change**

Kill the runner and relaunch it with the opt-out (direct xcodebuild launch avoids restarting the MCP session just to change env):

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
cd scripts/rn-fast-runner/RnFastRunner && \
RN_FAST_RUNNER_PORT=22090 \
TEST_RUNNER_RN_QUIESCENCE_BYPASS=0 RN_QUIESCENCE_BYPASS=0 \
xcodebuild test-without-building \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand 2>&1 | \
  grep -m1 "RN_FAST_RUNNER_QUIESCENCE"
```

Expected: the startup marker line is `RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED`. Then, with the fixture screen foregrounded, exercise the stock idle-wait — the `appBundleId` is REQUIRED (without it the runner falls back to activating its own host app via `executeOnMain`'s `app.activate()` and the test proves nothing):

```bash
curl -s -X POST "http://127.0.0.1:22090/command" -H 'content-type: application/json' \
  -d '{"command":"tap","appBundleId":"com.rndevagent.testapp","x":<inputCenterX>,"y":<inputCenterY>}'
curl -s -X POST "http://127.0.0.1:22090/command" -H 'content-type: application/json' \
  -d '{"command":"snapshot","appBundleId":"com.rndevagent.testapp"}'
```

Expected: OLD behavior returns — the snapshot/tap sits on the XCTest idle-wait (markedly slower than Step 1's <2s, up to the internal timeouts) while the Reanimated loop runs. Also confirm `curl -s http://127.0.0.1:22090/health` shows `"capabilities":[]`. Terminate this runner (`Ctrl-C` / kill the xcodebuild) when done — the port-22090 instance must not linger into later steps.

- [ ] **Step 3: UNAVAILABLE degrade path (fault injection)**

Relaunch the runner once more with the test-only fault-injection env (spec acceptance criterion: selector missing → boots, logs `_UNAVAILABLE`, commands still work):

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
cd scripts/rn-fast-runner/RnFastRunner && \
RN_FAST_RUNNER_PORT=22091 \
TEST_RUNNER_RN_QUIESCENCE_FORCE_UNAVAILABLE=1 \
xcodebuild test-without-building \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand 2>&1 | \
  grep -m1 "RN_FAST_RUNNER_QUIESCENCE"
```

Expected: marker is `RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`; `curl -s http://127.0.0.1:22091/health` returns `ok:true` with `"capabilities":[]`; a `snapshot` command via curl (with `appBundleId`) still succeeds. Terminate when done.

- [ ] **Step 4: The rest of the UITests bundle is unaffected by the always-compiled swizzle**

The `+load` swizzle is active for EVERY test in the target, not just `QuiescenceBypassTests` — prove the others still pass with it compiled in:

```bash
UDID=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
cd scripts/rn-fast-runner/RnFastRunner && xcodebuild test \
  -project RnFastRunner.xcodeproj -scheme RnFastRunner \
  -destination "platform=iOS Simulator,id=$UDID" \
  -derivedDataPath ../build/DerivedData \
  -only-testing:RnFastRunnerUITests/KeyboardGuardTests \
  -only-testing:RnFastRunnerUITests/QuiescenceBypassTests \
  -only-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest 2>&1 | tail -5
```

(Do NOT run the whole target unfiltered — `RnFastRunnerTests/testCommand` blocks on its 24h listener wait.) Expected: **TEST SUCCEEDED**.

- [ ] **Step 5: No regression on golden flows**

Re-open the normal device session (`device_snapshot action=open …`) and run the existing TaskWizard golden flow (fill/press/longpress with keyboard guard):

```
cdp_run_action  (the TaskWizard action from .rn-agent/actions — see /list-learned-actions)
```

plus a manual `device_press` on a keyboard-occluded target to confirm `meta.keyboardGuard` still reports (`dismissed`/`not_occluded`). Expected: all pass unchanged.

- [ ] **Step 6: Record the matrix in the PR**

Include in the PR body: simulator OS version(s) tested (iOS 18 minimum; iOS 26 too if a runtime is installed), WHICH selector variant was swizzled (`=classic`/`=preEvent` from the startup marker — the other variant's code path is code-review-only on this OS), the ON/OFF/UNAVAILABLE matrix results per command ({snapshot, type, scroll, longpress} × {fixture screen, TaskWizard}), timings for snapshot before/after where observable, and the native-type result from Step 1.2 with the note that `typeText` has its own internal sync — `meta.runnerTimeoutShim` trending down over a week of dogfooding is a trailing telemetry signal, NOT a PR gate (the gates are snapshot <2s and scroll no-deadlock).

- [ ] **Step 7: If any gate fails** — STOP, capture the evidence (`cdp_error_log`, runner stdout, timings), and fix before proceeding to the PR. The bypass-OFF path failing means the toggle leaks; the bypass-ON snapshot gate failing means the swizzle didn't install or didn't cover the variant XCTest actually calls (check the startup marker first).

---

## Self-Review (performed while writing)

- **Spec coverage:** Design pts 1-4 → Tasks 1-6; implementation steps 1-4 → Tasks 1-6, 8; acceptance criteria + test plan → Tasks 1-2 (Swift units), 3-6 (TS units), 9 (live matrix); follow-on (HID scroll simplification) explicitly out of scope per spec pt 5. Env-var naming deviates from spec deliberately (documented at top).
- **Placeholder scan:** every code step contains complete code; no TBDs.
- **Type consistency:** `QuiescenceStatus` string union is identical in Swift (`rawValue`), TS type, marker mapping, and state field; `capabilities` spelling matches the existing Swift `Response` model field; `runnerCapabilities` used consistently for the deviceSession surface; test seam names match their definitions (`_resetQuiescenceAnnouncementForTest`).
- **Known judgment calls:** (a) shim-branch announcement uses a spread on a `resp.ok === false` path where `announce` is always null — uniformity over micro-optimization; the audit marker is deliberately deferred (not lost) past a shimmed `type`; (b) `testProbeResolvedAtBundleLoad` is environment-sensitive by design (it IS the drift detector) and fails if `RN_QUIESCENCE_FORCE_UNAVAILABLE=1` leaks into a unit-test run — that env is Task 9 Step 3-only; (c) the once-only announcement requires every `runIOS` success return site to attach it — the sites are enumerated in the Task 5 comment.
- **Multi-LLM review applied:** all 7 SHOULD-FIX findings and 5 nice-to-haves from the 2026-07-02 Claude+Codex review are folded into the tasks above (see the Amendments section in the header).
