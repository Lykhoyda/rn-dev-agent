# Story 06 Phase C.2 — subscription-funded eval runner (design)

**Issue:** #387 (Story 06 — Native runner tests in CI + LLM-behavior evals)
**Story doc:** `docs/stories/06-native-runner-ci-and-evals.md` (Phase C section)
**Date:** 2026-07-09
**Status:** Approved (user, 2026-07-09)
**Amends:** `2026-07-09-387-phase-c-llm-evals-design.md` (Decision 3 —
harness choice — and Decision 2 — credentials). Everything not named here is
unchanged from that spec.
**Prior state:** Phase C merged as PR #521 (fixtures, orchestrator,
compare-baseline gate, on-demand workflow). Acceptance (baseline capture) was
NOT run — it required a paid `ANTHROPIC_API_KEY`, which does not exist.

## Problem

Phase C's runner (`mcp-server-tester`) embeds the Anthropic SDK and
authenticates **only** with a raw API key — both the CI lane and the local
`yarn evals` lane are pay-per-token. The maintainer has no API budget; the
sanctioned funding source is the Claude **subscription**, which is only
usable through Claude Code itself. As merged, the harness can never run, so
the Story 08/12 regression gate has no baseline.

## Decisions (approved, user 2026-07-09)

1. **Execution engine: headless Claude Code** (`claude -p`), replacing
   `mcp-server-tester`. Verified against CLI 2.1.205: `-p`,
   `--mcp-config`/`--strict-mcp-config`, `--allowedTools`,
   `--output-format stream-json`, `--model` all exist. Each fixture becomes
   one headless run against the real server config; the stream-json
   transcript carries every `tool_use` + result (`is_error`) + final text —
   everything the existing assertions need.
2. **CI stays alive, subscription-funded:** the `llm-evals.yml` secret
   becomes `CLAUDE_CODE_OAUTH_TOKEN`, minted once by the maintainer with
   `claude setup-token` (long-lived, requires Claude subscription — verified
   in CLI 2.1.205). Locally, `corepack yarn evals` uses the developer's
   logged-in `claude` session; no token, no key.
3. **Everything downstream of the junit files is untouched:** fixture YAML
   schema and contents (byte-identical), `compare-baseline.ts`, baseline
   semantics (per-model, gate only baselined-passing, filtered runs
   informational), junit/summary/results shapes, workflow dispatch-only +
   fail-red-guard structure.

## Design

### Runner swap (`run-evals.ts` + new `claude-runner.ts`)

`run-evals.ts` keeps its contract (env vars `EVAL_MODEL`, `EVAL_FILTER`,
`EVAL_RESULTS_DIR`; per-YAML junit + `summary.md` into `results/`; baseline
compare last; filtered runs skip the gate). Internals change:

- **Parse the eval YAMLs ourselves** (schema unchanged:
  `evals.models/max_steps/tests[].{name,prompt,expected_tool_calls.required,response_scorers}`).
  `${VAR}` substitution stays **raw-text pre-parse** (same as the tester),
  so the minified-fixture-injection behavior and committed YAMLs are
  byte-identical.
- **One fixture = one headless run:**
  `claude -p <prompt> --mcp-config server-config.json --strict-mcp-config
  --allowedTools "mcp__<server>__*" --output-format stream-json
  --model $EVAL_MODEL` with cwd set to an **empty scratch directory** so no
  project `CLAUDE.md`/plugins leak into the fixture context (CI has no user
  config; local must match it as closely as the CLI allows — the probe task
  pins the exact flag set, e.g. `--setting-sources`, and the README
  documents any residual local/CI divergence).
- **Assertions engine (ours), same semantics the fixtures were authored
  for:**
  - `expected_tool_calls.required` — tool called at least once **and** its
    result has `is_error: false` (the review-verified required-implies-
    success constraint is preserved deliberately).
  - `llm-judge` — a second plain `claude -p` (no MCP) that receives the
    criteria + the fixture's final response (+ a compact tool-call trace),
    returns strict JSON `{score: 0..1, reasoning}`, compared against the
    fixture's `threshold`. Judge model: `EVAL_JUDGE_MODEL`, default
    `claude-haiku-4-5-20251001`.
  - `regex` — kept for schema parity (no current fixture uses it).
