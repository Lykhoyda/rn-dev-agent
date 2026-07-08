# Story 06 — Native runner tests in CI + LLM-behavior evals

**Status:** Phase A implemented (2026-07-05, #387); Phases B/C proposed
**Epic:** [Maestro adoption](README.md)
**Impact:** The highest-risk layer (native gesture/snapshot/keyboard-guard behavior) currently has zero automated execution; this adds three graduated coverage tiers
**Effort:** M (Phase A is S; Phases B/C are M)
**Depends on:** Story 01 for Phase B (prebuilt artifacts make device smoke affordable)

## Problem

CI (` .github/workflows/ci.yml`) runs 2,522 TS unit cases, 3 integration tests, lint/format, and changeset guards — but the native runners are only **compiled** (CodeQL, ~17 min macOS job), never **executed**. The Swift suites (`RnFastRunnerTests+*.swift`, `KeyboardGuardTests.swift`, `SnapshotForegroundRegressionTest.swift`) and the Kotlin JVM test (`KeyboardGuardTest.kt`) exist in-tree and run only when a developer remembers to. Device behavior is validated by manual smoke sessions recorded in docs (e.g. the Pixel_9_Pro Task-10 run in `BUGS.md`). D1288's lesson applies at layer scale: green TS suites say nothing about the layer where the hardest bugs live.

## What Maestro does

- Driver test suites run in CI as a matter of course.
- Beyond correctness, they run **LLM-behavior evals**: the `mcp-server-tester` npm package drives YAML fixtures (`full-evals.yaml`, `inspect-screen-evals.yaml`, `tool-tests-{with,without}-device.yaml`) to test *"not only that it works correctly but that LLMs can call it correctly and use the output appropriately. This happens less frequently than is expected."* (`maestro-cli/src/test/mcp/README.md`). That last sentence is the entire justification for Phase C.

## Design

### Phase A — run the existing native tests (cheap, do first)

> **Implemented 2026-07-05** (#387): `.github/workflows/native-tests.yml` + `scripts/test-native-ios.sh` + root `test:native:*` npm scripts.
> Triage notes: (1) a red on `QuiescenceBypassTests.testProbeResolvedAtBundleLoad` means the CI Xcode's private quiescence selectors drifted ("degrade loudly" by design, #384) — an Xcode-compat issue, not a plugin bug. (2) Any future subclass of `RnFastRunnerTests` inherits the 24-hour `testCommand` and MUST be added to the skip-list in `scripts/test-native-ios.sh`. (3) NEVER move the skips into `RnFastRunnerUITests.xctestplan` as `skippedTests` — `build-for-testing` bakes them into the `.xctestrun` that the PRODUCTION launch (`test-without-building -only-testing:…/testCommand`) consumes, and skips subtract from the only-set, so the runner would never boot.

- **Android JVM tests** (ubuntu runner, ~1 min): `(cd packages/rn-android-runner && ./gradlew testDebugUnitTest)` — covers `KeyboardGuardTest.kt` and future pure-Kotlin logic. Gradle cache via `actions/setup-java` + `gradle/actions/setup-gradle`.
- **iOS unit tests** (macOS runner): `bash scripts/test-native-ios.sh` — `xcodebuild test` on the `RnFastRunner` scheme with a SKIP-list (`-skip-testing:RnFastRunnerUITests/RnFastRunnerTests`, the production server entry that never returns; `-skip-testing:RnFastRunnerUITests/SnapshotForegroundRegressionTest`, needs the test app installed). New test classes in the folder run automatically (Xcode 16 synchronized groups). Budget ~8–12 min; path-filtered on PRs, unconditional on main.
- Wire both into the required-checks set for merge (consistent with the existing pre-merge CI-green rule).

### Phase B — nightly device smoke (golden command set)

Nightly macOS job (not per-PR — simulators are too slow/flaky for the merge gate):

1. Download the prebuilt runner artifact for the current main build (Story 01) — no xcodebuild in the smoke job itself.
2. Boot a pinned simulator (e.g. iPhone 16 / iOS 18 runtime; add an iOS 26 lane when the runner image supports it) and, in a parallel lane, a pinned AVD via `reactivecircus/android-emulator-runner`.
3. Install a **minimal fixture app** (a tiny native/Expo prebuild app committed under `test-fixtures/`, or the seed-experience app if install-ready) exposing: a button with testID, a text field, a scrollable list, a keyboard-occlusion layout, a Reanimated loop screen (Story 03's fixture).
4. Drive the golden set through the *real bridge* (spawn `dist/supervisor.js`, speak MCP over stdio — reuse the integration-test harness): `device_snapshot open` → `snapshot` → `device_press @ref` → `device_fill` (verify read-back) → `device_scroll` → `device_screenshot` → keyboard-guard scenario → `device_snapshot close`.
5. Assert on the JSON envelopes (`ok`, error codes, `meta.keyboardGuard`, `meta.timings_ms` budget ceilings). Upload simulator logs + screenshots as artifacts on failure; open/refresh a tracking issue automatically on 2 consecutive red nights (avoids one-off sim flake noise).

### Phase C — LLM-behavior evals (nightly, budget-capped)

- Adopt `mcp-server-tester` (Maestro's tool) or an equivalent YAML-driven harness under `packages/rn-dev-agent-core/test/evals/`:
  - **Tool-call correctness fixtures** (no device): does the model choose `device_find` vs `device_snapshot` appropriately; does it recover from `NOT_CONNECTED` by opening a session; does it act correctly on `STALE_REF` candidates (Story 05's enriched payload).
  - **Output-usability fixtures**: given a real `device_snapshot` payload, can the model produce the right `@ref` for a described element (this is the regression gate for Story 08's compact format and Story 12's consolidation).
- Runs nightly with an explicit token budget; results trended, not merge-gating (evals are noisy; they gate *releases* of surface-changing stories, not every PR).

## Acceptance criteria

- Phase A: a deliberately broken `KeyboardGuard.shouldDismiss` fails CI on both platforms (verify once by reverting a predicate in a draft PR).
- Phase B: green nightly runs on both platforms for one week; a seeded runner bug (e.g. off-by-one in tap coordinates on the fixture) is caught by the golden set.
- Phase C: baseline eval scores recorded; Story 08/12 PRs must show no regression against that baseline.
- Total added per-PR CI time ≤ 12 min (path-filtered), nightly wall-clock ≤ 45 min.

## Test plan

Phases are their own test plan; additionally, the MCP-over-stdio harness from Phase B step 4 gets a local `npm run smoke:ios` / `smoke:android` entry so developers can run the golden set against their own booted simulator before release.

## Risks & open questions

- **Simulator flake in CI:** mitigated by nightly-not-gating, 2-consecutive-red alerting, pinned runtimes, and prebuilt artifacts (no build variance).
- **macOS runner cost:** Phase A path-filtering keeps PR cost near zero for TS-only changes; Phase B is one nightly job.
- **Fixture app maintenance:** keep it intentionally tiny (5 screens, no backend); it is a *contract* fixture, not a demo app.
