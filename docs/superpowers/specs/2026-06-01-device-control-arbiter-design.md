# Design — 3-layer device control + Session Arbiter to end multi-runner foreground contention (#202)

- **Date:** 2026-06-01
- **Issue:** [#202](https://github.com/Lykhoyda/rn-dev-agent/issues/202)
- **Related:** #186 (dual Maestro surfaces), #194 (iOS verification UX / recovery loops), #199 (native-log-first / clearState), #201 (`maestro_run --app-file` gap)
- **Status:** Approved design, pending implementation plan
- **Approach:** Phased — Phase 1 (single-runner enforcement) · Phase 1.5 (persisted UDID lock) · Phase 2 (DeviceSessionArbiter) · Phase 3 (contracts + Maestro consolidation)
- **Author:** brainstorming session (Anton + Claude), cross-checked by Gemini + Codex via `/brainstorm`

## 1. Background & current state

The plugin drives one iOS simulator through three layers that currently compete for it with nothing serializing them. The session that motivated #202 stalled because **duplicate L2 interaction runners** were alive at once: the in-tree `RnFastRunner` (correct owner, D1219) *and* a stale upstream `AgentDeviceRunner.app` left over from a prior day, plus an orphaned `~/.agent-device/daemon.{json,lock}`. The legacy runner stole foreground from the app-under-test → iOS paused its JS thread → CDP wedged → the agent burned ~7 recovery attempts and drifted across three tool surfaces for one job. **The defect was duplicate interaction runners, not any single tool.**

### Ground truth verified in source (Claude-read + Codex/Gemini cross-check)

| Fact | Evidence |
|---|---|
| `RN_DEVICE_KILL_LEGACY` is opt-in (`=== '1'`), fires only at `device_snapshot action=open`, and only `process.kill(pid,'SIGTERM')`s the daemon PID from `daemon.json` — never kills `AgentDeviceRunner.app`, never removes the lock files | `tools/device-session.ts:192-205` |
| Legacy detection reads only `~/.agent-device/daemon.json` — no lock-file check, no process scan | `runners/external-runner-detect.ts:21-59` |
| `maestro` arg builder has no `--app-file` / `clearState` support (this is #201) | `tools/maestro-dispatch.ts:108-168` |
| `cdp_status` on `app.isPaused` does one `softReconnect()` then warns — never re-foregrounds the app-under-test | `tools/status.ts:198-211` |
| `startFastRunner()` early-returns on **any** existing runner state with no `deviceId` comparison; state path is a fixed constant | `runners/rn-fast-runner-client.ts:17, 174` |
| `markCdpStale()` recovery machinery already exists | `cdp/recovery.ts` |
| No `DeviceSessionArbiter` / lease / `foregroundOwner` concept exists | (absent) |
| Tests are `node --test`, TS-friendly, in `scripts/cdp-bridge/test/unit/` | `cdp-bridge/package.json` |

### Two bugs the issue did not name (surfaced by the brainstorm)

1. **`/tmp/rn-fast-runner-state.json` cross-project leak** (Codex-found, Claude-verified). Fixed path + no `deviceId` guard → a second project's bridge can adopt a runner bound to a *different* UDID. A sibling of the original bug.
2. **The multi-bridge race** (panel-reasoned). Two Claude Code windows = two bridges = two *in-memory* arbiters on one simulator, neither seeing the other. An in-memory-only arbiter cannot serialize across processes.

### Decisions locked during brainstorming

- **`ensureSingleRunner()` lives in TS in the bridge only** — run at bridge startup and reused per-call by the Phase 2 arbiter. **Not** in the bash SessionStart hook (`hooks/detect-rn-project.sh`). Enforcement begins when the bridge first wakes.
- **The persisted UDID lock is its own increment (Phase 1.5)** — Phase 1 stays tight to the *observed* (single-bridge) bug; the UDID lock closes the *latent* multi-bridge race.
- **Conflict policy = refuse-fast**, never queue.
- **Persistence is split:** the transient per-call lease stays **in-memory** (persisting it recreates the root-cause orphaned-lock bug); only **cross-bridge simulator ownership** is persisted (carefully, with liveness + heartbeat).
- **Rejected:** Gemini's "re-key the existing `md5(projectRoot)` bridge lock to `md5(UDID)`" — the UDID is unknown at startup when that lock is acquired, and it would drop the same-project-two-windows protection. The UDID lock must be a *separate, additional* lock.

## 2. North-star architecture: three layers, explicit contracts

| Layer | Mechanism | Role | Exclusivity |
|---|---|---|---|
| **L1 INTROSPECTION** | CDP/Hermes (the bridge) | read store / network / component-tree / mmkv / native | **shared** |
| **L2 INTERACTION** | iOS `RnFastRunner` / Android `agent-device`; `cdp_interact` (fiber path) | primitive taps / types / scrolls | **shared** |
| **L3 FLOW-REPLAY** | `maestro-runner` (Go+WDA) | whole-`.yaml` E2E flows only | **exclusive** |

**Contracts:** one mechanism per capability tier; **L1+L2 coexist** (drive with XCTest, assert with CDP — same per-step loop); **L3 is exclusive** (owns the whole device for the flow's duration); legacy `agent-device` is **Android-only** (retired on iOS per D1219). `maestro-runner` is **not** a primitive tap driver.

## 3. Phase 1 — single-runner enforcement (the *observed* bug)

**Goal:** make the documented kill-switch actually kill the thing that caused the bug, default-on, without footguns. Prevents the bulk of the observed friction.

### 3.1 New module: `runners/ensure-single-runner.ts`

```
ensureSingleRunner(opts: { udid?: string }): Promise<{
  killedPids: number[];
  removedFiles: string[];
  skipped: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}>
```

**Split by what we know when — this dissolves the over-aggressive-kill footgun (brainstorm Q4):**

- **Startup pass (UDID unknown), files-only:** remove orphaned `~/.agent-device/daemon.json` + `daemon.lock` **only when the PID they reference is dead.** No live process is ever touched at startup. Zero footgun for a user legitimately running `agent-device` for an Android project in another window.
- **Device-open pass (UDID known), scope-kill:** terminate legacy `AgentDeviceRunner*.app` XCUITest processes **whose argv targets this UDID**. Validate the UDID-in-argv assumption against a live `ps aux` against a real leak before relying on it; fall back to `simctl terminate <udid> <legacyBundleId>` (inherently UDID-scoped) when argv matching is unreliable. **Never** kill our own `RnFastRunner` / `RnFastRunnerUITests-Runner`. **Never** kill the generic `agent-device` CLI of another repo.

Idempotent; safe to call repeatedly; returns telemetry (`meta.timings_ms`, killed PIDs, removed files) per the CLAUDE.md instrumentation convention.

### 3.2 Wiring + default-on flip

- Call `ensureSingleRunner()` at **bridge startup** (`index.ts`) and reuse it per-call in Phase 2.
- **Replace** the opt-in branch at `device-session.ts:192` with `ensureSingleRunner()`.
- Flip the default: `RN_DEVICE_KILL_LEGACY !== '0'` (was `=== '1'`). Opt-out via `=0`. **Ships in the same change as the real logic — never before** (finding: flipping the default before the real kill logic exists is a no-op-with-surprise-kill-risk). Log every killed PID + removed file.

### 3.3 rn-fast-runner-state guard (the second leak)

In `startFastRunner()`, reject reuse when stored `deviceId !== requested deviceId` (instead of early-returning on any existing state). Cheap; prevents the cross-project runner adoption.

### 3.4 #201 — `--app-file` for `clearState`

`maestro-run.ts` already resolves and validates `headerAppId`. Resolve the session `appId`'s built `.app` path (e.g. via `simctl get_app_container <udid> <bundleId>` or derived-data lookup) and thread it into `buildArgs` as `--app-file <path>` **when an iOS flow uses `clearState`**. No CLI escape hatch needed.

## 4. Phase 1.5 — persisted UDID simulator-ownership lock (multi-bridge race)

**Goal:** serialize ownership of one simulator across *separate bridge processes* (two Claude Code windows). The only thing that closes the multi-bridge race.

### 4.1 New module: `lifecycle/device-lock.ts`

- **Path:** `${tmpdir}/rn-dev-agent-device-${uid}-ios-${udid}.lock` — UDID-scoped, per-user. **Additive** to the existing `md5(projectRoot)` bridge lock (which stays — it protects same-project-two-windows).
- **Schema:** `{ pid, projectRoot, platform, udid, appId, startedAt, lastHeartbeat, version }`.
- **Acquire:** atomic `open(path, 'wx')`, **lazily at `device_snapshot action=open`** (the UDID is only known then — it is populated at `setActiveSession`, not at bridge startup). On `EEXIST`: read holder; reclaim iff holder PID is dead **or** `lastHeartbeat` is stale (>90 s); else refuse `{ code: 'DEVICE_BUSY', holder: { pid, projectRoot, appId } }`.
- **Heartbeat:** bridge updates `lastHeartbeat` every ~30 s while the session is active. **Drop the naive 24h-age reclaim for live PIDs** (Codex) — use PID-liveness + heartbeat staleness instead, so a long-running bridge is never falsely stealable.
- **Release:** at `device_snapshot action=close` and on process exit (best-effort cleanup handler).
- **Restart-safety:** a bridge crash leaves the file behind, but the stale heartbeat + dead PID let the next bridge reclaim it. **No permanent orphan** — unlike the original `daemon.lock`, which had no liveness check and is exactly why it orphaned.

## 5. Phase 2 — DeviceSessionArbiter

**Goal:** serialize the three planes *within* one bridge and bound wedge recovery so the agent never burns 7 attempts again.

### 5.1 New module: `lifecycle/device-arbiter.ts` — in-memory singleton

The lease **must not persist** (persisting it recreates the #202 root cause).

- **State:** `{ platform, flowLeaseHeldBy: string | null, activeOps: Set<opId>, runnerHealth }`.
- **`tryAcquire(plane: 'introspection'|'interaction'|'flow', opId)` — refuse-fast, no queue:**
  - `introspection` + `interaction`: always granted **unless** a flow lease is held → `BUSY_FLOW_ACTIVE` (they coexist; this is the per-step drive-and-assert loop).
  - `flow`: granted only when `activeOps` is empty and no other flow lease → else `BUSY`. Caller retries.
  - A reader/writer scheduler is **YAGNI** for a single-threaded Node bridge — a boolean flow lease + an `activeOps` set is enough.
- **`release(lease)`.**
- **`recoverWedge({ udid, appId })` — bounded 1/call, max 3/session, counter reset on `device_snapshot action=open`:**
  1. **Diagnose** the *real* foreground via `simctl spawn <udid> launchctl list` (the honest "who stole it" probe — RnFastRunner's `appState` is polluted because the runner calls `.activate()` on every request).
  2. If foreground ≠ target → **re-foreground:** `simctl launch <udid> <appId>` → `markCdpStale()` → reconnect. **Confirm** recovery via RnFastRunner `appState`.
  3. If foreground *is* the target but `/health ∈ {stale,dead}` → reap + restart the runner **once**, else surface `RUNNER_STALE`.

This is the exact signal that distinguishes "foreground stolen → re-foreground and continue" from "runner dead → surface the error" (brainstorm Q3).

### 5.2 Wiring

- `cdp_status` isPaused path → call `recoverWedge()` **before** returning the wedge error.
- `device_*` → `acquire('interaction')`.
- `cdp_*` reads → `acquire('introspection')`.
- `maestro_run` → `acquire('flow')` + `stopFastRunner()` (park L2) + run flow + `simctl launch <udid> <appId>` + `markCdpStale()` + lazy fast-runner restart. This is the **only** place L3 exclusivity is actually enforced.

The arbiter uses (does not duplicate) Phase 1's `ensureSingleRunner()` and Phase 1.5's device lock.

## 6. Phase 3 — formalize contracts + consolidate Maestro (#186)

Lighter milestone, not a big build:

- Document the §2 three-layer contract in `CLAUDE.md` + `docs-site`.
- Consolidate the **dual Maestro surfaces** — plugin `maestro_run` vs the standalone maestro MCP — so both honor the flow lease, or deprecate one. This sub-problem warrants its own brainstorm; Phase 3 is a contracts + consolidation checkpoint.

## 7. Failure-mode matrix

| Failure (observed or latent) | Detection | Recovery | Phase |
|---|---|---|---|
| Stale legacy runner steals foreground | `ps`/argv scan scoped to UDID at device-open | scope-kill legacy `.app`; fallback `simctl terminate` | 1 |
| Orphaned daemon lock (dead PID) | startup file check + PID liveness | remove `daemon.{json,lock}` (files-only, dead-PID-gated) | 1 |
| Cross-project runner adoption | stored `deviceId !== requested` | reject state reuse | 1 |
| `clearState` needs `--app-file` (#201) | iOS flow has `clearState` | resolve `.app`, inject `--app-file` | 1 |
| Multi-bridge contention (two windows) | UDID lock `EEXIST` + live holder | refuse `DEVICE_BUSY`; reclaim only on dead/stale holder | 1.5 |
| CDP wedge (JS paused) | `isPaused` + `launchctl` foreground ≠ target | re-foreground + `markCdpStale` + reconnect (bounded) | 2 |
| Runner dead (not just backgrounded) | foreground = target but `/health` stale/dead | reap + restart once, else `RUNNER_STALE` | 2 |
| Plane race (CDP read mid-flow) | flow lease held | refuse `BUSY_FLOW_ACTIVE` with a clear message | 2 |

## 8. Testing strategy

All unit-layer tests are `node --test`, fully mockable, **no live simulator required**:

- `ensure-single-runner`: mock `ps`/`simctl`/`fs` → assert **startup = files-only** (never kills a live process), **device-open = scoped-kill** (only argv-matches-UDID), idempotency, telemetry shape.
- `device-lock`: atomic acquire, reclaim-on-dead-PID, **refuse-on-live-holder**, heartbeat staleness reclaim, schema round-trip.
- `device-arbiter`: flow exclusivity, L1+L2 shared-grant, `BUSY_FLOW_ACTIVE` on read-during-flow, `recoverWedge` bounding (1/call, 3/session, reset on open).
- `maestro buildArgs`: `--app-file` injected iff iOS + `clearState`, omitted otherwise.

## 9. Telemetry & conventions

- Every result carries `meta.timings_ms` plus kill/removal/recovery counts (CLAUDE.md instrumentation convention).
- Explicit type imports; no unnecessary comments; CDP tree queries always filtered.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| UDID-in-argv scoping assumption may not hold for the legacy runner | Conservative startup (files-only); `simctl terminate <udid> <legacyBundleId>` fallback; validate against a live `ps aux` before shipping the argv matcher |
| Default-on flip surprises existing opt-in users | Ships only with the real (scoped, logged) logic; `=0` opt-out preserved; every action logged |
| Heartbeat staleness threshold tuning (90 s) | Start conservative; PID-liveness is the primary gate, heartbeat is the secondary |
| Bridge crash mid-flow leaves L2 parked | `recoverWedge` + lazy fast-runner restart re-establish L2; UDID lock reclaim on dead PID |

## 11. Out of scope (YAGNI)

- Separate arbiter daemon (re-creates the orphaned-lock hazard — the root cause).
- Retiring `RnFastRunner` (debated, rejected — the agent needs L2's sub-second in-process loop).
- Multi-session / CI fan-out arbitration.
- A reader/writer scheduler for the planes (a flow lease + `activeOps` set suffices for a single-threaded bridge).
