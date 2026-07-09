# LLM-behavior evals (Story 06 Phase C, #387)

On-demand evals that measure how a real LLM **uses** the rn-dev-agent MCP tool
surface — not whether the tools work (that is the Phase B device smoke), but
whether a model picks the right tool, stays honest when a call fails, and can
read our payloads. Each fixture runs as a **headless Claude Code call**
(`claude -p`) against the real server
(`packages/rn-dev-agent-core/dist/supervisor.js`) with **no device connected**
— **subscription-funded, no API key** — and gates on a committed per-model
baseline.

## The two families

Both families live as `*.eval.yaml` here and share one baseline.

- **`tool-correctness.eval.yaml` — tool-call correctness.** Drives the real
  server with nothing connected and checks the model reaches for the right tool
  and reports failures honestly (e.g. a store read with no session → check
  connection + report the real error, never invent store contents). Uses
  `expected_tool_calls.required` + `llm-judge` scorers on the final response.
- **`output-usability.eval.yaml` — output usability.** Embeds **real recorded
  payloads** (`fixtures/*.json`) in the prompt and checks a model can consume
  them: pick the right `@ref` from a snapshot, recover from a `STALE_REF`
  envelope via its `candidates` list, admit when an element is absent. This
  family is the **regression gate for Story 08** (compact snapshot format) and
  **Story 12** (tool consolidation) — if a format/tool change makes a payload
  harder to consume, these scores drop and the baseline compare goes red.

## Run it

### On demand in CI (canonical)

Dispatch the **LLM evals** workflow (`.github/workflows/llm-evals.yml`) —
`workflow_dispatch` only. It requires the `CLAUDE_CODE_OAUTH_TOKEN` repo secret
(mint one with `claude setup-token`, needs a Claude subscription); a missing
secret is a **RED run with an actionable message**, never a silent skip.
Inputs: `model` (default `claude-haiku-4-5-20251001`), `filter` (default
empty). Marginal cost **~$0** — the run draws on the subscription's rate-limit
weight, not per-token billing (the summary still reports the API-equivalent
dollar figure informationally).

### Locally

```bash
corepack yarn evals
```

`corepack yarn evals` runs `packages/rn-dev-agent-core/test/evals/run-evals.ts`
(Node 22 type stripping — no build step; the server is the committed `dist/`).
It needs a **logged-in `claude` CLI** and **no booted simulator/emulator** — a
preflight refuses when a device is connected (evals must be device-free;
`EVAL_ALLOW_DEVICE=1` allows an informational, non-gating run). It runs each
fixture as a `claude -p` call, retries any **file** that had a failure once,
writes per-YAML `*.junit.xml` + a `summary.md` into `results/` (gitignored),
then runs the baseline compare. Your local CLI version may drift from the CI
pin (`@anthropic-ai/claude-code@2.1.205`); **gating runs are canonical in CI**.

**Isolation:** fixtures run with `--setting-sources ""`, `--tools ToolSearch`,
`--strict-mcp-config`, and an empty scratch cwd, so your local `CLAUDE.md` /
plugins / MCP config do **not** leak into a run.

Environment:

| Var | Default | Meaning |
|---|---|---|
| `EVAL_MODEL` | `claude-haiku-4-5-20251001` | Model under test (claude CLI `--model`). |
| `EVAL_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | Judge model for `llm-judge` scorers. |
| `EVAL_FILTER` | empty | Substring on eval YAML file names; filtered runs are **INFORMATIONAL** — the baseline gate is SKIPPED and the run exits 0, because comparing a partial result set against the full baseline would count every omitted fixture as a regression. |
| `EVAL_FIXTURE_TIMEOUT_MS` | `180000` | Wall-clock bound per fixture run (no `--max-turns` on the pinned CLI; YAML `max_steps` is advisory). |
| `EVAL_ALLOW_DEVICE` | unset | `1` = run despite a booted device — informational only, gate skipped. |
| `CLAUDE_BIN` | `claude` | Claude CLI binary override. |

## Baseline semantics

The baseline (`baseline.json`) is **per-model** and records, for each fixture,
the verdict it is promised to hold. The gate (`compare-baseline.ts`):
regression = a fixture recorded `pass` in the baseline that now fails **or is
missing** from the results; non-baselined fixtures never gate.

Regenerate (a **reviewed commit**, not automatic):

```bash
node packages/rn-dev-agent-core/test/evals/compare-baseline.ts \
  --results <results-dir> --write-baseline --model <model-id>
```

It **refuses to enshrine failing fixtures** (an all-red first run must not
become a green gate) unless you pass `--allow-failures` deliberately, justified
in the PR. Because the baseline is per-model, re-baseline whenever you change
`EVAL_MODEL`. The baseline's `testerVersion` now records the **claude CLI
version** the run used (not a tester package version). Only capture a baseline
from a **non-informational** run — a `EVAL_FILTER`ed or `EVAL_ALLOW_DEVICE=1`
run skips the gate and must never become the committed baseline.

## Authoring fixtures

- **One behavior per fixture.** Keep each test focused on a single decision.
- **Never name the expected tool in the prompt.** Describe the goal
  ("what devices can I test on?"), not the tool (`device_list`). Naming the tool
  measures instruction-following, not tool choice.
- **`required` implies the tool must SUCCEED.** The tester fails a fixture if a
  `required` tool returns `isError:true`. With no device connected, only
  `cdp_status` and `device_list` succeed — so those are the only tools you may
  put in `expected_tool_calls.required`. Assert behavior around *failing* tools
  via `llm-judge` criteria on the final response instead.
- **Prefer `llm-judge`/`regex` scorers over `allowed`.** Avoid pinning an exact
  allowed-tool set; judge the outcome.

## Cost notes

- Every request carries the **full ~79-tool schema** (the whole MCP surface),
  so each eval turn is not cheap.
- A file containing **any** failure is retried **whole**, so a flaky fixture
  costs roughly **2× that file's tokens**.
- Measured per-run figure: _filled in by the acceptance task._
