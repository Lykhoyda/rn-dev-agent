# rn-dev-agent-plugin

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
