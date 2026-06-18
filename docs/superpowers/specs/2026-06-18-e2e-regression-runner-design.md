# E2E Regression Runner + Action→Locked-Test promotion — design spec

**Date:** 2026-06-18
**Status:** Approved (pending implementation plan)
**Topic:** A "Regression" page in the read-only `observe` web app that runs the user's **locked e2e tests** strictly on the booted simulator and reports pass/fail, plus the promotion lifecycle that turns a repairable action into a frozen, locked e2e test.

## Problem

The plugin already turns verified interactive walks into **actions** (parameterized Maestro flows under `.rn-agent/actions/<id>.yaml`) that auto-repair on UI drift via `cdp_run_action`. Actions are optimized for *resilience* — they absorb `testID` drift so they keep working as prologues.

What's missing is the opposite stance: a way to detect that a feature change **broke** an existing flow. The user wants a personal, dev-tools-coupled regression workflow — distinct from expensive team/CI e2e — where, after implementing a feature, they click a button and see whether their known-good flows still pass. Auto-repair is exactly *wrong* here: a drifted selector that repair would silently absorb is precisely the regression signal we want to surface.

This needs two things the codebase does not have:
1. A **promotion lifecycle**: a verified, repairable action → a **frozen, locked e2e test** (a regression baseline that never auto-repairs).
2. A **strict regression runner** surfaced in the `observe` app: run all locked tests, report a verdict, persist history, highlight what newly broke.

## Goals (v1)

- Promote a working action into a **locked e2e test** (frozen snapshot) via an explicit, verified gate.
- Run all locked tests **strict** (no repair) on the **already-booted** dev simulator.
- A **Regression** view in the `observe` app: a Run button, live progress, a verdict, a per-test table, and run history with a "newly failing since last green" diff.
- The bridge executes runs **autonomously in-process** (no active Claude conversation required).
- Persist a **suite-run report** per run; survive worker restarts without silently losing an in-flight run.

## Non-goals (deferred to later phases)

- **Isolated/dedicated simulator** + provisioning (create/boot/wait/install/teardown), end-to-end UDID threading, and the no-`setActiveSession` session handling. *(This is where ~all the cost lives — see Plan review §B. Deferred deliberately.)*
- **UDID-aware arbiter + multi-session** ("keep working on the dev sim while a run executes"). v1 is honest **stop-the-world**.
- Native rebuild each run (v1 uses `cdp_reload` against the running Metro — see Resolved opens).
- Android (iOS-first; the design is platform-neutral where cheap).
- Scheduling / run-on-save, bundle-change detection, flaky-retry policy.

## The lifecycle (the core mental model)

```
  ACTION (repairable)                LOCK GATE                 LOCKED E2E TEST (frozen)        REGRESSION SUITE
  .rn-agent/actions/<id>.yaml   →   must pass one clean    →   .rn-agent/e2e/<id>.yaml     →   run all locked tests
  auto-repairs on drift             STRICT run (no repair)     immutable baseline, never       STRICT; any failure = red
  (dev prologue, dev sim)                                      auto-repaired
```

