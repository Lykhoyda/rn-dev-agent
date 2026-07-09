# Story 06 — Native runner tests in CI + LLM-behavior evals

**Status:** Phase A shipped (2026-07-05, #387); Phase B workflow shipped (2026-07-06, #387) — one-week-green + seeded-bug acceptance pending its first scheduled runs (post-merge, not a merge gate); Phase C shipped (PR #521, 2026-07-09) and re-engined + acceptance-complete as Phase C.2 (2026-07-10, subscription-funded headless-Claude runner — see the Phase C.2 note below)
**Epic:** [Maestro adoption](README.md)
**Impact:** The highest-risk layer (native gesture/snapshot/keyboard-guard behavior) currently has zero automated execution; this adds three graduated coverage tiers
**Effort:** M (Phase A is S; Phases B/C are M)
**Depends on:** Story 01 for Phase B (prebuilt artifacts make device smoke affordable)

## Problem

> **Historical (pre-Phase-A) framing.** Phase A now executes the native unit suites
> (`native-tests.yml`) and Phase B drives them on-device nightly
> (`nightly-device-smoke.yml`); the "only compiled, never executed" gap below is what
> those phases closed. What remains is Phase C (LLM-behavior evals) and Phase B's
> post-merge week-of-green acceptance.

CI (` .github/workflows/ci.yml`) runs 2,522 TS unit cases, 3 integration tests, lint/format, and changeset guards — but the native runners are only **compiled** (CodeQL, ~17 min macOS job), never **executed**. The Swift suites (`RnFastRunnerTests+*.swift`, `KeyboardGuardTests.swift`, `SnapshotForegroundRegressionTest.swift`) and the Kotlin JVM test (`KeyboardGuardTest.kt`) exist in-tree and run only when a developer remembers to. Device behavior is validated by manual smoke sessions recorded in GitHub Issues and PR proof artifacts. D1288's lesson applies at layer scale: green TS suites say nothing about the layer where the hardest bugs live.

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

> **Implemented 2026-07-06** (#387): `.github/workflows/nightly-device-smoke.yml` +
> `test-fixtures/{ios,android}-fixture/` + `scripts/cdp-bridge/test/smoke/device-smoke.ts`
> + root `smoke:{ios,android}` scripts.
>
> Triage notes:
> - **Runner provenance is main-HEAD, not the release artifact** (deviation from the
>   original plan, deliberate): the smoke lanes cache-build the runner from the tested
>   commit (`RN_RUNNER_BUILD=local`) so a red night is a real regression, never
>   release lag. The released artifacts (Story 01) get their own nightly
>   **artifact-integrity lane** (download → sha256/bytes/traversal/contents vs
>   `runner-manifest.json`) — the two signals are kept separate on purpose.
> - **Native contract fixtures, not Expo/RN** (deliberate): the golden set is `device_*`
>   (L2), which drives any app via XCUITest/UIAutomator2; CDP (L1) is already covered by
>   2900+ TS unit cases against mock Hermes. A CDP-driving RN fixture lane is a named
>   deferral (Phase B2).
> - **The on-device keyboard-guard step is iOS-only** (decided 2026-07-09 after
>   acceptance). iPhone standard QWERTY refuses the occluded tap (`KEYBOARD_OCCLUDED`,
>   `dismiss_failed`) because XCTest `swipeDown` on the keyboard corrupts the focused
>   field — a stable, meaningful contract to pin. Android is skipped on-device: UiAutomator
>   drops occluded views AND its IME-frame containment check is edge-sensitive, so the
>   scenario's outcome (dismiss vs a tap swallowed at the frame edge) varies run-to-run.
>   Android's guard predicate (`shouldDismiss`) is precisely unit-tested in
>   `KeyboardGuardTest.kt` (Phase A CI, every push), so re-testing that geometry on-device
>   adds flake, not coverage. iOS still fails loudly if the software keyboard never
>   appears — set `ConnectHardwareKeyboard=false`.
> - Two runner bugs were found by the smoke before CI: `fastSwipe` omitted the target
>   `appBundleId` (drags no-op'd on the runner's own host app), and the Android
>   screen-rect heuristic + missing package-visibility `<queries>` broke scroll and
>   re-foreground. Both fixed with unit coverage.

The numbered steps below are the ORIGINAL design; the "Implemented" blockquote above
records where the shipped workflow deliberately deviated (main-HEAD runner provenance
instead of downloading the release artifact; native fixtures instead of Expo). Read the
blockquote as authoritative for the current contract.

Nightly job (not per-PR — simulators/emulators are too slow/flaky for the merge gate):

1. ~~Download the prebuilt runner artifact for the current main build (Story 01)~~ →
   **as-built:** cache-build the runner from the tested commit (`RN_RUNNER_BUILD=local`)
   so a red night is a real regression, not release lag; the released artifacts get a
   separate integrity lane.
2. Boot a pinned simulator (e.g. iPhone 16 / iOS 18 runtime; add an iOS 26 lane when the runner image supports it) and, in a parallel lane, a pinned AVD via `reactivecircus/android-emulator-runner`.
3. Install a **minimal fixture app** (a tiny native/Expo prebuild app committed under `test-fixtures/`, or the seed-experience app if install-ready) exposing: a button with testID, a text field, a scrollable list, a keyboard-occlusion layout, a Reanimated loop screen (Story 03's fixture).
4. Drive the golden set through the *real bridge* (spawn `dist/supervisor.js`, speak MCP over stdio — reuse the integration-test harness): `device_snapshot open` → `snapshot` → `device_press @ref` → `device_fill` (verify read-back) → `device_scroll` → `device_screenshot` → keyboard-guard scenario → `device_snapshot close`.
5. Assert on the JSON envelopes (`ok`, error codes, `meta.keyboardGuard`, `meta.timings_ms` budget ceilings). Upload simulator logs + screenshots as artifacts on failure; open/refresh a tracking issue automatically on 2 consecutive red nights (avoids one-off sim flake noise).

### Phase C — LLM-behavior evals (nightly, budget-capped)

- Adopt `mcp-server-tester` (Maestro's tool) or an equivalent YAML-driven harness under `packages/rn-dev-agent-core/test/evals/`:
  - **Tool-call correctness fixtures** (no device): does the model choose `device_find` vs `device_snapshot` appropriately; does it recover from `NOT_CONNECTED` by opening a session; does it act correctly on `STALE_REF` candidates (Story 05's enriched payload).
  - **Output-usability fixtures**: given a real `device_snapshot` payload, can the model produce the right `@ref` for a described element (this is the regression gate for Story 08's compact format and Story 12's consolidation).
- Runs nightly with an explicit token budget; results trended, not merge-gating (evals are noisy; they gate *releases* of surface-changing stories, not every PR).

**As shipped:** cadence relaxed to on-demand `workflow_dispatch` (user decision 2026-07-09); harness shipped in PR #521 on `mcp-server-tester`, then **re-engined as Phase C.2** (spec `2026-07-09-387-phase-c2-subscription-evals-design.md`) onto headless Claude Code (`claude -p`) because the tester was API-key-only and no API budget exists — evals now run on the maintainer's Claude subscription (locally via the logged-in CLI; CI via a `CLAUDE_CODE_OAUTH_TOKEN` secret from `claude setup-token`).

**Phase C.2 acceptance record (2026-07-10, Haiku 4.5 model + judge, claude-code 2.1.205):**
- Run 1 (7/9): exposed that `required: ['cdp_status']` could never pass — `cdp_status` returns `failResult` (isError) when no Metro exists at all (`status.ts` catch path), falsifying the Phase C header's "succeeds disconnected" assumption. Triage: dropped those two `required` assertions (`blank-screen-diagnosis`, `not-connected-recovery`), behavior asserted via llm-judge only.
- Run 2 (8/9): exposed judge blindness — the judge saw tool names + errored flags + final text but NOT the fixture prompt, so it scored the prompt-given "blank white screen" as a fabricated UI finding. Fix: `buildJudgePrompt` now includes a "Task the assistant was given" section (commit `304b8206`).
- Run 3 (9/9): baseline captured from these results and committed (`baseline.json`, 9 pass). Flap profile across runs: `tool-discovery`, `honest-press-failure`, `blank-screen-diagnosis` each flapped ≤1 attempt and were absorbed by the per-fixture retry — noise stays within the designed retry budget.
- Seeded regression: `device-inventory` required tool swapped to `device_press` on a scratch edit → run exited 1 with `REGRESSION: device-inventory` against the committed baseline, then reverted. The Story 08/12 gate demonstrably goes red.
- Cost: ~60–62 turns, $0.28–0.34 API-equivalent per full run (subscription-covered, ~$0 marginal).
- Known judge limitation (recorded for fixture authors): the judge never sees tool-result contents; criteria must be judgeable from tool names + errored flags + the task prompt + the final response.

## Acceptance criteria

- Phase A: a deliberately broken `KeyboardGuard.shouldDismiss` fails CI on both platforms (verify once by reverting a predicate in a draft PR).
- Phase B: green nightly runs on both platforms for one week; a seeded runner bug (e.g. off-by-one in tap coordinates on the fixture) is caught by the golden set.
- Phase C: baseline eval scores recorded; Story 08/12 PRs must show no regression against that baseline. ✅ 2026-07-10 (C.2): baseline committed from a real 9/9 subscription run; seeded regression proven red (see the Phase C.2 acceptance record).
- Total added per-PR CI time ≤ 12 min (path-filtered), nightly wall-clock ≤ 45 min.

## Test plan

Phases are their own test plan; additionally, the MCP-over-stdio harness from Phase B step 4 gets a local `npm run smoke:ios` / `smoke:android` entry so developers can run the golden set against their own booted simulator before release.

## Risks & open questions

- **Simulator flake in CI:** mitigated by nightly-not-gating, 2-consecutive-red alerting, pinned runtimes, and prebuilt artifacts (no build variance).
- **macOS runner cost:** Phase A path-filtering keeps PR cost near zero for TS-only changes; Phase B is one nightly job.
- **Fixture app maintenance:** keep it intentionally tiny (5 screens, no backend); it is a *contract* fixture, not a demo app.
