# Design — #210: device-session visibility (rn-fast-runner up/down in cdp_status + lazy auto-spawn + screenshot fallback)

- **Issue:** #210 (`bug`, `kano:must-be` — Wave-1) — `device_*` fails "rn-fast-runner not started" while `cdp_status` reports connected; no device-session visibility.
- **Platform:** iOS (the rn-fast-runner / XCUITest path is iOS-only; Android `agent-device` is unaffected and its dispatch is untouched).
- **Approach:** Reuse-first. Surface the runner state that already exists, auto-spawn the runner that already has a spawn helper, and fall back to the screenshot path the OS already provides. **No new device backend.**
- **Reviewed:** Brainstormed with Gemini (2026-06-08) — explicitly agreed the WDA client should be avoided; added the hierarchical state model, the `runIOS()` cold-build-gated auto-spawn, and the arbiter screenshot exception. Codex was rate-limited that session (re-run before/with the multi-LLM *plan* review).

---

## 1. Problem

On iOS, `device_screenshot` / `device_find` / `device_press` fail with **"rn-fast-runner not started — open a device session first"** while `cdp_status` reports `cdp.connected: true`. The reporter fell back to `xcrun simctl io booted screenshot` for an entire session.

**Root cause (verified).** The iOS interaction backend — **rn-fast-runner**, an in-tree XCUITest rig exposing `POST /command` on `127.0.0.1:22088` — is spawned in exactly one place: `device_snapshot action=open` (`src/tools/device-session.ts:303`), and even there it is fire-and-forget:

```ts
if (args.platform === 'ios' && deviceId) {
  ensureFastRunner(deviceId, appId).catch(() => { /* non-fatal */ });
}
```

Every `device_*` verb routes `device_* → runAgentDevice → runIOS → postCommand`, and `postCommand` (`src/runners/rn-fast-runner-client.ts:549`) throws the instant the module-scoped `runnerState` is null:

```ts
async function postCommand(body): Promise<RunnerResponse> {
  const state = runnerState;
  if (!state) throw new Error('rn-fast-runner not started — open a device session first');
  ...
}
```

Meanwhile `cdp_status.cdp.connected` (`src/tools/status.ts`) reflects only the **Metro/Hermes CDP WebSocket** — a different channel from the XCUITest runner. So both observations are simultaneously true and nothing surfaces the gap. Two failure modes compound:
1. Call a `device_*` verb without a prior `device_snapshot action=open` → not-started error, with no hint of the unblock.
2. No `cdp_status` signal that the device session / runner is down.

## 2. Scope & decision

The issue lists three fixes of escalating cost. The user requested **full scope**, including (iii). Investigation (two read-only Explores + a Gemini brainstorm) showed **(iii)-as-written is infeasible and counterproductive**, so it is **reframed** (see §6 + §8):

- **(i)** `cdp_status` reports the device-session/runner state. *(in scope)*
- **(ii)** Auto-spawn the runner from the `device_*` path, cold-build-safe; improve the error. *(in scope)*
- **(iii) reframed** — `device_screenshot` never hard-fails on iOS (simctl fallback), plus the written 3-layer contract. **Not** a WDA client. *(in scope, reframed)*

## 3. Design

### Fix (i) — `cdp_status.deviceSession`

Add a `deviceSession` field to `StatusResult` (`src/types.ts` — optional in the type for back-compat, but **always populated** by `buildStatusResult()` so the agent never has to null-check) in `src/tools/status.ts`, **modeled hierarchically** so "never opened" is distinguishable from "crashed":

```ts
deviceSession: {
  sessionOpen: boolean;                       // getActiveSession() !== null
  rnFastRunner: 'alive' | 'stale' | 'dead';   // probeFastRunnerLiveness(); only probed when sessionOpen
  appId?: string;                             // from getActiveSession()
  deviceId?: string;                          // from getActiveSession()
  foreignRunner?: { tool: string };           // from external-runner-detect (a Maestro/WDA flow owns the device)
}
```

