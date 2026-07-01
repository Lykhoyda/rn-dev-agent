# Story 13 — Seamless integration with the existing maestro-runner (Go)

**Status:** Proposed (2026-07-02) — replaces Story 07 as the near-term replay direction (D1290; Story 07 postponed, kept as the documented escalation path)
**Epic:** [Maestro adoption](README.md)
**Impact:** Replay stays on the proven Go maestro-runner engine, but the seams — version drift, WDA-blind 40 s doomed attempts, Android hideKeyboard no-op, narrow fallback grammar, no fast iteration mode — get closed so the integration feels first-party
**Effort:** M (phased; each phase lands independently)
**Depends:** — (Phase 3 extends the existing #317 Phase 2 fallback; relates #334, #240, #358, #369, #371, #379, #227)

## Problem

maestro-runner (DeviceLab.dev Go implementation, currently v1.0.9 at `~/.maestro-runner/bin/maestro-runner`, Maestro CLI as fallback — `maestro-invoke.ts:46-49`) is the replay engine for `cdp_run_action`, `maestro_run`, and the e2e suite. The engine itself is solid; the **integration seams** are where sessions bleed time and trust:

1. **No version pinning or compat gate.** `ensure-maestro-runner.sh` installs whatever it installs; upstream behavior changes arrive silently (B223/#369 — v1.0.9 no-ops `hideKeyboard` on Android — was discovered mid-verification, not at upgrade time). The upstream drift tracker (#227) is a manual routine, not a gate.
2. **WDA-blind runtimes burn ~40 s before the fallback engages.** On iOS 26.x bridgeless, every replay pays a doomed "Building WDA…" attempt before the reactive CDP fallback fires (`2026-06-19-317-...-phase2-design.md` accepted this deliberately, deferring a proactive probe).
3. **The CDP fallback grammar is deliberately narrow** (id-only selectors, actions-only, small step subset). Actions with `tapOn: text:` remain WDA-only; `maestro_run`/suite have no fallback at all (#334 tracks exactly this extension).
4. **Keyboard handling depends on a runner verb that is broken upstream** (`hideKeyboard` no-op on Android, B223), while we have working host-side dismissal (keyboard guard #356/#370, JS-first dismissal #379, repair-time injection idea #371) that isn't wired into the replay path.
5. **No fast iteration mode.** Repairing an action means re-running the whole flow with a full app relaunch; #240 (single-step / no-relaunch `maestro_run`) was filed for this and matters more now that the engine stays.

## What "seamless" means (design, phased)

### Phase 1 — Version pinning, compat gate, doctor surfacing (S)

- Pin the **tested** maestro-runner version in a committed manifest (`scripts/cdp-bridge/src/e2e/` or alongside `maestro-invoke.ts`): `{version, sha256 per platform, knownQuirks: ["android-hidekeyboard-noop"]}`.
- `ensure-maestro-runner.sh`: install exactly the pinned version, verify checksum; on a locally-newer/older binary, warn with the drift note instead of silently proceeding.
- `cdp_status` + `/doctor`: report engine (`maestro-runner 1.0.9 (pinned, quirks: …)` vs `Maestro CLI fallback`), so every session log records which engine ran.
- Upgrade ritual: bumping the pin requires the golden replay set green (Phase 5 / Story 06 harness) — the #369 class gets caught at upgrade time, not mid-session.

### Phase 2 — Proactive blind-probe: skip the doomed 40 s (S)

- Before invoking maestro on at-risk runtimes (iOS ≥ 26, or after any prior `TRANSPORT_BLIND` RunRecord for this device), run the **cheap oracle first**: the action's first top-level testID verbatim-present in the CDP component tree (`isTransportBlindViaCdp` exists) while a 1–2 s WDA/a11y sanity read comes back empty → route straight to the CDP fallback with `RunRecord.transport='cdp-js'`, skipping the maestro attempt entirely.
- Healthy runtimes are untouched (probe only on the at-risk gate). Phase 2 of #317 explicitly deferred this "without redesign" — this is that reclaim.

### Phase 3 — Widen the CDP fallback grammar (#334 absorbed) (M)

- **Text selectors**: resolve `tapOn: text:` / bare-string `assertVisible` against component-tree text (exact-first, then Maestro's anchored-regex semantics) — the current biggest `UNSUPPORTED_STEP` source (e.g. `cycle-task-priority`).
- **`maestro_run` + `cdp_run_e2e_suite` fallback coverage** (today: actions only), preserving the per-file `{file, success, error}` continue-on-failure shape.
- Step types added per-need with the existing `UNSUPPORTED_STEP` fence (scroll/swipe next candidates, via `device_scroll`/`device_scrollintoview` dispatch).
- **Optional (differentiator kept alive despite 07's postponement):** `x-rn:` hybrid assertion steps (`expectRoute`/`expectStore`/`expectNoFailedRequests`) executed by the **fallback executor** and stripped from YAML handed to maestro-runner — hybrid assertions ship without the full native executor.

### Phase 4 — Keyboard seam: stop depending on the broken verb (S)

- Replay-path keyboard handling goes host-side: before steps that B223 would break, inject our own dismissal (iOS: guarded dismissal from #370; Android: `device_back`-based or #379 JS-first blur) instead of emitting `hideKeyboard` into flows for the Go runner.
- `maestro_generate` stops emitting `hideKeyboard` on Android while the quirk is in the pin manifest; #371's repair-time injection slots here as the corrective for existing action YAMLs.

### Phase 5 — Iteration speed + engine health (M)

- **#240 absorbed:** single-step / no-relaunch mode — synthesize a minimal flow (no `launchApp`, one step + assertion) against the current foreground app for repair-loop iteration; measure step-level MTTR drop in `autoRepair` telemetry.
- Investigate WDA warm reuse between consecutive runs (suite runs pay "Building WDA" per file today); if the Go runner supports a persistent session/daemon flag, adopt it — else batch suite files into fewer invocations.
- Golden replay set (Story 06 Phase B harness) runs against the pinned engine nightly — the integration gets the same regression net as our own runners.

## Explicitly out of scope

- Building the native flow executor (Story 07 — postponed, documented escalation path).
- Forking or patching the Go runner itself (upstream quirks are routed around host-side; #369 stays an upstream report).
- Full Maestro grammar in the fallback (per-need only, fence stays).

## Acceptance criteria

- Engine version + quirks visible in `cdp_status`/doctor; a pin bump with a seeded quirk (hideKeyboard) fails the golden set instead of shipping silently.
- iOS 26 bridgeless: `cdp_run_action` reaches its verdict in seconds (probe → fallback), not after a ~40 s doomed WDA build; healthy-OS path byte-identical.
- `tapOn: text:` actions replay via fallback on WDA-blind runtimes; suite runs have fallback coverage with unchanged result shape.
- Android replay flows no longer emit/depend on `hideKeyboard`; keyboard-occluded steps pass via host-side dismissal (B223 neutralized without upstream).
- Repair iteration on a single step completes without full-flow relaunch (#240), reflected in MTTR telemetry.

## Test plan

- Unit: pin/checksum/quirk manifest logic; probe gating truth table (runtime × prior-record × oracle result); grammar extensions per step type; keyboard-injection placement.
- Integration: fake-engine harness (scripted maestro-runner stdout) for version/drift paths; existing maestro-grammar integration test extended.
- Live: action corpus on iOS 18 (engine path) + iOS 26 (probe→fallback path); Android keyboard-occlusion action end-to-end; nightly golden set against the pin.

## Risks & open questions

- **Fallback grammar creep** toward a shadow executor — the fence is "only what committed actions/suites need," same as #317 Phase 2; if the fence keeps moving, that's the signal to un-postpone Story 07 rather than grow the fallback indefinitely.
- **Upstream cadence**: pinning trades freshness for predictability; the drift tracker (#227) plus the upgrade ritual is the countermeasure.
- **WDA warm reuse** may not be exposed by the Go runner — then batching is the fallback; measure before promising.
