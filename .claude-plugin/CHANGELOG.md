# rn-dev-agent-plugin

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