- The agent reads `sessionOpen` + `rnFastRunner` together: `sessionOpen:false` → "open a session first"; `sessionOpen:true` + `dead` → "crashed; will auto-respawn on next device_* if prebuilt".
- The `/health` probe (`probeFastRunnerLiveness()`) is **gated on `sessionOpen`** so `cdp_status` (called frequently) adds no HTTP round-trip when there is no session. When `sessionOpen` is false, `rnFastRunner` is reported as `'dead'` without probing.
- **Reuse:** `probeFastRunnerLiveness()` (`rn-fast-runner-client.ts:416`), `getActiveSession()` (`agent-device-wrapper.ts:178`), `detectIosExternalRunner()` (`runners/external-runner-detect.ts`). The foreign-runner detection is best-effort and must never fail `cdp_status`.

### Fix (ii) — lazy auto-spawn, cold-build-safe

In `runIOS()` (`rn-fast-runner-client.ts:602` — it already has `appId` via `buildRunIOSArgs`; resolve `deviceId` from `getActiveSession()` else the booted sim), when the runner is down before dispatch:

- **If `hasBuiltTestProduct(derivedData)` is `true`** (`rn-fast-runner-client.ts:161` — a prior `build-for-testing` left a `.xctestrun`) → call `ensureFastRunner(deviceId, appId)` transparently (fast `test-without-building` steady-state path) and proceed. "Just works."
- **If `false`** (no prebuilt rig) → throw an **actionable** error naming the exact unblock instead of triggering a silent multi-minute `xcodebuild test`:
  > `rn-fast-runner not started and not prebuilt. Run `device_snapshot action=open appId=<appId> platform=ios` first (one-time ~minutes cold build), then retry — or pre-build with `xcodebuild build-for-testing` (see Prerequisites).`

This is the heart of the reporter's fix: once a session has been opened (or the rig prebuilt), `device_find/press/fill` auto-recover rather than dead-ending. The bare `postCommand` message is also upgraded to name the unblock as a floor (defense in depth).

**Why `runIOS()` and not `postCommand()`** — `postCommand` is too low-level (no `deviceId`/`appId` context); `runIOS()` is the single iOS short-circuit that already carries the session context and is the natural choke point.

### Fix (iii) reframed — `device_screenshot` never hard-fails on iOS

`device_screenshot` gains an `xcrun simctl io <udid> screenshot` fallback used whenever rn-fast-runner cannot serve it — **runner down + not prebuilt, OR a Maestro flow currently owns the device.** simctl is OS-level framebuffer capture; it never touches XCUITest, so it is safe alongside a running flow.

- **Arbiter exception** — `device_screenshot` is classified `interaction` (`device-arbiter.ts:104`) and is therefore refused with `BUSY_FLOW_ACTIVE` during a flow today. The screenshot handler will, when a flow lease is held (or a foreign runner is detected), take the simctl path **without acquiring the interaction lease** (it cannot conflict), returning pixels with a `meta.via: 'simctl'` note. Write verbs (`press/fill/swipe/scroll`) continue to refuse with the existing clear arbiter message.
- This eliminates the reporter's manual `xcrun simctl io booted screenshot` — the tool does it for them.
- Primary path stays rn-fast-runner (app-scoped, consistent with the interaction model); simctl is strictly a fallback.

### Documentation
Update the 3-layer contract (`CLAUDE.md` + `docs-site`): rn-fast-runner = THE `device_*` interaction backend; Maestro/WDA = the flow engine; **serialized, not competing.** Mid-flow visual → simctl screenshot; mid-flow tree/state → `cdp_component_tree` / `cdp_store_state` (CDP introspection already coexists with a flow by design). Record the reframed (iii) decision + the WDA-client rejection.

## 4. State model (deviceSession)

| `sessionOpen` | `rnFastRunner` | Meaning | Agent action |
|---|---|---|---|
| `false` | `dead` (not probed) | No `device_snapshot action=open` yet | Open a session, or just call `device_screenshot` (simctl fallback) |
| `true` | `alive` | Runner healthy | `device_*` works |
| `true` | `stale` | PID alive, `/health` not 200 — wedged | Will be reaped+respawned on next `device_*` (if prebuilt) |
| `true` | `dead` | PID gone (crashed) | Auto-respawn on next `device_*` (if prebuilt) |
| any | + `foreignRunner` | A Maestro/WDA flow owns the device | Reads via CDP; `device_screenshot` → simctl; taps refuse |

