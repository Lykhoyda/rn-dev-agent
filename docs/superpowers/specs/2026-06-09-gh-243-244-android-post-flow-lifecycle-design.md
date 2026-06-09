# GH #243 + #244 — Android post-flow lifecycle (design)

**Date:** 2026-06-09
**Issues:** [#243](https://github.com/Lykhoyda/rn-dev-agent/issues/243), [#244](https://github.com/Lykhoyda/rn-dev-agent/issues/244)
**Branch:** `fix/gh-243-244-android-post-flow-lifecycle` (stacked on `main` after #237 / PR #241)
**Scope:** Surgical — fix exactly these two bugs. No contract docs, no `cdp_status` reconciliation.

## Context

Both bugs surfaced during live dogfood validation of #237 (PR #241) on a Pixel 9 Pro
emulator. #237 added `releaseAndroidInteractionSlot`, which before an L3 Maestro flow
(a) stops our in-tree `rn-android-runner` and force-stops its instrumentation packages,
and (b) kills the legacy agent-device daemon + removes `~/.agent-device/daemon.{json,lock}`.
That slot-release created two post-flow lifecycle seams. Both are low-impact (self-heal on
retry / cosmetic) but leak internals and surprise callers.

## Bug #243 — first `device_*` after a flow returns bare `fetch failed`

### Root cause

`startAndroidRunner` (`runners/rn-android-runner-client.ts`) gates readiness on a **logcat
line**: it spawns `adb logcat -s RnAndroidRunner:I` and resolves `finishReady()` when the
buffer contains both `RN_ANDROID_RUNNER_LISTENER_READY` and `RN_ANDROID_RUNNER_PORT=<port>`.

`adb logcat` **replays the existing ring buffer**, which still holds the *previous* runner's
ready lines (same tag, same fixed port `22089`). After a flow force-stops the runner and the
next `device_*` respawns it, the freshly-spawned logcat reads the **stale** ready lines and
fires `finishReady()` *before* the new `ServerSocket` is bound. The immediately-following
`POST /command` hits a not-yet-listening port → Node surfaces a bare `fetch failed`. An
immediate retry succeeds because by then the server is up.

The native runner already serves `GET /health` (`CommandServer.kt:16` → `{ok:true}`), but
the TS client never probes it — the truthful readiness signal exists and is unused.

### Fix

1. **Health-gated readiness.** Add `waitForAndroidRunnerHealth(port, opts)` — a bounded
   `GET http://127.0.0.1:<port>/health` poll over the injectable `fetchImpl`. `startAndroidRunner`
   resolves only when `/health` returns `{ok:true}`. Readiness becomes HTTP-truthful and
   immune to stale logcat. The logcat child is still spawned (diagnostic stream + existing
   teardown in `stopAndroidRunner`) but no longer gates readiness. On poll timeout, reject
   with a clear "did not become ready" message (preserves the existing `READY_TIMEOUT_MS`
   budget).

2. **Structured error, not bare `fetch failed`.** In `runAndroid`, wrap the
   `startAndroidRunner` + `postCommand` section; classify a connection-style failure
   (message includes `fetch failed` / `ECONNREFUSED` / `not started` / `did not become ready`)
   → `failResult(message, 'RN_ANDROID_RUNNER_DOWN')` with an actionable hint. Already-structured
   errors (e.g. `RUNNER_TIMEOUT` from `postCommand`'s `AbortError` path) pass through unchanged;
   the `.type` runner-timeout shim (`resp.error`-based, not a throw) is untouched.

> The health gate is the principled fix (it removes the race). The structured error is the
> residual-case UX fix (when the runner genuinely cannot come up).

## Bug #244 — `open → flow → close` returns `SESSION_NOT_FOUND`

### Root cause

Post-flow, the in-memory `activeSession` (`agent-device-wrapper.ts`) is still set — the flow
only tore down the *runner/daemon*, not the logical session. So `device_snapshot action=close`
passes the existing `!session` benign-no-op guard (`device-session.ts:357`) and calls
`runAgentDevice(['close'])`. `close` is **not** in `RN_ANDROID_RUNNER_COMMANDS`, so it falls
through to the agent-device daemon/CLI path — whose daemon + lock the #237 slot-release deleted.
The CLI returns `SESSION_NOT_FOUND` ("No active session"), which the handler surfaces raw. The
runner self-heals for interaction (snapshot works) but `close` does not round-trip.

### Fix (issue's option 2 — `close` tolerates a gone session)

Option 1 (flow should not tear down the session) is rejected: the daemon teardown *is* the
#237 slot-release; leaving it would reintroduce the UiAutomation-slot contention #237 fixed.

Extract **`closeDeviceSession(deps)`** into `tools/device-session-close.ts` (dependency-injection,
mirroring #210's `getDeviceSessionHealth(deps)` so it is unit-testable against `dist/`):

1. `session = getActiveSession()`; if null → `okResult({ closed: true, message: 'No active session to close' })` (preserves existing behavior).
2. `result = await runAgentDevice(['close'])`.
3. `!result.isError` → run cleanup (`clearActiveSession`, `stopFastRunner`, `releaseDeviceLock`) → return `result`.
4. else if `isBenignSessionGoneError(result)` → run the **same** cleanup → return
   `okResult({ closed: true, sessionAlreadyGone: true, message: 'Underlying device session was already gone (likely torn down by a Maestro flow); cleared local session state.' })`.
5. else → return `result` (genuine close failure; **no** cleanup — local state stays so the caller can retry).

`isBenignSessionGoneError(result)` is a pure exported predicate matching the gone-session
shapes (code `SESSION_NOT_FOUND`, or text containing `no active session` / `session not found`,
case-insensitive). Specific enough that a real close failure (adb error, mid-close crash) is
never swallowed.

The `device-session.ts` `close` branch becomes thin glue: delegate to `closeDeviceSession`
with production deps (`getActiveSession`, `runAgentDevice`, `clearActiveSession`,
`stopFastRunner`, `releaseDeviceLockForSession`).

## Components & boundaries

| Unit | Purpose | Depends on | Tested by |
|---|---|---|---|
| `waitForAndroidRunnerHealth(port, opts)` | Bounded `/health` poll; HTTP-truthful readiness | `fetchImpl` (injectable) | direct unit test (fetch mock) |
| `runAndroid` connection classifier | Map connection failure → `RN_ANDROID_RUNNER_DOWN` | — | unit test (fetch mock throws) |
| `closeDeviceSession(deps)` | Close session, tolerate gone underlying session | injected deps | new unit test (fakes) |
| `isBenignSessionGoneError(result)` | Pure predicate for gone-session error shapes | — | covered via `closeDeviceSession` cases |

## Test plan (TDD — failing test first, minimal impl, pass, commit per task)

**#243**
- `waitForAndroidRunnerHealth` resolves `true` once `/health` returns `{ok:true}`.
- `waitForAndroidRunnerHealth` returns `false` on timeout (health never ok within budget).
- `waitForAndroidRunnerHealth` does **not** resolve while `/health` keeps failing (no premature ready).
- `runAndroid` returns `RN_ANDROID_RUNNER_DOWN` (not bare `fetch failed`) when `postCommand`'s
  fetch rejects with a `fetch failed`/`ECONNREFUSED` error (existing live-state short-circuit +
  fetch mock).
- Existing `rn-android-runner-client.test.js` cases still pass (pre-seeded live state path unchanged).

**#244** (`test/unit/gh-244-close-session-gone.test.js`)
- no in-memory session → `okResult` no-op; `runAgentDevice` not called.
- close succeeds → `okResult`; cleanup deps all called once.
- close fails with `SESSION_NOT_FOUND` → `okResult` with `sessionAlreadyGone:true`; cleanup all called.
- close fails with an unrelated error → that error returned; cleanup **not** called.

## Out of scope (YAGNI)

- Documenting the runner-vs-session lifecycle contract (offered, declined — surgical scope).
- `cdp_status.deviceSession` Android runner-health reconciliation (the #210 iOS parity; declined).
- Re-routing Android `close` away from the agent-device CLI to the in-tree runner (deeper
  question #244 raises; not needed to make `close` round-trip).
- One-shot internal retry on `fetch failed` in `postCommand` — the health gate removes the race,
  so a retry would be dead weight.

## Risks

- **Benign predicate too broad** → swallows a real close failure. Mitigation: match only the
  specific gone-session shapes; everything else surfaced as-is (case d).
- **Exact CLI error shape** for the gone session is from the issue text (`SESSION_NOT_FOUND` /
  "No active session"); confirm against live emulator output during device verification and
  tighten the matcher if the real shape differs.
- **Health-poll latency** adds a few poll iterations to a cold start. Bounded by the existing
  `READY_TIMEOUT_MS`; net effect is replacing a *premature* resolve with a *correct* one.
