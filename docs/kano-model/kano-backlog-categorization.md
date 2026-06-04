# Kano Categorization — rn-dev-agent Open Backlog (16 issues)

**Date:** 2026-06-04 · **Method:** inferred from issue content + field reports (#186) + ship-state — *no survey* (see the [report](./2026-06-04-kano-model-research-report.md) §5–6 for why these are **hypotheses, not measurements**).

**Anchor — the tool's core promise:** *turn Claude into an RN dev partner that **verifies live on device** (component tree, store, nav via CDP) + drives device interaction + runs Maestro flows + replays actions.* A bug that breaks **connect → introspect → interact** breaks the core promise → **Must-be**. Quality/accuracy/ergonomics that **scale** with satisfaction → **Performance**. New surfaces/capabilities that aren't missed when absent → **Attractive**.

## Category table

| # | Issue (short) | Kano | Ship-state | Rationale |
|---|---|---|---|---|
| **#208** | CDP connection wedges ("Already connecting") + misleading "Metro not found" | **Must-be** | open | Connecting is step one; a wedge breaks *everything* downstream. Absence of reliable connect = strong dissatisfaction; the misleading error compounds it. |
| **#182** | CDP MCP `-32000` when orphaned bridge holds the single-instance lock | **Must-be** | open | A stale prior session bricks startup. Core reliability; users expect a clean start. |
| **#210** | `device_*` fails "rn-fast-runner not started" while `cdp_status` says connected — no session visibility | **Must-be** | open | Core L2 interaction silently unavailable + state is unobservable. Breaks the "interact + verify" loop and its diagnosability. |
| **#191** | Native text-input unreliable (char-drop); make `cdp_interact` typeText default | **Must-be** | open | Entering text into forms is table-stakes interaction. Dropped characters = a basic promise failing. |
| **#202** | 3-layer device control + Session Arbiter (foreground contention) | **Must-be** | ✅ shipped (Ph1–2b, #218) | Fixed the contention that broke core device control. The floor; now "verify & close" (Phase 3 = docs + proactive warn). |
| **#194** | iOS verification UX: stale sessions, runner conflict, destructive clearState, recovery loops | **Must-be** | ◑ largely shipped (#202/#188) | Core iOS verification reliability. Most addressed; remaining ergonomics are Performance. *Note: destructive clearState has a mild **Reverse** signal — see below.* |
| **#186** | maestro-mcp interop — driver conflict, runFlow allowlist, flow-drift | **Performance** | ◑ largely shipped (#188, Ph3 docs pending) | Interop smoothness scales satisfaction for power users; the reliability-breaking part shipped. Remainder is polish. |
| **#201** | `maestro_run` can't pass `--app-file` (clearState on iOS) | **Performance** | ✅ shipped (#202 Ph1) | clearState flows are a core test capability; the gap forced a CLI escape. Resolved. |
| **#214** | `cdp_network_log` returns duplicate entries per request | **Performance** | open | Introspection **accuracy** scales satisfaction; duplicates degrade a core read. Cheap, high-confidence fix. |
| **#209** | `cdp_mmkv` delete fails on Nitro MMKV v3 (API is `remove`) | **Performance** | open | Storage/auth-reset capability broken for a real subset (Nitro MMKV v3). Small, well-scoped fix. |
| **#206** | `/observe` device section — screenshot stale + route out of sync | **Performance** | open | Observability **freshness** scales trust in the UI; stale data is misleading but not core-breaking. |
| **#211** | `maestro_run` — structured step results, partial progress on timeout, iOS clearState | **Performance** | open | Better flow feedback scales satisfaction; partial-progress-on-timeout improves the failure experience. |
| **#199** | CLAUDE-MD-TEMPLATE native-log-first error-recovery row | **Performance** *(weak)* | open | Improves error-recovery success via better guidance. Low dissatisfaction if absent; docs-only. |
| **#108** | CLI surface for L3 actions (`bin/rn-action list/run`) for non-LLM consumers | **Attractive** | open | Net-new audience (CI/non-LLM). Not missed by current LLM-driven users; opens a delight/strategic surface. |
| **#212** | Route-triggered capture for transient screens + auto-recover after many reloads | **Attractive** | open | Novel proof-capture capability (transient screens) — a delighter. (The "auto-recover after reloads" sub-part is Performance/reliability.) |
| **#173** | Session feedback (IX-2997): 5 wins + 5 friction items | **Indifferent** *(meta)* | open | Not a single feature — a feedback **container**. Decompose into discrete issues, then categorize each; as-is it carries no single satisfaction signature. |

**Reverse watch:** #194's **destructive `clearState`** is a mild **Reverse** signal — for users mid-debug, an aggressive auto-reset *destroys* state they wanted (more "helpfulness" = worse). Keep clearState opt-in/guarded rather than default-aggressive.

## Prioritized order (Kano-gated, then effort/impact within gate)

> Kano rule: clear Must-bes first; then Performance by satisfaction-gradient × cheapness; then selective Attractive. Ship-state pulls completed items to the bottom.

**Wave 1 — Must-be, still open (the floor; do first):**
1. **#208** — connection wedge + misleading error (blocks the whole loop)
2. **#182** — orphaned-bridge lock `-32000` (blocks clean startup)
3. **#210** — `device_*` unavailable + no session visibility (blocks interaction + diagnosability)
4. **#191** — reliable text input (`cdp_interact` typeText default)

**Wave 2 — Performance, cheap & high-confidence (fast satisfaction gains):**
5. **#214** — dedupe network log (data accuracy; small)
6. **#209** — `cdp_mmkv` `remove` API (unblocks storage/auth reset; small)
7. **#206** — `/observe` freshness (screenshot + route sync)
8. **#211** — structured maestro step results + partial progress

**Wave 3 — Attractive (differentiate, after the floor):**
9. **#212** — transient-screen capture (+ its reliability sub-part)
10. **#108** — `bin/rn-action` CLI surface (strategic, non-LLM audience)

**Wave 4 — de-prioritize / housekeeping:**
11. **#199** — template error-recovery docs (weak Performance; bundle into a docs pass)
12. **#173** — decompose the feedback bucket into discrete issues, then re-triage

**Verify & close (largely shipped via #218 / #188 — confirm on device, then close or scope the true remainder):**
- **#202** (Phases 1–2b shipped; Phase 3 = docs + proactive foreign-runner warning) · **#201** (shipped) · **#194** (largely shipped) · **#186** (reactive fix shipped; Phase 3 docs pending)

## How to apply

1. Add the `kano:*` + `effort:*` labels (see [`kano-label-scheme-and-triage.md`](./kano-label-scheme-and-triage.md)).
2. Label the 16 issues per the table above.
3. Work top-down through the waves; never start a later wave while a Must-be is open and unblocked.
4. Re-run the triage cadence monthly (categories decay — today's delighter is tomorrow's must-be).