## 5. Error handling / edge cases

- **Cold build never silent** — the `hasBuiltTestProduct` gate guarantees auto-spawn only takes the fast path; the slow path is always an explicit, opt-in error message.
- **`deviceId` resolution** — prefer `getActiveSession().deviceId`; if absent (no session yet but a sim is booted), resolve the booted UDID (existing helper). If none → the actionable error.
- **`cdp_status` robustness** — the `/health` probe + foreign-runner scan are wrapped; any failure degrades to `rnFastRunner:'dead'` / no `foreignRunner`, never throws.
- **simctl fallback failure** — if simctl itself errors (no booted device), return a clear error (not a silent empty image).
- **Android** — entirely unaffected; the `rnFastRunner` sub-field carries iOS-only semantics. On Android, `sessionOpen` reflects the agent-device session and `rnFastRunner` is always `'dead'` (the iOS runner is never used). Document the field as iOS-focused.

## 6. Testing (TDD)

Unit (plain `.js` in `test/unit/`, `node --test` after build):
- `gh-210-status-device-session.test.js` — `deviceSession` shape across all §4 rows (inject `getActiveSession`, `probeFastRunnerLiveness`, foreign-runner detector); probe **not** called when `sessionOpen:false`.
- `gh-210-runio-autospawn.test.js` — runner-down + `hasBuiltTestProduct:true` → `ensureFastRunner` invoked + dispatch proceeds; `hasBuiltTestProduct:false` → actionable error (no spawn); runner-up → no spawn. Inject the build-check + spawn fns.
- `gh-210-screenshot-fallback.test.js` — runner-up → rn-fast-runner path; runner-down/not-prebuilt → simctl; flow-lease-held → simctl path bypasses the arbiter (no `BUSY_FLOW_ACTIVE`); write verb during flow → still refuses.

Device verification (end): iOS sim — `device_screenshot` with no session (simctl fallback), then open + auto-spawn + `device_find`; `cdp_status.deviceSession` reflects each state; screenshot during a `maestro_run`. Android emulator — confirm no regression in `device_*` + status.

## 7. Files touched

| File | Change |
|---|---|
| `src/types.ts` | `StatusResult.deviceSession` field |
| `src/tools/status.ts` | populate `deviceSession` (gated probe + foreign-runner) |
| `src/runners/rn-fast-runner-client.ts` | `runIOS()` cold-build-gated auto-spawn; upgraded `postCommand` error |
| `src/tools/device-interact.ts` (or screenshot handler) | simctl screenshot fallback |
| `src/lifecycle/device-arbiter.ts` | screenshot-during-flow exception (simctl path) |
| `CLAUDE.md`, `docs-site/...` | 3-layer contract + reframed (iii) + state model |
| `.changeset/*`, `dist/` | changeset (patch × both pkgs) + rebuilt outputs |

## 8. Explicitly rejected — WDA W3C client / "ride Maestro's WDA"

The issue's literal (iii). Rejected with evidence:
1. **No session to ride** — maestro-runner spawns WebDriverAgent **per-flow** (temp `.yaml` via `execFile`, process exits, WDA torn down). No persistent WDA service; the bridge has no WDA port/session/client. maestro-runner accepts whole `.yaml` flows only — no primitive surface.
2. **Anti-unification** — rn-fast-runner and WDA are *both* XCUITest. A ~500–800 LOC W3C client + independent WDA lifecycle + arbiter surgery + conditional routing would create a **second** backend doing the same job.
3. **Only enables an anti-pattern** — the one thing it'd uniquely allow is `device_*` taps *mid-flow*, which the arbiter blocks on purpose (racing the flow's own steps). Mid-flow pixels are covered by simctl; mid-flow tree/state by CDP introspection (already coexists). A WDA client provides no unique value.

Revisit only if a concrete, validated need for mid-flow `device_*` interaction ever appears.

## 9. Deferred / open

- Surfacing the lock/conflict reason in the host `/mcp` panel (issue suggestion #3 from #182) — out of the bridge's control; deferred.
- Per-tool `meta.timings_ms` on the new paths (per repo convention) — include in the implementation.
