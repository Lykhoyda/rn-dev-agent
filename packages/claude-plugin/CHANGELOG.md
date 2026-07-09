# rn-dev-agent-plugin

## 0.66.1

### Patch Changes

- 2f7ceda: Fix the documented install command: the marketplace registers under the manifest name `rn-dev-agent`, so the correct command is `/plugin install rn-dev-agent@rn-dev-agent` — every doc previously said `rn-dev-agent@Lykhoyda-rn-dev-agent`, which fails with "Marketplace not found" (caught live on the first post-split install). Also corrects the stale `~/.claude/plugins/cache/Lykhoyda-rn-dev-agent` paths in troubleshooting docs.

  Also adds the missing Codex install path: the repo now ships a Codex marketplace manifest (`.agents/plugins/marketplace.json`) resolving `packages/codex-plugin`, so `codex plugin marketplace add Lykhoyda/rn-dev-agent` + `codex plugin add rn-dev-agent@rn-dev-agent` works (validated live: marketplace add, plugin add, and an MCP handshake through the installed launcher). Install instructions documented in the README, docs-site getting-started, and the Codex package README; the package-sync guard asserts the manifest.

## 0.66.0

### Minor Changes

- 272c113: Add Codex plugin metadata and Yarn workspace package boundaries alongside the existing Claude Code plugin surface so rn-dev-agent can be used from both agents.
- 272c113: Make the Claude plugin package self-contained so marketplace installs work after the workspace split (fixes the release-blocking finding on PR #500). Claude Code copies ONLY the plugin source directory into `~/.claude/plugins/cache/…` — `${CLAUDE_PLUGIN_ROOT}/../…` references resolve to nothing in an installed plugin (docs-confirmed; the pre-split plugin worked only because the runtime lived inside the plugin root).

  - The package now ships a bundled runtime at `rn-dev-agent-core/dist/{supervisor,index,learned-actions}.js` (same esbuild output as the Codex package, byte-identical by construction), the observe web bundle, native runner sources under `scripts/rn-fast-runner` + `scripts/rn-android-runner`, `runner-manifest.json`, and the helper scripts the SessionStart hook and skills invoke (`ensure-*`, `mcp-bridge-probe.mjs`, `check-physical-devices.sh`, `check-vercel-rules.mjs`).
  - `plugin.json` MCP entry now spawns `${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js`; all agent/command/skill snippets and hooks resolve package-local paths (dev-checkout fallbacks preserved). `ensure-cdp-deps.sh` exits fast on the dependency-free bundled runtime.
  - `scripts/build-codex-runtime.ts` → `scripts/build-host-runtimes.ts`: the single writer for every derived host-package artifact (both runtimes, runner copies, manifests, templates, helper scripts); `check-dist-fresh.sh` regenerates and porcelain-checks all of it, and `check-agent-package-sync.sh` asserts the Claude artifacts including byte-identity of the two host runtime bundles. The `runner-artifacts` release workflow now commits the Claude manifest copy too.
  - The Codex launcher ships as plain `bin/cdp-supervisor.js` (was `.ts`) so `node <launcher>` cannot hard-fail on Node 22.x below 22.18 at the file-extension gate.
  - New `.gitattributes` marks all generated trees `linguist-generated` (bundles additionally `-diff`) to collapse PR review noise; runner build output inside the package copies is now gitignored.

### Patch Changes

- Updated dependencies [272c113]
  - rn-dev-agent-core@0.61.0

## 0.65.10

### Patch Changes

- bfb5e10: Android device-smoke keyboard-guard step: accept both non-blocked guard outcomes (`dismissed` and `not_occluded`) instead of pinning `dismissed`. Which one fires depends on the emulator's exact keyboard geometry (whether the bottom button's tap point lands inside the IME frame or at/below its edge), which varies run-to-run. The smoke now verifies the guard evaluated on-device and did not wrongly block the tap; the precise `shouldDismiss` predicate stays unit-tested in `KeyboardGuardTest.kt`.

## 0.65.9

### Patch Changes

- 60720e1: Make the rn-fast-runner warm-launch ready gate overridable via `RN_FAST_RUNNER_READY_TIMEOUT_MS` (default 30s) so a slow CI simulator that needs longer to install+launch+attach the XCUITest runner is not a false `RN_FAST_RUNNER_DOWN`. The nightly iOS device-smoke lane also now reuses the image's already-booted (warm) simulator and shuts down only extras, instead of a blanket `shutdown all` that cold-boots the target and makes the runner launch time out.

## 0.65.8

### Patch Changes

- fd8909d: Nightly iOS device-smoke lane: build the rn-fast-runner fresh each run instead of restoring DerivedData from cache. A restored DerivedData drove an unreliable `test-without-building` warm launch (`RN_FAST_RUNNER_DOWN`), whereas a fresh `build-for-testing` then warm launch is the known-good path. The ~5 min build is well within the 40 min lane timeout and the nightly budget.

## 0.65.7

### Patch Changes

- 27f320d: Nightly device-smoke fixes: (1) the iOS lane now shuts down any pre-booted simulators before booting exactly one, so `device_snapshot open` (which refuses on >1 booted iOS device) resolves deterministically. (2) The keyboard-guard step is platform-split: Android UiAutomator drops occluded views, so the occluded bottom button is absent from a post-fill snapshot — the driver now presses the pre-fill ref (its cached coords are under the keyboard) without re-snapshotting, exercising the Android dismiss contract; iOS keeps its re-snapshot + refusal-contract path (XCUITest reports occluded elements).

## 0.65.6

### Patch Changes

- 41d6bd9: Fix direction `device_scroll`/`device_swipe` computing a no-op gesture on Android when no snapshot node spans the full window. The screen rect (used to size direction gestures) was picked as the largest `(0,0)`-anchored node; on some Android snapshots that is a ~128px top-chrome strip while the scrollable content sits below it, so scrolls dragged ~50px in the status bar and never moved the list. The screen rect is now the union bounding box of all node rects (max extent), recovering the true viewport on both platforms.

## 0.65.5

### Patch Changes

- 8c18951: Observe UI: surface the idb install hint as a banner under the device pane header while mirroring runs on the ~6fps simctl fallback, instead of an ellipsized footer line that truncated the brew command. Error hints stay in the footer. The idb install command is corrected everywhere to include the required tap (`brew tap facebook/fb && brew install idb-companion`) — including the executed installs in `ensure-idb.sh` / `ensure-idb-companion.sh`, which previously failed on untapped machines. `/rn-dev-agent:setup` now diffs an already-injected CLAUDE.md template block against the plugin's current CLAUDE-MD-TEMPLATE.md and offers an in-place refresh when stale (new `<!-- rn-dev-agent:template-end -->` sentinel delimits the block; legacy blocks are upgraded on refresh).

## 0.65.4

### Patch Changes

