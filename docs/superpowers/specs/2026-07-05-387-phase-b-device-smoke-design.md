# Story 06 Phase B — Nightly Device Smoke (design)

**Issue:** #387 (Story 06 — Native runner tests in CI + LLM-behavior evals)
**Story doc:** `docs/stories/06-native-runner-ci-and-evals.md` (Phase B section)
**Date:** 2026-07-05
**Status:** Approved (user, 2026-07-05)
**Depends on:** Story 01 (#382) artifact pipeline — shipped in #456 but **never fired** (bug, fixed as Task 0 here)
**Prior phase:** Phase A (native unit tests in CI) shipped in #464, merge `277bc811`

## Problem

Phase A executes the native runners' *unit* tests in CI, but no automated job drives
the runners on a real device. Gesture dispatch, snapshot capture, keyboard-guard
behavior, settle timing — the layer where the hardest bugs live (B153/B154, the
QuickPath corruption find) — is still validated only by manual smoke sessions.

Additionally, during design exploration we found that **Story 01's prebuilt-artifact
pipeline is dead on arrival**: `release.yml` merges the Version Packages PR with
`GITHUB_TOKEN`, and GitHub's workflow-recursion guard suppresses all workflow
triggers for pushes made with that token. The version-bump merge commit — the only
event `runner-artifacts.yml`'s `detect` job was designed to react to — can never
trigger it. Four releases (0.60.x → 0.63.0) silently skipped artifact publishing;
the committed `runner-manifest.json` is still the empty seed (`version: null`).
Evidence: runs 28720929431…28736816834 all completed in 6–9 s (detect-only no-ops),
and bump commits `c4b7afe8`/`462ac66f`/`8e9b844c`/`3fe5e328` have **no**
runner-artifacts runs at all.

## Decisions (approved)

1. **Scope:** Phase B only. Phase C (LLM-behavior evals) stays open in #387.
2. **Trigger bug fixed in scope** as Task 0 (not a separate session).
3. **Fixture:** tiny **native** apps (SwiftUI + Kotlin/Views), no RN/Expo/Metro in
   the nightly. The golden set is `device_*` (L2) verbs, which drive any app via
   XCUITest/UIAutomator2; CDP (L1) is already covered by the TS unit suites against
   mock Hermes. An RN-fixture CDP lane is a *named deferral* (possible Phase B2).
4. **Runner provenance — hybrid (Approach 3):**
   - Smoke lanes drive **main-HEAD-built runners** (cached) so bridge and runner
     come from the same commit → a red night means a real regression, never
     release lag. `RUNNER_COMMANDS_STALE` noise from old release bits is designed
     behavior, not a smoke signal.
   - A separate **artifact-integrity lane** validates the *released* bits +
     manifest, so Story 01's product is exercised nightly without coupling the
     smoke signal to it.

## Design

### Task 0 — make the artifact pipeline fire (Story 01 bug fix)

Two complementary mechanisms, no new secrets (a PAT would be a new credential to
rotate; `workflow_dispatch` is the documented exception to the `GITHUB_TOKEN`
recursion guard):

- **Dispatch-after-merge:** in `release.yml`, after the Version PR merge step
  succeeds, fetch `origin/main`, read the bumped version from
  `.claude-plugin/plugin.json` at `origin/main` (NOT the pre-bump checkout), and
  `gh workflow run runner-artifacts.yml -f force_version=$V`. Building from the
  dispatch-time main HEAD is safe: Version PRs touch only versions/changelogs,
  never runner sources.
- **Nightly catch-up sweep:** add a `schedule` trigger to `runner-artifacts.yml`.
  In catch-up mode, `detect` reads main's current `plugin.json` version and treats
  it as `changed=true` when the `v<version>` release is missing OR lacks any of
  its three assets (`rn-fast-runner-<v>-sim.zip`, `rn-android-runner-<v>.zip`,
  `runner-manifest.json`). This is level-triggered self-healing: it covers the
  auto-merge race (`gh pr merge --auto` returns before the merge lands, so the
  in-run dispatch could fire pre-merge), any future missed event, and — on its
  **first run** — publishes artifacts for the current already-missed version with
  no manual seed step.
- The idempotence guard already exists (`gh release create` only if absent;
  uploads use `--clobber`).
- Bug logged to workspace `BUGS.md`; decision (dispatch + sweep over PAT) to
  `DECISIONS.md`.

### Fixture apps — `test-fixtures/`

Contract fixtures, intentionally tiny, no backend, no JS toolchain:

- `test-fixtures/ios-fixture/` — SwiftUI app, bundle id
  `dev.lykhoyda.rndevagent.fixture`, built with `xcodebuild build` (no signing,
  simulator SDK).
- `test-fixtures/android-fixture/` — Kotlin, minimal Views/XML (lightest build),
  applicationId `dev.lykhoyda.rndevagent.fixture`, built with
  `gradle assembleDebug`.

One screen each, identical element contract (identifiers are the runners'
testID-resolution keys — `accessibilityIdentifier` on iOS, `resource-id` on
Android; the exact Android attribute is confirmed against the runner's matcher
during planning):

| Element | Identifier | Purpose in golden set |
|---|---|---|
| Counter button | `fixture_button` | tap → visible label increments (observable state change for settle/no-change detection) |
| Counter label | `fixture_count` | assert increment after `device_press` |
| Text field | `fixture_input` | `device_fill` + native read-back verify |
| 100-row list | `fixture_list`, rows `fixture_row_<n>` | `device_scroll`, `device_scrollintoview` |
| Bottom-anchored field + button | `fixture_bottom_input`, `fixture_bottom_button` | keyboard genuinely occludes the button → keyboard-guard scenario |

Fixture builds are cached (`actions/cache`, key = fixture-source hash + toolchain
version).

### Nightly smoke workflow — `.github/workflows/nightly-device-smoke.yml`

Triggers: `schedule` (03:00 UTC) + `workflow_dispatch` (on-demand runs and the
seeded-bug acceptance check). Permissions: `contents: read`, `issues: write`
(alerting). Lanes run in parallel as independent jobs.

- **iOS smoke** (`macos-15`, timeout ~35 min): checkout → Node 22 → `npm ci` →
  restore runner DerivedData cache (key: hash of `scripts/rn-fast-runner/**` +
  Xcode version); on miss `xcodebuild build-for-testing` into the client's
  expected path (`scripts/rn-fast-runner/RnFastRunner/build/DerivedData`, the
  warm-path location `hasBuiltTestProduct` checks) → build/restore fixture →
  boot pinned simulator (Phase A's UDID-resolution pattern, iPhone 16 preferred)
  → `simctl install` fixture → run golden-set driver.
- **Android smoke** (`ubuntu-latest` + KVM, `reactivecircus/android-emulator-runner`,
  pinned API-34 AVD, timeout ~35 min): Gradle-build runner APKs
  (`assembleDebug` + `assembleDebugAndroidTest`, setup-gradle cache) → build
  fixture APK → inside the emulator step: `adb install` fixture → run driver.
- Simulator/emulator logs + screenshots uploaded as artifacts on failure.

### Golden-set driver — `scripts/cdp-bridge/test/smoke/device-smoke.mjs`

`node:test`, reusing `test/helpers/supervisor-harness.js`: spawn
`dist/supervisor.js` over MCP stdio, cwd = tmp project dir, env
`RN_RUNNER_BUILD=local` (forces `build-local` provenance in
`runner-artifacts.ts:156` so a version-matching release can never shadow the
fresh main-HEAD build). CDP is intentionally absent; `device_fill` exercises its
native read-back path by design.

Sequence (all assertions on the JSON envelopes; generous `meta.timings_ms`
ceilings, e.g. snapshot < 10 s):

1. `device_snapshot action=open` with explicit `appId` (the open handler requires
   it without an `app.json`) → `ok`, runner alive.
2. `device_snapshot` → `@ref`s present for the contract elements.
3. `device_find` (exact testID) → found.
4. `device_press @fixture_button` → next snapshot shows `fixture_count`
   incremented; `meta.settle` present.
5. `device_fill @fixture_input` → `meta.verify` read-back passes (native path).
6. `device_scroll` + `device_scrollintoview fixture_row_80` → row present in
   snapshot.
7. `device_screenshot` → PNG magic bytes, non-trivial size.
8. **Keyboard-guard scenario (platform-conditional by documented #370 contract):**
   focus `fixture_bottom_input` (keyboard up) → `device_press
   @fixture_bottom_button`:
   - Android: `meta.keyboardGuard: "dismissed"`, tap lands.
   - iOS (iPhone standard QWERTY, no dismiss control): the **designed refusal** —
     error `KEYBOARD_OCCLUDED`, `keyboardGuard: "dismiss_failed"`.
9. Negative case: `device_press` on a nonexistent testID → error envelope with
   the documented code (no crash, no hang).
10. `device_snapshot action=close` → clean.

### Artifact-integrity lane (Story 01 product validation)

Cheap `ubuntu-latest` job in the same nightly (~1–2 min, no simulator): read the
committed `runner-manifest.json` → fail actionably if still the empty seed
(post-Task-0 catch-up it must be populated) → download the named release assets →
verify sha256 + byte counts against the manifest → traversal-safe extract →
assert the `.xctestrun` exists in the iOS zip and both APKs in the Android zip.
Red here means "pipeline/release broke," never "runner regressed."

### Alerting + local entries

- **`report` job** (`needs:` all lanes, `if: always()`): if any lane failed AND
  the previous *scheduled* run also failed → create-or-refresh a tracking issue
  (label `nightly-smoke-red`); on a green run, comment-and-close any open one.
  One-off simulator flake never pages (story's 2-consecutive-red rule).
- **Local entries** (story test plan): root `package.json` `smoke:ios` /
  `smoke:android` run the same driver against the developer's own booted
  simulator/emulator; the driver prints actionable instructions when the fixture
  app is not installed.

## Deliverable decomposition

- **PR 1 (Task 0):** release.yml dispatch-after-merge + runner-artifacts.yml
  catch-up sweep + workspace BUGS/DECISIONS entries. Small, independently
  verifiable (first scheduled sweep publishes 0.63.x artifacts).
- **PR 2:** fixtures + golden-set driver + `smoke:*` scripts +
  `nightly-device-smoke.yml` (both lanes + integrity + alerting). Stacked on PR 1
  only if release timing requires; otherwise independent.

## Acceptance criteria

- Task 0: a real release (or the catch-up sweep) publishes both runner zips +
  manifest for the current version; `runner-manifest.json` on main is populated.
- Smoke: both device lanes green on a real scheduled (or dispatch) run.
- Seeded-bug check (story criterion): a `workflow_dispatch` run against a branch
  with a deliberate tap-coordinate offset in the runner goes red in the smoke
  lane (Phase A's mutation-check pattern).
- Integrity lane green against the seeded current-version artifacts.
- Nightly wall-clock ≤ 45 min (lanes parallel; worst lane ~25 min cold-cache).
- Week-of-green: post-merge observation, explicitly NOT a merge gate for these PRs.

## Out of scope

- Reanimated loop screen (Story 03's fixture) and any RN/Expo fixture — deferred,
  named slot "Phase B2 (CDP lane)".
- Phase C (LLM-behavior evals) — remains open in #387, needs a budget decision.
- iOS 26 lane — add when the macos runner images make it pinnable (story note).

## Risks

- **Simulator flake:** mitigated by nightly-not-gating, 2-consecutive-red
  alerting, pinned runtimes, and parallel independent lanes.
- **XCUITest keyboard variance on CI images** (hardware-keyboard settings could
  keep the software keyboard hidden → keyboard-guard scenario degrades to
  `no_keyboard`): the driver asserts the *envelope contract* and fails loudly if
  the keyboard never appeared, so the scenario cannot silently pass; the plan
  includes the known simulator setting (`simctl` connect-hardware-keyboard off)
  to force the software keyboard.
- **Cache-miss nights** pay one runner build (~4–6 min iOS, ~2–3 min Android) —
  exactly the nights fresh bits are wanted anyway.
- **Auto-merge race in Task 0:** dispatch-after-merge may fire pre-merge in the
  `--auto` path; the catch-up sweep converges within 24 h by design.
