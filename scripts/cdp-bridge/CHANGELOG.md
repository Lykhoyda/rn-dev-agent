# rn-dev-agent-cdp

## 0.55.0

### Minor Changes

- 683a132: Story 04 (#385): shared two-tier settle engine. Every mutating device\_\* verb now waits for the UI to actually stabilize instead of relying on fixed sleeps: Android gates on a new `isWindowUpdating` runner probe (capability `WINDOW_UPDATE`) then falls back to snapshot-hash equality polling; iOS polls a new on-runner `isScreenStatic` SHA-256 screenshot compare (capability `SCREEN_STATIC`, Maestro's 3s screen-settle budget) with the same snapshot-hash fallback. Results surface `meta.settle: {method, settled}` + `meta.timings_ms.settle`. `device_fill` drops its fixed 150ms focus delay when settle ran and pins its target coordinates once up front (`--at-x/--at-y`) so the settle's ref-map refresh can never retarget the fill mid-call; its corrective retypes skip settle (their stability check is the CDP read-back). `device_batch` settles between steps by default at a batch-scoped 2500ms budget (per-step `settle: false` escape hatch) and its blanket 300ms inter-step delay defaults to 0 while settle is on. Legacy runner artifacts (no new capabilities) transparently degrade to snapshot polling — no rebuild required, the new verbs are deliberately NOT in the required-command gate. Opt out globally with `RN_SETTLE=0` or per batch step with `settle: false`; tune the per-call budget with `settleTimeoutMs` (a budget knob, not a disable switch). A perpetually-animating screen settles via hierarchy stability or returns `method: 'timeout'` at budget — bounded, never hanging.

## 0.54.1

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

## 0.54.0

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

## 0.53.0

### Minor Changes

- d5acd6b: Observe web UI overhaul: session header (connection, app, route, duration, call/error stats),
  filterable + searchable timeline with follow/pause autoscroll, device-screenshot hero pane with
  route chip, guided empty states, inline param inputs for learned actions (server now honors
  UI-provided params), expandable action output, and E2E run-history drill-down with per-flow
  error excerpts. The SPA is split from one 670-line file into focused modules.

## 0.52.0

### Minor Changes

- d12f18f: feat(rn-fast-runner): quiescence bypass — make XCTest's private quiescence wait a no-op inside the iOS runner (#384, Story 03). RN apps with Reanimated worklets/looping animations never report idle, so XCTest queries and snapshots stalled until per-symptom patches (runner-timeout shim, HID-synthesis scroll, 35s budgets) caught them; the bypass removes the idle-wait at the root — the same WebDriverAgent-lineage approach Maestro uses. Probes both private selector variants (`waitForQuiescenceIncludingAnimationsIdle:` and the Xcode-16 `:isPreEvent:` form), swizzles exactly one (classic preferred), and degrades loudly (`RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE`) when Apple drifts the API — the runner keeps working without the bypass. Default ON; opt out with `RN_QUIESCENCE_BYPASS=0` (resolved at runner spawn; threaded as `TEST_RUNNER_RN_QUIESCENCE_BYPASS` because xcodebuild only forwards `TEST_RUNNER_`-prefixed vars). Note: `XCUIElement.typeText` runs its own internal sync, so the type-timeout shim remains as a safety net. Auditable via `meta.quiescenceBypass` on the first command after boot, `QUIESCENCE_BYPASS` in `/health.capabilities`, and `cdp_status.deviceSession.runnerCapabilities`.
- 0cfa78a: The observe web UI now autostarts when the MCP worker boots in an RN project, listening on a
  stable default port (7333, `http://127.0.0.1:7333`) with an ephemeral fallback on collision.
  New `.rn-agent/config.json` block `{ "observe": { "autoStart": boolean, "port": number } }`
  plus `RN_AGENT_OBSERVE_AUTOSTART` env override (precedence env > config > default, matching
  `cdp.autoConnect`). The `observe` tool gains a `restart` action; `stop` is session-scoped.
  The live URL is recorded in a per-project state file and announced at SessionStart.

## 0.51.1

### Patch Changes

- 3cf6787: fix(device_batch): testID steps failed with a misleading STALE_REF on the in-tree runners (#396). `findRefByTestID` passed the envelope's ref through verbatim; the in-tree iOS/Android runners emit `@`-prefixed refs (`@e68`), so the testID branches of `device_batch` (find+tap / press / fill) composed `@@e68`, which missed the ref-map (`lookupRef` strips exactly one `@`) and surfaced as `Element at ref @@e68 no longer hittable — UI re-rendered since snapshot` even though the snapshot was taken fresh that same step. `findRefByTestID` now returns the canonical bare id in both the flat-nodes and nested-tree envelope shapes, restoring the documented "re-resolve at execution time" contract; the GH #114 producer-consumer contract tests are updated to pin the bare-id contract for the in-tree producers.

## 0.51.0

### Minor Changes

- 694a57d: feat(protocol): version the native runner /command wire protocol + move runner state out of /tmp (#383). Both runners' `GET /health` now reports `{protocolVersion, runnerVersion, capabilities}` and every response carries a `"v"` stamp; the bridge classifies a reachable runner with a missing/older/newer protocol or a skewed `runnerVersion` as stale and transparently reaps + reinstalls it (the first device tool call after upgrading from a pre-protocol plugin pays one runner restart — `meta.note: "runner upgraded (protocol/version mismatch)"`). Only a mismatch that survives reinstall surfaces the new typed error `RUNNER_PROTOCOL_MISMATCH` with exact rebuild commands. Runner state files move from fixed shared `/tmp` paths to per-device hardened files (0600, symlink-refusing, atomic) under the app-support state dir (`runner-state/ios-<udid>.json`, `android-<serial>.json`; Android persists only under a resolved serial) via a shared `util/secure-state-file.ts` also adopted by the session file; a live pre-upgrade runner pointed at by the legacy `/tmp` state is adopted once, reaped, and relaunched before the `/tmp` files are deleted, and a grep-enforced test keeps `/tmp` out of the runner clients. `cdp_status` → `deviceSession.runnerProtocol` surfaces the handshake.

## 0.50.4

### Patch Changes

- b1e0ad6: feat(keyboard-guard): in-runner keyboard-occlusion guard for live `device_press`/`device_longpress` taps on iOS + Android (#370). Before a guarded tap, the runner probes for a visible software keyboard whose frame contains the tap point (containment on a sane rect — non-empty, min height 120pt iOS / 150px Android, so accessory bars don't false-trigger) and auto-dismisses first when occluded. Android dismissal is `pressBack` + a bounded `waitForIdle(1500)` (≈3.6s measured incl. bounded idle), gated on a TYPE_INPUT_METHOD window with sane bounds so it never navigates back otherwise — requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS`, now enabled at dispatcher init. iOS is verify-or-refuse: only the safe dismiss-control tap ("Hide keyboard"/"Dismiss keyboard"/"Done") is used, then re-verified; on iPhone standard QWERTY, which has no such control, the runner REFUSES the tap with `KEYBOARD_OCCLUDED … keyboardGuard=dismiss_failed` instead of tapping the keyboard, because XCTest's `swipeDown` on the keyboard triggers QuickPath slide-typing and corrupts the focused field (device-proven). Every guarded gesture returns `meta.keyboardGuard`: `"off" | "no_keyboard" | "not_occluded" | "dismissed"` (plus `dismiss_failed` inside the iOS refusal error). Opt out with `RN_KEYBOARD_GUARD=0`/`false`, resolved TS-side per command (`guardKeyboard` on the wire; absent → guard stays ON, so older clients keep guarding). Scope is command-handler tap/longPress only — `tapSeries`, by-text taps, element-center taps, the focus-tap inside type/fill, swipes/scrolls/drags, and `doubleTap` are explicitly unguarded. Follow-up #379 tracks a JS-first (`Keyboard.dismiss()`) auto-heal for the iOS refusal case; #378 tracks a pre-existing Android `foreground()` pre-flight stall surfaced (not fixed) during verification.

## 0.50.3

### Patch Changes

- a6112e6: fix(record): `device_record stop` no longer crashes on macOS with `adb_args[@]: unbound variable` (#374). In `record_proof.sh` the Android stop branch expanded an empty `adb_args` array unguarded (`"${adb_args[@]}"`); under `set -euo pipefail` on bash 3.2 (the macOS default `/bin/bash`) that is an unbound-variable error, aborting the stop before the pull/convert — so recording finalize (and, via a leftover Android `.pid`, even iOS stops) failed. All three expansions now use the `+`-default guard already present elsewhere in the file. Regression-guarded by a static invariant test (effective on bash 5.x CI) plus a behavioral reproduction gated to bash < 4.4.

## 0.50.2

### Patch Changes

- 0a9a732: fix(interact): cdp_interact no longer corrupts react-hook-form Controller-wrapped inputs (#336). `setFieldValue` keeps a string a string for string-typed fields (a digit-string injected as a number is coerced back to string only when the field currently holds a string — number/boolean fields are untouched). `press` gains an optional `value`: when provided, `onPress` receives the value instead of a synthetic event, so radio/chip-style controls whose onPress sets a form value select correctly. HELPERS_VERSION bumped to 33.

## 0.50.1

### Patch Changes

- d61985f: fix(actions): inject `- hideKeyboard` before button taps that follow text entry when generating/saving Maestro action flows, and route Android hideKeyboard replays to the official Maestro CLI (#356, Phase 1). Bottom-pinned taps (submit/continue) previously landed on the soft keyboard during replays — the single biggest source of flaky replays. `generateMaestro` now tracks soft-keyboard state and emits a `hideKeyboard` step before a `tap`/`long_press` that follows an `inputText`, reset on navigation. `hideKeyboard` is a no-op when no keyboard is showing and Maestro re-resolves the selector after dismiss, so the injection is safe. Device verification surfaced that maestro-runner v1.0.9 silently no-ops `hideKeyboard` on Android (B223), so `maestro_run` now prefers the official Maestro CLI for Android flows containing `hideKeyboard` (verified to dismiss the keyboard on-device), warning when the CLI is unavailable; iOS is unaffected (maestro-runner honors hideKeyboard there). Live `device_*` taps (the in-runner guard) and existing-corpus backfill are deferred to later phases.

## 0.50.0

### Minor Changes

- 98d3fb7: Add an RNTL-style discovery resolver to the injected helpers. `resolveLadder` finds elements by `byRole(+name)` / `byText` / `byPlaceholder` — ported from React Native Testing Library (matcher + normalizer, accessible-name, role, hidden, host-kind) — with fail-closed truncation and fail-closed multiplicity (never silently picks the wrong element), hidden-element exclusion by default, and a selector bundle (`testID` / `text` / `accessibleName` / `role` / `placeholder` / `anchors`). `interact()` routes `role`/`name`/`text`/`placeholder` selectors through the ladder. Includes RNTL `matchDeepestOnly` so a composite+host fiber pair (e.g. `Text`+`RCTText`) resolves to a single on-device element instead of fail-closing as ambiguous.

## 0.49.0

### Minor Changes

- 5fe66c9: Action corpus run/repair history now persists in a derived, gitignored node:sqlite store (.rn-agent/state/actions.db) alongside the per-action JSON sidecars (Phase 1 dual-write: sidecars stay authoritative, the DB is a rebuildable mirror), with graceful degradation to sidecar-only when node:sqlite is unavailable. The worker enables node:sqlite via a version-gated --experimental-sqlite flag (Node 22.5–23.5); the engines floor stays >=22. cdp_status now reports the active backend as `actionStore`. The learned-actions inventory script is migrated from JavaScript to TypeScript (compiled to dist/).

## 0.48.0

### Minor Changes

- d3be838: #317 Phase 2: when an action fails on iOS 26.x because WebDriverAgent is blind (empty accessibility tree), `cdp_run_action` now replays the action's id-based steps through the CDP/JS transport and returns a real pass/fail verdict — restoring action replay (and the observe Regression Run button) on iOS 26.x. The fallback fires on both observed blind failure modes — `SELECTOR_NOT_FOUND` (probe = the failed selector) and `UNKNOWN`/WDA-died-at-launch (probe = the action's first testID) — guarded by an exact-match CDP-tree oracle so genuine drift still routes to repair. Fallback verdicts are labeled `transport:'cdp-js'` (handler-level semantics) and failed replays record `failureCode:'TRANSPORT_BLIND'`; unsupported step types (e.g. text-based selectors) fail loudly rather than passing silently.

## 0.47.2

### Patch Changes

- 8cf8d4e: Fix the observe Regression tab's per-action **Run** button doing nothing. The observe `runAction` wiring resolved the correct project root for `loadAction` but then called the inner `runActionHandler` (`cdp_run_action`) without passing `projectRoot`, so the runner re-derived it from `process.cwd()` (the plugin repo) and failed instantly with `NO_PROJECT_ROOT` before ever reaching the device. The resolved root is now threaded into `runActionHandler`, so a clicked action runs its Maestro flow on the connected app's project. (Follow-up to #348, which fixed the same root-resolution family for the actions list and suite.)

## 0.47.1

### Patch Changes

- 6dc02a8: Fix the observe Regression tab showing an empty actions list and "Run E2E Suite" always reporting PASS. The observe e2e surface now resolves the project root of the _connected_ app by its bundleId (`findProjectRoot({ bundleId })`), so a stray sibling React Native repo can no longer hijack the heuristic filesystem scan and point the actions list / locked-test discovery at the wrong project. A suite that discovers zero locked tests now reports a distinct `empty` verdict ("NO TESTS") instead of a false-green pass.

## 0.47.0

### Minor Changes

- 33db4be: feat(e2e): Actions panel in the observe page — list the project's actions and run any one (repairable `cdp_run_action`) with params resolved from `.rn-agent/e2e.config.json`, via `GET /api/e2e/actions` + `POST /api/e2e/actions/run`.
- 042280b: feat(e2e): params source — `.rn-agent/e2e.config.json` supplies per-test param values (with shared `defaults` + secret redaction) so parameterized actions can be locked and run as e2e tests. `cdp_lock_e2e_test` now accepts a param-needing action when the config covers all its params (else `MISSING_PARAMS` listing the gaps); `cdp_run_e2e_suite` runs param tests with their resolved values (else skips with a clear reason). Secret param values (names in `secretParams`) are redacted to `***` in failure output and run records, and only an action's declared params are passed to Maestro (unrelated defaults never leak).
- 33db4be: feat(e2e): observe Regression page + CSRF-guarded control endpoint — a top-level Live|Regression toggle with a Run button, live progress, verdict badge, per-test table, and run history, backed by `POST /api/e2e/run` + `GET /api/e2e/runs[/:id]` (host + Sec-Fetch + CSRF + method/content-type guarded; one flow lease).

## 0.46.0

### Minor Changes

- 8f0b7ff: feat(e2e): regression runner engine — `cdp_lock_e2e_test` promotes a verified (param-free) action into a frozen, executable locked e2e test, and `cdp_run_e2e_suite` runs all locked tests strict (no auto-repair) on the booted sim, persisting a suite-run report with verdict, per-test classification (regression vs infra, params skipped), and a newly-failing-since-last-green diff. Engine only; observe page + CSRF HTTP trigger land in a follow-up.

## 0.45.8

### Patch Changes

- 7731024: chore: adopt oxlint + oxfmt as the lint/format layer, format the codebase (code only — prose docs excluded), and add a blocking CI lint-format gate.

## 0.45.7

### Patch Changes

- 8305bbd: `maestro_run` now returns structured per-step results and partial progress on timeout (GH #211).

  The result gains `steps[]` (`{index,name,verb,status,durationMs}`), `failedStep`, `reason` (sanitized `{kind,selector}` — never the raw runner log), `lastStep` (progress marker), `timedOut`, and `outputTruncated`. On timeout the partial steps are returned instead of a bare failure, and the failure headline names the failing/last step. Parsed from maestro-runner stdout (the JVM Maestro CLI fallback degrades fail-open to empty steps); `tapOn` latencies for #263 now derive from the shared parser. Additive — `output` is preserved for `run-action` consumers.

## 0.45.6

### Patch Changes

- 16f0a0d: `maestro_run` now flags a wedged simulator runtime (GH #263).

  When a flow fails AND the median latency of its successful `tapOn` steps exceeds a floor (default 1500ms, `RN_RUNTIME_DEGRADED_FLOOR_MS`), the result gains a `RUNTIME_DEGRADED` hint and `meta.runtimeDegraded` — "the simulator test runtime is likely wedged; reboot it (xcrun simctl shutdown/boot), relaunch, and retry." This replaces the misleading "Element not found" that previously sent the agent chasing app code when the real cause was a degraded simulator (taps reported success but `onPress` never fired). Detection is purely additive — it never changes a pass/fail verdict, never fires on a passing run, and only counts successful taps (a failed tap's duration is the step timeout, which would otherwise false-positive an ordinary element-not-found failure). Fail-open: unparseable output → no hint.

## 0.45.5

### Patch Changes

- 6c77108: `/observe` device panels now refresh live (GH #206).

  The observability layer was a passive recorder of tool observations — the screenshot only updated on `device_screenshot` calls and the route only on navigation-family tools, so driving the app with `cdp_interact`/`cdp_navigate` left both panels stale. A fire-and-forget hook now captures a fresh screenshot (simctl/adb, OS-level) + route (CDP nav-state) after each state-mutating tool and delivers them via a dedicated live SSE channel (`{type:'live'}` + `/api/live-screenshot`), so the timeline stays clean. Platform resolves from the active device session or the connected CDP target (so a purely CDP-driven flow with no agent-device session still refreshes). Gated on a connected `/observe` tab, skipped during Maestro flows, single-flight trailing-coalesce, opt-out with `RN_OBSERVE_LIVE=0`.

## 0.45.4

### Patch Changes

- 64531c8: Bump esbuild to 0.28.1 across the build toolchains to clear the HIGH Dependabot advisory (GHSA-gv7w-rqvm-qjhr).

  The advisory is in esbuild's Deno installer (binary-integrity RCE via `NPM_CONFIG_REGISTRY`) — a code path this repo never executes (esbuild is consumed as an npm transitive dep via Vite/Astro, not Deno), so it was never exploitable here. Still, both the observability web UI (`scripts/cdp-bridge/src/observability/web/`) and the docs site carried the vulnerable transitive esbuild, so both now pin it to the patched 0.28.1 via an npm `overrides`. The observability Vite build also sets `build.target: 'esnext'` (it's an internal localhost-only dev tool viewed in a modern browser) to sidestep an esbuild 0.28 regression that refused to downlevel destructuring to Vite's default old-browser baseline; the single-file bundle was rebuilt. `npm audit` is clean in both subtrees.

## 0.45.3

### Patch Changes

- a88d139: `cdp_network_log` no longer returns two entries per request (GH #214).

  Root cause: setup sends `Network.enable` (mode `cdp`), then `probeNetworkDomain` fires a probe fetch and watches the buffer. On RN ≥ 0.83 the CDP Network domain _does_ deliver events, but when they don't flush within the probe window — a false negative documented after platform switches / reloads (GH #59 #9) — the probe returns `none` and setup injects the fetch/XHR hook **without disabling the still-enabled Network domain**. Both paths then capture every request (CDP numeric-id entries + hook UUID-id entries), and the existing exact-id dedup can't collapse them because the two id schemes never collide.

  Fix: when setup falls back to the hook, it now disables the CDP Network domain first, so the hook is the single capture source. This also makes `cdp_status`'s `networkDomain: false` truthful instead of a label over a still-running domain — the "capability flag out of sync" symptom in the report was the same root cause. Read-time fuzzy dedup was deliberately rejected: it would collapse legitimately-identical rapid requests (a real double-mutation) and hide bugs — the opposite of what the reporter needed.

## 0.45.2

### Patch Changes

- 0386204: `cdp_mmkv` delete and boolean reads now work on the Nitro react-native-mmkv line (GH #209).

  - `delete` was calling `mmkv.delete(key)` — a JS-wrapper-class method that doesn't exist on the raw Nitro hybrid object the tool actually talks to (`createHybridObject('MMKVFactory').createMMKV(...)`), whose spec exposes `remove(key)`. The generated expression now prefers `remove()`, falls back to `delete()` for wrapper-shaped objects, and reports a named error (instead of a bare TypeError) when neither exists. This unblocks first-class auth/storage resets for logged-out replays on iOS — previously a raw `cdp_evaluate` escape hatch every time.
  - `get` with `type: 'boolean'` emitted `mmkv.getBool(key)`, which exists on no MMKV surface (hybrid object and wrapper both spell it `getBoolean`) — broken since the tool shipped. Now fixed.
  - The follow-up enhancement from the issue (a `clearKeys:` action-YAML directive for self-contained auth-gated replays) is tracked as GH #286.

## 0.45.1

### Patch Changes

- bd5d585: Recovery paths now detect "app not installed" and resolve their relaunch target truthfully (GH #262, absorbs #194 BUG 2).

  - `cdp_status` APP_DETACHED auto-relaunch: when `simctl launch` fails AND `get_app_container`'s stderr carries the `NSPOSIXErrorDomain code=2` marker (allowlist-only, stderr-only — argv-spoof-proof), the tool returns a distinct `APP_NOT_INSTALLED` code with install advice — including a shell-quoted `simctl install` line for the newest matching `.app` snapshot from the last clearState (GH #201 dir, mtime-sorted budgeted scan). Ambiguous probe verdicts fail open to the existing `APP_DETACHED` behavior. Concurrent recoveries are serialized, and a confirmed missing bundle is cached (with a cheap re-probe) so the diagnosis is never masked by `budget-exhausted`.
  - `cdp_restart hardReset=true`: the relaunch target resolves through `explicit arg > connectedTarget > cache > active-session appId > strict per-platform app.json` (no iOS←Android fallback), simctl targets the active session's UDID when one exists, failed launches are classified the same way in `hardResetSteps`, and a successful hard reset resets the detached-recovery budget.

- 81c386a: `device_screenshot` no longer blames "device transitioning state" when the target directory doesn't exist (GH #265).

  - `captureAndResizeScreenshot` now `mkdir -p`'s the parent of the derived output path before any dispatch tier runs (simctl raw, rn-fast-runner, agent-device daemon/CLI, adb stream) — new directories are the expected case, since the tool's own advisories steer agents toward fresh `docs/proof/<slug>/` paths. The fix covers `device_screenshot`, `device_batch` auto-captures, and `proof_step`, all of which funnel through the same helper.
  - When the directory itself cannot be created (e.g. a file blocks an intermediate path segment), the tool short-circuits before probing any device and returns an honest `SCREENSHOT_FAILED` with `reason: 'target-dir-unavailable'` naming the offending path — never the device-state guess.
  - A leading `~/` in the screenshot path is now expanded to the real home directory (Node never expands `~`, so mkdir would otherwise create a literal `./~/` under the bridge cwd and report success into the wrong location). Unexpandable forms (`~user/...`, bare `~`) are refused with an actionable error.

## 0.45.0

### Minor Changes

- eff45cd: #202 Phase 6 / #186 — foreign Maestro sessions become arbiter refusals; plugin maestro_run is the canonical surface.

  While a foreign Maestro/XCUITest session drives the target simulator (UDID-scoped detection, 5 s TTL, fail-open), local `device_*` and flow tools refuse fast with `BUSY_FOREIGN_FLOW` (~50 ms measured) — pointing at the safe L1 reads — instead of colliding into the ~44 s runner-leak cascade. L1 introspection stays free; `device_screenshot` serves pixels via its simctl fallback; a ~10 s teardown grace after the plugin's own flows prevents self-false-positives while WDA dies. The two historical reasons to leave the plugin surface are live-gate-verified closed and #201 is closed — including a new fix: the clearState `--app-file` resolution is snapshotted outside the device container (the installed-container path used to be deleted by clearState itself before the reinstall could read it). `RN_IOS_FOREIGN_GUARD=0` disables both the warning and the refusal (`RN_IOS_FOREIGN_WARN=0` remains a deprecated alias). The foreign-runner `ps` scan now uses `-ww` (command-column truncation could silently drop the UDID → false negatives).

## 0.44.0

### Minor Changes

- c05c058: #202 Phase 5 / #264 — the bridge now survives Metro restarts (supervisor split).

  The MCP entry point is now `dist/supervisor.js`: a thin stdio shim holding zero network sockets (immune to `lsof -ti tcp:8081 | xargs kill -9`, which used to SIGKILL the whole server and cost the session all 77 tools). It spawns the real bridge as a worker, and on worker death: errors in-flight calls with `-32000` ("retry the call"), respawns it (max 3 per rolling 60 s, then a terminal crash-loop error), and replays the cached MCP `initialize` handshake so the session continues seamlessly. Visibility: `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Opt out with `RN_BRIDGE_SUPERVISOR=0` (legacy single process). `SIGUSR2` now performs a real hot-reload (worker restart + handshake replay).

## 0.43.0

### Minor Changes

- abe4411: Expose `params` in the `maestro_run` and `cdp_run_action` MCP tool schemas.

  Both handlers have accepted `params` since GH #116 (forwarded to maestro as `-e KEY=VALUE` on the first attempt AND the post-repair retry), but the zod registrations omitted the field — and zod strips unknown keys by default, so a caller's parameter bindings were **silently dropped** at the tool-call layer and a parameterised action failed at runtime with unset `${VAR}` placeholders. Found by Codex review on PR #272 (the new `creating-actions` skill recommends `cdp_run_action({ actionId, params, trigger })`, which was un-callable as advertised; `commands/run-action.md` documented the same call shape). Key-format validation (`/^[A-Z_][A-Z0-9_]*$/`) stays in the handler. Wiring test pins both registrations.

## 0.42.0

### Minor Changes

- 73c6bf4: #202 Phase 4 — eradicate legacy runner apps, not just processes.

  At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Scanned at every device-open (one `simctl listapps`, ~150–350 ms measured — no memo, so a reinstall by another session is always caught); error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.

## 0.41.0

### Minor Changes

- 58c4886: Debugger-seat coexistence with React Native DevTools + silent hook-mode network capture.

  - New opt-out for background auto-reconnect: `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` `{ "cdp": { "autoConnect": false } }`. In passive mode the bridge yields the single RN debugger seat to the visual DevTools and reconnects only on explicit tool calls. Resolved mode is visible in `cdp_status` → `autoConnect` and `/doctor`.
  - Hook-mode network capture (RN < 0.83 fallback) no longer transports entries via `console.log("__RN_NET__:…")` — entries go to an in-app ring buffer drained on demand, so Metro logs and the user's DevTools console stay clean.

## 0.40.5

### Patch Changes

- 6190178: fix(#253): `cdp_repair_action` no longer hardcodes `targetPlatform='ios'` — Android auto-repair works against an emulator. The repair orchestrator now derives the platform from the active device session via `detectPlatform()` (booted-device probe fallback when no session is open; `'ios'` only as the final no-session, no-device fallback). Previously an Android repair foregrounded the app via `xcrun simctl`, snapshotted through the iOS short-circuit, and bootstrapped the iOS fast-runner — so Android selector drift always escalated as a hard failure instead of self-healing.

## 0.40.4

### Patch Changes

- e5404ed: fix(#249): Maestro pass detection no longer flips passing flows to failed when app logs contain the substring `FAILED`. The exit-0 secondary guard in `maestro_run`, `maestro_test_all`, and the inline maestro fallback used a bare `output.includes('FAILED')` over combined stdout+stderr — app/console output like a `FETCH_FAILED` Redux action or a `LOGIN_FAILED` analytics event marked a genuinely passing flow as failed and triggered pointless auto-repair. All three call sites now share `outputIndicatesFlowFailure`, which keys on Maestro's own terminal status lines (`Test FAILED` / `Flow FAILED` / a `[FAILED]` step marker / a bare `FAILED` line) instead of a substring.
- 070586d: fix(#250): `cdp_interact` no longer reports success when the app's own handler throws. The injected interact dispatch caught handler exceptions (`onPress`/`onChangeText`/`setValue` raising — unmounted component, missing context, thrown validation) and returned `success: true, action_executed: true`, which the tool layer surfaced as a non-error warning — so agents proceeded against a screen that may be in an error state. The helper now reports `success: false` (keeping `action_executed: true` to distinguish "dispatched but handler threw" from "couldn't dispatch"), and the tool layer maps it to a structured error with `meta.actionExecuted`, `meta.handlerError`, and a check-`cdp_error_log` hint. HELPERS_VERSION bumped to 25 so connected sessions re-inject.
- 8269476: fix(#251,#252): startup hardening. The project single-instance lock (`Lockfile.acquire`) now uses the same atomic `openSync('wx')` exclusive-create pattern as `DeviceLock` — the previous read-then-write let two bridges starting in the same instant both "acquire" the lock, with the second silently truncating the first; the loser now gets a structured conflict, stale-holder reclaim narrows the steal window with a re-read before unlink, and fs infra errors fail open (`degraded: true`) instead of crashing the bridge at boot. Separately, SessionStart is now bounded: the hook declares an explicit 120s timeout and the maestro-runner installer's `curl | bash` carries `--connect-timeout 10 --max-time 90`, so a stalled CDN can no longer block session start indefinitely; a CI guard (`session-start-bounded.test.sh`) pins both.

## 0.40.3

### Patch Changes

- 609c825: fix(B191,B192): post-flow lifecycle hardening follow-ups to #243/#244. `isAndroidConnectionFailure` now also classifies `startAndroidRunner`'s startup-failure shapes (`exited before readiness`, `Failed to spawn Android runner instrumentation`) into the structured retryable `RN_ANDROID_RUNNER_DOWN` instead of letting a startup crash escape as a raw exception. And `isBenignSessionGoneError` no longer runs its session-gone regex over unparseable (non-JSON) close payloads — with no error field to scope the match to, they surface unchanged, so a real close failure whose raw text merely mentions "no active session" can't be silently swallowed.

## 0.40.2

### Patch Changes

- c9d447d: fix(#243,#244): Android post-flow lifecycle. `rn-android-runner` readiness is now gated on its own `GET /health` instead of the `adb logcat` ring buffer — a prior runner's stale ready line (same tag + fixed port) used to fire readiness before the new socket bound, so the first `device_*` after a Maestro flow returned a bare `fetch failed`. When the runner genuinely can't come up, `runAndroid` now surfaces a structured `RN_ANDROID_RUNNER_DOWN` with a retry hint. Separately, `device_snapshot action=close` now tolerates an underlying session that a flow already tore down (the #237 slot-release): it cleans up local state and returns ok, so `open → flow → close` round-trips cleanly instead of erroring `SESSION_NOT_FOUND`.

## 0.40.1

### Patch Changes

- 51976e8: fix(#237): Android instrumentation-slot handoff — `runFlowParked` now releases the single Android `UiAutomation` slot before a Maestro flow (`maestro_run`/`maestro_test_all`/`cdp_auto_login`), fixing `UIAutomator2 server not ready after 30s`. It stops the in-tree `rn-android-runner`, `am force-stop`s our two instrumentation packages (the decisive device-side release), and — gated by `RN_DEVICE_KILL_LEGACY` — kills a stale legacy `agent-device` daemon by its specific PID (never `pkill`, guarded against our own process tree so the MCP server is never collateral). Best-effort and idempotent; iOS behavior is unchanged.

## 0.40.0

### Minor Changes

- de6a8d8: fix(#191): JS-first text entry — `device_fill` now prefers the deterministic React `onChangeText` path when CDP is connected and the ref resolves to a testID (via its cached snapshot identifier), settle-polls the field value to verify it (defeating the debounced-`onChangeText` read race), and on the native fallback runs a bounded clear+retype (real `clearFirst` + per-character delay) when the value is corrupted, escalating to a verified maestro fallback before erroring. Adds best-effort iOS predictive-keyboard suppression at session-open and a new `TEXT_ENTRY_UNVERIFIED` error code for the exhausted-and-still-corrupted case. Additive `meta` only (`textEntryPath`, `verify`, `timings_ms`); no breaking change for existing callers. NOTE: `device_batch` fills are not yet JS-first (they call the runner directly) — tracked as a follow-up.

## 0.39.4

### Patch Changes

- 72d17b5: Fix #210: iOS device-session visibility + self-healing. `cdp_status` now reports `deviceSession: { sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', appId?, deviceId?, foreignRunner? }` so the agent can see the XCUITest runner state before calling `device_*` (iOS-gated — Android leaves `rnFastRunner:'dead'` and skips the probe/scan). `device_find/press/fill` now auto-spawn the runner from the dispatch choke point when a session or booted simulator exists and the rig is prebuilt — cold-build-safe: a missing prebuilt rig returns an actionable `RN_FAST_RUNNER_DOWN` error naming `device_snapshot action=open` instead of a silent multi-minute `xcodebuild`. `device_screenshot` now falls back to `xcrun simctl io screenshot` (or `adb`) whenever the runner can't serve it — including while a Maestro flow owns the device — so it never hard-fails on iOS. Also fixes a latent bug where an omitted-platform `device_snapshot action=open` stored `platform: undefined`, skipping the iOS dispatch branch.

  Reframes the issue's "ride Maestro's WDA" suggestion (rejected: WDA is per-flow/ephemeral with no session to ride, and a WDA client would add a second XCUITest backend rather than unify; mid-flow pixels use simctl, mid-flow state uses CDP introspection). (GH #210, B186, D1249)

## 0.39.3

### Patch Changes

- 75a9573: Fix #182: the CDP MCP no longer fails with `-32000: Connection closed` when an orphaned bridge from a dead Claude Code session holds the single-instance lock.

  Root cause: when CC dies abnormally (SIGKILL/crash/window-close on macOS) without closing the child's stdin or signaling it, the bridge becomes a **live orphan** — still running, still holding the project lock. The existing reclaim (PID-dead / mtime>24h / process-name) can't recover a _live_ owner, so the next session hard-failed for up to 24h. Four composing fixes:

  - **Parent-death self-exit (prevent).** A `getppid()` poll (`lifecycle/parent-watch.ts`) captures the bridge's PPID at startup and self-exits (releasing the lock) when it _changes_ — i.e. the original Claude Code host died and the bridge was reparented. This catches the abnormal-death cases stdin-EOF + signal handlers miss. It compares against the startup PPID rather than testing `=== 1` so a bridge whose host runs as PID 1 (a container with no init system) is never falsely killed.
  - **Orphaned-owner reclaim (recover).** `Lockfile.isLockLive` reclaims a _live_ owner whose parent **changed** from the PPID it recorded at acquire (`ps -o ppid=`) — so a new session self-heals past an existing orphan instead of hard-failing. A null PPID lookup fails safe; pre-0.39 locks with no recorded `ppid` fall back to a legacy `PPID===1` reclaim.
  - **Heartbeat (recover wedged).** The lock body carries `lastHeartbeat`, refreshed every ~10s; a live owner whose heartbeat goes stale (>90s) is wedged and reclaimable — mirroring the device-lock's self-healing. Pre-0.39 locks without `lastHeartbeat` fall back to the existing mtime check (back-compat).
  - **Usurp self-terminate (sleep/wake safety).** `Lockfile.touch()` now returns whether we still own the lock. If a contender reclaimed our slot while the laptop slept (heartbeat expired → reclaimed → we wake), the next heartbeat detects the foreign PID and self-terminates instead of running as a second bridge on the same device. This also makes the (pre-existing, non-atomic) reclaim path self-correcting within one tick.

  Together these eliminate the manual `kill <pid> && rm <lock>` workaround. 15 #182 unit tests (incl. container-safety, sleep/wake usurp, and a real `ps -o ppid=` check); unit suite 1744/1744; `tsc` clean. (GH #182, B185, D1246)

## 0.39.2

### Patch Changes

- bc577e9: Fix the CDP connection wedge (GH #208): `cdp_status` no longer dead-locks on "Already connecting to Metro..." and no longer misreports a detached app as "Metro not found". Three root causes were addressed:

  - **RC1 — reconnect-storm wedge.** When the app detaches but Metro stays up, the WS-close reconnect loop holds `isReconnecting()` true for up to ~12 min (30 attempts × 30s cap, then re-armed indefinitely by the background poll). `autoConnect`'s guard threw "Already connecting" for every `cdp_status`/`cdp_*` call in that window. `cdp_status` now **preempts** an active reconnect storm via `softReconnect()` (the existing 3s `softReconnectRequested` handshake) for one fresh attempt instead of refusing, and surfaces the live `reconnectState` (attempt N/30) on any connect failure so it reads as progress, not a dead end.
  - **RC2 — misleading error.** "Metro up but 0 Hermes targets" now throws a typed `AppDetachedError` ("Metro is up … advertises 0 Hermes debug targets — the app isn't attached") instead of being conflated with the genuine "Metro not found" (now reserved for `discoverMetroPort` returning null).
  - **RC3 — no auto-recovery.** New `recoverDetached()` cold-restarts a detached iOS app (`simctl terminate` + `launch`) → reconnects → confirms with a real CDP liveness probe. Bounded to 3 consecutive attempts/session, skips while a Maestro flow holds the arbiter lease, iOS-only, opt-out via `RN_AUTO_RELAUNCH_ON_DETACH=0`. Cold-restart (vs recover-wedge's bare launch) is acceptable because it only fires when the app is ALREADY detached — never against a working app.

  Hardened via a Codex + Gemini multi-review: `cdp_status` now honors an explicit `args.platform` during a storm (tears down + reconnects rather than reusing the storm's target), auto-relaunch is skipped when the caller pinned a non-iOS platform (never cold-restarts an unrelated iOS session), `simctl launch` failures are surfaced instead of hidden behind "still detached", and the post-recovery status read can no longer throw out of the handler.

  19 new unit tests; full suite 1729/1729; `tsc --noEmit` clean. Live false-positive guard verified: the real `discover()` against Metro does not fire `AppDetachedError` while a target is present. Scoping: the literal-0-targets case is fixed; the RN-0.85 "C++ target present, 0 Hermes" flavor remains B156/B184 territory (recover-wedge path). (GH #208, B181, D1245)

## 0.39.1

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

## 0.39.0

### Minor Changes

- 5c4ca04: Add the read-only observability UI (D1226 "watch the agent live"): an in-process recorder + opt-in SSE server serving a React SPA (timeline | device | state). New `observe` MCP tool + `/rn-dev-agent:observe` slash command. Deep-redacted (args + payload, fail-closed), localhost-only with Host-header + Sec-Fetch-Site guards.

### Patch Changes

- c4804dc: Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
  Client picker dismissal after Android deep links (#136 sub-3). Routed through a
  single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
  actionable manual-select message instead of touching the legacy agent-device
  path. Cross-platform iOS support tracked as a follow-up.

## 0.38.40

### Patch Changes

- Deliver the GH #186 maestro-interop fixes that merged in #188 without a version bump (closes #189).

  - `cdp_run_action` now allows `runFlow` (including `when:` conditionals and `{file}` sub-flows) through the Maestro command allowlist, so actions with conditional dialog-handling (Expo dev-server picker, iOS "Open in" dialog) replay through the canonical runner instead of hard-failing with `Command not in allowlist: runFlow (Phase 134.1)`.
  - Non-destructive runner-leak `reacquire` recovery tier + cross-tool CDP re-pin, avoiding the ~44s relaunch / ~47s STALE_TARGET when maestro-mcp and rn-dev-agent contend for the same iOS device.
  - Structural route-drift detection: a stale-selector failure on an inserted screen is classified `ROUTE_DRIFT` instead of triggering a wasted fuzzy-repair.

  #188 shipped these to `main` with no version bump, leaving them undeliverable to marketplace installs; this patch publishes them.
