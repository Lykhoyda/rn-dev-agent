# Story 07 — Native-first action replay: own runners as the primary transport, Maestro YAML as interchange

**Status:** POSTPONED (2026-07-02, maintainer call — D1290). Near-term replay direction is [Story 13 — seamless maestro-runner (Go) integration](13-maestro-runner-seamless-integration.md); this story is the documented escalation path if that integration hits a wall (e.g. WDA-blindness spreads beyond iOS 26 bridgeless, or upstream stalls).
**Epic:** [Maestro adoption](README.md)

## Effort assessment (recorded 2026-07-02, basis for the postponement call)

"Alternative to maestro-runner" is two things: a **device driver layer** and a **flow-execution brain**. The driver layer — the genuinely hard, years-of-fixes part — already exists in-tree (rn-fast-runner, rn-android-runner) and works where WDA is blind. What this story builds is only the brain:

- Core interpreter + `NativeDispatch` over existing handlers: **~1–2 weeks** (pure TS, unit-testable).
- With prerequisites (Story 04 settle engine, Story 05 re-resolution): **~3–4 weeks** to native-first-on-iOS-26.
- Parity confidence to flip the default everywhere: **plus several weeks of dogfood telemetry** — WDA's implicit-wait tuning has years of edge cases baked in, and that long tail (transitions, modals, toasts mid-flow) only surfaces in use.
- From-scratch equivalent *without* the in-tree runners would be a multi-month project; the drivers are the moat and they're done.

