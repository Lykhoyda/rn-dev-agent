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

- Detects the binary (existing `~/.maestro-runner/bin` path logic), runs `--version` (lenient `/\d+\.\d+\.\d+/` parse), hashes the file. Both cached per process.
- Classifies: `pinned-ok | drift-newer | drift-older | checksum-mismatch | unknown-version | not-installed`. Version comparison is numeric per segment (no semver dep).
- `checksum-mismatch` only when the version string MATCHES the pin but the hash differs for a known platform key (possible tamper/corruption — worth a louder note); a missing platform key skips the hash check.
- Any detection error ⇒ `unknown-version`, no throw — **fail-open**, the engine still runs.

Drift surfacing: warn **once per process** via the existing `shouldWarnFallback()` mechanism at the first maestro invocation (`chooseMaestroDispatch` call sites get the status attached to their result meta); subsequent runs carry it quietly in `meta`.

### Component: installer pinning — `scripts/ensure-maestro-runner.sh`

- The upstream installer supports pinning: `curl … | bash -s -- --version <V>` (verified 2026-07-05 against `open.devicelab.dev`). Fresh installs install **exactly** `MAESTRO_RUNNER_PIN_VERSION="1.0.9"`.
- Post-install: `shasum -a 256` the binary; on mismatch for a known platform key, print a warning (do not delete — fail-open, but the note names the risk).
- An **already-installed** different version is NOT auto-reinstalled: print the drift note (respect deliberate local upgrades; the runtime warn-once covers the session).
- Shell↔TS pin sync enforced by a grep-based unit test (D1292 tri-file precedent): test reads both files, asserts the version strings match.

### Component: surfacing — `cdp_status` + doctor

- `cdp_status` result gains `replayEngine`:
  `{ engine: 'maestro-runner' | 'maestro-cli' | 'none', version?, pin: { pinned: string, status: <classification> }, quirks: string[] }`
  computed lazily from `getEngineStatus()` + `chooseMaestroDispatch` availability probes (all cached; adds no meaningful latency to `cdp_status`).
- rn-setup skill checklist (the doctor's source): the maestro-runner row reports `1.0.9 (pinned, quirks: android-hidekeyboard-noop, requires-adb-on-ios)` vs `1.1.x (DRIFT from pin 1.0.9 — untested)` vs `Maestro CLI fallback`.

### Upgrade ritual (documented now, automated with Story 06)

The golden-replay-set gate requires the Story 06 Phase B harness, which does not exist yet. PR 1 ships the ritual as a **documented checklist** in the manifest module header + the docs-site actions page: bump pin → run the committed action corpus (`cdp_run_e2e_suite`) on iOS + Android against the new binary → reconcile `knownQuirks` → update both pin sites → changeset. The story's "seeded quirk fails the golden set" acceptance criterion moves to Story 06.

## PR 1 — Phase 2: proactive blind-probe in `cdp_run_action`

Scope: `cdp_run_action` only (its reactive fallback exists today). `maestro_run`/suite coverage is PR 2 (#334).

Two-stage gate, every stage fail-open to today's behavior. The gate applies to **iOS targets only** (transport-blindness is a WDA/iOS phenomenon; Android behavior is untouched):

**Stage 1 — at-risk? (cheap, no WDA, no runner spawn):**
- Target platform is iOS AND simulator runtime major ≥ 26 — resolved via one cached `simctl list devices -j` lookup keyed by UDID (`getIosRuntimeMajor(udid)`, null on any error ⇒ not at-risk), OR
- The action's run history contains a prior `failureCode: 'TRANSPORT_BLIND'` record for this device. `RunRecord` gains additive-optional `deviceId?: string` (Story 05 already threads device-id); history records without `deviceId` match conservatively (they may have been this device).

**Stage 2 — oracle (can the fallback anchor?):**
- The action's first anchor testID (`firstTestId(steps)`, exists) resolves in the live CDP component tree via the existing CDP replay dispatch's `isVisible`.
- Anchor found ⇒ **skip maestro entirely**; replay through the existing fallback path; `RunRecord.transport: 'cdp-js'` plus new additive-optional `blindProbe?: { atRisk: 'ios26' | 'prior-transport-blind', skippedMaestro: true }`; tool meta mirrors it.
- Anchor not found / CDP disconnected / action has no tap-or-assert step ⇒ fall through to the normal maestro path (reactive fallback unchanged).

Invariants:
- Healthy runtimes: the gate never fires; byte-identical behavior (acceptance criterion).
- The probe consumes no arbiter `flow` lease of its own — it runs inside `cdp_run_action`'s existing orchestration, before engine selection.
- On a probe-routed replay that FAILS, the RunRecord keeps `failureCode: 'TRANSPORT_BLIND'` semantics identical to the reactive path (same downstream repair/refusal behavior).

## Error handling summary

Every new mechanism degrades to the current path: engine detection errors ⇒ `unknown-version` + no block; missing platform hash ⇒ skip checksum; simctl/runtime lookup failure ⇒ not-at-risk; CDP down ⇒ maestro path. No new hard-failure modes. Warnings are once-per-process.

## Test plan (PR 1)

- Unit: pin classification truth table (equal/newer/older/garbage version, hash match/mismatch/missing key, binary absent); shell↔TS pin grep-sync; probe gate truth table (platform × runtime major × history record with/without deviceId × oracle result) — pure functions, injected resolvers.
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
- With seeded TRANSPORT_BLIND history (or iOS ≥ 26): `cdp_run_action` reaches its verdict without any maestro/WDA invocation when the oracle anchors; healthy-OS path byte-identical.
- Shell and TS pin values cannot diverge silently (sync test).

## Risks

- **Pin staleness vs upstream fixes:** the documented ritual + drift tracker (#227) is the countermeasure; automation lands with Story 06.
- **Probe false-positives** (skipping a maestro run that would have worked): bounded to at-risk runtimes with a verified anchor; the replay still yields a real verdict, and `blindProbe` telemetry makes the routing auditable.
- **Fence creep in PR 2:** the `UNSUPPORTED_STEP` fence + "only what committed actions need" rule carries over; if it keeps moving even under NativeDispatch, that is Story 07's full un-postpone signal, per D1291.
