# Story 06 Phase C — LLM-behavior evals (design)

**Issue:** #387 (Story 06 — Native runner tests in CI + LLM-behavior evals)
**Story doc:** `docs/stories/06-native-runner-ci-and-evals.md` (Phase C section)
**Date:** 2026-07-09
**Status:** Approved (user, 2026-07-09)
**Prior phases:** A (native unit tests in CI, #464) and B (nightly device smoke,
#480 + follow-ups) shipped and acceptance-complete.
**Unblocks:** Story 08 (token-efficient outputs) and Story 12 (tool-surface
consolidation) — both declare Phase C's eval baseline as their regression gate.

## Problem

The Maestro precedent (`mcp-server-tester` README): tools must be tested "not
only that [they work] correctly but that LLMs can call [them] correctly and use
the output appropriately. This happens less frequently than is expected."
rn-dev-agent exposes ~79 MCP tools; nothing measures whether a model picks the
right tool, recovers from the documented error envelopes, or can consume a
`device_snapshot` payload well enough to produce the right `@ref`. Stories 08
and 12 will change exactly these surfaces (compact snapshot format; tool
merges/removals) and have no safety gate without a recorded baseline.

## Decisions (approved)

1. **Cadence & budget: on-demand only** (user decision 2026-07-09). No
   schedule. `workflow_dispatch` runs before Story 08/12 merges and for
   baseline (re)capture. Budget control is approximate — fixture count ×
   model choice (Haiku default, ~$1–3/run) — accepted for on-demand cadence.
   The story's "nightly" is deliberately relaxed; a schedule can be added
   later without design changes.
2. **Credentials:** a repo secret `ANTHROPIC_API_KEY`, added by the
   maintainer (no API-key precedent exists in this repo's CI). The workflow
   fails fast with an actionable message when the secret is absent.
3. **Approach: adopt `mcp-server-tester`** (story-named, Maestro-proven;
   version-pinned devDependency). Its `evals` command spawns our real server
   from a config JSON, drives an Anthropic model in an agentic loop against
   the live tool surface, and supports two assertion kinds we need: expected
   tool calls ("Required tool 'X' was not called (actual: Y)") and LLM-judge
   scores with thresholds. Rejected: a custom harness on `supervisor-harness`
   + Anthropic SDK (full token control, but a whole framework to own —
   YAGNI at on-demand cadence). Documented fallback (hybrid): a tiny custom
   judge script only if a fixture type proves inexpressible in the tool's
   YAML.

## Design

### Layout

Everything lives in `packages/rn-dev-agent-core/test/evals/`:

- `server-config.json` — spawns the real server:
  `node packages/rn-dev-agent-core/dist/supervisor.js` over stdio (the same
  entry marketplace installs run).
- `tool-correctness.eval.yaml` — fixtures that run against the real server
  with **no device connected**.
- `output-usability.eval.yaml` — fixtures with **real recorded payloads
  embedded in the prompt**.
- `fixtures/` — the recorded envelopes (committed JSON): a real
  `device_snapshot` payload from the Phase B smoke debug artifacts, and a
  `STALE_REF` envelope with `candidates[]` (Story 05's enriched shape).
- `baseline.json` — per-fixture results from the accepted baseline run;
  records the model id and mcp-server-tester version (baselines are
  per-model).
- `README.md` — how to run locally, cost note, fixture-authoring rules.
- A compare script (`compare-baseline.ts`, same package) — exits non-zero if
  any fixture that passes in `baseline.json` fails in the current results
  (after the harness's retry); new fixtures don't fail the compare until
  baselined.

Local entry: root `yarn evals` (requires `ANTHROPIC_API_KEY` in the env).

### Fixture set v1 (~12–16 evals, two families)

**Tool-call correctness** — live server, no device; assertions on which tools
the model calls, not on their success:

- *Snapshot-before-press:* "Tap the login button in the running app" → must
  call an observation tool (`device_snapshot`/`device_find`/`cdp_status`)
  before any `device_press`; a blind press with a fabricated `@ref` fails.
- *Blank-screen diagnosis:* "The app shows a blank screen — investigate" →
  first calls diagnostic tools (`cdp_status`, logs/error tools), not
  interaction verbs.
- *NOT_CONNECTED recovery:* "Read the Redux store state" (CDP down) → after
  the error envelope, attempts recovery (`cdp_status`/`cdp_connect`) rather
  than repeating the same failing call verbatim.
- *Tool discovery:* "What can you do with the device?" → LLM-judge scores
  coverage/accuracy of the described surface.

**Output-usability** — recorded payloads in the prompt (envelopes that need
device state can't be elicited live; this split is deliberate):

- *@ref selection:* real `device_snapshot` payload + "which `@ref` is the
  bottom Tap button?" → judged/regexed on the correct `@eNN`.
- *Ambiguity handling:* description matching multiple nodes → model
  disambiguates by `identifier` (or asks), not by picking the first label hit.
- *STALE_REF recovery:* embedded `STALE_REF` envelope with `candidates[]` →
  model re-targets the correct candidate ref.

Fixture-authoring rules (in the README): small and assertion-focused; one
behavior per fixture; prompts must not name the expected tool (that would
test string-matching, not selection).

### Baseline + regression gate

The first accepted dispatch run's results are committed as `baseline.json`.
The compare script is the Story 08/12 gate: their PRs dispatch the workflow
and must not regress any baselined-passing fixture. Noise handling: one retry
per failing fixture before it counts as failed; baselines are per-model, so a
model upgrade means a deliberate re-baseline commit, never a silent drift.
Results are uploaded as run artifacts + rendered into the job summary; no
dashboard (on-demand cadence does not warrant one).

### Workflow — `.github/workflows/llm-evals.yml`

- Trigger: `workflow_dispatch` only. Inputs: `model` (default Haiku),
  `filter` (optional fixture-name filter).
- Guard step: if `ANTHROPIC_API_KEY` is absent → fail immediately with "add
  the ANTHROPIC_API_KEY repo secret" (never a silent skip — a gate run that
  didn't run must not look green).
- Steps: checkout → Node 22 → `corepack yarn install --immutable` →
  `yarn evals` (with the secret) → compare against `baseline.json` → upload
  results artifact + job summary.
- Permissions: `contents: read` only. ~5–10 min, est. $1–3 per run (Haiku).

## Acceptance criteria

- A real dispatch run is green with the secret in place, and `baseline.json`
  is committed **from that run's actual results** (not hand-authored).
- Seeded-regression check (the Phase A/B mutation pattern): deliberately
  degrade one tool description or swap an expected behavior on a scratch
  branch, dispatch, and show the eval catches it (red compare).
- Cost per run measured and documented in the evals README.
- Story doc Phase C marked implemented with triage notes.

## Out of scope

- Any scheduled cadence (deliberate; can be added later).
- Multi-provider evals (Anthropic only — mcp-server-tester's support and the
  plugin's primary runtime).
- Device-dependent eval fixtures (the golden-path device behavior is Phase
  B's job; evals test model behavior against the tool surface).
- Dashboards/trend visualization.

## Risks

- **Eval noisiness:** mitigated by small assertion-focused fixtures, one
  retry, and gating only on baselined-passing fixtures. If a fixture flaps
  across runs, it is removed or rewritten, not tolerated.
- **mcp-server-tester expressiveness:** if a fixture type cannot be expressed
  (e.g. payload-in-prompt judging), the documented fallback is a tiny custom
  judge script driving the same server config — not a harness rewrite.
- **Model drift:** baselines record the model id; re-baselining is an explicit
  reviewed commit.
- **Tool-surface size:** ~79 tool definitions per request is itself part of
  what's being measured (Story 12's motivation); if context limits bite,
  fixture-level tool allowlists are the escape hatch (mcp-server-tester
  supports server-config-level tool filtering; verify at plan time).
