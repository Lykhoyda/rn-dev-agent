# Eradicate agent-device — In-tree Native Runners as Sole Backend — Design

**Date:** 2026-06-15
**Status:** Approved (design) — ready for implementation plan
**Author:** brainstormed with the user (plugin maintainer)
**Scope:** Remove the third-party `agent-device` CLI dependency entirely (iOS + Android), making the in-tree native runners (`rn-fast-runner` for iOS, `rn-android-runner` for Android) the only device-interaction backend; prove they beat agent-device on speed + reliability; harden port-lock / conflict handling on both platforms.

## 1. Problem & Context

The plugin's L2 device-interaction layer ("INTERACTION" in the three-layer contract) historically dispatched through the upstream Callstack **`agent-device`** CLI (package `agent-device`, bundle `com.callstack.agentdevice.runner`). Two migrations have already replaced most of it with in-tree native runners — but the dependency is not gone, and the state is **asymmetric**:

- **iOS** — fully migrated (GH #105). `runAgentDevice()` short-circuits every interaction verb to `rn-fast-runner` (Swift/XCTest rig, `POST /command` HTTP server @ **22088**) via `runIOS()`. agent-device's iOS in-bridge path was deleted (~200 LOC).
- **Android** — the in-tree **`rn-android-runner` already exists and is default-on** (`scripts/rn-android-runner/`, Kotlin/UIAutomator2, NanoHTTPD `POST /command` @ **22089**, TS client `rn-android-runner-client.ts` with `adb forward` + `/health`-gated readiness from GH #243). It routes the interaction verbs when `RN_ANDROID_RUNNER !== '0'`.

What still depends on agent-device (the real surface area of this work):

| Surviving usage | Location |
|---|---|
| Android **daemon-socket tier** (Tier 1) | `agent-device-wrapper.ts:779–788` |
| Android **CLI tier** (Tier 3, `execFile('agent-device', …)`) | `agent-device-wrapper.ts:800–859` |
| `RN_ANDROID_RUNNER=0` **restores** the agent-device tiers | `agent-device-wrapper.ts:760–768` |
| Residual verb `device_list`/`devices` → `runAgentDevice(['devices'])` | `tools/device-list.ts:5,26` |
| Residual verb session **`open`** → `runAgentDevice(['open', appId, …])` | `tools/device-session.ts:196–202` |
| Residual verb session **`close`** → `runAgentDevice(['close'])` | `tools/device-session.ts:237,240,394` |
| Auto-install script, invoked on **every SessionStart** | `scripts/ensure-agent-device.sh`, `hooks/detect-rn-project.sh:67` |
| Legacy-runner eradication (kill `AgentDeviceRunner`, clean `~/.agent-device/*`, uninstall `com.callstack.agentdevice.*`) | `runners/ensure-single-runner.ts` |
| Runner-leak sentinel detection | `tools/runner-leak-recovery.ts` (`isAgentDeviceRunnerSentinel`) |
| ~**522** `agent-device` string references (code + tests + docs) | repo-wide |

> Note: verbs **not** in `RN_FAST_RUNNER_COMMANDS` (`agent-device-wrapper.ts:308`) — notably `open`/`close`/`devices` — fall through to the agent-device path on **both** platforms today, because the iOS short-circuit only fires for that command set and only when `!opts.skipSession`. The deepest entanglement is therefore **session lifecycle**, not taps.

The user's intent: get rid of agent-device **completely**, on both platforms, with the in-tree runners as the sole backend; benchmark to prove ours is faster + more reliable than the 3rd party; pay special attention to **port locks and conflicts**; verify it works seamlessly on iOS simulator and Android emulator.

## 2. Goals / Non-goals

**Goals**
- G1. No code path spawns, installs, or requires `agent-device` after this work. No silent fallback can ever resurrect it.
- G2. The in-tree runners handle **all** device verbs, including the residual lifecycle verbs (`open`/`close`/`list`).
- G3. Head-to-head benchmark data (latency + reliability) proving ours ≥ agent-device, captured **before** removal, committed as proof.
- G4. Hardened port-lock / conflict handling: Android serial-scoped device lock (parity with iOS), collision-tolerant runner ports, robust `adb forward`/slot cleanup.
- G5. Seamless `device_*` operation verified live on **both** iOS simulator and Android emulator; zero agent-device process spawns confirmed.

**Non-goals**
- N1. No change to the L1 CDP introspection layer or the L3 Maestro flow layer beyond what conflict-hardening requires.
- N2. No new device capabilities (WebView DOM, real physical devices) — purely backend substitution + hardening.
- N3. Not removing the *defensive cleanup* of a foreign/stale upstream `AgentDeviceRunner` (see D-b) — that protects users with old installs and is not a dependency.

## 3. Resolved decisions (from brainstorming)

1. **Removal depth → Hard cutover.** Delete the daemon + CLI tiers, the install script, and its SessionStart hook. In-tree runners become the only backend. `RN_ANDROID_RUNNER=0` no longer restores agent-device — it errors with guidance. No silent fallback.
2. **Benchmark → Head-to-head on both simulators.** Keep agent-device installed temporarily; benchmark identical flows (ours vs agent-device) for per-op latency + reliability on iOS sim AND Android emulator; record a results table; then remove.
3. **Conflict hardening → In scope.** Add an Android serial-scoped device lock, make runner ports collision-tolerant, harden adb forward/reverse + slot cleanup.

## 4. End-state architecture

One mechanism per platform; no third party; no silent fallback:

```
device_* / cdp_interact
        │
   runNative(platform, cmd)         ← renamed from runAgentDevice; zero agent-device knowledge
        ├── ios     → runIOS()      → rn-fast-runner    POST /command @ probed port (default 22088)
        └── android → runAndroid()  → rn-android-runner POST /command @ probed port (default 22089, via adb forward)

device_list   → xcrun simctl list devices --json   /   adb devices -l        (native enumeration)
session open  → resolve target device → acquire device-lock (DEVICE_BUSY if held)
                → ensure runner ready → launch/foreground app (simctl launch / adb am start)
                → write session state                                        (no agent-device 'open')
session close → shutdown runner + release locks + clear session state        (no agent-device 'close')
find          → pure-TS orchestrator (snapshot → match → tap)                [already native]
```

A "device session" becomes purely *our* concept: runner readiness + a per-project session-state file + the device lock. There is no external session daemon to open/close.

## 5. Phased plan (stacked PRs, `#202`-style)

### Phase 0 — Benchmark harness + head-to-head data (agent-device still installed)
- Extend the existing harness at `rn-dev-agent-workspace/docs/proof/issue-3-benchmark/` (it already records `agent-device --version`).
- **Metrics per op:** latency p50/p95 over N≈25 iterations; reliability (success rate over repeats); cold-start.
- **Ops:** `snapshot`, `tap`, `find+tap`, `fill`/`type`, `swipe`/`scroll`, `screenshot`.
- **Android = true A/B in-bridge:** same flows with `RN_ANDROID_RUNNER` unset (ours) vs `=0` (agent-device daemon/CLI).
- **iOS = asymmetric (see §6):** agent-device's in-bridge iOS path was already deleted (#105), so compare our `runIOS` against **agent-device standalone CLI** for identical ops; if its iOS CLI is broken on the current Xcode/runtime, fall back to the recorded `v0.21.1-baseline` numbers and state so explicitly.
- **Output:** committed results table under `rn-dev-agent-workspace/docs/proof/` (proof artifacts live in the sibling workspace). **Gate:** removal proceeds only once this exists and shows ours ≥ agent-device.

### Phase 1 — Port/conflict hardening (independently valuable; de-risks the cutover)
- **Android device lock**: add `android` support to `lifecycle/device-lock.ts`, keyed on adb serial — `${TMPDIR}/rn-dev-agent-device-<uid>-android-<serial>.lock` — mirroring the iOS UDID lock (atomic `wx`, PID-liveness + 30s heartbeat self-heal, fail-open on fs error). Acquired at session open.
- **Collision-tolerant ports** (probe-on-collision; default to current ports when free → zero behavior change for the single-sim case):
  - **iOS** — a single host-loopback port (`RN_FAST_RUNNER_PORT`, default 22088). The XCUITest runner binds it on the Mac's loopback, so two simulators would collide; probe a free port and pass it to the runner.
  - **Android** — **two distinct ports**, never conflated: a fixed **`devicePort`** (the NanoHTTPD listener inside the emulator via `RN_ANDROID_RUNNER_PORT`, default 22089 — emulator-namespaced, so it needn't move) and a probed **`hostPort`** (what the TS client connects to on `127.0.0.1`). Bridge them with `adb forward tcp:<hostPort> tcp:<devicePort>`. The host port is the globally-contended one (two bridges share one host `adb`), so it is what gets probed; health checks and `adb forward --remove` use **`hostPort`**.
  - Persist `hostPort`/`devicePort` in the runner state file; reconnects reuse them.
- **adb cleanup + slot handoff**: ensure `adb forward --remove` always runs on stop; verify `release-android-slot.ts` UIAutomator single-slot handoff is robust under the new lock.

### Phase 2 — Hard cutover (the removal)
- Delete the Android **daemon-socket** + **CLI** tiers from `agent-device-wrapper.ts`; rename the export `runAgentDevice` → `runNative` with a thin temporary re-export so the ~20 importers don't all churn at once (D-a).
- Replace residual verbs:
  - `device_list`/`devices` → `xcrun simctl list devices --json` (iOS) + `adb devices -l` (Android).
  - session `open` → resolve target device → **acquire device lock first** (`DEVICE_BUSY` if held) → ensure runner ready (`ensureFastRunner` / `startAndroidRunner`) → launch/foreground app via simctl/adb → write session state.
  - session `close` → shutdown runner + release locks + clear session state.
- `RN_ANDROID_RUNNER=0` (and any iOS "disable" intent) → **error with actionable guidance** (D-c) instead of restoring agent-device.

### Phase 3 — Cleanup + docs
- Remove `scripts/ensure-agent-device.sh` and its `hooks/detect-rn-project.sh:67` SessionStart call.
- Reconcile the ~522 references: dead code/tests, `/setup` + `/doctor` rows, `CLAUDE.md`, `docs-site`, troubleshooting notes. Update the prerequisites ("agent-device required for Android") and the architecture tables.
- **Retain** foreign-runner cleanup in `ensure-single-runner.ts` (D-b) — but reframe it from "kill our legacy dependency" to "defend against a foreign/stale upstream runner stealing focus."

### Phase 4 — Final dual-platform verification + ours-only re-benchmark
- Full `device_*` smoke on iOS sim **and** Android emulator until seamless.
- Assert **zero** agent-device process spawns during a full session (grep `ps`/no `~/.agent-device` writes).
- Re-run the benchmark (ours-only) to confirm targets still hold post-removal.

## 6. Benchmark methodology (the asymmetry, explicitly)

The comparison is asymmetric *by construction* and the proof must say so honestly:

- **Android** — clean in-bridge A/B: a single env flip (`RN_ANDROID_RUNNER`) routes the same MCP `device_*` calls through ours vs agent-device's daemon/CLI. Same device, same flows, same harness → directly comparable.
- **iOS** — agent-device's in-bridge path is already gone (#105), so we cannot A/B inside the bridge. Two honest options, in order of preference:
  1. Drive `agent-device` **standalone CLI** for the same ops against the same booted simulator, vs our `runIOS`. Fresh, comparable numbers.
  2. If agent-device's iOS CLI no longer works on the current Xcode/runtime, compare ours against the **recorded baseline** (`v0.21.1-baseline/PROOF.md`, e.g. `device_snapshot` open ≈533 ms via agent-device) and label it a historical baseline, not a same-day A/B.

Acceptance: ours ≤ agent-device on median latency for the common verbs and ≥ on reliability, on both platforms (with the iOS caveat documented).

## 7. Key technical decisions

- **D-a (dispatcher rename):** `runAgentDevice` → `runNative(cliArgs, {platform})`, no agent-device branches. Keep a one-line `export const runAgentDevice = runNative` shim during Phase 2 to avoid a 20-file churn in a single commit; drop the shim in Phase 3.
- **D-b (retain foreign-runner defense):** Keep killing stale `com.callstack.agentdevice.*` processes/apps and cleaning `~/.agent-device/*` in `ensure-single-runner.ts`, and keep `isAgentDeviceRunnerSentinel`. Rationale: this removes a *dependency*, not the *defense* against a third party's stale runner capturing simulator focus. It must never re-spawn agent-device — only clean it up.
- **D-c (disable = error, never fallback):** Setting `RN_ANDROID_RUNNER=0` (or any iOS equivalent) makes `device_*` return an actionable error ("in-tree runner is the only backend; the agent-device fallback was removed in <version>"), never a silent degrade. Symmetric iOS/Android behavior.
- **D-d (port strategy):** Stable-by-default, probe-on-collision. iOS uses a single host-loopback port. **Android separates a fixed device-listener port (`RN_ANDROID_RUNNER_PORT`, emulator-namespaced) from a probed host port** used for `adb forward`, `127.0.0.1` health checks, and `adb forward --remove` — never conflate the two. The (project, device) pair gets deterministic ports unless taken; only then probe upward. Persisted in the runner state file (Android stores both `hostPort` and `devicePort`) so reconnects are stable.
- **D-e (Android device lock + lock-before-side-effects):** Serial-scoped, same shape/semantics as the iOS UDID lock, so two different projects' bridges can't drive one emulator (`DEVICE_BUSY`), with PID + heartbeat self-heal (no orphaned-lock regression). **Critically, session open acquires the device lock immediately after resolving the target device and *before* starting any runner, launching/foregrounding the app, or writing session state** — otherwise a competing bridge could start a runner or steal focus before the conflict is detected. This ordering applies to iOS too.

## 8. Testing & verification

- **TDD throughout:** failing test → minimal impl → pass → signed per-task commit; a changeset per change; `dist/` rebuilt + staged.
- **Unit baseline:** the full `scripts/cdp-bridge` unit suite (≈2087 tests as of #211) stays green and grows — new tests for: the Android device lock, port-probe/collision, `runNative` (no agent-device branch), residual-verb native replacements, and `RN_ANDROID_RUNNER=0` error semantics.
- **Plan review BEFORE code:** `/brainstorm gemini,codex <plan + key files>`; apply findings; amend the plan commit.
- **Multi-review AFTER code:** `/multi-review` on the diff per phase.
- **Device verification:** the acceptance bar — `device_*` smoke on iOS sim AND Android emulator, plus the zero-agent-device-spawn assertion.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Hard cutover removes the safety net on the plugin's core capability | Phase 0 proof + Phase 1 hardening land first; device-verify between every phase; phased stacked PRs keep blast radius small |
| iOS head-to-head limited (agent-device iOS path already deleted) | Standalone-CLI comparison; cite recorded baseline if broken — stated honestly in the proof |
| Port probing regresses the existing single-sim flow | Default to current ports when free; probe only on collision; unit-test both branches |
| A live agent-device code path slips through 522 refs | grep-gate (a CI-style check that no `execFile('agent-device'` / install remains); Phase 4 asserts zero spawns at runtime |
| Session lifecycle (`open`/`close`) is the riskiest edit | Isolated to Phase 2, behind the Phase 1 lock/port safety net; covered by new unit tests + device smoke |
| Android UIAutomator single-slot contention with Maestro L3 | Reuse `release-android-slot.ts` handoff; verify under the new serial lock |

## 10. References

- **devicelab-dev** org (user-suggested): `maestro-runner` (Go flow engine this plugin already prefers) and `maestro-ios-device` (Obj-C real-device driver) — reference patterns for native iOS/Android driving and the "fast, no-JVM" framing; `maestro-complete-reports` for results formatting.
- Prior art in-repo: `2026-05-15-rn-device-ios-first-mvp-design.md` (iOS #105 cutover), `2026-05-16-rn-android-runner-mvp-plan.md` (Android runner build), `2026-06-09-237-android-instrumentation-slot-handoff-design.md`, `2026-06-09-gh-243-244-android-post-flow-lifecycle-design.md`.
- Benchmark harness: `rn-dev-agent-workspace/docs/proof/issue-3-benchmark/`, `…/v0.21.1-baseline/PROOF.md`.

## 11. Out of scope / follow-ups

- WebView DOM inspection from the Android runner.
- Real physical-device support.
- Any rename of the `device_*` MCP tool surface (kept stable for users).
