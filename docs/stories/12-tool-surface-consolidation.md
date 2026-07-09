# Story 12 — MCP tool-surface consolidation + instructions budget

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Agent ergonomics: fewer, clearer tools → better tool selection, lower per-session token overhead; institutionalizes the "agents ignore descriptions" defenses
**Effort:** L (spread over several releases; telemetry-gated)
**Depends on:** Story 06 Phase C (evals are the safety gate for every merge/removal)

## Problem

The bridge registers **74 tools** (`packages/rn-dev-agent-core/src/index.ts`, ~2488 lines of registration). Maestro's team went the opposite direction — 15 → 8 — and wrote down why (commit `b54bdfa8`): primitives that are one-line wrappers get deleted; validation folds into execution; docs-retrieval delegates to the host agent. They also *observed agents ignoring tool descriptions and server instructions* (Cursor, Codex — `viewer/ViewerHint.kt:9-12`), which gets worse as the surface grows: every tool is another entry competing in the model's selection, and another block of schema tokens in every session.

Our situation is legitimately different — the CDP white-box layer (state, component tree, network, navigation) has no DSL to collapse into, and a *development* agent needs interactive primitives a *test runner* doesn't. The goal is not 8 tools; it's removing overlap and merge-debt so every remaining tool earns its slot.

## What Maestro does (mechanics worth copying regardless of count)

- **Instructions ≤ 2 KB, enforced by a unit test** (`McpServerTest.kt:9-11`), and the test asserts instructions name every registered tool (`:14-28`).
- **Anti-hallucination guidance lives in tool descriptions** (`InspectScreenTool.kt:14-29`): copy `txt` verbatim, never author selectors from screenshots, regex full-match semantics with a worked example.
- **First-tool-result injection** for information agents must not miss (`ViewerHint.kt:13-32`, AtomicBoolean once-only) — because descriptions are "suggestion-grade."
- **Mutual-exclusion schemas with precise failure messages** (`RunTool.kt:317-372`: "`yaml`, `files`, and `dir` are mutually exclusive; got: yaml, files") — merged tools stay unambiguous because bad input errors *teach*.
- **Validation folded into execution** (no separate `check_flow_syntax`).

## Design

### Phase 0 — Measure (2 weeks, no behavior change)

Per-tool call counts + co-occurrence from session telemetry (the observability layer already sees every call). Deliverable: usage table ranked ascending — the merge shortlist is data, not taste.

### Phase 1 — Merge families (each merge = one PR, eval-gated)

Candidates by inspection (Phase 0 confirms/reorders):

| Family | Today | Proposed |
|---|---|---|
| Assertions | `expect_text`, `expect_route`, `expect_redux`, `expect_visible_by_testid` | `expect` with `kind` discriminant (mutually-exclusive fields, Maestro-style errors). Also becomes the `x-rn:` step vocabulary (Story 07) — one assertion grammar, two consumers |
| Recording | 8 × `cdp_record_test_*` | `cdp_record` with `action: start\|stop\|annotate\|save\|save_as_action\|load\|list\|generate` |
| Logs | `cdp_console_log`, `cdp_error_log`, `cdp_native_errors` | `cdp_logs` with `source` param |
| Pickers | `device_pick_date`, `device_pick_value` | `device_pick` |
| System dialogs | `device_accept_system_dialog`, `device_dismiss_system_dialog`, `device_permission` | `device_system` with `action` |
| Diagnostics | `cdp_status`, `cdp_targets`, `cdp_diagnostic_renderers` overlap | `cdp_status` absorbs targets/renderers behind `detail` levels |

Non-goals: `device_batch` already is our composite executor — promote it in skill guidance as the preferred multi-step verb (the Maestro "prefer one full flow over many single-command calls" nudge), but do **not** delete live primitives; a dev agent legitimately drives step-by-step while observing state between steps.

**Deprecation policy:** merged-away names stay registered as thin aliases for 2 minor versions with `[DEPRECATED → use X]` prefixed to their descriptions; alias calls logged; removal PR cites zero/near-zero alias telemetry. Skills/docs/agents update in the same PR as each merge (grep-enforced: no skill references a deprecated name).

### Phase 2 — Instructions budget + hint injection

- Rewrite server instructions to a compact workflow guide (session-open → snapshot → interact → verify → record), ≤ 2 KB, naming every tool family; **unit test enforcing size + completeness** (Maestro's exact test shape).
- One-time first-result hint (per session, AtomicBoolean-equivalent): when the first tool call arrives without an open session/connection, prepend the 3-line quickstart to the result. Mirrors `ViewerHint`; replaces hoping the model read the instructions.
- Description audit pass: every observation tool gets its anti-hallucination lines (snapshot: "use `@ref`s verbatim; `t` is testID — never invent selectors from screenshots"; this ships with Story 08's format).

### Phase 3 — Prune (telemetry + evals decide)

Tools with ~zero calls over Phase 0 + a dogfood cycle become removal candidates (each removal PR carries its usage numbers). Expected surface after all phases: **~45–50 tools** — honest for a white-box dev agent; the win is eliminated *overlap*, not a vanity count.

## Implementation steps

1. Telemetry aggregation script + usage report artifact.
2. Merge PRs in table order (assertions first — it also unblocks Story 07's `x-rn:` grammar), each: new tool + aliases + skill/doc updates + eval run attached.
3. Instructions rewrite + size test + first-result hint.
4. Prune PRs; final state documented in README tool index.

## Acceptance criteria

- Story 06 Phase C eval scores (tool-selection accuracy, task completion) non-regressing after every merge PR — the hard gate.
- Server instructions ≤ 2048 bytes with the completeness test green.
- A fresh session where the model's first call is `device_press` (no session) receives the quickstart hint in that result and recovers in ≤ 2 calls (eval fixture).
- Alias telemetry at removal time shows < 1 % of calls on deprecated names.
- Per-session schema token overhead reduced ≥ 25 % (measure: serialized tool-list size before/after).

## Test plan

- Unit: schema mutual-exclusion error messages for every merged tool (table-driven); instructions size/completeness; alias routing.
- Evals: per-merge fixture runs (Phase C harness); a dedicated "which tool would you use to X" fixture set covering the merged families.
- Dogfood: one week per merge wave before the next.

## Risks & open questions

- **Muscle-memory breakage for existing users/skills:** the 2-minor alias window + same-PR skill updates cover plugin-internal callers; CHANGELOG calls out each merge loudly.
- **Merged schemas becoming kitchen-sinks:** the discriminant-field pattern with mutual-exclusion errors is the guard — if a merged tool needs > ~6 fields per variant, it stays split (RunTool's 3-variant shape is the ceiling).
- **Eval noise gating real work:** evals gate on *regression beyond noise band* (baseline ± measured variance from Story 06), not point scores.
