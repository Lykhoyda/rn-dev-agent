# Design — Phase 3: formalize the 3-layer contract + foreign-runner coexistence (#202 / #186)

- **Issue:** #202 Phase 3 (final phase) · **Field report:** #186 (rn-dev-agent + maestro-mcp interop)
- **Builds on:** Phase 1 (`ensureSingleRunner`), Phase 1.5 (`DeviceLock`), Phase 2a (`DeviceSessionArbiter`), Phase 2b (`recoverWedge`) — all merged to `main` via #218.
- **Platform:** iOS (the contention #186 reports is iOS-only; Android already warns via `detectAndroidExternalRunner`).
- **Approach:** Formalize the §2 contract in docs + add a **proactive** foreign-runner detection warning. The *reactive* recovery (don't-evict + CDP re-pin) already shipped in **#188** — see §0.

---

## 0. Status reconciliation — what already shipped (#188)

The brainstorm's "approach B" (detect → don't-evict → auto-settle) was scoped before auditing `main`. **PR #188 (`fix(#186): maestro-interop`) already shipped the reactive functional fix**, so Phase 3 does **not** rebuild it:

| #186 item | Status | Where in `main` |
|---|---|---|
| 7 — driver eviction (the ~91 s cascade) | ✅ shipped (#188) | `runner-leak-recovery.ts` **Tier-0 `reacquire`** + `device-session.ts:reacquireIosTargetApp` (state-preserving re-foreground, no relaunch) |
| 2 — silent CDP desync | ✅ shipped (#188) | `markCdpStale()` in the device-session recovery path |
| 1 — `runFlow` allowlist | ✅ shipped (#188) | — |
| 3 — route-structure drift | ✅ shipped (#188) | — |

#188's brainstorm explicitly **rejected** an "is-it-foreign?" heuristic for the *recovery* path: field telemetry labels the maestro-eviction case with the same `agent-device-runner-leak` sentinel as the daemon-leak, so a cause-agnostic cheap reacquire tier was chosen. Phase 3 therefore does **not** make the recovery foreign-aware.

**What Phase 3 actually adds:**
- **(A)** Formalize the §2 three-layer contract in `CLAUDE.md` + `docs-site`, and document the #188 handoff behavior. *(genuinely missing)*
- **(B)** A **proactive** `detectIosExternalRunner()` + a non-blocking `FOREIGN_RUNNER_ACTIVE` warning surfaced on `device_snapshot action=open` — a heads-up that a foreign maestro/WDA session is present *before* a leak, complementing #188's *reactive* recovery. *(genuinely missing)*

## 1. Problem

Phase 2a's `DeviceSessionArbiter` ended *internal* device-plane contention: the plugin's own L1/L2/L3 tools share one process and one in-memory lease, so the arbiter can serialize them. But #186 is about a **foreign** runner — the standalone **`maestro-mcp`** server (`mcp__maestro__*`), a *separate process* that never calls `tryAcquire` and is therefore structurally invisible to the arbiter.

Observed (#186, item 7): maestro-mcp and rn-dev-agent both drive the same iOS simulator's **XCUITest** automation channel (maestro via WDA, rn-dev-agent via `RnFastRunner`). iOS grants one foreground automation session, so they evict each other. After a sequence of `mcp__maestro__run` calls, the next rn-dev-agent `device_snapshot` triggered a `RUNNER_LEAK → full-relaunch` (~44 s), and the subsequent `cdp_navigation_state` failed `STALE_TARGET` (~47 s) until a manual `cdp_status` re-pinned the CDP target (#186 item 2 — the silent CDP desync).

Key narrowing: rn-dev-agent's *verification* is mostly **L1 (CDP reads)** — `cdp_navigation_state`, `cdp_store_state` — which **do not touch XCUITest**. The interleave #186 wants (maestro executes, rn-dev-agent verifies) only contends when verification reaches **L2 `device_*`**. So the fix is "**re-attach instead of evict** on L2, and auto-re-pin CDP," not "block the interleave." **That reactive fix already shipped in #188 (§0); Phase 3 adds the *proactive* warning + the written contract.**

## 2. North-star: the three-layer contract (written down)

| Layer | Mechanism | Role | Exclusivity | Behavior toward a **foreign** runner |
|---|---|---|---|---|
| **L1 INTROSPECTION** | CDP / Hermes (the bridge) | read store / network / component-tree / mmkv / native | **shared** | **always safe** — never touches XCUITest; keeps working during/after a foreign session |
| **L2 INTERACTION** | iOS `RnFastRunner` / Android `agent-device`; `cdp_interact` (fiber path) | primitive taps / types / scrolls | **shared** | **re-attach, do not evict** — prefer `attach-only` over `full-relaunch` when a foreign session is present |
| **L3 FLOW-REPLAY** | `maestro-runner` (Go + WDA) | whole-`.yaml` E2E flows only | **exclusive** | owns the device for the flow's duration |

**Coexistence rule:** *L1 reads never conflict with a foreign runner; L2 re-attaches rather than evicts; L3 owns the device.* The device-session **already honors** this rule (via #188's reacquire tier + CDP re-pin); Phase 3 writes it down and adds a proactive heads-up when the contention is present.

This contract is currently implicit (scattered across `CLAUDE.md` prose + code). Phase 3 makes it explicit in `CLAUDE.md` and `docs-site`, and adds a **"Using rn-dev-agent alongside maestro-mcp"** handoff page.

## 3. Part A — documentation

- **`CLAUDE.md`** — a "Three-layer device-control contract" subsection: the table above + the coexistence rule. Cross-reference the existing Architecture section.
- **`docs-site/src/content/docs/architecture.mdx`** — same contract table + coexistence rule.
- **`docs-site`** — a new short page **"Using rn-dev-agent with maestro-mcp"**: what is safe to interleave (L1 reads always; L2 self-recovers), what the **#188 reacquire + CDP re-pin** does on handback, that the new `FOREIGN_RUNNER_ACTIVE` warning is informational, and that L3 maestro flows own the device. This is the "documented handoff pattern" #186 asked for.

## 4. Part B1 — iOS foreign-runner detection

New `detectIosExternalRunner()` in the existing `scripts/cdp-bridge/src/runners/external-runner-detect.ts` (mirrors `detectAndroidExternalRunner`):

```
detectIosExternalRunner(
  execFileImpl = execFile,
): Promise<IosExternalRunnerWarning | null>

interface IosExternalRunnerWarning {
  platform: 'ios';
  code: 'IOS_XCUITEST_COMPETITOR';
  message: string;
  processLines: string[];
}
```

- `ps`-scan (`ps ax -o pid=,command=`) for foreign maestro/WebDriverAgent automation processes, **excluding our own `RnFastRunner`** host + UITests-runner processes (matched by the `RnFastRunner` app name — the iOS process command shows the app name, not the bundle id; validate against a live `ps` before shipping).
- Match set (documented, narrow to avoid self-match): `WebDriverAgent` / `WebDriverAgentRunner` (maestro's iOS driver) and the `maestro` CLI. `XCTRunner` is intentionally **left out** — too generic; it would catch our own runner. (`maestro`/WDA can also be rn-dev-agent's *own* L3 driver; §5's gate disambiguates via the arbiter flow lease.)
- Returns `null` on no match or on any error (error-safe, like the Android detector). Injectable `execFile` → fully `node --test`-mockable.

## 5. Part B2 — proactive `FOREIGN_RUNNER_ACTIVE` warning

The *reactive* recovery already exists (#188, §0). Phase 3 adds only a **proactive, non-blocking heads-up**: after a successful iOS `device_snapshot action=open`, detect a foreign session and warn — so the user knows the device is contended *before* hitting a leak.

**Wiring** (`device-session.ts`, the iOS `action=open` success path):
1. Best-effort, timeout-bounded `detectIosExternalRunner()` (never throws; failure → no warning).
2. **Gate — foreign vs. ours:** treat a hit as foreign only when `arbiter.snapshot.flowLeaseHeldBy === null`. rn-dev-agent's own L3 `maestro-runner` also spawns WDA; if we hold the flow lease the WDA is ours (and an L2 call would already be refused `BUSY_FLOW_ACTIVE` upstream).
3. On a gated hit, attach to the open result: `meta.foreignRunner = { code: 'IOS_XCUITEST_COMPETITOR', message, processLines }` + a human-readable warning string.

**Strictly informational.** It does **not** refuse, evict, or change the open behavior — #188's reacquire tier already handles an actual leak if one occurs. This keeps Phase 3 additive and the arbiter untouched (no cross-process lease coupling).

## 6. Data flow

**Already in `main` (#188) — reactive recovery on a real leak:**
```
mcp__maestro__run (external, L3/WDA)          # maestro owns XCUITest
        │
        ▼
device_snapshot (rn-dev-agent, L2)            # sees the AgentDeviceRunner sentinel
        │
        ▼
Tier-0 reacquire (re-foreground target, no relaunch) → markCdpStale   # #188
        │
        ▼
snapshot returns; the next CDP read reconnects transparently
```

**Added by Phase 3 — proactive warning on open (no leak required):**
```
device_snapshot action=open (iOS, success)
        │
        ├── arbiter.flowLeaseHeldBy === null ?  ──no──▶ (WDA is ours; no warning)
        │                yes
        ▼
detectIosExternalRunner() fires → meta.foreignRunner + FOREIGN_RUNNER_ACTIVE warning   # informational only
```
Throughout, **L1 CDP reads keep working** — they never touched XCUITest.

## 7. Out of scope (YAGNI)

- **Done in #188 (§0), Phase 3 does not touch:** item 1 (runFlow allowlist), item 2 (CDP re-pin), item 3 (route-drift), item 7 (reacquire / eviction).
- **Deferred to follow-up issues:** item 4 (shared device handle across the two MCPs), item 5 (unified telemetry — maestro-mcp calls in rn-dev-agent's timeline), item 6 (warm maestro session — avoid per-call driver startup).
- **No** change to the recovery path, the arbiter, or Android behavior. The new detection is **informational only**.

## 8. Testing strategy

All `node --test`, no live simulator:
- `detectIosExternalRunner`: matches a foreign WDA/maestro line; **excludes our fastrunner**; `null` on none; error-safe on `ps` failure.
- proactive-warning wiring (pure helper, injected deps): on a detector hit **with no flow lease**, the open result carries `meta.foreignRunner` + a `FOREIGN_RUNNER_ACTIVE` warning; on a hit **while a flow lease is held**, **no warning** (the WDA is ours); detector error → no warning, open unaffected.
- a light **doc-presence assertion** that the "Three-layer device-control contract" subsection exists in `CLAUDE.md` (guards doc drift).

## 9. Failure-mode matrix

| Failure (#186) | Status | Detection | Handling |
|---|---|---|---|
| Foreign session evicts L2 (the ~91 s cascade) | #188 (existing) | AgentDeviceRunner sentinel | Tier-0 reacquire → `markCdpStale` |
| Foreign session present, no leak yet | **Phase 3** | `detectIosExternalRunner()` on open, gated on `flowLeaseHeldBy === null` | informational `FOREIGN_RUNNER_ACTIVE` warning (no behavior change) |

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Detection signature drift (maestro/WDA process names vary by version) | Validate the matcher against a live `ps aux` before shipping; keep the match set broad + documented; note the Maestro Viewer `:9999` probe as a future augmentation |
| Over-detection (flagging our own runner) | Exclude `dev.lykhoyda.rndevagent.fastrunner`; gate on `flowLeaseHeldBy === null`; unit tests assert both |
| Warning noise on every open | Warning is informational + only on a gated hit; detector is best-effort + timeout-bounded so it never delays or fails an open |

## 11. Conventions

- Explicit type imports; no unnecessary comments; CDP tree queries always filtered.
- The `device_snapshot` open result carries `meta.foreignRunner` when a gated detection hit occurs; detection latency folds into the existing open `meta.timings_ms`.
- `dist/` is tracked — staged rebuilt; one changeset for the increment.
