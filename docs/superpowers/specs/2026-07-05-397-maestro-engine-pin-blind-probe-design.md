# Story 13 (#397) — Engine pin + proactive blind-probe (Phases 1–2), with NativeDispatch as the fallback backend (PR 2)

**Status:** Approved (2026-07-05)
**Story:** [13 — Seamless maestro-runner integration](../../stories/13-maestro-runner-seamless-integration.md) (#397)
**Relates:** D1291 (postponement + un-postpone trigger), #388 (Story 07), #334, #240, #358, #369/B223, #317, #395, D1292 (grep-sync precedent)

## Direction decision (recorded from the 2026-07-05 debate)

Maintainer question: should we proceed with Story 13 as written, or un-postpone Story 07 (#388)?

**Chosen: Hybrid (option B).** Story 13 Phases 1–2 exactly as specified; but the Phase-3 grammar investment goes into a **NativeDispatch** backend for the existing fallback interpreter (Story 07's core) instead of growing the CDP-only dispatch. Rationale:

1. Story 07's prerequisites (Story 04 settle, Story 05 re-resolution) shipped since D1291 was made — the executor's hard runtime pieces now exist and are device-verified.
2. The fallback interpreter is **already dispatch-injected** (`replayFlow(steps, dispatch)` over the 5-method `ReplayDispatch` in `domain/cdp-flow-replay.ts`). Stories 13-P3 and 07 share the interpreter; the only real fork is the dispatch backend.
3. Story 13 P3's own step list routes scroll/swipe "via `device_scroll`/`device_scrollintoview` dispatch" — i.e. the planned "CDP fallback" growth is a native dispatch wearing a CDP name. D1291's written un-postpone trigger ("if the fallback-grammar fence keeps moving, grow the executor, not the fallback") fires on the story's own plan; following it executes the decision rather than relitigating it.
4. `tapOn: text:` semantics (rendered/accessibility text + hit-testing) belong to the native runner, which sees everything where WDA is blind; fiber-tree text matching is the weaker approximation.

**What stays postponed from Story 07:** the WDA-parity chase, the healthy-OS default flip, and full grammar parity. Maestro remains the default engine on healthy runtimes and the export/interop format. Kano/priority on #388 unchanged (`later`); this spec implements #397.

**Slicing:** two stacked PRs. PR 1 = Phases 1–2 (this spec's main body). PR 2 = NativeDispatch + per-need grammar (outline below; own plan when started). #395 (iOS modal `hittable=false`) is fixed separately before PR 2 dogfood since NativeDispatch inherits it on modal screens.

---

## PR 1 — Phase 1: version pin, compat gate, doctor surfacing

### Component: engine pin manifest — `scripts/cdp-bridge/src/domain/engine-pin.ts` (new)

Pure-TS constant, compiled into dist; single source of truth:

```ts
export const MAESTRO_RUNNER_PIN = {
  version: '1.0.9',
  // sha256 per platform key `${process.platform}-${process.arch}`
  sha256: {
    'darwin-arm64': '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
    // darwin-x64: computed when a maintainer/CI on that arch bumps the pin; absent ⇒ checksum check skipped (fail-open)
  },
  knownQuirks: [
    { id: 'android-hidekeyboard-noop', ref: 'B223 / #369', note: 'hideKeyboard reports pass in ~5ms on Android, keyboard stays up' },
    { id: 'requires-adb-on-ios', ref: 'B59', note: 'v1.0.9 requires adb in PATH even with --platform ios' },
  ],
} as const;
```

`getEngineStatus()` (same module, injected resolvers for tests):

- Detects the binary (existing `~/.maestro-runner/bin` path logic), runs `--version` via argv-mode `execFile` with an explicit 5 s timeout (timeout/error ⇒ `unknown-version`, never blocks), hashes the file. Both cached per process.
- Classifies: `pinned-ok | unverified | drift-newer | drift-older | checksum-mismatch | unknown-version | not-installed`. Version comparison is numeric per segment (no semver dep).
- `checksum-mismatch` only when the version string MATCHES the pin but the hash differs for a known platform key. `pinned-ok` strictly means version AND hash verified; a missing platform key or a failed hash computation classifies `unverified` (informational — no caveat, no warning, not refused by strict mode). Malformed version strings classify `unknown-version` (never NaN-compare equal).
- **Trust story, stated explicitly (scope + defaults considered and decided):**
  - The checksum validates the FINAL BINARY only. The install path remains upstream's `curl | bash` — the checksum does NOT protect installer-script execution (upstream publishes no installer checksum to verify against). This is a documented scope limit, not an oversight.
  - The BLOCKING control by default is the installer: it fails closed on a just-downloaded mismatch (delete + exit 1). Scope: binary integrity only — installer-script execution risk is the documented scope limit above, out of scope for this feature everywhere "fail-closed" is mentioned.
  - Runtime classification is **informational by default** — telemetry + warn-once + doctor visibility. Rationale: a pre-existing local binary may be a deliberate user build; the pin's threat model is untested behavioral drift (B223 class), not local-filesystem compromise (an attacker who can replace `~/.maestro-runner/bin` can replace `node`). Runtime fail-closed was considered and rejected — it would brick replay on a benign upstream re-release.
  - **Opt-in strict mode:** `RN_ENGINE_PIN_STRICT=1` makes `maestro_run`/replay refuse (`failResult`, actionable message) when the pin status is `drift-newer`/`drift-older`/`checksum-mismatch`. Scope stated precisely: strict mode enforces **proven divergence**, not availability — `unverified` (no hash shipped for this platform, or hashing failed) and `unknown-version` (detection gap) do NOT refuse, otherwise strict-mode users on platforms without a manifest hash could never replay at all.
- Any detection error ⇒ `unknown-version`, no throw — **fail-open**, the engine still runs.

Drift surfacing: warn **once per process** via the existing `shouldWarnFallback()` mechanism at the first maestro invocation (`chooseMaestroDispatch` call sites get the status attached to their result meta); subsequent runs carry it quietly in `meta`.

### Component: installer pinning — `scripts/ensure-maestro-runner.sh`

- The upstream installer supports pinning: `curl … | bash -s -- --version <V>` (verified 2026-07-05 against `open.devicelab.dev`). Fresh installs install **exactly** `MAESTRO_RUNNER_PIN_VERSION="1.0.9"`.
- Post-install: `shasum -a 256` the binary; on mismatch for a known platform key the installer **fails closed** — deletes the just-downloaded binary and exits 1 with the expected/got hashes (a fresh download that doesn't match the pin is exactly what the hash exists to catch, and failing an install is actionable, not session-blocking). This is a **binary-integrity control only**, applied after the upstream installer script has run — it is NOT an install-time script-execution control (see the Trust story scope limit). RUNTIME detection of a mismatched pre-existing binary stays warn-once + surfaced `pin.status: 'checksum-mismatch'` — a local binary may be a deliberate user build, and the drift-class threat model (untested behavior) is covered by the warning; fail-closed at runtime would brick replay on a benign upstream re-release.
- An **already-installed** different version is NOT auto-reinstalled: print the drift note (respect deliberate local upgrades; the runtime warn-once covers the session).
- Shell↔TS pin sync enforced by a grep-based unit test (D1292 tri-file precedent): test reads both files and asserts BOTH duplicated pin fields match — the version string and the darwin-arm64 sha256.

### Component: surfacing — `cdp_status` + doctor

- `cdp_status` result gains `replayEngine`:
  `{ engine: 'maestro-runner' | 'maestro-cli' | 'none', version?, pin: { pinned: string, status: <classification> }, quirks: string[] }`
  computed lazily from `getEngineStatus()` only — every subprocess it spawns is bounded (`--version` 5 s timeout, `which maestro` 2 s timeout) and the result is process-cached, so only the first `cdp_status` pays anything.
- rn-setup skill checklist (the doctor's source): the maestro-runner row reports `1.0.9 (pinned, quirks: android-hidekeyboard-noop, requires-adb-on-ios)` vs `1.1.x (DRIFT from pin 1.0.9 — untested)` vs `Maestro CLI fallback`.

### Upgrade ritual (documented now, automated with Story 06)

The golden-replay-set gate requires the Story 06 Phase B harness, which does not exist yet. PR 1 ships the ritual as a **documented checklist** in the manifest module header + the docs-site actions page: bump pin → run the committed action corpus (`cdp_run_e2e_suite`) on iOS + Android against the new binary → reconcile `knownQuirks` → update both pin sites → changeset. The story's "seeded quirk fails the golden set" acceptance criterion moves to Story 06.

## PR 1 — Phase 2: proactive blind-probe in `cdp_run_action`

Scope: `cdp_run_action` only (its reactive fallback exists today). `maestro_run`/suite coverage is PR 2 (#334).

Two-stage gate, every stage fail-open to today's behavior. The gate applies to **iOS targets only** (transport-blindness is a WDA/iOS phenomenon; Android behavior is untouched):

**Stage 1 — at-risk? (cheap, no WDA, no runner spawn):**
- Target platform is iOS AND simulator runtime major ≥ 26 — resolved via one cached argv-mode `execFile('xcrun', ['simctl','list','devices','--json'])` lookup keyed by UDID, with an explicit timeout (5 s); timeout/error ⇒ null ⇒ not at-risk (codex-pair: no new unbounded subprocess on the `cdp_run_action` path). iOS-ness requires positive evidence: explicit `platform: 'ios'` or a successful iOS runtime resolution — `platform` absent with no runtime evidence never latches. OR
- The action's **recent** run history latches: scanning the last 5 records newest-first (device-matching only), a clean maestro pass (`status: 'pass'` with `transport` unset) **clears** the latch; a `failureCode: 'TRANSPORT_BLIND'` record **sets** it. Nothing decisive in the window ⇒ not at-risk. This bounds the latch so ONE transient `TRANSPORT_BLIND` cannot permanently route an otherwise-healthy action through the narrower cdp-js grammar (multi-LLM review blocker #1); a cdp-js pass does NOT clear the latch (it proves nothing about WDA). The aging/retry property applies to the history latch only — the `ios26` runtime clause is a standing condition by design (its escape hatch is the `RN_BLIND_PROBE=0` opt-out below). `RunRecord` gains additive-optional `deviceId?: string`; matching is **strict** — a history record latches only when BOTH its `deviceId` and the live device id are present and equal (codex-pair: device-less pre-upgrade records must not latch other devices; they are grandfathered out, and the `ios26` clause remains the primary signal on genuinely blind runtimes).
- Global opt-out: `RN_BLIND_PROBE=0` (or `false`) disables the proactive gate entirely (same env-toggle pattern as `RN_SETTLE`/`RN_SELF_HEAL`), restoring today's maestro-first behavior — the escape hatch if cdp-js routing misbehaves on an at-risk runtime.

**Stage 2 — oracle (can the fallback anchor?):**
- Device-found during T11 (iOS 26.5, real app): the oracle's `treeFor` was silently blinded on heavy screens — the filtered full tree exceeded the injected helper's 50 KB `safeStringify` guard, which replaces the payload with `{__agent_truncated}` and made `isExactPresent` always false (this also latently affected the shipped reactive fallback; likely the #423 "unexplained UNKNOWN" class). Fix: `treeFor` fetches the full filtered tree first and, on truncation, retries with the `interactiveOnly` salient digest (#321) — full tree stays primary because the digest excludes pure-text labels that `assertVisible` steps target (also device-proven).
- The action's first anchor testID — via the existing `firstReplayTestId(action.body, params)`, which normalizes the WHOLE flow and returns null if ANY step is outside the cdp-js grammar (so a supported-first-step/unsupported-later-step action never probe-routes) — resolves in the live CDP component tree.
- Anchor found ⇒ **skip maestro entirely**; replay through the existing fallback path; `RunRecord.transport: 'cdp-js'` plus new additive-optional `blindProbe?: { atRisk: 'ios26' | 'prior-transport-blind', skippedMaestro: true }`; tool meta mirrors it.
- Anchor not found / CDP disconnected / action has no tap-or-assert step ⇒ fall through to the normal maestro path (reactive fallback unchanged).

Invariants:
- "Healthy" is defined precisely: iOS below the WDA-blind floor (major < 26) with no device-matched recent latch. On such runtimes the gate never fires; the **agent-facing output is byte-identical**. Treating iOS ≥ 26 as at-risk WITHOUT a live WDA oracle is the deliberate D1291 trade — a "cheap WDA sanity read" does not exist (spawning WDA IS the ~40 s cost being avoided); `RN_BLIND_PROBE=0` is the escape for an iOS-26 setup where WDA actually works, and the floor is revisited via the upstream drift tracker (#227) when a WDA fix ships. (The persisted RunRecord additionally carries `deviceId` when a device context resolved, and the first iOS run execs one cached `simctl list` — multi-LLM review #7 wording fix.)
- The probe consumes no arbiter `flow` lease of its own — it runs inside `cdp_run_action`'s existing orchestration, before engine selection.
- On a probe-routed replay that FAILS, the RunRecord carries a NEW `failureCode: 'FALLBACK_REPLAY_FAILED'` — NOT `TRANSPORT_BLIND` (codex-pair finding): this run skipped maestro entirely, so no transport blindness was observed; the failure may be app drift, stale anchors, or grammar. `TRANSPORT_BLIND` is reserved for maestro-observed blindness (reactive path). The latch treats `FALLBACK_REPLAY_FAILED` as non-decisive, so repeated probe-routed failures age the genuine latch record out of the recency window — maestro then gets retried and either re-latches (real blindness) or clean-passes (reset). No repair attempt on this path in PR 1 (mirrors the reactive fail-fast; repair-on-fallback-failure is a PR 2 consideration).
- **Probe-routed cdp-js passes do NOT auto-promote** `experimental → active` (`shouldAutoPromoteToActive` excludes `blindProbe.skippedMaestro` records): "active" continues to mean "validated on the full engine", never "validated only by the narrower fallback" (review blocker #2). Reactive-fallback promotion semantics are unchanged (pre-existing, shipped).
- Precondition: the device context comes from the open iOS device session (`foreignGateUdid()`); with no session the gate is inert (fail-open). A `resolveIosUdid()`-based fallback is a PR 2 consideration.
- A flow containing ANY step outside the cdp-js grammar gets no proactive benefit (the anchor extractor returns null over unsupported grammar ⇒ maestro path, including the ~40s attempt on iOS 26). Prefix-safe probing is deferred to PR 2's NativeDispatch grammar widening.
- DB mirror (`action-db.ts`): `deviceId` and `blindProbe` ARE mirrored (new `device_id TEXT` + `blind_probe_json TEXT` columns, added via idempotent `ALTER TABLE` on open, extending `insertRunRecord` + the `loadState` reconstruction with a round-trip test). Two reviewers flagged that dropping them makes the routing telemetry unauditable anywhere that reads the SQLite mirror; the sidecar remains authoritative for the gate (#365 unchanged).

## Error handling summary

Every new mechanism degrades to the current path: engine detection errors ⇒ `unknown-version` + no block; missing platform hash ⇒ skip checksum; simctl/runtime lookup failure ⇒ not-at-risk; CDP down ⇒ maestro path. No new hard-failure modes. Warnings are once-per-process.

## Test plan (PR 1)

- Unit: pin classification truth table (equal/newer/older/garbage version, hash match/mismatch/missing key, binary absent); shell↔TS pin grep-sync; probe gate truth table (platform/iOS-evidence × runtime major × latch recency/reset × strict deviceId matching × oracle result) — pure functions, injected resolvers; `shouldAutoPromoteToActive` excludes `blindProbe.skippedMaestro` records (promotion invariant locked directly); `FALLBACK_REPLAY_FAILED` recorded on probe-routed failures and treated as non-decisive by the latch; DB mirror round-trip for `device_id`/`blind_probe_json`.
- Integration: `cdp_run_action` with a fake maestro invoker — at-risk + anchor-found ⇒ **zero** maestro executions, pass recorded with `transport: 'cdp-js'` + `blindProbe`; not-at-risk ⇒ invoker called exactly as today (existing tests stay green); at-risk + oracle-fail ⇒ invoker called.
- Status shape test for `replayEngine`.
- Live: iOS 18 sim — replay a committed action, confirm engine path + `replayEngine` in `cdp_status`; probe path forced by seeding a TRANSPORT_BLIND run record (no iOS 26 sim required); Android smoke — drift warning absent on pinned-ok.

## PR 2 outline — NativeDispatch + per-need grammar (own plan when started)

- `NativeDispatch implements ReplayDispatch` over device-layer handler internals (`device_press`/`device_fill`/`device_scrollintoview`), inheriting settle (Story 04) and re-resolution (Story 05); one arbiter `flow` lease for the whole replay (composite-tool rule).
- Grammar widened per-need behind `UNSUPPORTED_STEP`: `tapOn: text:` (runner-side text semantics), `assertVisible` by text, `scroll`/`scrollUntilVisible`, `optional:`; only what committed actions/suites need — the fence stays.
- Transport policy: probe-routed replays prefer `NativeDispatch` (runner sees text where WDA is blind); `RunRecord.transport` gains `'native'`.
- `maestro_run` + `cdp_run_e2e_suite` fallback coverage, preserving per-file `{file, success, error}` shape (#334 absorbed).
- Precondition: #395 (iOS modal subtrees `hittable=false`) fixed first.
- Deferred decisions to PR 2 planning: `x-rn:` hybrid asserts; host-side keyboard seam (Story 13 Phase 4).

## Acceptance criteria (PR 1)

- `cdp_status.replayEngine` + doctor row report engine, version-vs-pin, quirks.
- Fresh install lands exactly the pinned version; drift warns once per process and never blocks.
- With seeded TRANSPORT_BLIND history (or iOS ≥ 26): `cdp_run_action` reaches its verdict without any maestro/WDA invocation when the oracle anchors; healthy-OS agent-facing output byte-identical (RunRecord gains only additive `deviceId`).
- Shell and TS pin values cannot diverge silently (sync test).

## Risks

- **Pin staleness vs upstream fixes:** the documented ritual + drift tracker (#227) is the countermeasure; automation lands with Story 06.
- **Probe false-positives** (skipping a maestro run that would have worked): bounded to at-risk runtimes with a verified anchor; the replay still yields a real verdict, and `blindProbe` telemetry makes the routing auditable.
- **Fence creep in PR 2:** the `UNSUPPORTED_STEP` fence + "only what committed actions need" rule carries over; if it keeps moving even under NativeDispatch, that is Story 07's full un-postpone signal, per D1291.
