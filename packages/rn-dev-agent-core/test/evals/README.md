# LLM-behavior evals (Story 06 Phase C, #387)

On-demand evals that measure how a real LLM **uses** the rn-dev-agent MCP tool
surface — not whether the tools work (that is the Phase B device smoke), but
whether a model picks the right tool, stays honest when a call fails, and can
read our payloads. They run `mcp-server-tester` against the real server
(`packages/rn-dev-agent-core/dist/supervisor.js`) with **no device connected**,
and gate on a committed per-model baseline.

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
`workflow_dispatch` only. It requires the `ANTHROPIC_API_KEY` repo secret; a
missing secret is a **RED run with an actionable message**, never a silent
skip. Inputs: `model` (default `claude-haiku-4-5-20251001`), `filter` (default
empty). Est. **$1–3 per run** on the default Haiku model.

### Locally

```bash
ANTHROPIC_API_KEY=sk-ant-… corepack yarn evals
```

`corepack yarn evals` runs `packages/rn-dev-agent-core/test/evals/run-evals.ts`
(Node 22 type stripping — no build step; the server is the committed `dist/`).
It spawns the tester per YAML, retries any **file** that had a failure once,
writes per-YAML `*.junit.xml` + a `summary.md` into `results/` (gitignored),
then runs the baseline compare.

Environment:

| Var | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Anthropic key for both the model under test and the llm-judge. |
| `EVAL_MODEL` | `claude-haiku-4-5-20251001` | Model under test. |
| `EVAL_FILTER` | empty | Substring on eval YAML file names. **A filtered run is INFORMATIONAL** — the baseline gate is SKIPPED and the run exits 0, because comparing a partial result set against the full baseline would count every omitted fixture as a regression. |

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
`EVAL_MODEL`.

## The mcp-server-tester Yarn patch

`mcp-server-tester@1.4.1` hardcoded the retired judge model
`claude-3-haiku-20240307`. A committed Yarn `patch:`
(`.yarn/patches/mcp-server-tester-npm-1.4.1-*.patch`) swaps it (and the config
default) to `claude-haiku-4-5-20251001`. A plain `corepack yarn install
--immutable` from the repo root applies it — no extra step.

The **judge model ≠ the eval model**: the patch pins the judge; `EVAL_MODEL`
(substituted into each YAML's `models`) is the model under test. They are
independent knobs.

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