- df5c76e: Nightly device-smoke Android lane: scroll the golden-set list at full amplitude (amount 1) so row 80 is reached within the 30-scroll budget. The earlier amount-0.5 guard (added for a local emulator's drag latency) fell ~5 rows short on CI, where all 30 drags run with zero RUNNER_TIMEOUT — the shorter drag bought nothing.

## 0.65.3

### Patch Changes

- 552d151: Fix the nightly device-smoke workflow failing at setup: it ran `npm ci` inside `scripts/cdp-bridge`, which fights the root lockfile and triggers the root `prepare: husky` without husky installed (exit 127). Both lanes now install from the repo root (npm workspaces resolves the cdp-bridge deps) with `HUSKY=0`.

## 0.65.2

### Patch Changes

- 57e7699: Fix two Android device-control defects surfaced by the Story 06 Phase B smoke: (1) with interactive-windows snapshots (#370), the status bar precedes the app window, and the screen-rect heuristic took the first (0,0)-anchored node — so direction-based device_scroll/device_swipe computed gestures inside the status bar; it now picks the largest full-bleed rect. (2) The in-tree rn-android-runner could not re-foreground an app under test on API 30+ because its manifest lacked a package-visibility <queries> declaration (getLaunchIntentForPackage returned null → "No launch intent for package …"); a MAIN/LAUNCHER queries entry restores visibility.
- 57e7699: Fix device_scroll/device_swipe silently no-oping on iOS: the drag /command body omitted the target appBundleId, so the runner cleared its target, activated its own RnFastRunner host app, and dragged on a blank screen — every coordinate scroll/swipe returned ok:true with zero movement while foreground-stealing from the app under test. All fastSwipe dispatch sites now forward the active session's appId. Found by the Story 06 Phase B golden-set smoke before it ever reached CI.
- 57e7699: Story 06 Phase B: add a nightly device-smoke workflow that drives the golden device\_\* command set through the real bridge (MCP over stdio) against tiny native contract fixtures (test-fixtures/{ios,android}-fixture) on a booted simulator/emulator, plus a release-artifact-integrity lane and 2-consecutive-red tracking-issue alerting. Local `npm run smoke:ios` / `smoke:android` run the same golden set against a developer's own device.

## 0.65.1

### Patch Changes

- f74b5b7: Observe UI: make the right state pane fit its width, and slim the timeline
  column.

  The right pane is a fixed ~26% column (~340-450px), but the actions tab
  rendered a 5-column table and the e2e tab 3- and 4-column tables. Tables
  cannot shrink below their column content, so at typical window widths the
  Status/Params/Run columns were clipped clean off the pane — the Run button
  was unreachable — and action ids line-wrapped mid-word. Both tabs now render
  stacked rows designed for a narrow column:

  - **Actions**: one item per action — id (truncating, full value on hover) +
    status badge + Run on the first line, intent wrapped below (2-line clamp),
    param inputs flex-wrapping to the available width instead of fixed 110px
    columns, result/output underneath.
  - **E2E**: suite results and run history as one-line rows — pass/fail mark,
    truncating test/run id, duration, classification badge or `2✓ 1✗` totals +
    verdict — with error excerpts wrapping below and the expanded run detail
    reusing the same row layout.
  - Pane guards: `.pane.right` gets `min-width: 340px`, tabs wrap instead of
    overflowing, long live routes break instead of pushing the pane wide.
  - Layout rebalance: the left timeline column drops from 40% to 33%
    (`min-width: 380px`; summaries already ellipsize), and the device pane no
    longer greedily takes all remaining width — the mirror is a portrait phone
    screen capped at ~100vh, so the pane is capped at 400px and the state pane
    absorbs the surplus instead.

## 0.65.0

### Minor Changes

- 24842f8: Story 13 (#397) Phases 1–2: maestro-runner engine pinning and a proactive blind-probe. The installer now installs the tested pin (`1.0.9`) exactly, verifies its checksum fail-closed on fresh downloads, and warns on local drift; `cdp_status.replayEngine` + `/doctor` report engine, version-vs-pin, and known quirks; `maestro_run` carries `enginePin` meta and warns once on drift (opt-in hard enforcement: `RN_ENGINE_PIN_STRICT=1`). `cdp_run_action` on at-risk iOS runtimes (>= 26, or a recent device-matched `TRANSPORT_BLIND` with clean-pass reset) probes the CDP tree first and, when the action's anchor is visible, skips the doomed ~40s WDA attempt and replays via CDP/JS directly — `RunRecord` gains additive `deviceId`/`blindProbe`, probe-routed failures classify as `FALLBACK_REPLAY_FAILED` (never false `TRANSPORT_BLIND`), probe-routed passes never auto-promote, and the DB mirror persists the new fields. Opt out with `RN_BLIND_PROBE=0`.

## 0.64.6

### Patch Changes

- 6534bf3: Make the Runner artifacts workflow self-healing (B258, second half): the gate
  is now state-based — any trigger checks whether release `v<plugin.json version>`
  already carries both runner zips + `runner-manifest.json` and builds only when
  something is missing — and a 6-hourly scheduled sweep catches the releases the
  push trigger structurally cannot see. release.yml merges Version Packages PRs
  as `github-actions` with `GITHUB_TOKEN`, and GitHub's recursion guard suppresses
  workflow triggers for `GITHUB_TOKEN`-initiated pushes, so under the normal
  automated release path the artifact build NEVER fired (v0.64.4 and v0.64.5
  both shipped artifact-less and needed manual `workflow_dispatch` backfills).
  The state-based gate also heals partially failed builds: incomplete assets →
  rebuild both runners, uploads `--clobber`.

## 0.64.5

### Patch Changes

- f4368e4: Fix the release-triggered iOS runner-artifact build (Runner artifacts workflow):
  the `build-ios` job ran on `macos-14` (Xcode 15.4), which cannot open
  `RnFastRunner.xcodeproj` in project format 77 — its first real invocation (the
  v0.64.2 release push) failed with "future Xcode project file format (77)" and
  the runner manifest was never generated, so installs kept resolving to local
  builds. The job now runs on `macos-15` (Xcode 16.x), matching `native-tests.yml`
  and `codeql.yml`, which already build this project green.

## 0.64.4

### Patch Changes

- 588dedc: Sync CLAUDE-MD-TEMPLATE.md (the operating manual `/setup` injects into user
  projects) with everything shipped since 0.49.0. The template still documented
  the pre-0.55 world: it told agents to run a manual multi-minute `xcodebuild`
  pre-build (obsolete since prebuilt runner artifacts, #382), described Android
  dispatch as "3-tier agent-device" (removed entirely in 0.55.0), routed MMKV
  through raw `cdp_evaluate` Nitro poking (superseded by `cdp_mmkv`), and framed
  multi-device screenshot routing as an open bug (#60 — fixed).

  Updated: in-tree runner section rewritten around prebuilt-artifact resolution,
  protocol/command staleness self-healing, quiescence bypass, and the foreign-flow
  arbiter; new reliability-layers table (settle engine, self-healing taps,
  keyboard guard) with opt-out env vars; perception guidance for
  `cdp_component_tree(interactiveOnly)`, `device_batch finalSnapshot`, and cached
  `device_find`; E2E lock/suite flow (`/lock-e2e`, `cdp_lock_e2e_test`,
  `cdp_run_e2e_suite`) in the actions lifecycle; dev-menu dismiss via
  `cdp_dev_settings hideDevMenu`; `device_reset_state` in the auth/permission
  pre-flight; nine new error-recovery rows (BUSY_FOREIGN_FLOW,
  RUNNER_COMMANDS_STALE, KEYBOARD_OCCLUDED, RUNTIME_DEGRADED, APP_NOT_INSTALLED,
  TRANSPORT_BLIND fallback, post-upgrade zero-tools recovery, wrong-worktree
  Metro); Key Commands table gains doctor / list-learned-actions / run-action /
  lock-e2e and the autostarting observe UI description.

## 0.64.3

### Patch Changes

- d041bac: Harden the Android **raw** screenshot capture path (`device_screenshot`, GH #428),
  mirroring the iOS hardening from #427:

  - **Truncate-before-success**: raw capture now stages `adb exec-out screencap`
    bytes in a unique sibling temp file and `renameSync`s onto the caller's path
    only after both the write stream drains and adb exits 0. A failed or timed-out
    capture can no longer truncate-then-delete an existing file the tool never
    created.
  - **Multi-emulator first-pick**: with several emulators booted and no session
    binding, resolution now refuses (exactly-one-or-null via `resolveAndroidEmu`)
    instead of silently grabbing the first emulator — matching iOS
    exactly-one-or-refuse. Sessions still bind to their device id.
  - **adb child leak on stream error**: a write-stream error (ENOSPC/EACCES) now
    unpipes and kills the `adb` child before settling, instead of leaving it
    running blocked on stdout.

## 0.64.2

### Patch Changes

- 277bc81: Story 06 Phase A (#387): the native runner unit suites now execute in CI.
  `native-tests.yml` runs `gradlew testDebugUnitTest` (ubuntu) and
  `xcodebuild test` with a skip-list (macos-15, simulator) — path-filtered with
  green skip notices on TS-only PRs, unconditional on pushes to main. Local
  entry points: `npm run test:native:android` / `npm run test:native:ios`.
  Also removes a dangling `RnFastRunnerTests` testable from the shared scheme.

## 0.64.1

### Patch Changes

- f583249: `cdp_dev_settings` gains a `hideDevMenu` action that dismisses the iOS
  expo-dev-client dev menu bottom sheet over CDP via `ExpoDevMenu.hideMenu()`
  (#335). Because it runs through `client.evaluate` instead of a coordinate
  tap/swipe, it never triggers the touch-induced Hermes detach the issue
  describes — the JS thread stays attached and the in-memory store survives.
  `cdp_reload` now also best-effort auto-dismisses the menu on iOS after
  reconnect, so the agent lands on the app instead of behind the sheet. The
  dismiss resolves the `ExpoDevMenu` native module through a multi-tier chain
  (`globalThis.expo.modules` → `NativeModules` → TurboModule proxies) and is a
  silent no-op on non-expo builds.

## 0.64.0

### Minor Changes

- d6f72f7: Story 05 (#386) self-healing taps: stale `@ref` taps re-resolve inline by identity signature (unique-match only; ambiguous/absent STALE_REF now lists candidates), swallowed taps retry exactly once via settle-hash change detection (`meta.reResolved` / `meta.tapRetried` / `meta.noUiChange`), 3 consecutive no-change taps on distinct targets surface a wedged-runtime hint, and `device_batch` testID resolution refuses ambiguous matches (`AMBIGUOUS_TESTID`). Opt-outs: `retryIfNoChange: false` per call, `RN_SELF_HEAL=0` global.

## 0.63.0

### Minor Changes

- dabe8cc: Prebuilt runner artifacts (Story 01, #382): the iOS rn-fast-runner and Android
  rn-android-runner now resolve from a verified prebuilt artifact — a SHA-256-checked
  local cache, then a download of the release asset for the exact plugin version —
  before falling back to the on-machine build. This removes the multi-minute cold
  `xcodebuild` / Gradle build from the first `device_snapshot action=open` once a
  release ships the artifacts. Resolution is fail-open: any missing manifest, offline
  state, 404, checksum mismatch, or unsafe archive falls back to the local build with a
  one-line `meta.note`, never a hard failure. `RN_RUNNER_BUILD=local` forces the local
  build. `cdp_status` / `/doctor` now report runner provenance (`prebuilt v<X>` vs
  `local-built`). Until a release ships the artifacts, builds resolve to `local` by
  design.

## 0.62.4

### Patch Changes

- 8740f75: Observe UI: single-page layout — the Live/Regression view split is gone. The right column now has five tabs (route | store | tree | actions | e2e): learned actions run from the main page next to the live mirror, and E2E suite runs + history live in the e2e tab. The mirror status/hint moved to a slim footer so the device pane keeps its full height.

## 0.62.3

### Patch Changes

- 0abb27a: Engineering rule: all new code must be TypeScript. CI gains a typescript-only gate (`scripts/check-typescript-only.sh`) that fails when a `.js`/`.mjs`/`.cjs` file appears outside the grandfathered baseline (`scripts/js-migration-baseline.txt`, 344 pre-rule files slated for migration). Shrinking the baseline (migrating to TS) passes automatically; growing it requires an explicit, reviewable baseline edit.

## 0.62.2

### Patch Changes

- f2c9fa4: SessionStart auto-installs idb in the background (`brew install idb-companion && pipx install fb-idb`) for the observe live mirror's 20-30fps fast path — never blocks session start (detached worker, pidfile guard, 24h failure backoff). `/doctor` and `/setup` gain an idb row: OK / INSTALLING (background) / MISSING with the manual command.
- a33f19d: Observe UI: continuous live mirroring of the simulator/emulator screen (Maestro-style MJPEG). New `GET /api/device/mirror` stream — idb (20–30fps) or simctl loop (~6fps) on iOS, adb screenrecord+ffmpeg on Android emulators and physical devices. Zero capture cost with no tab open; per-tool-call screenshots are skipped while the mirror streams. Config: `observe.mirror.enabled` / `observe.mirror.fps`, env `RN_AGENT_OBSERVE_MIRROR=0` to disable.

## 0.62.1

### Patch Changes

- 396e862: rn-android-runner `findText` refuses missing/blank `text` with a typed
  `INVALID_ARGUMENT` error (#444). Previously `optString("text")` silently
  defaulted to `""`, falling through to `By.textContains("")` — which matches an
  arbitrary node — so a malformed request reported `found: true` for whatever
  element UIAutomator visited first instead of surfacing an argument error. The
  guard runs in the dispatch when-branch before any selector is constructed;
  a source-sync test (gh-418 style) enforces it in CI without an emulator.

## 0.62.0

### Minor Changes

- 683a132: Story 04 (#385): shared two-tier settle engine. Every mutating device\_\* verb now waits for the UI to actually stabilize instead of relying on fixed sleeps: Android gates on a new `isWindowUpdating` runner probe (capability `WINDOW_UPDATE`) then falls back to snapshot-hash equality polling; iOS polls a new on-runner `isScreenStatic` SHA-256 screenshot compare (capability `SCREEN_STATIC`, Maestro's 3s screen-settle budget) with the same snapshot-hash fallback. Results surface `meta.settle: {method, settled}` + `meta.timings_ms.settle`. `device_fill` drops its fixed 150ms focus delay when settle ran and pins its target coordinates once up front (`--at-x/--at-y`) so the settle's ref-map refresh can never retarget the fill mid-call; its corrective retypes skip settle (their stability check is the CDP read-back). `device_batch` settles between steps by default at a batch-scoped 2500ms budget (per-step `settle: false` escape hatch) and its blanket 300ms inter-step delay defaults to 0 while settle is on. Legacy runner artifacts (no new capabilities) transparently degrade to snapshot polling — no rebuild required, the new verbs are deliberately NOT in the required-command gate. Opt out globally with `RN_SETTLE=0` or per batch step with `settle: false`; tune the per-call budget with `settleTimeoutMs` (a budget knob, not a disable switch). A perpetually-animating screen settles via hierarchy stability or returns `method: 'timeout'` at budget — bounded, never hanging.

## 0.61.2

### Patch Changes

- 04ce7bf: SessionStart hook no longer misleads after a plugin upgrade (GH #419): the upgrade notice now recommends the field-proven cheap recovery — `/mcp` → reconnect the rn-dev-agent server — before a full Claude Code restart; a new read-only lockfile probe (`scripts/mcp-bridge-probe.mjs`) explicitly flags a live bridge still running from a PREVIOUS plugin install (the cause of zero-tool sessions after marketplace upgrades) naming its PID and path; and the banner no longer asserts a static "76 MCP tools" count that can't reflect actual registration — it states the installed plugin version and tells the agent the reconnect recovery path when ToolSearch finds no cdp*\*/device*\* tools.

## 0.61.1

### Patch Changes

- c15bc52: iOS `device_screenshot` honors the caller's `path` (#422): iOS pixels now route
  to `xcrun simctl io screenshot` even with an rn-fast-runner session open — the
  runner's screenshot verb writes inside its own sandbox and returns a relative
  `tmp/…` path the host can never serve, which blanked the observe UI panel and
  broke `sips` resizing (`meta.resize.reason: no-dimensions`). simctl was already
  the flow-active and runner-down backend; it is now the sole iOS pixel path
  ("pixels → simctl", D1249). Android is unchanged (its runner honors `outPath`
  host-side). Defense-in-depth: the observe recorder rejects relative screenshot
  paths instead of resolving them against the bridge cwd.
- c15bc52: `cdp_run_action` no longer dead-ends in an opaque UNKNOWN when WDA dies at
  launch (#423). Root cause chain from the field failure: the #317 CDP/JS replay
  fallback covers this exact case, but its single tree probe ran while CDP was
  mid-reconnect (the failed flow had just relaunched the app), was silently
  swallowed, and the fallback never engaged. The probe now retries (bounded,
  default 3×1.5s) until the probe testID is actually present — tolerating both a
  reconnecting CDP and a still-mounting app — and every skip is surfaced as
  `meta.cdpJsFallback: { attempted: false, reason }`
  (`no-replay-deps | no-probe-testid | cdp-unreachable | testid-not-in-tree`).
  A `cdp-unreachable` skip appends actionable guidance (check `cdp_status`,
  reconnect, stop foreign XCUITest automation) instead of a bare
  "failure not auto-repairable". Also (#422 hardening): the simctl UDID parsers
  now only consider iOS runtimes (a booted paired watchOS/tvOS simulator can
  neither win the screenshot UDID pick nor make the single iPhone look ambiguous
  to `resolveIosUdid`), and raw captures bind to the open device session's UDID
  when platforms match instead of picking the first booted device.
- c15bc52: iOS cold start persists a reusable `.xctestrun` (#424): `startFastRunner()` now
  runs `xcodebuild build-for-testing` first when no test product exists and then
  launches via the same `test-without-building` path as every warm start, instead
  of a single bare `xcodebuild test` — which never writes a `.xctestrun`, so
  self-built runners were permanently "not prebuilt" and every runner death cost
  another multi-minute cold build. The build phase keeps the 360s cold timeout;
  the launch phase uses the standard 30s ready window. The #418 stale-artifact
  rebuild tier funnels through the same path, so it also leaves a reusable
  artifact now.

## 0.61.0

### Minor Changes

- 8a21532: Command-surface gate (#418, B235): both native runners enumerate their supported
  commands in `/health.commands` (iOS derives it from `CommandType.allCases`, Android
  from a sync-tested `SUPPORTED_COMMANDS` list) and the liveness gate classifies a
  runner missing any bridge-required verb as stale (`missing-commands`). Remediation
  is tiered: `device_snapshot action=open` auto-invalidates the stale artifact and
  rebuilds — iOS deletes DerivedData and cold-builds (once per plugin version, behind a
  checkout-scoped build lock), Android deletes the runner APKs so self-install
  Gradle-rebuilds; mid-flow device tools refuse fast with `RUNNER_COMMANDS_STALE`
  instead of silently building. An unknown verb reaching the iOS runner now returns a
  typed `UNSUPPORTED_COMMAND` error instead of a raw Swift decode failure. Root cause
  of B235 fixed: the explicit iOS keyboard-dismiss path posted `dismissKeyboard`,
  which no Swift artifact ever accepted — the wire verb is now `keyboardDismiss`.
  `cdp_status` surfaces `deviceSession.runnerProtocol.missingCommands`. Hardening
  from per-edit review: the iOS runner validates client-supplied Content-Length
  (400 on invalid instead of crash/hang) and Android foregrounds alias verbs
  (press/fill/scroll) before dispatch.

## 0.60.0

### Minor Changes

- d5acd6b: Observe web UI overhaul: session header (connection, app, route, duration, call/error stats),
  filterable + searchable timeline with follow/pause autoscroll, device-screenshot hero pane with
  route chip, guided empty states, inline param inputs for learned actions (server now honors
  UI-provided params), expandable action output, and E2E run-history drill-down with per-flow
  error excerpts. The SPA is split from one 670-line file into focused modules.

### Patch Changes

- d5acd6b: SessionStart hook links `.rn-agent` from the main checkout when running in a git worktree, so learned actions, e2e config, and troubleshooting notes stay available (previously they silently disappeared in worktrees).

## 0.59.0

### Minor Changes

- d12f18f: feat(rn-fast-runner): quiescence bypass — make XCTest's private quiescence wait a no-op inside the iOS runner (#384, Story 03). RN apps with Reanimated worklets/looping animations never report idle, so XCTest queries and snapshots stalled until per-symptom patches (runner-timeout shim, HID-synthesis scroll, 35s budgets) caught them; the bypass removes the idle-wait at the root — the same WebDriverAgent-lineage approach Maestro uses. Probes both private selector variants (`waitForQuiescenceIncludingAnimationsIdle:` and the Xcode-16 `:isPreEvent:` form), swizzles exactly one (classic preferred), and degrades loudly (`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`) when Apple drifts the API — the runner keeps working without the bypass. Default ON; opt out with `RN_QUIESCENCE_BYPASS=0` (resolved at runner spawn; threaded as `TEST_RUNNER_RN_QUIESCENCE_BYPASS` because xcodebuild only forwards `TEST_RUNNER_`-prefixed vars). Note: `XCUIElement.typeText` runs its own internal sync, so the type-timeout shim remains as a safety net. Auditable via `meta.quiescenceBypass` on the first command after boot, `QUIESCENCE_BYPASS` in `/health.capabilities`, and `cdp_status.deviceSession.runnerCapabilities`.
- 0cfa78a: The observe web UI now autostarts when the MCP worker boots in an RN project, listening on a
  stable default port (7333, `http://127.0.0.1:7333`) with an ephemeral fallback on collision.
  New `.rn-agent/config.json` block `{ "observe": { "autoStart": boolean, "port": number } }`
  plus `RN_AGENT_OBSERVE_AUTOSTART` env override (precedence env > config > default, matching
  `cdp.autoConnect`). The `observe` tool gains a `restart` action; `stop` is session-scoped.
  The live URL is recorded in a per-project state file and announced at SessionStart.

## 0.58.1

### Patch Changes

- 3cf6787: fix(device_batch): testID steps failed with a misleading STALE_REF on the in-tree runners (#396). `findRefByTestID` passed the envelope's ref through verbatim; the in-tree iOS/Android runners emit `@`-prefixed refs (`@e68`), so the testID branches of `device_batch` (find+tap / press / fill) composed `@@e68`, which missed the ref-map (`lookupRef` strips exactly one `@`) and surfaced as `Element at ref @@e68 no longer hittable — UI re-rendered since snapshot` even though the snapshot was taken fresh that same step. `findRefByTestID` now returns the canonical bare id in both the flat-nodes and nested-tree envelope shapes, restoring the documented "re-resolve at execution time" contract; the GH #114 producer-consumer contract tests are updated to pin the bare-id contract for the in-tree producers.

## 0.58.0

### Minor Changes

- 694a57d: feat(protocol): version the native runner /command wire protocol + move runner state out of /tmp (#383). Both runners' `GET /health` now reports `{protocolVersion, runnerVersion, capabilities}` and every response carries a `"v"` stamp; the bridge classifies a reachable runner with a missing/older/newer protocol or a skewed `runnerVersion` as stale and transparently reaps + reinstalls it (the first device tool call after upgrading from a pre-protocol plugin pays one runner restart — `meta.note: "runner upgraded (protocol/version mismatch)"`). Only a mismatch that survives reinstall surfaces the new typed error `RUNNER_PROTOCOL_MISMATCH` with exact rebuild commands. Runner state files move from fixed shared `/tmp` paths to per-device hardened files (0600, symlink-refusing, atomic) under the app-support state dir (`runner-state/ios-<udid>.json`, `android-<serial>.json`; Android persists only under a resolved serial) via a shared `util/secure-state-file.ts` also adopted by the session file; a live pre-upgrade runner pointed at by the legacy `/tmp` state is adopted once, reaped, and relaunched before the `/tmp` files are deleted, and a grep-enforced test keeps `/tmp` out of the runner clients. `cdp_status` → `deviceSession.runnerProtocol` surfaces the handshake.

## 0.57.4

### Patch Changes

- b1e0ad6: feat(keyboard-guard): in-runner keyboard-occlusion guard for live `device_press`/`device_longpress` taps on iOS + Android (#370). Before a guarded tap, the runner probes for a visible software keyboard whose frame contains the tap point (containment on a sane rect — non-empty, min height 120pt iOS / 150px Android, so accessory bars don't false-trigger) and auto-dismisses first when occluded. Android dismissal is `pressBack` + a bounded `waitForIdle(1500)` (≈3.6s measured incl. bounded idle), gated on a TYPE_INPUT_METHOD window with sane bounds so it never navigates back otherwise — requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`, now enabled at dispatcher init. iOS is verify-or-refuse: only the safe dismiss-control tap ("Hide keyboard"/"Dismiss keyboard"/"Done") is used, then re-verified; on iPhone standard QWERTY, which has no such control, the runner REFUSES the tap with `KEYBOARD_OCCLUDED … keyboardGuard=dismiss_failed` instead of tapping the keyboard, because XCTest's `swipeDown` on the keyboard triggers QuickPath slide-typing and corrupts the focused field (device-proven). Every guarded gesture returns `meta.keyboardGuard`: `"off" | "no_keyboard" | "not_occluded" | "dismissed"` (plus `dismiss_failed` inside the iOS refusal error). Opt out with `RN_KEYBOARD_GUARD=0`/`false`, resolved TS-side per command (`guardKeyboard` on the wire; absent → guard stays ON, so older clients keep guarding). Scope is command-handler tap/longPress only — `tapSeries`, by-text taps, element-center taps, the focus-tap inside type/fill, swipes/scrolls/drags, and `doubleTap` are explicitly unguarded. Follow-up #379 tracks a JS-first (`Keyboard.dismiss()`) auto-heal for the iOS refusal case; #378 tracks a pre-existing Android `foreground()` pre-flight stall surfaced (not fixed) during verification.

## 0.57.3

### Patch Changes

- a6112e6: fix(record): `device_record stop` no longer crashes on macOS with `adb_args[@]: unbound variable` (#374). In `record_proof.sh` the Android stop branch expanded an empty `adb_args` array unguarded (`"${adb_args[@]}"`); under `set -euo pipefail` on bash 3.2 (the macOS default `/bin/bash`) that is an unbound-variable error, aborting the stop before the pull/convert — so recording finalize (and, via a leftover Android `.pid`, even iOS stops) failed. All three expansions now use the `+`-default guard already present elsewhere in the file. Regression-guarded by a static invariant test (effective on bash 5.x CI) plus a behavioral reproduction gated to bash < 4.4.

## 0.57.2

### Patch Changes

- 0a9a732: fix(interact): cdp_interact no longer corrupts react-hook-form Controller-wrapped inputs (#336). `setFieldValue` keeps a string a string for string-typed fields (a digit-string injected as a number is coerced back to string only when the field currently holds a string — number/boolean fields are untouched). `press` gains an optional `value`: when provided, `onPress` receives the value instead of a synthetic event, so radio/chip-style controls whose onPress sets a form value select correctly. HELPERS_VERSION bumped to 33.

## 0.57.1

### Patch Changes

- d61985f: fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows, and route Android hideKeyboard replays to the official Maestro CLI (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Device verification surfaced that maestro-runner v1.0.9 silently no-ops `hideKeyboard` on Android (B223), so `maestro_run` now prefers the official Maestro CLI for Android flows containing `hideKeyboard` (verified to dismiss the keyboard on-device), warning when the CLI is unavailable; iOS is unaffected (maestro-runner honors hideKeyboard there). Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.

## 0.57.0

### Minor Changes

- 98d3fb7: Add an RNTL-style discovery resolver to the injected helpers. `resolveLadder` finds elements by `byRole(+name)` / `byText` / `byPlaceholder` — ported from React Native Testing Library (matcher + normalizer, accessible-name, role, hidden, host-kind) — with fail-closed truncation and fail-closed multiplicity (never silently picks the wrong element), hidden-element exclusion by default, and a selector bundle (`testID` / `text` / `accessibleName` / `role` / `placeholder` / `anchors`). `interact()` routes `role`/`name`/`text`/`placeholder` selectors through the ladder. Includes RNTL `matchDeepestOnly` so a composite+host fiber pair (e.g. `Text`+`RCTText`) resolves to a single on-device element instead of fail-closing as ambiguous.

## 0.56.0

### Minor Changes

- dd95747: Bump the plugin manifest so installed users receive the recently-merged cdp-bridge work via `/plugin update`. Until now the changesets flow only versioned the internal `rn-dev-agent-cdp` package, leaving `plugin.json` / `marketplace.json` pinned at 0.55.5 — so the plugin's cache key never moved and updates never reached installs even though the bundled `dist/` had advanced.

  This release ships, to installed users:

  - **observe Regression "Run" reaches the device (#351):** the per-action Run resolves the connected app's project root via bundleId instead of falling back to `process.cwd()`, so clicking Run no longer fails with `NO_PROJECT_ROOT`.
  - **iOS 26.x action replay (#353, Phase 2):** when WebDriverAgent reads an empty accessibility tree, `cdp_run_action` falls back to a CDP/JS transport so replays still drive the app.
  - **Durable action store (#359, Phase 1):** run/repair history persists in a derived, gitignored node:sqlite store (dual-write mirror of the JSON sidecars; graceful degradation when node:sqlite is unavailable); `cdp_status` reports the active `actionStore` backend.
  - **CI now runs nested unit test dirs (#340).**

## 0.55.5

### Patch Changes

- 577b13b: cdp_repair_action now reports TRANSPORT_BLIND when the failed Maestro selector is present in the live rn-fast-runner snapshot — the iOS 26.2 + bridgeless empty-a11y-tree case (GH #317) — instead of the misleading "no confident replacement". cdp_run_action surfaces it as a terminal refusal with refusedReason TRANSPORT_BLIND. Diagnostic-only; restoring replay on that runtime is Phase 2.

## 0.55.4

### Patch Changes

- 9a0f632: Live-sim speedup (GH #321, quick win #4): `device_batch` returns a **salient final
  payload** by default and gains a `finalSnapshot` option (`salient` | `full` |
  `none`).

  `device_batch` already collapses N interactions into one MCP round-trip, but its
  `final_snapshot` was always the full a11y node list (large) and it always took an
  implicit trailing snapshot. Now:

  - `salient` (default) — `final_snapshot` is compacted to only actionable nodes
    (Button/TextField/Switch/Slider/Cell/Link/…), each `{ ref, type, label,
identifier, hittable? }`, with a `fullNodeCount`. Far fewer tokens; `@ref`s for
    actionable elements are preserved so follow-up `device_press(ref)` still works.
  - `none` — skips the implicit trailing snapshot entirely (~1,450 ms saved) for
    action-only batches verified via `expect_*`/`cdp_store_state`.
  - `full` — the legacy complete node list.

  An explicit `snapshot` step or `screenshotOn:'end'` still populates the payload;
  the option only governs the implicit trailing snapshot and its shape. `rn-tester`
  now recommends a single `device_batch` for known multi-step sequences.

## 0.55.3

### Patch Changes

- e4d9e3b: Live-sim speedup (GH #321, quick win #3): `cdp_component_tree(interactiveOnly: true)`
  returns a compact **salient digest** of a screen — only actionable nodes
  (Pressable/Button/TextInput/Switch/Link and `accessibilityRole` controls) with a
  minimal `{ testID, role, text, label, placeholder, disabled }` shape, dropping
  props, hook state, and nesting.

  This is the perception _payload_ (token) lever, complementary to the cached-find
  _round-trip_ lever: answering "what can I tap here?" on a novel screen now costs
  hundreds of tokens instead of the full fiber tree's thousands. Implemented as an
  `interactiveOnly` mode in the injected `__RN_AGENT.getTree()` (HELPERS_VERSION 26) — a bounded BFS over every renderer root that collects interactive fibers and
  their text. `rn-tester` is updated to prefer it for perceiving novel screens.

## 0.55.2

### Patch Changes

- 3186f64: Live-sim speedup (GH #321): `device_find` now reuses the snapshot it already
  captured instead of issuing a redundant runner round-trip — but only while that
  snapshot is still a faithful picture of the screen.

  A snapshot cache already existed (`cacheSnapshot`) but nothing read it for
  targeting, so every `device_find` re-snapshotted. On the live iOS test-app a warm
  `device_find` measured ~1,449 ms — essentially one full XCUITest accessibility
  snapshot (~1,435 ms) plus matching. Reusing a valid cache drops a repeated find on
  an unchanged screen to ~0.004 ms (in-memory filter), saving ~1.45 s per avoided
  find.

  Correctness is gated on a two-condition validity check, not just a TTL: the cache
  must be clean AND within the freshness budget. Invalidation is **fail-safe and
  centralized at the MCP tool boundary** (`trackedTool`): every tool call that is not
  on an explicit read allowlist marks the cache dirty — so JS-level mutations that
  bypass the native dispatch path (`cdp_interact`, `cdp_navigate`, the `fastSwipe`
  swipe/scroll path, `device_deeplink`, `cdp_dispatch`/`cdp_reload`/`maestro_run`, …)
  all invalidate it, and any future tool defaults to "invalidate" until proven a pure
  read. The native `runNative` choke point also marks dirty as defense-in-depth for
  direct (intra-composite) handler calls. A tap or navigation therefore forces a
  fresh snapshot — the cache is never reused against a screen it no longer describes.
  Only the `device_find` handler opts in (`allowCache`); all other snapshot callers
  are unchanged.

## 0.55.1

### Patch Changes

- 65fc134: Fix #312: harden the Maestro step-line parser (`maestro-step-parser.ts`), which structures `maestro_run` results from the runner's untrusted combined stdout+stderr.

  - **B211** — cap the `verb` field to `MAX_FIELD`; previously only `name` was bounded, so a step-shaped line with a multi-KB first token could bloat the MCP response across up to 1000 steps.
  - **B212** — anchor `parseSteps` on the runner's leading indentation (horizontal-whitespace-only `^[ \t]+`, matched against the un-trimmed line) so an unindented (column-0) app-log line shaped like `✓/✗ … (N.Ns)` can no longer be mistaken for a step and poison `lastStep`/`failedStep`/the failure headline. `\r`/`\v`/`\f`/NBSP-prefixed lines are rejected too (JS `\s` would have re-admitted them). `parseTapLatencies` (#263) inherits the same hardening.
  - A new `combineRunnerOutput(stdout, stderr)` helper joins the streams for parsing without the blanket `.trim()` that would strip the first step line's indent (dropping `launchApp` from `meta.steps`); it uses native `.trimEnd()` to stay linear on multi-MB output.
  - Stripped stale review-provenance comments per the repo's no-unnecessary-comments convention.

## 0.55.0

### Minor Changes

- 9c3b1d2: Harden device-control conflicts: add an Android serial-scoped device lock (parity with iOS) that engages on a normal emulator, separate the Android runner's probed host port from its fixed device-listener port (`adb forward`), and let the iOS runner self-assign a free port when 22088 is taken.
- 1954ef1: Android `rn-android-runner` now self-installs on first use (parity with the iOS `rn-fast-runner` cold build): `startAndroidRunner` installs the prebuilt APKs — and cold-builds them via Gradle if absent — when the instrumentation isn't on the device yet. No external CLI or manual `gradlew + adb install` step is required; this makes the `/setup` and `/doctor` "builds/installs on first use" promise true on Android.
- fec0464: Remove the agent-device dependency entirely. The Android daemon-socket + CLI fallback tiers are deleted; session open/close/list and find now route natively (simctl/adb + the in-tree rn-fast-runner / rn-android-runner), the Android dispatch gained an ensure-on-dispatch choke point (parity with iOS), session open validates the appId and acquires the device lock before any side-effect, RN_ANDROID_RUNNER=0 now errors (RUNNER_DISABLED) instead of silently falling back, and the agent-device install script + its SessionStart hook are gone. The in-tree runners are the sole device backend; the foreign-AgentDeviceRunner cleanup (self-heal for old installs) is retained.

### Patch Changes

- d591710: Fix #303: Metro-port discovery now prefers the port with an attached Hermes target over a merely-running one, and when several Metros have an app it auto-selects the one whose serving directory matches this worktree's project root (resolved via `findProjectRoot` + realpath, containment-aware). `cdp_status` surfaces all candidate Metros (`metro.candidates`) plus `projectRoot`/`servingCwd`, and warns when the connected Metro serves a different worktree — catching the silent trap where an agent verifies against the wrong worktree's JS bundle even with a single Metro running. `cdp_targets` (`discoverForList`) prefers the attached port too. Fail-open throughout (macOS `lsof`; degrades to prior behavior off-darwin or when paths can't be resolved).

## 0.54.7

### Patch Changes

- 8305bbd: `maestro_run` now returns structured per-step results and partial progress on timeout (GH #211).

  The result gains `steps[]` (`{index,name,verb,status,durationMs}`), `failedStep`, `reason` (sanitized `{kind,selector}` — never the raw runner log), `lastStep` (progress marker), `timedOut`, and `outputTruncated`. On timeout the partial steps are returned instead of a bare failure, and the failure headline names the failing/last step. Parsed from maestro-runner stdout (the JVM Maestro CLI fallback degrades fail-open to empty steps); `tapOn` latencies for #263 now derive from the shared parser. Additive — `output` is preserved for `run-action` consumers.

## 0.54.6

### Patch Changes

- 16f0a0d: `maestro_run` now flags a wedged simulator runtime (GH #263).

  When a flow fails AND the median latency of its successful `tapOn` steps exceeds a floor (default 1500ms, `RN_RUNTIME_DEGRADED_FLOOR_MS`), the result gains a `RUNTIME_DEGRADED` hint and `meta.runtimeDegraded` — "the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown/boot), relaunch, and retry." This replaces the misleading "Element not found" that previously sent the agent chasing app code when the real cause was a degraded simulator (taps reported success but `onPress` never fired). Detection is purely additive — it never changes a pass/fail verdict, never fires on a passing run, and only counts successful taps (a failed tap's duration is the step timeout, which would otherwise false-positive an ordinary element-not-found failure). Fail-open: unparseable output → no hint.

## 0.54.5

### Patch Changes

- 6c77108: `/observe` device panels now refresh live (GH #206).

  The observability layer was a passive recorder of tool observations — the screenshot only updated on `device_screenshot` calls and the route only on navigation-family tools, so driving the app with `cdp_interact`/`cdp_navigate` left both panels stale. A fire-and-forget hook now captures a fresh screenshot (simctl/adb, OS-level) + route (CDP nav-state) after each state-mutating tool and delivers them via a dedicated live SSE channel (`{type:'live'}` + `/api/live-screenshot`), so the timeline stays clean. Platform resolves from the active device session or the connected CDP target (so a purely CDP-driven flow with no agent-device session still refreshes). Gated on a connected `/observe` tab, skipped during Maestro flows, single-flight trailing-coalesce, opt-out with `RN_OBSERVE_LIVE=0`.

## 0.54.4

### Patch Changes

- 64531c8: Bump esbuild to 0.28.1 across the build toolchains to clear the HIGH Dependabot advisory (GHSA-gv7w-rqvm-qjhr).

  The advisory is in esbuild's Deno installer (binary-integrity RCE via `NPM_CONFIG_REGISTRY`) — a code path this repo never executes (esbuild is consumed as an npm transitive dep via Vite/Astro, not Deno), so it was never exploitable here. Still, both the observability web UI (`scripts/cdp-bridge/src/observability/web/`) and the docs site carried the vulnerable transitive esbuild, so both now pin it to the patched 0.28.1 via an npm `overrides`. The observability Vite build also sets `build.target: 'esnext'` (it's an internal localhost-only dev tool viewed in a modern browser) to sidestep an esbuild 0.28 regression that refused to downlevel destructuring to Vite's default old-browser baseline; the single-file bundle was rebuilt. `npm audit` is clean in both subtrees.

## 0.54.3

### Patch Changes

- a88d139: `cdp_network_log` no longer returns two entries per request (GH #214).

  Root cause: setup sends `Network.enable` (mode `cdp`), then `probeNetworkDomain` fires a probe fetch and watches the buffer. On RN ≥ 0.83 the CDP Network domain _does_ deliver events, but when they don't flush within the probe window — a false negative documented after platform switches / reloads (GH #59 #9) — the probe returns `none` and setup injects the fetch/XHR hook **without disabling the still-enabled Network domain**. Both paths then capture every request (CDP numeric-id entries + hook UUID-id entries), and the existing exact-id dedup can't collapse them because the two id schemes never collide.

  Fix: when setup falls back to the hook, it now disables the CDP Network domain first, so the hook is the single capture source. This also makes `cdp_status`'s `networkDomain: false` truthful instead of a label over a still-running domain — the "capability flag out of sync" symptom in the report was the same root cause. Read-time fuzzy dedup was deliberately rejected: it would collapse legitimately-identical rapid requests (a real double-mutation) and hide bugs — the opposite of what the reporter needed.

## 0.54.2

### Patch Changes

- 0386204: `cdp_mmkv` delete and boolean reads now work on the Nitro react-native-mmkv line (GH #209).

  - `delete` was calling `mmkv.delete(key)` — a JS-wrapper-class method that doesn't exist on the raw Nitro hybrid object the tool actually talks to (`createHybridObject('MMKVFactory').createMMKV(...)`), whose spec exposes `remove(key)`. The generated expression now prefers `remove()`, falls back to `delete()` for wrapper-shaped objects, and reports a named error (instead of a bare TypeError) when neither exists. This unblocks first-class auth/storage resets for logged-out replays on iOS — previously a raw `cdp_evaluate` escape hatch every time.
  - `get` with `type: 'boolean'` emitted `mmkv.getBool(key)`, which exists on no MMKV surface (hybrid object and wrapper both spell it `getBoolean`) — broken since the tool shipped. Now fixed.
  - The follow-up enhancement from the issue (a `clearKeys:` action-YAML directive for self-contained auth-gated replays) is tracked as GH #286.

- 0466d15: `/send-feedback` no longer presents weeks-old telemetry as "recent" (GH #266).

  Root cause: the per-tool-call telemetry writer was removed with the Experience Engine (GH #200, v0.49 era), but `collect-feedback.sh` kept reading the orphaned `~/.claude/rn-agent/telemetry/*.jsonl` files and shipped their tail as "Recent Tool Activity" in filed issues. The collector now cross-checks the newest event's age: fresh events (<24h, legacy plugin versions still writing) ship as before with `telemetry_status: "ok"`; otherwise events are omitted and `telemetry_status` reports `stale (last event N days ago — …)` or `none` explicitly. The `/send-feedback` issue template renders the status line instead of an empty/misleading activity table, and the empty-telemetry edge no longer emits a single bogus `{}` event.

## 0.54.1

### Patch Changes

- bd5d585: Recovery paths now detect "app not installed" and resolve their relaunch target truthfully (GH #262, absorbs #194 BUG 2).

  - `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container`'s stderr carries the `NSPOSIXErrorDomain code=2` marker (allowlist-only, stderr-only — argv-spoof-proof), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the newest matching `.app` snapshot from the last clearState (GH #201 dir, mtime-sorted budgeted scan). Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior. Concurrent recoveries are serialized, and a confirmed missing bundle is cached (with a cheap re-probe) so the diagnosis is never masked by `budget-exhausted`.
  - `cdp_restart hardReset=true`: the relaunch target resolves through `explicit arg > connectedTarget > cache > active-session appId > strict per-platform app.json` (no iOS←Android fallback), simctl targets the active session's UDID when one exists, failed launches are classified the same way in `hardResetSteps`, and a successful hard reset resets the detached-recovery budget.

- 81c386a: `device_screenshot` no longer blames "device transitioning state" when the target directory doesn't exist (GH #265).

  - `captureAndResizeScreenshot` now `mkdir -p`'s the parent of the derived output path before any dispatch tier runs (simctl raw, rn-fast-runner, agent-device daemon/CLI, adb stream) — new directories are the expected case, since the tool's own advisories steer agents toward fresh `docs/proof/<slug>/` paths. The fix covers `device_screenshot`, `device_batch` auto-captures, and `proof_step`, all of which funnel through the same helper.
  - When the directory itself cannot be created (e.g. a file blocks an intermediate path segment), the tool short-circuits before probing any device and returns an honest `SCREENSHOT_FAILED` with `reason: 'target-dir-unavailable'` naming the offending path — never the device-state guess.
  - A leading `~/` in the screenshot path is now expanded to the real home directory (Node never expands `~`, so mkdir would otherwise create a literal `./~/` under the bridge cwd and report success into the wrong location). Unexpandable forms (`~user/...`, bare `~`) are refused with an actionable error.

## 0.54.0

### Minor Changes

- 85a6b60: Agent model upgrades + skill efficiency pass.

  **Agents**: all agents now run on `opus` (rn-tester, rn-code-explorer, rn-code-reviewer up from sonnet; rn-debugger unchanged); `rn-code-architect` moves to `fable` — the top model tier for the pipeline's single deep-reasoning blueprint step. Model-tier prose synced in the router skill and docs-site.

  **Skills** (token efficiency + correctness, verified by a confined-subagent retrieval test):

  - `rn-feature-development` 5,076 → ~3,960 words (−22%): Phase 8 no longer duplicates the proof protocol — `commands/proof-capture.md` is the single source of truth, with pipeline deltas (architect's flow table as source, persist-as-action via creating-actions Steps 3–6, `cdp_run_action` smoke-test, Deviations section) listed on top; 8 repeated per-phase evaluator lines collapsed into one core principle; description rewritten trigger-only (a workflow-summarizing description makes the body get skipped).
  - `using-rn-dev-agent` (always loaded at session start) 2,065 → ~1,825 words: HELPERS_NOT_INJECTED recovery protocol moved to `rn-debugging` (its natural home) with a routing pointer left behind; stale surface counts fixed (76 MCP tools / 14 commands).
  - `rn-testing`: M7 header section slimmed to a 5-key table + creating-actions pointer (the full glossary lives there) — same heading kept for existing citations.
  - `rn-best-practices` / `rn-setup`: descriptions rewritten trigger-only (dropped the rot-prone rule-count inventory; added concrete failure-phrase triggers).
  - Stale claims fixed everywhere: `maestro_run`/`cdp_run_action` DO forward `params` since #272 (proof-capture + feature-dev said otherwise); broken section citation in `run-action.md`; dangling "Step 1.4" cross-references from the old inline Phase 8; smoke-test now consistently `cdp_run_action` (RunRecord + auto-promotion) with plain `maestro_run` reserved for the on-camera replay.

## 0.53.0

### Minor Changes

- eff45cd: #202 Phase 6 / #186 — foreign Maestro sessions become arbiter refusals; plugin maestro_run is the canonical surface.

  While a foreign Maestro/XCUITest session drives the target simulator (UDID-scoped detection, 5 s TTL, fail-open), local `device_*` and flow tools refuse fast with `BUSY_FOREIGN_FLOW` (~50 ms measured) — pointing at the safe L1 reads — instead of colliding into the ~44 s runner-leak cascade. L1 introspection stays free; `device_screenshot` serves pixels via its simctl fallback; a ~10 s teardown grace after the plugin's own flows prevents self-false-positives while WDA dies. The two historical reasons to leave the plugin surface are live-gate-verified closed and #201 is closed — including a new fix: the clearState `--app-file` resolution is snapshotted outside the device container (the installed-container path used to be deleted by clearState itself before the reinstall could read it). `RN_IOS_FOREIGN_GUARD=0` disables both the warning and the refusal (`RN_IOS_FOREIGN_WARN=0` remains a deprecated alias). The foreign-runner `ps` scan now uses `-ww` (command-column truncation could silently drop the UDID → false negatives).

## 0.52.0

### Minor Changes

- c05c058: #202 Phase 5 / #264 — the bridge now survives Metro restarts (supervisor split).

  The MCP entry point is now `dist/supervisor.js`: a thin stdio shim holding zero network sockets (immune to `lsof -ti tcp:8081 | xargs kill -9`, which used to SIGKILL the whole server and cost the session all 77 tools). It spawns the real bridge as a worker, and on worker death: errors in-flight calls with `-32000` ("retry the call"), respawns it (max 3 per rolling 60 s, then a terminal crash-loop error), and replays the cached MCP `initialize` handshake so the session continues seamlessly. Visibility: `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Opt out with `RN_BRIDGE_SUPERVISOR=0` (legacy single process). `SIGUSR2` now performs a real hot-reload (worker restart + handshake replay).

## 0.51.0

### Minor Changes

- abe4411: New `creating-actions` skill — guided authoring of reusable Maestro actions.

  Walks the agent through the full authoring contract: inventory-dedup scan before authoring (via `learned-actions.mjs`), creation-path choice (recorder vs direct YAML vs `maestro_generate`), selector grounding (never invent a testID), a **required ASCII flow diagram** of screens/transitions annotated with exact testIDs and `${PARAMS}` (embedded in the YAML header — glyph-first lines so the M7 parser can't misread a diagram line as metadata, which would otherwise silently overwrite fields like `status`), the M7 header contract, pre-replay validation (header round-trip through the inventory parser, placeholder↔params coverage, selector audit), and replay-to-promote via `cdp_run_action` (never hand-set `active`). Ships with a full M7 field reference (`references/m7-header-reference.md`) and a toolchain-validated worked example (`examples/add-product-to-cart.yaml` — verified against `parseM7Header`, `learned-actions.mjs`, and Maestro's syntax checker). Routed from `using-rn-dev-agent` (decision tree + skill map) and cross-linked from `rn-testing`'s M7 section.

## 0.50.0

### Minor Changes

- 73c6bf4: #202 Phase 4 — eradicate legacy runner apps, not just processes.

  At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Scanned at every device-open (one `simctl listapps`, ~150–350 ms measured — no memo, so a reinstall by another session is always caught); error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.

## 0.49.0

### Minor Changes

- 58c4886: Debugger-seat coexistence with React Native DevTools + silent hook-mode network capture.

  - New opt-out for background auto-reconnect: `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` `{ "cdp": { "autoConnect": false } }`. In passive mode the bridge yields the single RN debugger seat to the visual DevTools and reconnects only on explicit tool calls. Resolved mode is visible in `cdp_status` → `autoConnect` and `/doctor`.
  - Hook-mode network capture (RN < 0.83 fallback) no longer transports entries via `console.log("__RN_NET__:…")` — entries go to an in-app ring buffer drained on demand, so Metro logs and the user's DevTools console stay clean.

## 0.48.5

### Patch Changes

- 6190178: fix(#253): `cdp_repair_action` no longer hardcodes `targetPlatform='ios'` — Android auto-repair works against an emulator. The repair orchestrator now derives the platform from the active device session via `detectPlatform()` (booted-device probe fallback when no session is open; `'ios'` only as the final no-session, no-device fallback). Previously an Android repair foregrounded the app via `xcrun simctl`, snapshotted through the iOS short-circuit, and bootstrapped the iOS fast-runner — so Android selector drift always escalated as a hard failure instead of self-healing.

## 0.48.4

### Patch Changes

- e5404ed: fix(#249): Maestro pass detection no longer flips passing flows to failed when app logs contain the substring `FAILED`. The exit-0 secondary guard in `maestro_run`, `maestro_test_all`, and the inline maestro fallback used a bare `output.includes('FAILED')` over combined stdout+stderr — app/console output like a `FETCH_FAILED` Redux action or a `LOGIN_FAILED` analytics event marked a genuinely passing flow as failed and triggered pointless auto-repair. All three call sites now share `outputIndicatesFlowFailure`, which keys on Maestro's own terminal status lines (`Test FAILED` / `Flow FAILED` / a `[FAILED]` step marker / a bare `FAILED` line) instead of a substring.
- 070586d: fix(#250): `cdp_interact` no longer reports success when the app's own handler throws. The injected interact dispatch caught handler exceptions (`onPress`/`onChangeText`/`setValue` raising — unmounted component, missing context, thrown validation) and returned `success: true, action_executed: true`, which the tool layer surfaced as a non-error warning — so agents proceeded against a screen that may be in an error state. The helper now reports `success: false` (keeping `action_executed: true` to distinguish "dispatched but handler threw" from "couldn't dispatch"), and the tool layer maps it to a structured error with `meta.actionExecuted`, `meta.handlerError`, and a check-`cdp_error_log` hint. HELPERS_VERSION bumped to 25 so connected sessions re-inject.
- 8269476: fix(#251,#252): startup hardening. The project single-instance lock (`Lockfile.acquire`) now uses the same atomic `openSync('wx')` exclusive-create pattern as `DeviceLock` — the previous read-then-write let two bridges starting in the same instant both "acquire" the lock, with the second silently truncating the first; the loser now gets a structured conflict, stale-holder reclaim narrows the steal window with a re-read before unlink, and fs infra errors fail open (`degraded: true`) instead of crashing the bridge at boot. Separately, SessionStart is now bounded: the hook declares an explicit 120s timeout and the maestro-runner installer's `curl | bash` carries `--connect-timeout 10 --max-time 90`, so a stalled CDN can no longer block session start indefinitely; a CI guard (`session-start-bounded.test.sh`) pins both.

## 0.48.3

### Patch Changes

- 609c825: fix(B191,B192): post-flow lifecycle hardening follow-ups to #243/#244. `isAndroidConnectionFailure` now also classifies `startAndroidRunner`'s startup-failure shapes (`exited before readiness`, `Failed to spawn Android runner instrumentation`) into the structured retryable `RN_ANDROID_RUNNER_DOWN` instead of letting a startup crash escape as a raw exception. And `isBenignSessionGoneError` no longer runs its session-gone regex over unparseable (non-JSON) close payloads — with no error field to scope the match to, they surface unchanged, so a real close failure whose raw text merely mentions "no active session" can't be silently swallowed.

## 0.48.2

### Patch Changes

- c9d447d: fix(#243,#244): Android post-flow lifecycle. `rn-android-runner` readiness is now gated on its own `GET /health` instead of the `adb logcat` ring buffer — a prior runner's stale ready line (same tag + fixed port) used to fire readiness before the new socket bound, so the first `device_*` after a Maestro flow returned a bare `fetch failed`. When the runner genuinely can't come up, `runAndroid` now surfaces a structured `RN_ANDROID_RUNNER_DOWN` with a retry hint. Separately, `device_snapshot action=close` now tolerates an underlying session that a flow already tore down (the #237 slot-release): it cleans up local state and returns ok, so `open → flow → close` round-trips cleanly instead of erroring `SESSION_NOT_FOUND`.

## 0.48.1

### Patch Changes

- 51976e8: fix(#237): Android instrumentation-slot handoff — `runFlowParked` now releases the single Android `UiAutomation` slot before a Maestro flow (`maestro_run`/`maestro_test_all`/`cdp_auto_login`), fixing `UIAutomator2 server not ready after 30s`. It stops the in-tree `rn-android-runner`, `am force-stop`s our two instrumentation packages (the decisive device-side release), and — gated by `RN_DEVICE_KILL_LEGACY` — kills a stale legacy `agent-device` daemon by its specific PID (never `pkill`, guarded against our own process tree so the MCP server is never collateral). Best-effort and idempotent; iOS behavior is unchanged.

## 0.48.0

### Minor Changes

- de6a8d8: fix(#191): JS-first text entry — `device_fill` now prefers the deterministic React `onChangeText` path when CDP is connected and the ref resolves to a testID (via its cached snapshot identifier), settle-polls the field value to verify it (defeating the debounced-`onChangeText` read race), and on the native fallback runs a bounded clear+retype (real `clearFirst` + per-character delay) when the value is corrupted, escalating to a verified maestro fallback before erroring. Adds best-effort iOS predictive-keyboard suppression at session-open and a new `TEXT_ENTRY_UNVERIFIED` error code for the exhausted-and-still-corrupted case. Additive `meta` only (`textEntryPath`, `verify`, `timings_ms`); no breaking change for existing callers. NOTE: `device_batch` fills are not yet JS-first (they call the runner directly) — tracked as a follow-up.

## 0.47.5

### Patch Changes

- 72d17b5: Fix #210: iOS device-session visibility + self-healing. `cdp_status` now reports `deviceSession: { sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', appId?, deviceId?, foreignRunner? }` so the agent can see the XCUITest runner state before calling `device_*` (iOS-gated — Android leaves `rnFastRunner:'dead'` and skips the probe/scan). `device_find/press/fill` now auto-spawn the runner from the dispatch choke point when a session or booted simulator exists and the rig is prebuilt — cold-build-safe: a missing prebuilt rig returns an actionable `RN_FAST_RUNNER_DOWN` error naming `device_snapshot action=open` instead of a silent multi-minute `xcodebuild`. `device_screenshot` now falls back to `xcrun simctl io screenshot` (or `adb`) whenever the runner can't serve it — including while a Maestro flow owns the device — so it never hard-fails on iOS. Also fixes a latent bug where an omitted-platform `device_snapshot action=open` stored `platform: undefined`, skipping the iOS dispatch branch.

  Reframes the issue's "ride Maestro's WDA" suggestion (rejected: WDA is per-flow/ephemeral with no session to ride, and a WDA client would add a second XCUITest backend rather than unify; mid-flow pixels use simctl, mid-flow state uses CDP introspection). (GH #210, B186, D1249)

## 0.47.4

### Patch Changes

- 75a9573: Fix #182: the CDP MCP no longer fails with `-32000: Connection closed` when an orphaned bridge from a dead Claude Code session holds the single-instance lock.

  Root cause: when CC dies abnormally (SIGKILL/crash/window-close on macOS) without closing the child's stdin or signaling it, the bridge becomes a **live orphan** — still running, still holding the project lock. The existing reclaim (PID-dead / mtime>24h / process-name) can't recover a _live_ owner, so the next session hard-failed for up to 24h. Four composing fixes:

  - **Parent-death self-exit (prevent).** A `getppid()` poll (`lifecycle/parent-watch.ts`) captures the bridge's PPID at startup and self-exits (releasing the lock) when it _changes_ — i.e. the original Claude Code host died and the bridge was reparented. This catches the abnormal-death cases stdin-EOF + signal handlers miss. It compares against the startup PPID rather than testing `=== 1` so a bridge whose host runs as PID 1 (a container with no init system) is never falsely killed.
  - **Orphaned-owner reclaim (recover).** `Lockfile.isLockLive` reclaims a _live_ owner whose parent **changed** from the PPID it recorded at acquire (`ps -o ppid=`) — so a new session self-heals past an existing orphan instead of hard-failing. A null PPID lookup fails safe; pre-0.39 locks with no recorded `ppid` fall back to a legacy `PPID===1` reclaim.
  - **Heartbeat (recover wedged).** The lock body carries `lastHeartbeat`, refreshed every ~10s; a live owner whose heartbeat goes stale (>90s) is wedged and reclaimable — mirroring the device-lock's self-healing. Pre-0.39 locks without `lastHeartbeat` fall back to the existing mtime check (back-compat).
  - **Usurp self-terminate (sleep/wake safety).** `Lockfile.touch()` now returns whether we still own the lock. If a contender reclaimed our slot while the laptop slept (heartbeat expired → reclaimed → we wake), the next heartbeat detects the foreign PID and self-terminates instead of running as a second bridge on the same device. This also makes the (pre-existing, non-atomic) reclaim path self-correcting within one tick.

  Together these eliminate the manual `kill <pid> && rm <lock>` workaround. 15 #182 unit tests (incl. container-safety, sleep/wake usurp, and a real `ps -o ppid=` check); unit suite 1744/1744; `tsc` clean. (GH #182, B185, D1246)

## 0.47.3

### Patch Changes

- b29a8e4: Fix `cdp_console_log` and harden the helper-expr injection guard. The guard that validates injected-helper calls before `Runtime.evaluate` banned any call containing `{}`, which broke `cdp_console_log` — it passes a JSON object argument (`getConsole({"level":"all","limit":50})`) and was refused with "helper-expr: refusing to interpolate untrusted call". The guard now validates that the argument list is **pure JSON data** (object/array literals included) instead of banning `{}` characters. This fixes `cdp_console_log` (and any object-arg helper call, e.g. `dispatchAction`) **and tightens security**: the old `[^;{}]*` regex let nested calls such as `getConsole(stealSecrets())` through; those are now rejected. The one non-JSON token a call site emits — `undefined` (store-state's absent path/type) — is normalized to `null` for validation only; the original call is interpolated unchanged. Verified: 1710/1710 unit tests pass (incl. 10 new helper-expr tests) and live `cdp_console_log` returns the console buffer (69 entries). (B180)
- bc577e9: Fix the CDP connection wedge (GH #208): `cdp_status` no longer dead-locks on "Already connecting to Metro..." and no longer misreports a detached app as "Metro not found". Three root causes were addressed:

  - **RC1 — reconnect-storm wedge.** When the app detaches but Metro stays up, the WS-close reconnect loop holds `isReconnecting()` true for up to ~12 min (30 attempts × 30s cap, then re-armed indefinitely by the background poll). `autoConnect`'s guard threw "Already connecting" for every `cdp_status`/`cdp_*` call in that window. `cdp_status` now **preempts** an active reconnect storm via `softReconnect()` (the existing 3s `softReconnectRequested` handshake) for one fresh attempt instead of refusing, and surfaces the live `reconnectState` (attempt N/30) on any connect failure so it reads as progress, not a dead end.
  - **RC2 — misleading error.** "Metro up but 0 Hermes targets" now throws a typed `AppDetachedError` ("Metro is up … advertises 0 Hermes debug targets — the app isn't attached") instead of being conflated with the genuine "Metro not found" (now reserved for `discoverMetroPort` returning null).
  - **RC3 — no auto-recovery.** New `recoverDetached()` cold-restarts a detached iOS app (`simctl terminate` + `launch`) → reconnects → confirms with a real CDP liveness probe. Bounded to 3 consecutive attempts/session, skips while a Maestro flow holds the arbiter lease, iOS-only, opt-out via `RN_AUTO_RELAUNCH_ON_DETACH=0`. Cold-restart (vs recover-wedge's bare launch) is acceptable because it only fires when the app is ALREADY detached — never against a working app.

  Hardened via a Codex + Gemini multi-review: `cdp_status` now honors an explicit `args.platform` during a storm (tears down + reconnects rather than reusing the storm's target), auto-relaunch is skipped when the caller pinned a non-iOS platform (never cold-restarts an unrelated iOS session), `simctl launch` failures are surfaced instead of hidden behind "still detached", and the post-recovery status read can no longer throw out of the handler.

  19 new unit tests; full suite 1729/1729; `tsc --noEmit` clean. Live false-positive guard verified: the real `discover()` against Metro does not fire `AppDetachedError` while a target is present. Scoping: the literal-0-targets case is fixed; the RN-0.85 "C++ target present, 0 Hermes" flavor remains B156/B184 territory (recover-wedge path). (GH #208, B181, D1245)

## 0.47.2

### Patch Changes

- dc49a98: Fix B178: CDP introspection returning zero frames on Expo SDK 56 / RN 0.85. The B177 Origin fix used `localhost`, which clears `@react-native/dev-middleware`'s loopback gate (no 401) but trips Expo SDK 56's **second** origin gate in `createDebugMiddleware` (`isMatchingOrigin`): it requires the `Origin` host to equal the dev server's `serverBaseUrl` host (`127.0.0.1`), and a mismatch is force-closed via `socket.terminate()` → a **1006 abnormal close right after connect, before any CDP frame relays**. Switching `metroOrigin` to emit `127.0.0.1` clears **both** gates (and bare RN's single gate), fully restoring `cdp_status` / `cdp_component_tree` / `cdp_store_state` / `cdp_evaluate` on RN 0.85. Verified end-to-end against a live RN 0.85 app: `Runtime.evaluate` plus Redux / Zustand / navigation reads now relay. (B178 / D1242)
- de2353b: Fix CDP-bridge connection failure on React Native 0.85 / Expo SDK 56. RN 0.85's Metro inspector proxy (`@react-native/dev-middleware`) now enforces a WebSocket `Origin` allowlist (loopback hostnames only) as a CSRF defense and returns **HTTP 401** to the bridge's header-less `ws` clients — breaking `cdp_status` and all CDP introspection on the newest RN. A new `metroOrigin()` helper (`scripts/cdp-bridge/src/ws-origin.ts`) synthesizes a loopback `Origin` matching the dev-server port; it is now sent on all three Metro WebSocket clients (`cdp/connect.ts`, `cdp/multiplexer.ts`, `metro/events-client.ts`). Verified end-to-end: the handshake now succeeds against an RN 0.85 / SDK 56 app (proven: no-Origin → 401, loopback Origin → OPEN). (B177 / D1240)

## 0.47.1

### Patch Changes

- 6835fbf: #202 Phase 3: formalize the three-layer device-control contract (L1 introspection / L2 interaction / L3 flow) in the docs, and add a proactive, informational `FOREIGN_RUNNER_ACTIVE` warning. When `device_snapshot action=open` finds a foreign maestro automation session driving the simulator (UDID-scoped) and rn-dev-agent is not itself running a flow, the open result now carries `meta.foreignRunner` + a heads-up that interleaving `device_*` may trigger a re-foreground (CDP reads are unaffected). Opt out with `RN_IOS_FOREIGN_WARN=0`. The reactive recovery for an actual leak shipped earlier in #188; this is the complementary proactive signal.

## 0.47.0

### Minor Changes

- 6e8af52: #202 Phase 2a: a process-wide in-memory `DeviceSessionArbiter` now serializes the three device-control planes — `flow` (Maestro) is exclusive; `introspection` (CDP reads) and `interaction` (`device_*`) coexist. A read or tap issued while a Maestro flow is running refuses fast with `BUSY_FLOW_ACTIVE` instead of interleaving with it. The flow tools (`maestro_run`, `maestro_test_all`, `cdp_auto_login`) park the in-tree fast-runner for the flow's duration and mark CDP stale afterward so the next read reconnects. Diagnostics (`cdp_status`), connection management, and session-less tools stay unarbitrated and always work; a wedged arbiter (a leaked plane lease) is cleared via `cdp_status({ resetArbiter: true })`.
- 6e8af52: Phase 1 of device-control hardening (#202): `ensureSingleRunner()` now kills stale `AgentDeviceRunner` processes scoped to the target simulator and clears orphaned `~/.agent-device/daemon.{json,lock}` (default-on; opt out with `RN_DEVICE_KILL_LEGACY=0`). Fast-runner state is no longer reused across simulators. `maestro_run` auto-resolves `--app-file` for iOS `clearState` flows (#201).
- 6e8af52: #202 Phase 2b: `cdp_status` now auto-recovers the JS-thread-paused wedge. When the simulator's foreground is stolen and iOS suspends the app's JS thread (CDP wedged), `cdp_status` parks the fast-runner, re-foregrounds the target app (`simctl launch`, which resumes its JS thread), reconnects, and confirms recovery with a real CDP liveness probe — bounded to 3 consecutive attempts per session (reset on a successful recovery and on `device_snapshot action=open`). It skips when a Maestro flow is running (it would yank the app out from under the flow) and falls back to suggesting `cdp_restart(hardReset=true)`. This replaces the previous dead-end "Debugger is still paused" warning that left the agent to rediscover the fix over many attempts. iOS-only.

### Patch Changes

- 6e8af52: Fix a batch of bugs, regressions, and reliability issues surfaced by a multi-agent repo audit.

  **Security**

  - Redaction no longer leaks private-key material. `redactString` now applies secret patterns BEFORE truncating (a >2000-char PEM previously had its `-----END-----` marker severed by truncation so the key body passed through), and the PEM rule now matches multi-word labels like `RSA PRIVATE KEY` / `OPENSSH PRIVATE KEY` (the old single-word pattern never matched the most common headers).

  **Device interaction**

  - `device_scroll` no longer throws on Android (and on the iOS fast-runner fallback): a direction-form scroll is now converted to coordinates before dispatch, matching `device_swipe`.
  - `device_batch` scroll steps no longer crash the whole batch on either platform (same root cause).
  - A coordinate `device_swipe` with `--count`/`--pattern` but no `durationMs` no longer mis-parses the flag value as a 3 ms duration on iOS (the positional extractor now strips flag values, matching Android).
  - The Android runner is no longer reused across emulators: `shouldReuseAndroidRunner` checks the bound `deviceId` (parity with iOS `shouldReuseRunner`), so a runner bound to one emulator can't silently drive another.
  - A wedged-but-alive fast-runner is now reaped: `ensureFastRunner` probes tri-state liveness instead of PID-only, so a hung HTTP listener no longer makes every subsequent command burn the full timeout.
  - `ensureSingleRunner` is now awaited at session-open so the stale-runner kill completes before the first interaction, and its `ps` failure surfaces as a warning instead of a silent no-op.

  **Actions / Maestro**

  - Actions now auto-promote `experimental → active` on the first clean replay (the documented lifecycle was defined + tested but never wired).
  - The GH#186 route-drift guard is now active in production (`cdp_run_action` is wired with a CDP-backed live-route reader; it previously defaulted to a no-op).
  - `maestro_test_all` and the inline Maestro fallback no longer mark passing flows as failed when app/console output merely contains `Error:`, and both now auto-resolve `--app-file` for iOS `clearState` flows (previously only `maestro_run` did). `clearState` detection also recognises the standalone `- clearState` command.
  - All Maestro `execFile` calls raise `maxBuffer` to 10 MB so a large flow log can't kill the child and mask a passing run.
  - `cdp_repair_action` `RUNNER_LEAK` refusals are now bucketed as `SNAPSHOT_FAILED` in MTTR telemetry instead of `INTERNAL_ERROR`.
  - A bare-form `id:` repair now emits a quoted scalar, so a testID containing YAML-special characters can't corrupt the action.

  **Reliability / correctness**

  - `collect_logs` no longer double-shifts Android logcat timestamps by the host UTC offset (which corrupted both the time and the cross-source merge order).
  - CDP freshness/dev probes attach a no-op catch to the raced `evaluate()` promise so a mid-probe WebSocket close can't surface as an unhandledRejection.
  - The observability server keeps a small `headersTimeout` (slow-loris guard), broadcasts a `shutdown` event so the browser stops auto-reconnecting after stop, and `Recorder.clear()` notifies subscribers instead of orphaning live SSE streams.
  - Action IDs now accept dots (`v2.0-login`) per their documented contract while still rejecting `..`.
  - The post-edit health-check hook's "app not installed → skip" guard works again (`grep -c || echo "0"` produced a two-line `0\n0`).
  - `learned-actions` resolves the project memory dir correctly for paths containing a dot, and its `${VAR}` extractor accepts digit-bearing keys.
  - The injected-helpers version is a single source of truth (the post-injection log no longer reports a stale `v11`).
  - `sync-versions.sh` drops a dead, misleading variable and documents that `rn-dev-agent-cdp` is independently versioned.

  Hardened the previously flaky `proof_step` unit tests (they depended on a machine-global session file) with a dependency-injection seam, making the suite deterministic.

- 6e8af52: #202 Phase 1.5: iOS `device_snapshot action=open` now takes a persisted, UDID-scoped simulator-ownership lock — closing the multi-bridge race where two Claude Code windows (two bridge processes) could drive the same simulator. The second bridge gets a `DEVICE_BUSY` error. The lock self-heals via PID-liveness + a 30s heartbeat (reclaimable once the holder PID is dead or its heartbeat is >90s stale), so it cannot orphan like the legacy `daemon.lock`; on an fs error it fails open (logged) rather than blocking a session.

## 0.46.0

### Minor Changes

- 3beb8e5: Replace the Experience Engine with a repo-local troubleshooting memory.

  `/rn-agent-compact`, `/rn-agent-health`, `/rn-agent-export`, and `/rn-agent-import`
  are removed (GH #200: compaction had no runnable entry point and the read path was
  vestigial). In their place, rn-dev-agent now maintains a gitignored
  `.rn-agent/local/troubleshooting.md` per repo: failures are captured by a hook,
  the agent synthesizes them into the doc at session end, and the doc is injected at
  session start so the agent learns this repo's config and gotchas.

## 0.45.0

### Minor Changes

- 5c4ca04: Add the read-only observability UI (D1226 "watch the agent live"): an in-process recorder + opt-in SSE server serving a React SPA (timeline | device | state). New `observe` MCP tool + `/rn-dev-agent:observe` slash command. Deep-redacted (args + payload, fail-closed), localhost-only with Host-header + Sec-Fetch-Site guards.

### Patch Changes

- c4804dc: Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
  Client picker dismissal after Android deep links (#136 sub-3). Routed through a
  single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
  actionable manual-select message instead of touching the legacy agent-device
  path. Cross-platform iOS support tracked as a follow-up.
- 2c82b18: Fix iOS runner auto-install and stop force-installing agent-device on iOS-only setups.

  - **rn-fast-runner now self-builds on first use.** `startFastRunner()` falls back to a full `xcodebuild test` (build + test) when no prebuilt `.xctestrun` exists, instead of always using `test-without-building` (which failed on a fresh machine where `build/DerivedData` is gitignored and never produced). The first `device_snapshot action=open` on a clean clone now succeeds — it just cold-builds the rig once (ready-signal timeout widened to 360s for that path). Steady-state spawns still use the fast `test-without-building`.
  - **agent-device install is gated on a live Android target.** The SessionStart hook (`detect-rn-project.sh`) no longer runs `npm install -g agent-device` unconditionally. Since D1219/PR #164 iOS device control is owned by the in-tree rn-fast-runner, so agent-device is Android-only; the install now only runs when `adb devices` shows a booted device/emulator. iOS-only macOS users stop paying for a dependency they never use.
  - `/setup` and `/doctor` now offer to run the one-time `xcodebuild build-for-testing` pre-build to move the cold-build cost out of the first interaction (the lazy fallback covers correctness; pre-building just avoids the slow first call).

## 0.44.45

### Patch Changes

- Deliver the GH #186 maestro-interop fixes that merged in #188 without a version bump (closes #189).

  - `cdp_run_action` now allows `runFlow` (including `when:` conditionals and `{file}` sub-flows) through the Maestro command allowlist, so actions with conditional dialog-handling (Expo dev-server picker, iOS "Open in" dialog) replay through the canonical runner instead of hard-failing with `Command not in allowlist: runFlow (Phase 134.1)`.
  - Non-destructive runner-leak `reacquire` recovery tier + cross-tool CDP re-pin, avoiding the ~44s relaunch / ~47s STALE_TARGET when maestro-mcp and rn-dev-agent contend for the same iOS device.
  - Structural route-drift detection: a stale-selector failure on an inserted screen is classified `ROUTE_DRIFT` instead of triggering a wasted fuzzy-repair.

  #188 shipped these to `main` with no version bump, leaving them undeliverable to marketplace installs; this patch publishes them.