- The action **stays** a repairable dev prologue. Locking takes a **frozen copy** — the two coexist (mirrors the plugin's two-regime philosophy: resilient in dev, strict once locked).
- "Repaired until working" happens in normal dev use (`cdp_run_action` auto-repairs). The **lock** verifies the result is genuinely green *with repair off*, then freezes it. Every locked test was provably green at lock time → a later strict failure is a trustworthy regression.
- When a locked test fails because the UI **legitimately** changed (not a regression), the user repairs the source action in dev, then **re-locks** (re-snapshots). Re-lock is a conscious "approve the new truth" act.

This is the **approval / golden-file testing** pattern applied to live E2E. It reuses two existing precedents: the `experimental → active` auto-promotion gate (GH #174) for "promote only what's verified," and the repair-refuses-on-human-edit mtime guard (`repair-action.ts`) for "frozen artifacts are off-limits to the repairer."

## Architecture (Approach C — thin orchestrator over the proven inner loop)

Chosen over Approach A (a fully standalone subsystem) after a Codex + Claude debate (see Plan review). C reuses the hardened flow internals and confines new risk to a few new modules; A would re-implement the dangerous glue and still owe all the same work.

**Key reuse decision:** the orchestrator loops the **`maestro_run` core** per test — *not* `maestro_test_all`. All the hardened glue (flow validation, canonical temp-YAML re-serialization, runner parking, failure parsing) lives in `maestro_run`; `maestro_test_all` is only a discovery+loop+summary **and it drops Maestro `params`**, which locked tests need. Looping `maestro_run` reuses the hardened internals, gets `params` for free, and gives us per-test SSE progress + classification control — without modifying any existing tool.

**Lease discipline (critical):** the orchestrator acquires **exactly one** exclusive `flow` lease and then calls the *unwrapped* `maestro_run` core (not the `trackedTool`-wrapped MCP tool), matching the existing composite-tool pattern so we don't double-lease/deadlock against the arbiter.

### New modules (following repo conventions: types/IO in `domain/`, handlers in `tools/`)

| File | Role |
|---|---|
| `scripts/cdp-bridge/src/domain/e2e-test.ts` | Locked-test type + freeze/snapshot IO + content hashing; reads/writes `.rn-agent/e2e/<id>.yaml` |
| `scripts/cdp-bridge/src/domain/e2e-run.ts` | `E2eRunRecord` type + persistence (`.rn-agent/state/e2e-runs/`) + `index.json` + diff-vs-last-green |
| `scripts/cdp-bridge/src/domain/e2e-run-request.ts` | Durable run-request + state machine (crash recovery) |
| `scripts/cdp-bridge/src/tools/lock-e2e-test.ts` | `cdp_lock_e2e_test` handler (verify clean strict run → freeze) |
| `scripts/cdp-bridge/src/tools/run-e2e-suite.ts` | `cdp_run_e2e_suite` orchestrator handler |
| `scripts/cdp-bridge/src/observability/e2e-control.ts` | POST/GET route handlers + security guards for the observe server |
| extend `scripts/cdp-bridge/src/observability/server.ts` | mount the e2e routes; receive an injected `triggerE2eRun()` callback (no direct device access) |
| extend `scripts/cdp-bridge/src/observability/web/src/main.tsx` | new top-level **Regression** view |
| extend `scripts/cdp-bridge/src/index.ts` | register `cdp_lock_e2e_test` + `cdp_run_e2e_suite` via `trackedTool`; wire `triggerE2eRun` into the observe server |

New MCP tools (also callable by Claude): `cdp_lock_e2e_test`, `cdp_run_e2e_suite`. (A `cdp_list_e2e_tests` / re-lock surface may reuse `learned-actions` — see Open questions.)

## Lock (promotion) sequence — `cdp_lock_e2e_test(actionId, { relock? })`

1. Load the action; error if missing.
2. Acquire the exclusive `flow` lease; run it **once, strict** (`maestro_run` core, repair **off**) on the booted sim, with params from `e2e.config.json`.
3. **Fail → refuse the lock** with the failure detail ("repair the action until it passes strict, then lock"). This is the gate.
4. **Pass → freeze:** copy the flow YAML into `.rn-agent/e2e/<id>.yaml` with a lock header: `lockedAt`, `sourceActionId`, `sourceContentHash`, `lockedGitSha`, `status: locked`. Upsert the e2e-test index.
5. Return the locked-test metadata. `relock: true` overwrites an existing frozen copy and bumps `lockedAt` (same gate applies).

## Run sequence — `cdp_run_e2e_suite({ pattern? })` (also via `POST /api/e2e/run`)

1. **Single-slot guard** — refuse (`E2E_RUN_ACTIVE`) if a run is already in flight.
2. Write the run-request to disk (`status: requested`) **before** any work.
3. **Pre-flight gate** — Metro reachable? app installed on the sim? device booted + Maestro runner available? If the environment is broken, abort with a clear **`SETUP_ERROR`** (never a misleading green/red). CDP is **not** required here — it is used only for the optional reload in step 5. *(This is how environment problems are kept out of the per-test verdict — see Strict mode.)*
4. Stamp `gitSha` + dirty flag onto the run (records *what code* was tested).
5. **Optional `cdp_reload`** — if CDP is connected, pull a clean latest JS bundle from Metro and reset to the initial route (sets `metroReloaded: true`). If CDP is down, **skip with a warning** and run against whatever the app currently has loaded (`metroReloaded: false`); the Maestro flows themselves do not need CDP.
6. Acquire the exclusive `flow` lease (status → `running`).
7. Discover locked tests in `.rn-agent/e2e/` (filter by `pattern`). For each: call `maestro_run` core with `params`, **no repair**; collect `{ passed, durationMs, failureKind, errorExcerpt }`; emit an SSE progress event; update the run-request progress.
8. **Classify** each failure (below), compute the verdict, write the `E2eRunRecord`, update `index.json`, compute the diff vs `previousGreenRunId`.
9. Release the lease (status → `done`).

## Strict mode + verdict classification (conservative — "treat as regression")

Strict is achieved structurally: the suite **never routes through `cdp_run_action`**, so there is no repair to disable. Then:

- **Environment problems are caught by the pre-flight gate (step 3) and abort the whole run as `SETUP_ERROR`** — they never become per-test results.
- **Once the suite is actually running, any flow failure = regression = a RED verdict.** Likely-infra causes (e.g. a mid-run timeout) are kept as triage **annotations** on the result, but they do **not** soften the verdict. This is the deliberate conservative bias: never let a misclassification hide a real break.

Verdict: `green` (all passed) · `red` (≥1 failure) · `setup_error` (pre-flight aborted; inconclusive, not counted as green or red).

## Data model

### Locked e2e test — `.rn-agent/e2e/<id>.yaml`
Frozen copy of the action's flow body + a lock header (`lockedAt`, `sourceActionId`, `sourceContentHash`, `lockedGitSha`, `status: locked`). Immutable except via re-lock. Never touched by `cdp_repair_action`.

### Suite-run record — `.rn-agent/state/e2e-runs/<runId>.json`
```jsonc
{
  "runId": "...", "startedAt": "...", "finishedAt": "...", "durationMs": 0,
  "gitSha": "...", "gitDirty": true, "platform": "ios", "deviceId": "<udid>",
  "metroReloaded": true,
  "totals": { "total": 0, "passed": 0, "failed": 0 },
  "verdict": "green|red|setup_error",
  "results": [
    { "testId": "...", "intent": "...", "passed": true,
      "durationMs": 0, "failureKind": null, "infraAnnotation": null, "errorExcerpt": null }
  ],
  "previousGreenRunId": "..."        // for the "newly failing since last green" diff
}
```
Plus a bounded `.rn-agent/state/e2e-runs/index.json` (newest-first, for the dashboard + trend strip).

## Control endpoint + security

A trigger that runs flows is RCE-shaped (Codex catch), so the new write path is guarded:
- `POST /api/e2e/run` — **CSRF token** (minted into the served HTML, echoed in the request), strict `Origin`/`Host` + `Sec-Fetch-Site` checks, `Content-Type: application/json` required, **never GET-triggered**. Body: `{ pattern? }`.
- `GET /api/e2e/runs` and `/api/e2e/runs/:id` — read history/detail.
- Live progress rides the **existing SSE** stream (`/api/stream`).
- The observe server receives only an injected `triggerE2eRun()` callback — **not** device/arbiter handles — so the read-only boundary of the server module stays intact.

## Observe page (UI)

Top-level toggle: **Live** (today's view) | **Regression** (new). The Regression view:
- A **Run** button (disabled while a run is active) + a "run in progress" banner.
- Live progress: `test 3/12 ✓ ✓ ✗ …` driven by SSE.
- Latest verdict + a per-test table with pass/fail and a regression/infra badge.
- A history strip showing the green/red trend, with **newly-failing tests highlighted** (the diff-vs-last-green).

## Durability / crash recovery

The supervisor rebuilds all in-memory state on worker respawn, so an in-flight run would otherwise vanish silently. Mitigation: the run-request is persisted on disk with a state machine `requested → reloading → running → done | failed | cancelled`. On worker startup, any request left in `reloading`/`running` with no live process is marked **`interrupted`** (not lost). Cancellation is a v1.1 nicety.

## Concurrency

v1 is **stop-the-world by nature** — the suite runs on the same booted sim you'd otherwise use, and it holds the exclusive `flow` lease for its duration. While a run is active, agent-driven `device_*` taps refuse `BUSY_FLOW_ACTIVE` (expected); L1 CDP reads and `device_screenshot` (simctl fallback) still work. True "keep working during a run" requires the deferred UDID-aware arbiter + multi-session work.

## Resolved opens (defaults; flag to change)

- **Build freshness** → `cdp_reload` (latest JS from Metro), no native rebuild in v1. ("Fresh build each run" was a property of the deferred *isolated-install* path.)
- **Params** → from a new `.rn-agent/e2e.config.json`, threaded via `maestro_run`'s `-e KEY=VALUE`; **secret redaction** in logs/SSE; a param-needing test with no value is **skipped**, not failed.
- **Test set** → all locked tests; `pattern` filter exposed.
- **Fast Refresh racing a run** → stamp `gitSha`/dirty + warn "don't edit during a run"; live bundle-change detection is deferred.

## Phasing

- **v1 (this spec):** promotion/lock lifecycle + strict-on-booted regression runner + Regression page + persistence + crash recovery.
- **Phase 2:** isolated sim (provisioning + UDID threading incl. the `get_app_container booted` site + no-`setActiveSession` handling).
- **Phase 3:** UDID-aware arbiter + multi-session (keep working during a run).
- **Later:** native rebuild option, Android, scheduling/run-on-save, bundle-change detection, flaky-retry, cancellation.

## Testing (TDD)

Unit: lock gate (refuse on strict-fail; freeze + correct lock header/hash on pass); strict classification (pre-flight `SETUP_ERROR` separation; any in-run failure → red); `E2eRunRecord` write + diff-vs-last-green; run-request state machine + `interrupted` recovery; endpoint security (CSRF/Origin/method/Content-Type, GET refusal); single-slot guard; params redaction. Device smoke: lock a sample action, run the suite green; introduce a drift, confirm red + newly-failing highlight + that the locked file was **not** auto-repaired.

## Plan review (Codex gpt-5.5 + Claude Opus, 2026-06-18)

Both independently chose **C over A**. Findings that shaped this spec:
- **A. The orchestrator is the easy part.** The real cost is three blockers that exist *only* to support an isolated sim: no `simctl boot/create` primitive anywhere in the bridge; the singleton `activeSession`/runner layer (`agent-device-wrapper.ts:58`, `device-session.ts:51`) would evict the dev session; UDID threading is incomplete until the hardcoded `get_app_container booted` (`resolve-ios-app-file.ts:114`) is parameterized. → **Resolved by deferring isolation (v1 = strict-on-booted), which removes all three.**
- **B. Off-lease parallelism is unsafe in-process** (runner + CDP parking are process-global). → v1 is honest **stop-the-world**.
- **C. `maestro_test_all` drops `params`.** → loop `maestro_run` core instead.
- **D. The control endpoint is RCE-shaped.** → CSRF + Origin/method/Content-Type guards, never GET.
- **E. Supervisor restarts lose in-memory state.** → durable on-disk run-request + interrupted recovery.

## Open questions (minor — for spec review)

1. **Git tracking:** commit `.rn-agent/e2e/` locked tests (shareable regression baselines) but gitignore `.rn-agent/state/e2e-runs/` (machine state)? Recommended: yes.
2. **Re-lock / list surface:** expose `cdp_list_e2e_tests` + a UI "Promote to e2e" / "Re-lock" button now, or CLI-only (`/lock-e2e <action>`) in v1?
3. **Backend/test-data isolation:** out of scope (device isolation ≠ DB isolation); locked tests own their setup/state. Confirm acceptable for v1.