Scope-saver if/when resumed: this executor replays flows the agent recorded against the user's own RN app (self-placed testIDs, CDP side-channel) — a far easier correctness target than Maestro's any-app-cold generality; `UNSUPPORTED_STEP` refusals stay the fence.
**Impact:** Fully resolves the iOS 26.x bridgeless transport-blindness (#317) instead of falling back around it; removes WDA/maestro-runner from the replay critical path; unlocks hybrid (UI + state) assertions — the flagship differentiator
**Effort:** L
**Depends on:** Story 04 (settle), Story 05 (self-healing resolution); Story 10 improves `inputText` under it

## Problem

Action replay (`cdp_run_action`, the observe Run button, `cdp_run_e2e_suite`) executes through `maestro_run` → maestro-runner → **WDA/XCTest**. On iOS 26.x bridgeless, WDA reads an empty accessibility tree while **our own rn-fast-runner sees everything** (spec `2026-06-17-317-transport-blind-diagnostic-design.md`). Phase 1 named the failure (`TRANSPORT_BLIND`); Phase 2 (`2026-06-19-317-...-phase2-design.md`, shipped in #353) added a **CDP/JS replay fallback** that is deliberately narrow: id-based selectors only, a small step subset, reactive (fires only after a ~40 s doomed maestro attempt), actions-only. The strategic exposure remains: our e2e product depends on a transport we don't control, which is blind on the newest OS, while a transport we *do* control works.

## What Maestro teaches (and what we keep from it)

Maestro's MCP redesign concluded that **the flow DSL is the real API** — they deleted 8 primitive tools and kept one `run` (commit `b54bdfa8`: "Tool surface drops from 15 to 7"). We adopt the format lesson but invert the execution dependency: keep Maestro's proven, LLM-generable **YAML grammar** as our action format and export target, execute it through **our own runners + CDP**. Grammar features worth preserving exactly because they make AI-recorded flows resilient (`maestro-orchestra/.../YamlFluentCommand.kt`, `Orchestra.kt`):

- `optional:` steps downgrade failures to warnings (`Orchestra.kt:327-338`)
- `when:` conditions → `CommandSkipped`, `retry` capped at 3 (`:894-919`, `MAX_RETRIES_ALLOWED=3`)
- `env` + `${}` interpolation; `runFlow` composition with isolated env scopes (`:1126-1157`)
- element lookup as a retry-until-found loop with a default 17 s budget, **decremented by time since the last interaction** (`:1369-1422`, `adjustedToLatestInteraction`, `:1646-1649`)
- `scrollUntilVisible` with visibility-percentage threshold + center-element edge case (`:755-828`)

## Design

### `domain/flow-executor.ts` (new) — grows out of `cdp-flow-replay.ts`, does not replace it in one step

Phase-2's shape is right and stays: a **pure interpreter** over typed steps with an injected dispatch (`replayFlow(steps, params, dispatch)`), fully unit-testable. This story widens both halves:

**1. Grammar (normalizeSteps):** extend the supported subset to what the 7+ current actions and the locked e2e suite actually contain, in this order:
`launchApp` (+`clearState`), `tapOn:{id|text|index}`, `inputText`, `assertVisible:{id|text}` / `assertNotVisible`, `scroll`, `scrollUntilVisible`, `swipe`, `waitForAnimationToEnd`, `runFlow` (file + inline, `when:` gates), `optional:` on any step, `retry`. Everything else keeps hitting `UNSUPPORTED_STEP` loudly (no silent skips — the Phase-2 rule).

**2. Dispatch (`NativeDispatch`):** a second `ReplayDispatch` implementation routed through the device layer instead of CDP-only:

| Step | Execution |
|---|---|
| `tapOn: id` | snapshot query → `refreshRef`-style unique match (Story 05) → native press. **Text selectors work here** — the runner sees rendered text even where WDA is blind, which the CDP fallback could never support (fiber tree resolves testIDs, not text). |
| `tapOn: text` | snapshot text match (exact-first, then Maestro's anchored-regex semantics) → press |
| `inputText` | the existing `device_fill` pipeline with read-back verification (`device-interact.ts:684-899`) — already stronger than Maestro's blind `inputText` |
| `assertVisible` | polling snapshot query with the 17 s adjusted budget; hit-test visibility (topmost-at-center, Maestro `ViewHierarchy.kt:40-95`) not mere presence |
| `assertNotVisible` | inverted short-poll ("keep checking it stays gone", `Orchestra.kt:1027-1046`) |
| `scrollUntilVisible` | `device_scrollintoview` (exists, max 12 iterations) |
| `waitForAnimationToEnd` | `waitForSettle` (Story 04) |
| `launchApp` | session-open/simctl relaunch helpers (exist) |

CDP dispatch (Phase 2's) remains available; the executor takes *which dispatch* as a parameter.

**3. Transport policy (in `tools/run-action.ts`):**

```
transport: 'auto' (default) | 'native' | 'maestro' | 'cdp-js'
auto: native-first when (iOS major ≥ 26) OR (maestro-runner unavailable) OR (last RunRecord for this action was TRANSPORT_BLIND);
      otherwise maestro (proven path stays default on healthy OSes until native earns it — flip the default only after N green weeks of dogfood telemetry).
```

`RunRecord.transport` gains `'native'` (existing values `'cdp-js'` and absent-for-maestro unchanged — same additive-optional pattern Phase 2 used to keep run-history JSON stable). Repair, promotion/demotion, budgets all operate identically regardless of transport — the repair engine consumes selector-failure evidence, and the native executor produces richer evidence (Story 11).

**4. Hybrid assertion steps — the differentiator.** Namespaced extension steps in action YAML, executed only by native/CDP dispatch and **stripped on `maestro_generate` export** (with a comment noting what was stripped):

```yaml
- x-rn:expectRoute: "Tabs/HomeTab/HomeMain"
- x-rn:expectStore: { store: "cart", path: "items.length", equals: 3 }
- x-rn:expectNoFailedRequests: { sincePreviousStep: true }
```

Implemented over the existing `expect_route` / `expect_redux` / `cdp_network_log` handler internals (composite-tool rule: call handler functions, not wrapped MCP tools, under the single arbiter lease — exactly Phase 2's dispatch discipline). This is what no black-box tool can replicate: "the button tapped AND the store mutated AND no request failed."

**5. `cdp_run_e2e_suite`:** same policy; per-file result shape stays `{file, success, ...}` continue-on-failure (Maestro `runPlan`'s shape, `RunTool.kt:206-235`).

### Explicitly out of scope

- Deleting the maestro transport (it remains the export/interop story and the healthy-OS default initially).
- Full Maestro grammar parity (`copyTextFrom`, `travel`, media, etc.) — `UNSUPPORTED_STEP` until an action needs one.
- Recording-side changes (`cdp_record_test_*` already emits the compatible subset).

## Implementation steps

1. Grammar widening in `normalizeSteps` + typed-union growth; table-driven unit tests per step type (green/red/optional/when-gated).
2. `NativeDispatch` over existing handler internals; arbiter-lease audit (one `flow` lease held for the whole replay — `lifecycle/device-arbiter.ts` semantics).
3. Transport policy + `RunRecord.transport='native'` + observe UI badge.
4. `x-rn:` steps: parse, execute, strip-on-export in `maestro-invoke.ts`'s `buildMaestroFlow`.
5. Suite integration; dogfood period; default-flip decision recorded as a DECISIONS entry with the telemetry.

## Acceptance criteria

- On iOS 26.x bridgeless: `cdp_run_action` for every current action passes via `transport:'native'` with **zero** maestro/WDA invocation and no 40 s doomed attempt (`auto` policy short-circuits on OS version).
- On iOS 18: default behavior byte-identical to today (maestro path) until the flip; `transport:'native'` forced via param passes the same actions.
- An action containing `tapOn: text:` (e.g. `cycle-task-priority`) — currently WDA-only — replays natively on both OS generations.
- A hybrid action with `x-rn:expectStore` passes natively and exports valid pure-Maestro YAML with the step stripped + comment.
- Repair engine behavior unchanged for genuine drift (native evidence feeds the same `SELECTOR_NOT_FOUND`-shaped failures).

## Test plan

- Unit: interpreter matrix (every step × pass/fail/optional/when), transport-policy truth table, export-stripping round-trip.
- Integration: fake-dispatch replay of all committed actions' YAML (grammar coverage gate: CI fails if a committed action contains a step the executor can't parse).
- Live: full action corpus on iOS 18 + iOS 26 sims, both transports; suite run with newly-failing diff verified.

## Risks & open questions

- **Two executors drift apart** (maestro vs native semantics): mitigated by the grammar-coverage CI gate + golden actions run on both transports in the nightly (Story 06 Phase B).
- **Timing semantics differ** (WDA's implicit waits vs our settle engine): the adjusted-budget lookup (Maestro's own algorithm) is the equalizer; flake-rate telemetry gates the default flip.
- **Scope creep toward a full Maestro clone:** the `UNSUPPORTED_STEP` guard + "only what committed actions need" rule is the fence, same as Phase 2.
