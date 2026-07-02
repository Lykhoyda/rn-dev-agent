# Story 11 — Failure evidence bundles, structured refusal reasons, agent-device debt retirement

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Repair quality (evidence at failure time), telemetry integrity (kills the string-regex refusal mapping), maintainer/user clarity (retires misleading legacy references)
**Effort:** S–M (three independently-landable parts)
**Depends on:** — (Part A benefits from Story 08's compact format but doesn't require it)

## Part A — Evidence-in-the-failure

### Problem
When a replay step or device action fails, the agent gets an error string and must *then* gather context (snapshot, route, logs) with extra tool calls — by which time the screen may have moved on. The repair engine similarly works from the failure message plus a fresh snapshot that may no longer show the failing state.

### What Maestro does
- Failures carry evidence **captured at throw time**: `MaestroException.AssertionFailure`/`ElementNotFound` are constructed with `hierarchyRoot = maestro.viewHierarchy().root` and a rich debug message (`Orchestra.kt:487-491, 1417-1421`).
- Failure messages are **tuning guides**: `scrollUntilVisible`'s failure enumerates every knob (timeout, speed, visibility threshold, centerElement) and how to adjust each (`Orchestra.kt:793-827`). For an AI caller this is executable advice.
- One `ArtifactCollector` backs both the manifest and per-step artifact lists so they cannot disagree; failed/warned steps always capture hierarchy+screenshot, passing steps only in full-artifact mode (`debug/ArtifactsGenerator.kt:106-136`) — local runs don't pay per-command capture.

### Design
- New `domain/failure-evidence.ts`: `captureEvidence(ctx): Evidence` producing `{snapshotExcerpt, screenshotPath, route, consoleTail, hint}` where:
  - `snapshotExcerpt` = compact-format nodes (Story 08) filtered to ±the match attempt (candidates considered, their scores) — bounded ≤ 30 nodes;
  - `screenshotPath` = scratch-dir JPEG (downscaled), path-not-inline to keep envelopes small;
  - `route` from `cdp_navigation_state` internals; `consoleTail` = last 10 ring-buffer entries;
  - `hint` = per-failure-code template (the `scrollUntilVisible` pattern: name the knobs — `settleTimeoutMs`, `maxScrolls`, threshold — and when to turn each).
- Capture points: flow-executor step failure (Story 07), `cdp_run_action` selector failures (feeds the repair engine a *contemporaneous* snapshot instead of a later one), `device_find` NOT_FOUND/AMBIGUOUS (candidates already exist — attach scores).
- `RunRecord` gains optional `evidenceDir` (additive-optional, run-history JSON stable). Sidecar stays small; evidence dir is scratch/`.rn-agent/evidence/<runId>/` with a 20-run retention sweep.
- Capture is **best-effort and time-boxed** (≤ 1.5 s total; skip screenshot if runner unhealthy) — evidence must never turn one failure into two (Maestro's `DeviceArtifactCapturer` posture).

### Acceptance criteria
- A failed `tapOn` in a native replay produces an envelope whose `evidence.snapshotExcerpt` contains the near-miss candidates, and repair-engine fuzzy matching consumes that excerpt when present (no fresh-snapshot race).
- Evidence capture failure downgrades to `evidence: null` + debug log — proven by a fault-injection unit test.

## Part B — Structured refusal reasons (kill the string-regex)

### Problem
The only `TODO` in `src/`: `mapRefusedReason` (`tools/run-action.ts:162`) distinguishes `BUDGET_EXHAUSTED` from `EXTERNAL_EDIT` by regexing the human error string ("repair budget"); a wording change silently mis-categorizes MTTR analytics. Currently guarded only by a wording-lock test.

### Design
- `cdp_repair_action` returns structured `meta.refusal: {kind: 'BUDGET_EXHAUSTED'|'EXTERNAL_EDIT'|'ROUTE_DRIFT'|'TRANSPORT_BLIND'|'SNAPSHOT_FAILED', detail}` alongside the human message (the repair engine already knows the kind internally — `domain/repair-engine.ts` refusal branches; this only surfaces it).
- `mapRefusedReason` consumes `meta.refusal.kind`, falls back to the regex **only** for records predating the field (replay of old run history), with a deprecation comment + removal date.
- Delete the wording-lock test; add an exhaustiveness test over the refusal-kind union (compile-time `never` check + runtime table).

### Acceptance criteria
- Rewording any repair-refusal message changes zero telemetry categorizations (test: mutate the message in a fixture, assert categories stable).

## Part C — agent-device debt retirement

### Problem
~167 non-test references to the removed agent-device subsystem. Worst offenders actively mislead: error messages say "agent-device daemon dropped appBundleId" and point users at `Callstack/agent-device` (`tools/device-interact.ts:239-246`, `device-session.ts:507-519`) for failure modes that now originate in our own runners.

### Design — three buckets, three PRs
1. **User-facing strings (now):** rewrite every error/hint mentioning agent-device to name the actual component (rn-fast-runner / rn-android-runner / bridge) and the actual remedy. Grep-driven inventory checked into the PR description.
2. **Load-bearing identifiers (mechanical):** `runAgentDevice*`/`AgentDeviceRunner` sentinels that still do work (leak-recovery detection of the *legacy* runner's UI tree is intentionally about the old apps — keep the behavior, rename to `legacyRunnerLeak*` with a comment stating why the old bundle IDs remain hard-coded).
3. **Dead code (delete):** unreachable arms behind `NO_NATIVE_ROUTE` dispatch; `agent-device-wrapper.ts` itself gets renamed (`native-dispatch.ts`) once its exports stop referencing the old world — file rename lands last, alone, for blame continuity.
- **Ratchet guard:** CI check counting `agent-device` occurrences outside `test/` and `docs/`, failing if the count *rises*, with the current count committed as the baseline and lowered per bucket-PR (static source-invariant style, per D1288).

### Acceptance criteria
- No user-visible error/hint mentions agent-device or links to `Callstack/agent-device` (grep-enforced, zero-baseline for the strings bucket).
- Leak-recovery behavior byte-identical (existing tests pin it); ratchet baseline ≤ 40 after bucket 2, with the remainder enumerated in the PR as intentionally-retained.

## Test plan (all parts)
- Unit: evidence best-effort fault injection; refusal-kind exhaustiveness; ratchet script against fixture trees.
- Live: one induced replay failure end-to-end — inspect the evidence bundle by hand; one repair run over a pre-field RunRecord (regex fallback exercised).

## Risks & open questions
- Evidence disk growth: bounded by retention sweep + downscaled JPEGs (~100 KB/run).
- Renames churning open PRs: buckets are sequenced small→large; the file rename waits for a quiet window.