- **Budgets:** `max_steps` maps to the CLI's turn-limit flag if 2.1.205
  exposes one (probe task); otherwise a per-fixture wall-clock timeout
  (default 180 s) is the bound and `max_steps` is documented as advisory.
- **Retry improves:** per-FIXTURE retry (we control the loop) replaces the
  tester's per-FILE retry — closer to the original Phase C spec intent.
- **Junit output:** we write the same junit XML shape `parseJunitXml`
  already parses, per YAML file — `compare-baseline.ts` and the workflow's
  artifact/summary steps stay byte-identical.

### Dependency retirement

`mcp-server-tester` devDependency (root + core), the committed Yarn
`patch:` (retired-judge-model swap — moot: the judge is now our own call),
and the root `dependenciesMeta` workaround are all removed. If YAML parsing
needs a package, prefer one already in the workspace tree (probe task);
otherwise add `yaml` as a devDependency.

### Workflow — `.github/workflows/llm-evals.yml`

- Guard step now requires `CLAUDE_CODE_OAUTH_TOKEN` (same fail-red,
  actionable message: "run `claude setup-token` and add the repo secret").
- New step installs a **pinned** `@anthropic-ai/claude-code` globally
  (stream-json schema drift across CLI versions is the main supply-chain
  risk; the pin makes CI deterministic — local runs use whatever the
  developer has, documented).
- Eval step env: `CLAUDE_CODE_OAUTH_TOKEN` (recognized natively by the CLI)
  instead of `ANTHROPIC_API_KEY`. Inputs, permissions (`contents: read`),
  artifact/summary steps unchanged.

### Auth preflight

`run-evals.ts` replaces the API-key check with a cheap headless probe
(`claude -p` "reply OK", tiny budget) before touching fixtures: exit 2 with
an actionable message ("`claude` not logged in / token invalid") on
failure — the missing-credential path stays RED-with-message, never a
confusing mid-run error.

## Acceptance criteria (supersedes Phase C's)

- A real run is green **on subscription** (locally first; then a CI
  dispatch with the OAuth-token secret in place), and `baseline.json` is
  committed from that run's actual results.
- Seeded-regression check unchanged: degrade one tool description /
  expected behavior on a scratch branch, run, show the compare goes red.
- Cost note in the README rewritten: subscription rate-limit weight,
  ~$0 marginal; rough tokens-per-run measured from the stream-json usage
  fields.
- Story doc Phase C section updated (C.2 note + acceptance results).

## Out of scope

- Changing any fixture, the baseline semantics, or `compare-baseline.ts`.
- Multi-provider evals; scheduled cadence (both still deliberately out).
- A general-purpose eval framework — this stays a ~2-file runner private to
  `test/evals/`.

## Risks

- **stream-json schema drift:** CLI version pinned in CI; the transcript
  parser asserts on the event fields it needs and fails loud (infra exit 2,
  not a fake fixture verdict) when the shape changes.
- **Ambient-context contamination locally:** mitigated by empty-cwd +
  `--strict-mcp-config` + the probe-pinned flag set; residual divergence
  documented. Baselines are captured from runs using the same isolation.
- **Judge consistency:** the judge prompt is ours now; it ships with strict
  JSON output instructions and a fixed default judge model, and the same
  per-fixture retry absorbs residual noise.
- **Subscription rate limits:** ~9 fixtures × (1 agentic run + 1 judge
  call) on Haiku is a light dent in a Max plan; CI runs draw from the same
  subscription — acceptable at on-demand cadence (same reasoning as Phase
  C's budget decision).
- **ToS posture:** subscription usage flows exclusively through Claude Code
  itself (`claude -p`, `claude setup-token`) — the sanctioned surfaces; the
  raw-API path is fully removed rather than worked around.
