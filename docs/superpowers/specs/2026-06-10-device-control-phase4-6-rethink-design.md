# Design — #202 re-think: Phases 4–6 (eradicate · survive · arbitrate)

- **Issue:** #202 (architecture: 3-layer device control + Session Arbiter) — still OPEN after Phases 1–3
- **Absorbs:** the issue's 2026-06-08 comment (on-device legacy runner relaunch), #264 (MCP server dies on Metro restart), #186 (maestro-mcp interop / dual-surface fragmentation), residual #201 verification
- **Builds on:** Phase 1 `ensureSingleRunner` (#205), Phase 1.5 `DeviceLock` (#213), Phase 2a `DeviceSessionArbiter` (#215), Phase 2b `recoverWedge` (#216), Phase 3 contract docs + foreign-runner warning (#221), #210 visibility/self-healing, #237 Android slot handoff
- **Scope decision (user, 2026-06-10):** full re-think, all three fronts; Front B resolved as **supervisor split** (not harden-only)

---

## 0. The re-think — what the post-shipping evidence changed

Phases 1–3 implemented the #202 design as debated. Three pieces of field evidence
show the design enforced ownership at the wrong **lifetime** — each guarantee was
anchored to an artifact that dies sooner than the threat it guards against:

| # | Guarantee as shipped | Anchored to | What actually outlives it | Evidence |
|---|---|---|---|---|
| A | "one interaction runner" — SIGTERM/SIGKILL legacy `AgentDeviceRunner` **processes** (UDID-scoped argv match) + daemon-file cleanup | a process | the **installed app** (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) stays on the simulator; iOS relaunches it to the foreground mid-`maestro_run`, re-wedging CDP | #202 comment 2026-06-08: only `simctl uninstall` fixed it; `RN_DEVICE_KILL_LEGACY` never touched the on-device app |
| B | "the bridge is the long-lived owner" — in-memory arbiter lease, wedge counters, lock heartbeats all live in the MCP server process | a process | nothing — `lsof -ti tcp:8081 \| xargs kill -9` (a documented Metro-recovery step) SIGKILLs the bridge too, because it holds **client sockets to :8081** (CDP WS, metro-events WS). CC does not respawn MCP subprocesses → all 77 tools gone until full session restart | #264, hit twice across two days |
| C | "foreign runners coexist by contract" — written contract + one-time `FOREIGN_RUNNER_ACTIVE` warning at device-open | documentation | the foreign runner — maestro-mcp never reads docs; the 3-surface fragmentation (plugin `maestro_run` / standalone maestro-mcp / raw CLI) and the ~44 s leak-recovery cascade on collision remain | #186 still open; Phase 3 explicitly deferred consolidation |

**Revised debate conclusions (supersede nothing, extend D-series):**

1. *Eradication targets artifacts, not processes.* On iOS the legacy runner is
   retired (D1219); the only correct end-state is **not installed**.
2. *"Long-lived bridge" is a requirement to engineer, not an assumption to hold.*
   The component that owns stdio with Claude Code must hold **zero network
   sockets**; everything networked must be respawnable beneath it. (The code
   already anticipated this: the SIGUSR2 → exit 1 path is documented as "for
   future supervisor wiring".)
3. *A foreign flow is an arbiter input, not a footnote.* Detection exists
   (`external-runner-detect.ts`); wiring it into the lease decision converts a
   ~44 s collision cascade into a fast, explained refusal — consistent with the
   arbiter's existing `BUSY_FLOW_ACTIVE` semantics.

Standing decisions **re-affirmed** (debated again, unchanged): RnFastRunner stays
as L2 (sub-second primitives, @ref handles, fiber taps, in-process CDP handoff —
re-validated by #210's rejection of a WDA W3C client); the arbiter lease stays
**in-memory** (persisting it recreates the orphaned-lock hazard; the supervisor
makes the memory durable enough); no separate arbiter daemon.

---

## 1. Phase 4 — eradicate legacy runner apps (small, ships first)

**Problem.** `ensureSingleRunner()` (`runners/ensure-single-runner.ts`) kills
host processes and clears `~/.agent-device/daemon.{json,lock}`. The installed
simulator apps survive and are relaunched by iOS during WDA sessions, stealing
foreground from the app under test.

**Design.** Extend `ensureSingleRunner({ udid })` with an iOS app-eradication
step after the existing process kill:

```
LEGACY_BUNDLE_IDS = [
  'com.callstack.agentdevice.runner',
  'com.callstack.agentdevice.runner.uitests.xctrunner',
]
eradicateLegacyRunnerApps(udid, deps):
  installed = parse(simctl listapps <udid>)        // bundle-id scan, error-safe
  for id in LEGACY_BUNDLE_IDS ∩ installed:
    simctl terminate <udid> <id>                   // ignore "not running"
    simctl uninstall <udid> <id>
  → { removedApps: string[], warnings: string[], timings }
```

- **Gate:** same `RN_DEVICE_KILL_LEGACY` env (default ON, `=0` opts out) — one
  knob for the whole legacy-eradication behavior, as documented today.
- **Call sites:** unchanged — the single udid-bearing `ensureSingleRunner`
  caller (device-open, `device-session.ts`) inherits it. (Plan-review
  correction 2026-06-10: `cdp_repair_action` self-bootstrap does NOT call
  `ensureSingleRunner` — grep confirms only device-open + the no-udid boot
  call.) No new startup-time work (boot-time call has no udid → files-only
  pass, as today).
- **Idempotence/cost:** once uninstalled, the `listapps` scan finds nothing —
  steady-state cost is one `simctl listapps` (~tens of ms) per device-open.
  Memoize per (session, udid) after a clean scan to make repeat opens free.
- **Failure handling:** every step error-safe; a failed uninstall appends a
  warning (with the manual command) and never blocks the session. Result
  surfaces `removedApps` + `meta.timings_ms.appEradication`.
- **Result shape:** `EnsureSingleRunnerResult` gains `removedApps: string[]`.
- **Docs:** CLAUDE.md + docs-site troubleshooting rows that prescribe manual
  `pkill -f AgentDeviceRunner` get "since Phase 4 the plugin also uninstalls
  the legacy runner apps automatically".
- **Tests:** unit (injected deps: listapps output fixtures incl. absent /
  present / malformed; terminate/uninstall failures) + one live gate: plant the
  legacy bundle on a booted sim (install any stub .app under that bundle id, or
  the real one if available), run device-open, assert uninstalled.

**Non-goals:** Android (covered by #237's slot handoff); uninstalling *our own*
RnFastRunner (explicitly wanted installed); touching foreign non-legacy runners
(that's Phase 6's arbitration, not eradication).

---

## 2. Phase 5 — bridge survivability: the supervisor split (#264)

**Problem.** Restarting Metro is a routine, plugin-recommended recovery step,
yet it can take down the entire MCP server:

- *Kill-by-port* (`lsof -ti tcp:8081 | xargs kill -9`): the bridge holds client
  sockets to Metro's :8081, so it matches and gets SIGKILLed. Unsurvivable
  in-process by definition.
- *Graceful Metro stop/restart*: must NOT be fatal — any remaining crash path
  here is a plain bug (the `events-client.ts stop()` listener-gap class).

**Task 0 — diagnosis matrix (before any code).** Reproduce both variants
against the live test-app and record the actual failure mode of each:
(a) Metro stopped gracefully, (b) Metro killed by PID, (c) kill-by-port with
bridge attached, (d) new Metro started after each. Expected: (a)/(b) leave the
bridge alive (else: TDD-fix the crash path), (c) SIGKILLs the bridge —
motivating the split. Findings logged in the plan before Task 1 proceeds.

**Design — supervisor split.**

```
Claude Code ⇄ stdio ⇄ supervisor.ts (NO network sockets)
                          │ spawn + pipe stdio, respawn on death
                          ▼
                      worker (today's index.ts — CDP WS, metro WS,
                      runner HTTP, arbiter, device locks)
```

- **Entry point:** `.mcp.json` command becomes `dist/supervisor.js`. Escape
  hatch `RN_BRIDGE_SUPERVISOR=0` → supervisor `exec`s the legacy single-process
  path (debugging, bisecting).
- **Byte forwarding:** supervisor pipes CC⇄worker stdio verbatim — it does NOT
  parse tool traffic. The only protocol awareness it has:
  1. it **caches the `initialize` request** from CC (first frame) and the
     worker's response;
  2. on respawn it replays the cached `initialize` to the fresh worker and
     swallows the duplicate response;
  3. requests in flight when the worker dies get a JSON-RPC error response
     (`-32000`, "bridge worker restarted — retry the call") so CC's tool calls
     fail fast and cleanly instead of hanging.
- **Respawn policy:** bounded backoff — max 3 respawns per rolling 60 s, then
  the supervisor stays up but answers tool calls with a terminal error naming
  the worker's last exit cause + log path (no infinite crash-loop). A clean
  worker exit (code 0, supervisor-initiated shutdown) does not respawn.
- **Lock ownership moves with lifetime:**
  - single-instance project `Lockfile` + `startParentDeathWatch` → **supervisor**
    (it is now the durable per-project singleton); worker is spawned with
    `--no-lock`.
  - UDID device lock stays in the **worker** (it guards a device *session*,
    which dies with the worker; its PID-liveness + heartbeat reclaim already
    handles holder death by design — Phase 1.5).
  - graceful-shutdown signal handling: supervisor forwards SIGTERM/SIGINT to
    the worker, waits bounded, then exits; worker keeps its existing
    `buildGracefulShutdown` path.
- **Worker-side hardening (from Task 0 findings):** Metro/CDP loss degrades to
  `cdp_status → { metro: 'down' }` with the existing reconnect/backoff;
  re-audit `removeAllListeners`/'error'-emitter gaps in `metro/events-client.ts`
  and `cdp-client.ts` (the one class of crash observed before).
- **Visibility:** `cdp_status` gains
  `bridge: { supervised: boolean, workerRestarts: number, lastWorkerExit?: string }`
  (worker learns restart count via env/argv from supervisor).
- **What is lost on a worker restart (accepted, documented):** in-memory arbiter
  lease, ring buffers (console/network/log), CDP connection, recorded-walk
  state. All are session-scoped caches that self-heal on next use; the
  alternative (persisting them) was rejected in the original debate and stays
  rejected.
- **Tests:** unit-test the supervisor's framing/respawn logic with a scripted
  fake worker (death mid-request, double-init swallow, backoff cap); live gate:
  spawn real server under supervisor, `kill -9` the worker, assert next
  `cdp_status` succeeds in the same MCP session; repeat via actual kill-by-port
  against a running Metro.

**Non-goals:** surviving supervisor SIGKILL (CC session restart is the floor);
persisting arbiter/ring-buffer state; multi-worker pooling.

---

## 3. Phase 6 — canonical Maestro surface + arbiter-aware foreign flows (#186)

**Problem.** Phase 3 shipped a one-time warning; #186's fragmentation remains:
three surfaces for one engine, and a foreign maestro session still collides
with local L2/L3 (the ~44 s `RUNNER_LEAK → full-relaunch` + CDP desync cascade).

**Design.**

- **(a) Verify-and-close the escape hatches.** The two reasons users left the
  plugin surface were `--app-file` (#201) and the `runFlow` allowlist (#188).
  PR #205 claims #201; #188 claims the allowlist; both get a live gate
  (clearState flow on iOS end-to-end via `maestro_run`; a saved action using
  `runFlow` via `cdp_run_action`), then #201 is closed with the gate as
  evidence. Any gap found is fixed in this phase (TDD).
- **(b) Foreign flow = external flow-plane holder.** Wire
  `detectIosExternalRunner(udid)` into the arbiter decision at acquire time:
  when a UDID-scoped foreign maestro session is live and no local flow lease is
  held, treat the flow plane as **externally held** —
  - L2 `device_*` and L3 `maestro_run`/`cdp_run_action` refuse fast with
    `BUSY_FOREIGN_FLOW` (message: what was detected, that L1 reads remain safe,
    how to opt out);
  - L1 CDP reads, diagnostics, and connection tools stay unarbitrated (the
    contract's "L1 never conflicts");
  - `device_screenshot` keeps its simctl fallback (mid-foreign-flow pixels stay
    available, mirroring the local-flow `FLOW_FALLBACK_TOOLS` design).
  - **Cost control:** detection result cached with a ~5 s TTL so per-call cost
    is one `ps` scan per window (~10–20 ms worst case, recorded in
    `meta.timings_ms.foreignScan`).
  - **Knob:** reuse `RN_IOS_FOREIGN_WARN=0` — one switch disables both the
    warning and the refusal (renamed semantics documented; env name kept for
    back-compat).
  - **Failure mode:** detector error or `ps` timeout → fail-open (no refusal,
    optional warning), never block on infra.
- **(c) Docs.** The maestro-interop docs-site page + CLAUDE.md declare plugin
  `maestro_run` the **canonical** Maestro surface (it participates in the
  arbiter, parks the L2 runner, marks CDP stale, auto-repairs actions); the
  standalone maestro-mcp coexists for ad-hoc use and is now *refused against*
  rather than collided with mid-flow.

**Non-goals:** cross-process lease handshake with maestro-mcp (no protocol
exists; refusal + guidance covers the observed failure — YAGNI, re-affirmed);
`maestro_run` ergonomics (#211 structured step results, #240 single-step mode)
stay independent issues.

---

## 4. Sequencing, delivery, risk

| Phase | Size | Risk | Depends on | PR shape |
|---|---|---|---|---|
| 4 — eradicate apps | S | low (one module + docs) | — | stacked on main |
| 5 — supervisor split | L | medium (entry-point change; mitigated by `RN_BRIDGE_SUPERVISOR=0`, Task 0 matrix, live kill gates) | — | own branch; ships behind default-ON only after live gates pass |
| 6 — foreign arbitration | M | low-medium (refusals could false-positive → fail-open + TTL cache + knob) | arbiter (shipped) | stacked on 5 or main (independent) |

Per repo workflow: each phase gets its own TDD plan (`docs/superpowers/plans/`),
a multi-LLM plan review (`/brainstorm gemini,codex`) **before** code, signed
per-task commits, changesets, stacked PRs, live verification on the booted
simulator (Phases 4/6 also touch Android docs but ship iOS-only behavior).
A summary of this re-think is posted as a comment on #202 (issue-first record);
#264 and #186 are closed by Phases 5 and 6 respectively; #202 closes when all
three phases land.
