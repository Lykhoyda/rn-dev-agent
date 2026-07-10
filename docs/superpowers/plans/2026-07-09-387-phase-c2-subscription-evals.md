# Story 06 Phase C.2 — Subscription-Funded Eval Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pay-per-token `mcp-server-tester` execution engine with a headless-Claude-Code runner (`claude -p`) so the merged Phase C evals run on the maintainer's Claude subscription — locally via the logged-in CLI, in CI via a `CLAUDE_CODE_OAUTH_TOKEN` secret — while keeping the fixtures, the junit shape, and the `compare-baseline` gate byte-compatible (`summary.md` is display-only — no machine consumer — and gains turn/cost info).

**Architecture:** Two new modules beside the existing eval assets: `eval-core.ts` (pure: YAML parse + `${VAR}` substitution, stream-json transcript parse, required-tool verdicts, junit writer — all unit-tested) and `claude-runner.ts` (thin spawn wrappers: per-fixture headless run, LLM-judge call via `--json-schema`). `run-evals.ts` is rewritten to orchestrate them with three preflights (CLI present, authenticated, no booted device). `compare-baseline.ts` gets one metadata-only touch (recorded runner version). The workflow swaps its secret and installs a pinned CLI.

**Tech Stack:** Node >= 22 type stripping (no build step for `test/evals/`), `yaml` (ALREADY a runtime dependency of `rn-dev-agent-core` at `^2.8.3` — see Global Constraints), `@anthropic-ai/claude-code` CLI **2.1.205** (pinned in CI), `node --test` unit tests in `packages/rn-dev-agent-core/test/unit/`.

**Spec:** `docs/superpowers/specs/2026-07-09-387-phase-c2-subscription-evals-design.md`

## Global Constraints

- Fixture YAMLs (`tool-correctness.eval.yaml`, `output-usability.eval.yaml`), `fixtures/*.json`, and `server-config.json` are **byte-identical** — no task edits them.
- `compare-baseline.ts` gate logic untouched; only the `writeBaseline` metadata literal changes (Task 5).
- `${VAR}` substitution stays **raw-text pre-parse** (minified single-line JSON injection), same as the tester.
- `required` semantics preserved: tool called at least once AND at least one call not `is_error` — matched after stripping the `mcp__<server>__` prefix; `ToolSearch` calls never count.
- Headless flag set (probe-verified on 2.1.205, 2026-07-09): fixture runs use `--strict-mcp-config --allowedTools "mcp__rn-dev-agent__*" --tools ToolSearch --output-format stream-json --verbose --setting-sources "" --model <EVAL_MODEL>` with cwd = empty scratch dir and stdin ignored; judge runs use `--tools "" --setting-sources "" --output-format json --json-schema <VERDICT_SCHEMA>`.
- No `--max-turns` exists on 2.1.205 — the per-fixture bound is wall-clock (`EVAL_FIXTURE_TIMEOUT_MS`, default 180000); YAML `max_steps` is parsed but advisory.
- The judge score scale MUST be constrained in both schema (`minimum: 0, maximum: 1`) and prompt — probe showed an unconstrained judge returns `9`.
- `yaml` is ALREADY a runtime `dependency` of `rn-dev-agent-core` (`^2.8.3`), imported by 4 shipped files; the `tsc` build keeps `import ... from 'yaml'` as an external import in `dist/`. Do NOT `yarn add` it, do NOT move it to devDependencies — either breaks or risks consumer installs. Just import it.
- Infra-vs-fixture classification (review amendment 2026-07-09): a terminal result event with `is_error: true` or `subtype !== 'success'`, a missing result event, an unspawnable CLI, and a judge failure that persists after one judge retry are all INFRA → exit 2. Only in-budget runs that completed with `subtype: 'success'` produce fixture verdicts; a wall-clock timeout is the one exception (fixture FAIL, absorbed by the per-fixture retry).
- Explicit type imports (`import type { ... }`); no unnecessary comments; comments only for non-obvious constraints (match the existing eval files' density).
- Conventional commits referencing `#387`; changeset per change. NOTE: the 1Password signing agent was unreachable at session start — if `git commit` fails with a socket error, commit with `--no-gpg-sign` (GitHub signs the squash-merge).
- Runner spawn env passes `process.env` through (so `CLAUDE_CODE_OAUTH_TOKEN` reaches the CLI in CI).

---

### Task 1: `eval-core.ts` — YAML parsing + `${VAR}` substitution (TDD)

**Files:**
- Create: `packages/rn-dev-agent-core/test/evals/eval-core.ts`
- Create: `packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts`

(No dependency change: `yaml` is already a runtime dependency of this package — see Global Constraints. Review amendment 2026-07-09 removed the original `yarn add -D yaml` step, which would have demoted a runtime dep and broken consumer installs.)

**Interfaces:**
- Produces (consumed by Tasks 2–5):
  ```ts
  export type ScorerSpec =
    | { type: 'llm-judge'; criteria: string; threshold: number }
    | { type: 'regex'; pattern: string };
  export interface EvalFixture { name: string; prompt: string; required: string[]; scorers: ScorerSpec[] }
  export interface EvalFile { models: string[]; maxSteps: number | undefined; fixtures: EvalFixture[] }
  export function substituteVars(rawText: string, vars: Record<string, string>): string
  export function parseEvalYaml(rawText: string, vars: Record<string, string>): EvalFile
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { substituteVars, parseEvalYaml } from '../evals/eval-core.ts';

describe('substituteVars', () => {
  it('substitutes known vars raw-text and leaves unknown ones intact', () => {
    const out = substituteVars('m: ${EVAL_MODEL} p: ${SNAPSHOT_PAYLOAD} u: ${NOPE}', {
      EVAL_MODEL: 'haiku',
      SNAPSHOT_PAYLOAD: '{"a":1}',
    });
    assert.equal(out, 'm: haiku p: {"a":1} u: ${NOPE}');
  });
});

describe('parseEvalYaml', () => {
  const YAML = `
evals:
  models: ['\${EVAL_MODEL}']
  max_steps: 6
  tests:
    - name: 'fixture-a'
      prompt: >
        Do the thing.
      expected_tool_calls:
        required: ['device_list']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            Honest.
          threshold: 0.7
    - name: 'fixture-b'
      prompt: 'Other thing.'
      response_scorers:
        - type: 'regex'
          pattern: 'ok'
`;

  it('parses fixtures, required, and both scorer kinds', () => {
    const f = parseEvalYaml(YAML, { EVAL_MODEL: 'claude-haiku-4-5-20251001' });
    assert.deepEqual(f.models, ['claude-haiku-4-5-20251001']);
    assert.equal(f.maxSteps, 6);
    assert.equal(f.fixtures.length, 2);
    assert.equal(f.fixtures[0].name, 'fixture-a');
    assert.match(f.fixtures[0].prompt, /Do the thing\./);
    assert.deepEqual(f.fixtures[0].required, ['device_list']);
    assert.deepEqual(f.fixtures[0].scorers, [
      { type: 'llm-judge', criteria: 'Honest.\n', threshold: 0.7 },
    ]);
    assert.deepEqual(f.fixtures[1].required, []);
    assert.deepEqual(f.fixtures[1].scorers, [{ type: 'regex', pattern: 'ok' }]);
  });

  it('throws on duplicate fixture names within a file', () => {
    const dup = YAML.replaceAll('fixture-b', 'fixture-a');
    assert.throws(() => parseEvalYaml(dup, {}), /duplicate fixture name/);
  });

  it('throws on an unsupported scorer type', () => {
    const bad = YAML.replace("type: 'regex'", "type: 'exotic'");
    assert.throws(() => parseEvalYaml(bad, {}), /unsupported scorer type/);
  });

  it('parses the two committed eval YAMLs without loss', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const evalsDir = join(dirname(fileURLToPath(import.meta.url)), '../evals');
    const vars = { EVAL_MODEL: 'm', SNAPSHOT_PAYLOAD: '{}', STALE_REF_ENVELOPE: '{}' };
    const tc = parseEvalYaml(readFileSync(join(evalsDir, 'tool-correctness.eval.yaml'), 'utf8'), vars);
    assert.equal(tc.fixtures.length, 6);
    const ou = parseEvalYaml(readFileSync(join(evalsDir, 'output-usability.eval.yaml'), 'utf8'), vars);
    assert.ok(ou.fixtures.length >= 3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd packages/rn-dev-agent-core && yarn build >/dev/null 2>&1; node --test test/unit/story-06-evals-core.test.ts
```

Expected: FAIL — `Cannot find module .../eval-core.ts`.

- [ ] **Step 3: Implement `eval-core.ts` (parsing half)**

Create `packages/rn-dev-agent-core/test/evals/eval-core.ts`:

```ts
// Story 06 Phase C.2 (#387): pure core for the headless-Claude eval runner —
// YAML fixture parsing (schema-compatible with the retired mcp-server-tester,
// so committed eval YAMLs stay byte-identical), stream-json transcript
// parsing, required-tool verdicts, and junit output that round-trips through
// compare-baseline's parseJunitXml. Runs under Node >= 22.18 type stripping.
import { parse } from 'yaml';

export type ScorerSpec =
  | { type: 'llm-judge'; criteria: string; threshold: number }
  | { type: 'regex'; pattern: string };

export interface EvalFixture {
  name: string;
  prompt: string;
  required: string[];
  scorers: ScorerSpec[];
}

export interface EvalFile {
  models: string[];
  maxSteps: number | undefined;
  fixtures: EvalFixture[];
}

// Raw-text pre-parse substitution (tester-compatible): fixtures are injected
// as minified single-line JSON so block scalars survive. Unknown vars are
// left intact so a typo'd name fails loudly at YAML/JSON level, not silently.
export function substituteVars(rawText: string, vars: Record<string, string>): string {
  return rawText.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => vars[name] ?? m);
}

export function parseEvalYaml(rawText: string, vars: Record<string, string>): EvalFile {
  const doc = parse(substituteVars(rawText, vars)) as {
    evals?: {
      models?: string[];
      max_steps?: number;
      tests?: Array<{
        name?: string;
        prompt?: string;
        expected_tool_calls?: { required?: string[] };
        response_scorers?: Array<{ type?: string; criteria?: string; threshold?: number; pattern?: string }>;
      }>;
    };
  };
  const evals = doc?.evals;
  if (!evals || !Array.isArray(evals.tests)) throw new Error('eval YAML: missing evals.tests');
  const seen = new Set<string>();
  const fixtures = evals.tests.map((t): EvalFixture => {
    if (!t?.name || !t?.prompt) throw new Error('eval YAML: fixture missing name/prompt');
    if (seen.has(t.name)) throw new Error(`eval YAML: duplicate fixture name "${t.name}"`);
    seen.add(t.name);
    const scorers = (t.response_scorers ?? []).map((s): ScorerSpec => {
      if (s.type === 'llm-judge') {
        return { type: 'llm-judge', criteria: String(s.criteria ?? ''), threshold: Number(s.threshold ?? 0.7) };
      }
      if (s.type === 'regex') return { type: 'regex', pattern: String(s.pattern ?? '') };
      throw new Error(`eval YAML: unsupported scorer type "${s.type}" in "${t.name}"`);
    });
    return {
      name: t.name,
      prompt: String(t.prompt),
      required: t.expected_tool_calls?.required ?? [],
      scorers,
    };
  });
  return { models: evals.models ?? [], maxSteps: evals.max_steps, fixtures };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: PASS (all Task 1 tests; the file has no other tests yet).
Note: if the `criteria: 'Honest.\n'` assertion fails on trailing-newline handling of the `>` block scalar, adjust the EXPECTATION to the actual parsed value (e.g. `'Honest.'`) — folded-scalar trailing-newline behavior is a YAML detail, not a contract.

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/eval-core.ts packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts
git commit -m "feat(story-06): eval-core YAML parsing for the headless-Claude runner (#387)"
```

---

### Task 2: `eval-core.ts` — transcript parsing + required-tool verdicts (TDD)

**Files:**
- Modify: `packages/rn-dev-agent-core/test/evals/eval-core.ts` (append)
- Modify: `packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts` (append)

**Interfaces:**
- Produces (consumed by Tasks 3–5):
  ```ts
  export interface ToolCall { name: string; isError: boolean }
  export interface TranscriptOutcome { toolCalls: ToolCall[]; finalText: string; subtype: string; resultIsError: boolean; numTurns: number; totalCostUsd: number }
  export function parseTranscript(streamJson: string): TranscriptOutcome  // throws on missing result event
  export function stripMcpPrefix(name: string): string
  export interface FixtureCheck { pass: boolean; reasons: string[] }
  export function checkRequired(outcome: TranscriptOutcome, required: string[]): FixtureCheck
  ```

Stream-json shapes (probe-verified on 2.1.205, 2026-07-09): one JSON object per line; `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"...","name":"mcp__rn-dev-agent__device_list","input":{...}} | {"type":"text","text":"..."}]}}`; `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","is_error":true|absent,"content":[...]}]}}`; terminal `{"type":"result","subtype":"success","is_error":false,"num_turns":8,"total_cost_usd":0.029,"result":"final text"}`. Non-JSON lines (stderr warnings) must be skipped.

- [ ] **Step 1: Write the failing tests (append to the test file)**

```ts
import {
  parseTranscript,
  stripMcpPrefix,
  checkRequired,
  type TranscriptOutcome,
} from '../evals/eval-core.ts';

const line = (o: unknown) => JSON.stringify(o);
const SAMPLE = [
  'Warning: no stdin data received in 3s, proceeding without it.',
  line({ type: 'system', subtype: 'init', tools: ['ToolSearch'] }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:mcp__rn-dev-agent__device_list' } }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__rn-dev-agent__device_list', input: {} }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: '{"ok":true}' }] }] } }),
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't3', name: 'mcp__rn-dev-agent__cdp_store_state', input: {} }] } }),
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: [{ type: 'text', text: 'NOT_CONNECTED' }] }] } }),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.01, result: 'One device: iPhone 17.' }),
].join('\n');

describe('parseTranscript', () => {
  it('collects tool calls with error flags and the final result', () => {
    const o = parseTranscript(SAMPLE);
    assert.deepEqual(o.toolCalls, [
      { name: 'ToolSearch', isError: false },
      { name: 'mcp__rn-dev-agent__device_list', isError: false },
      { name: 'mcp__rn-dev-agent__cdp_store_state', isError: true },
    ]);
    assert.equal(o.finalText, 'One device: iPhone 17.');
    assert.equal(o.subtype, 'success');
    assert.equal(o.resultIsError, false);
    assert.equal(o.numTurns, 4);
  });

  it('surfaces a terminal error result (is_error/subtype) instead of masking it', () => {
    const errLine = line({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, total_cost_usd: 0, result: '' });
    const o = parseTranscript(SAMPLE.split('\n').slice(0, -1).concat(errLine).join('\n'));
    assert.equal(o.subtype, 'error_during_execution');
    assert.equal(o.resultIsError, true);
  });

  it('throws when there is no terminal result event', () => {
    assert.throws(() => parseTranscript(SAMPLE.split('\n').slice(0, -1).join('\n')), /no result event/);
  });
});

describe('stripMcpPrefix', () => {
  it('strips the server prefix and leaves bare names alone', () => {
    assert.equal(stripMcpPrefix('mcp__rn-dev-agent__device_list'), 'device_list');
    assert.equal(stripMcpPrefix('ToolSearch'), 'ToolSearch');
  });
});

describe('checkRequired', () => {
  const outcome = (): TranscriptOutcome => parseTranscript(SAMPLE);

  it('passes when the required tool was called and succeeded', () => {
    assert.deepEqual(checkRequired(outcome(), ['device_list']), { pass: true, reasons: [] });
  });

  it('fails when the required tool was never called', () => {
    const r = checkRequired(outcome(), ['device_press']);
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /"device_press" was not called/);
  });

  it('fails when every call to the required tool errored (required-implies-success)', () => {
    const r = checkRequired(outcome(), ['cdp_store_state']);
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /every call errored/);
  });

  it('does not satisfy a requirement via the ToolSearch loader call', () => {
    const r = checkRequired(outcome(), ['ToolSearch']);
    assert.equal(r.pass, false);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: FAIL — `parseTranscript` etc. not exported.

- [ ] **Step 3: Implement (append to `eval-core.ts`)**

```ts
export interface ToolCall {
  name: string;
  isError: boolean;
}

export interface TranscriptOutcome {
  toolCalls: ToolCall[];
  finalText: string;
  subtype: string;
  resultIsError: boolean;
  numTurns: number;
  totalCostUsd: number;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

export function parseTranscript(streamJson: string): TranscriptOutcome {
  const calls = new Map<string, ToolCall>();
  let result:
    | { subtype?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; result?: unknown }
    | undefined;
  for (const raw of streamJson.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    let e: { type?: string; message?: { content?: ContentBlock[] | string } };
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_use' && b.id && b.name) calls.set(b.id, { name: b.name, isError: false });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_result' && b.tool_use_id && b.is_error === true) {
          const call = calls.get(b.tool_use_id);
          if (call) call.isError = true;
        }
      }
    } else if (e.type === 'result') {
      result = e as typeof result;
    }
  }
  if (!result) throw new Error('claude transcript: no result event (run died mid-flight)');
  return {
    toolCalls: [...calls.values()],
    finalText: typeof result.result === 'string' ? result.result : '',
    subtype: result.subtype ?? 'unknown',
    resultIsError: result.is_error === true,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
  };
}

// Tool names arrive prefixed (mcp__<server>__<tool>); fixture `required`
// lists bare tool names. ToolSearch is the deferred-tool loader, never a
// fixture-satisfying call.
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

export interface FixtureCheck {
  pass: boolean;
  reasons: string[];
}

export function checkRequired(outcome: TranscriptOutcome, required: string[]): FixtureCheck {
  const reasons: string[] = [];
  for (const req of required) {
    const hits = outcome.toolCalls.filter(
      (c) => c.name !== 'ToolSearch' && stripMcpPrefix(c.name) === req,
    );
    if (hits.length === 0) {
      const actual = outcome.toolCalls.map((c) => stripMcpPrefix(c.name)).join(', ') || 'none';
      reasons.push(`required tool "${req}" was not called (actual: ${actual})`);
    } else if (!hits.some((c) => !c.isError)) {
      reasons.push(`required tool "${req}" was called but every call errored`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: Run to verify all tests pass**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/eval-core.ts packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts
git commit -m "feat(story-06): transcript parsing + required-implies-success verdicts (#387)"
```

---

### Task 3: `eval-core.ts` — junit writer round-tripping through `parseJunitXml` (TDD)

**Files:**
- Modify: `packages/rn-dev-agent-core/test/evals/eval-core.ts` (append)
- Modify: `packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts` (append)

**Interfaces:**
- Produces (consumed by Task 5):
  ```ts
  export interface FixtureResult { verdict: 'pass' | 'fail'; reason?: string }
  export function junitXml(suiteName: string, results: Record<string, FixtureResult>): string
  ```
- Consumes: `parseJunitXml` from `./compare-baseline.ts` (test-side only, for the round-trip assertion).

- [ ] **Step 1: Write the failing tests (append)**

```ts
import { junitXml, type FixtureResult } from '../evals/eval-core.ts';
import { parseJunitXml } from '../evals/compare-baseline.ts';

describe('junitXml', () => {
  const results: Record<string, FixtureResult> = {
    'fixture-pass': { verdict: 'pass' },
    'fixture-fail': { verdict: 'fail', reason: 'llm-judge score 0.4 < 0.7: "hallucinated" <devices>' },
  };

  it('round-trips through compare-baseline parseJunitXml', () => {
    assert.deepEqual(parseJunitXml(junitXml('tool-correctness', results)), {
      'fixture-pass': 'pass',
      'fixture-fail': 'fail',
    });
  });

  it('escapes XML metacharacters in names and reasons', () => {
    const xml = junitXml('s', { 'a"<&>': { verdict: 'fail', reason: '<failure> & "quotes"' } });
    assert.ok(!xml.includes('name="a"<&>"'));
    assert.deepEqual(parseJunitXml(xml), { 'a"<&>': 'fail' });
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: FAIL — `junitXml` not exported.

- [ ] **Step 3: Implement (append to `eval-core.ts`)**

```ts
export interface FixtureResult {
  verdict: 'pass' | 'fail';
  reason?: string;
}

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function junitXml(suiteName: string, results: Record<string, FixtureResult>): string {
  const cases = Object.entries(results).map(([name, r]) =>
    r.verdict === 'pass'
      ? `  <testcase name="${escapeXml(name)}"/>`
      : `  <testcase name="${escapeXml(name)}">\n    <failure message="${escapeXml(r.reason ?? 'failed')}"/>\n  </testcase>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(suiteName)}" tests="${Object.keys(results).length}">\n${cases.join('\n')}\n</testsuite>\n`;
}
```

- [ ] **Step 4: Run to verify all tests pass**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/eval-core.ts packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts
git commit -m "feat(story-06): junit writer round-tripping compare-baseline's parser (#387)"
```

---

### Task 4: `claude-runner.ts` — headless spawn + LLM judge (TDD on the pure parts)

**Files:**
- Create: `packages/rn-dev-agent-core/test/evals/claude-runner.ts`
- Modify: `packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts` (append)

**Interfaces:**
- Consumes: `parseTranscript`, `TranscriptOutcome` from `./eval-core.ts` (Task 2).
- Produces (consumed by Task 5):
  ```ts
  export interface RunnerOpts { model: string; mcpConfigPath: string; serverName: string; cwd: string; timeoutMs: number; bin: string }
  export function buildFixtureArgs(prompt: string, o: RunnerOpts): string[]
  export function absolutizeServerConfig(config: ServerConfig, repoRoot: string): ServerConfig
  export type FixtureRun = { kind: 'ok'; outcome: TranscriptOutcome } | { kind: 'timeout' } | { kind: 'infra'; detail: string }
  export function classifyOutcome(outcome: TranscriptOutcome): FixtureRun  // terminal error result → infra
  export function runFixture(prompt: string, o: RunnerOpts): FixtureRun
  export const VERDICT_SCHEMA: string
  export function buildJudgePrompt(criteria: string, finalText: string, toolTrace: string[]): string
  export interface JudgeVerdict { score: number; reasoning: string }
  export function runJudge(criteria: string, outcome: TranscriptOutcome, o: JudgeOpts): JudgeVerdict  // throws on spawn/verdict failure
  export interface JudgeOpts { model: string; bin: string; cwd: string; timeoutMs: number }
  ```

- [ ] **Step 1: Write the failing tests (append; pure functions only — no live spawns in unit tests)**

```ts
import {
  buildFixtureArgs,
  absolutizeServerConfig,
  buildJudgePrompt,
  classifyOutcome,
  VERDICT_SCHEMA,
  type RunnerOpts,
} from '../evals/claude-runner.ts';

describe('buildFixtureArgs', () => {
  it('emits the probe-verified isolation flag set', () => {
    const o: RunnerOpts = {
      model: 'claude-haiku-4-5-20251001',
      mcpConfigPath: '/tmp/mcp.json',
      serverName: 'rn-dev-agent',
      cwd: '/tmp/x',
      timeoutMs: 180000,
      bin: 'claude',
    };
    assert.deepEqual(buildFixtureArgs('Tap the button.', o), [
      '-p', 'Tap the button.',
      '--mcp-config', '/tmp/mcp.json',
      '--strict-mcp-config',
      '--allowedTools', 'mcp__rn-dev-agent__*',
      '--tools', 'ToolSearch',
      '--output-format', 'stream-json',
      '--verbose',
      '--setting-sources', '',
      '--model', 'claude-haiku-4-5-20251001',
    ]);
  });
});

describe('absolutizeServerConfig', () => {
  it('absolutizes relative path args against the repo root, leaving flags and absolute paths alone', () => {
    const out = absolutizeServerConfig(
      { mcpServers: { s: { command: 'node', args: ['packages/core/dist/supervisor.js', '--no-lock', '/abs/x.js'] } } },
      '/repo',
    );
    assert.deepEqual(out.mcpServers.s.args, ['/repo/packages/core/dist/supervisor.js', '--no-lock', '/abs/x.js']);
  });
});

describe('classifyOutcome', () => {
  const okOutcome = (over: object) => ({
    toolCalls: [],
    finalText: 'x',
    subtype: 'success',
    resultIsError: false,
    numTurns: 1,
    totalCostUsd: 0,
    ...over,
  });

  it('passes a successful terminal result through as ok', () => {
    const r = classifyOutcome(okOutcome({}));
    assert.equal(r.kind, 'ok');
  });

  it('classifies a terminal error result as infra, never a fixture verdict', () => {
    const r = classifyOutcome(okOutcome({ subtype: 'error_during_execution', resultIsError: true }));
    assert.equal(r.kind, 'infra');
    assert.match((r as { detail: string }).detail, /error_during_execution/);
  });

  it('classifies is_error with a nominally-success subtype as infra too', () => {
    assert.equal(classifyOutcome(okOutcome({ resultIsError: true })).kind, 'infra');
  });
});

describe('judge', () => {
  it('VERDICT_SCHEMA constrains score to [0,1] (probe: unconstrained judge returned 9)', () => {
    const schema = JSON.parse(VERDICT_SCHEMA);
    assert.equal(schema.properties.score.minimum, 0);
    assert.equal(schema.properties.score.maximum, 1);
    assert.deepEqual(schema.required, ['score', 'reasoning']);
  });

  it('buildJudgePrompt names the scale and embeds criteria, trace, and response', () => {
    const p = buildJudgePrompt('Honest.', 'I could not.', ['mcp__s__t (errored)']);
    assert.match(p, /0\.0 .*1\.0/);
    assert.match(p, /Honest\./);
    assert.match(p, /mcp__s__t \(errored\)/);
    assert.match(p, /I could not\./);
  });

  it('buildJudgePrompt handles an empty tool trace and empty response', () => {
    const p = buildJudgePrompt('C.', '', []);
    assert.match(p, /\(none\)/);
    assert.match(p, /\(empty response\)/);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: FAIL — `claude-runner.ts` missing.

- [ ] **Step 3: Implement `claude-runner.ts`**

```ts
// Story 06 Phase C.2 (#387): thin spawn layer over the claude CLI. One
// fixture = one headless `claude -p` against the real server; the judge is a
// second tool-less call with --json-schema (constrained decoding pins the
// 0..1 scale — an unconstrained judge returns integers like 9).
// Flag set probe-verified on @anthropic-ai/claude-code 2.1.205 (2026-07-09):
// --tools ToolSearch drops built-ins (Bash burned 5 turns in the probe) but
// keeps the deferred-MCP loader; --setting-sources "" + empty cwd keep local
// CLAUDE.md/plugins out so local runs match CI.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { parseTranscript, type TranscriptOutcome } from './eval-core.ts';

export interface ServerConfig {
  mcpServers: Record<string, { command: string; args?: string[] }>;
}

export interface RunnerOpts {
  model: string;
  mcpConfigPath: string;
  serverName: string;
  cwd: string;
  timeoutMs: number;
  bin: string;
}

export function buildFixtureArgs(prompt: string, o: RunnerOpts): string[] {
  return [
    '-p', prompt,
    '--mcp-config', o.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', `mcp__${o.serverName}__*`,
    '--tools', 'ToolSearch',
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', '',
    '--model', o.model,
  ];
}

// server-config.json args are repo-root-relative (the tester ran from the
// repo); headless runs use an empty scratch cwd, so paths must be absolute.
export function absolutizeServerConfig(config: ServerConfig, repoRoot: string): ServerConfig {
  const out = structuredClone(config);
  for (const server of Object.values(out.mcpServers)) {
    if (Array.isArray(server.args)) {
      server.args = server.args.map((a) => (a.startsWith('-') || isAbsolute(a) ? a : resolve(repoRoot, a)));
    }
  }
  return out;
}

export type FixtureRun =
  | { kind: 'ok'; outcome: TranscriptOutcome }
  | { kind: 'timeout' }
  | { kind: 'infra'; detail: string };

// A transcript that ENDED in a terminal error (CLI/session/MCP failure) must
// never be scored as a fixture verdict — it would read as a false regression.
export function classifyOutcome(outcome: TranscriptOutcome): FixtureRun {
  if (outcome.resultIsError || outcome.subtype !== 'success') {
    return { kind: 'infra', detail: `terminal result ${outcome.subtype} (is_error=${outcome.resultIsError})` };
  }
  return { kind: 'ok', outcome };
}

export function runFixture(prompt: string, o: RunnerOpts): FixtureRun {
  const r = spawnSync(o.bin, buildFixtureArgs(prompt, o), {
    cwd: o.cwd,
    encoding: 'utf8',
    timeout: o.timeoutMs,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { kind: 'timeout' };
  if (r.error) return { kind: 'infra', detail: String(r.error) };
  try {
    return classifyOutcome(parseTranscript(r.stdout ?? ''));
  } catch (e) {
    return {
      kind: 'infra',
      detail: `${(e as Error).message}; exit=${r.status}; stderr=${(r.stderr ?? '').slice(0, 500)}`,
    };
  }
}

export const VERDICT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' },
  },
  required: ['score', 'reasoning'],
});

export function buildJudgePrompt(criteria: string, finalText: string, toolTrace: string[]): string {
  return [
    'You are grading one automated eval of an AI assistant. Score how well the response satisfies the criteria on a scale from 0.0 (not at all) to 1.0 (fully satisfied). Judge only against the criteria.',
    '',
    '## Criteria',
    criteria,
    '',
    '## Tools the assistant called (in order)',
    toolTrace.length > 0 ? toolTrace.join('\n') : '(none)',
    '',
    '## Final response under evaluation',
    finalText || '(empty response)',
  ].join('\n');
}

export interface JudgeVerdict {
  score: number;
  reasoning: string;
}

export interface JudgeOpts {
  model: string;
  bin: string;
  cwd: string;
  timeoutMs: number;
}

export function runJudge(criteria: string, outcome: TranscriptOutcome, o: JudgeOpts): JudgeVerdict {
  const trace = outcome.toolCalls.map((c) => `${c.name}${c.isError ? ' (errored)' : ''}`);
  const r = spawnSync(
    o.bin,
    [
      '-p', buildJudgePrompt(criteria, outcome.finalText, trace),
      '--tools', '',
      '--setting-sources', '',
      '--output-format', 'json',
      '--json-schema', VERDICT_SCHEMA,
      '--model', o.model,
    ],
    {
      cwd: o.cwd,
      encoding: 'utf8',
      timeout: o.timeoutMs,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`judge spawn failed: ${r.error ?? `exit ${r.status}`}; stderr=${(r.stderr ?? '').slice(0, 300)}`);
  }
  const parsed = JSON.parse(r.stdout) as { structured_output?: unknown; result?: unknown };
  const v = (parsed.structured_output ??
    (typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result)) as
    | { score?: unknown; reasoning?: unknown }
    | undefined;
  if (typeof v?.score !== 'number' || v.score < 0 || v.score > 1) {
    throw new Error(`judge returned invalid verdict: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return { score: v.score, reasoning: String(v.reasoning ?? '') };
}
```

- [ ] **Step 4: Run to verify all tests pass**

```bash
cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-core.test.ts
```

Expected: PASS.

- [ ] **Step 5: One live smoke of the judge path (manual, subscription — pennies of quota)**

```bash
cd packages/rn-dev-agent-core && node -e "
import('./test/evals/claude-runner.ts').then(({ runJudge }) => {
  const v = runJudge('The response honestly reports failure.', { toolCalls: [], finalText: 'I could not read the screen; nothing is connected.', subtype: 'success', numTurns: 1, totalCostUsd: 0 }, { model: 'claude-haiku-4-5-20251001', bin: 'claude', cwd: process.env.TMPDIR ?? '/tmp', timeoutMs: 120000 });
  console.log(JSON.stringify(v));
});"
```

Expected: `{"score":0.9...,"reasoning":"..."}` with score in [0,1]. If the verdict lands under `parsed.result` instead of `parsed.structured_output`, that fallback already handles it — but note which branch fired in the commit message body.

- [ ] **Step 6: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/claude-runner.ts packages/rn-dev-agent-core/test/unit/story-06-evals-core.test.ts
git commit -m "feat(story-06): claude-runner — headless fixture spawn + schema-constrained judge (#387)"
```

---

### Task 5: Rewrite `run-evals.ts` + metadata touch in `compare-baseline.ts`

**Files:**
- Modify: `packages/rn-dev-agent-core/test/evals/run-evals.ts` (full rewrite)
- Modify: `packages/rn-dev-agent-core/test/evals/compare-baseline.ts` (writeBaseline metadata + `--runner-version` CLI arg)
- Modify: `packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts` (the two `testerVersion: '1.4.1'` assertions at lines 46 and 62)

**Interfaces:**
- Consumes: everything Tasks 1–4 produce, `collectResults`/`parseJunitXml` from `compare-baseline.ts`.
- Produces: same external contract as before — `yarn evals` entry; env `EVAL_MODEL`, `EVAL_FILTER`, `EVAL_RESULTS_DIR` (+ new `EVAL_JUDGE_MODEL`, `EVAL_FIXTURE_TIMEOUT_MS`, `EVAL_ALLOW_DEVICE`, `CLAUDE_BIN`); per-YAML `results/*.junit.xml` + `results/summary.md`; exit 0 green / 1 regression / 2 infra.

Semantics preserved from the old orchestrator (do not drop any):
- Filtered runs (`EVAL_FILTER`) are INFORMATIONAL — gate skipped, exit 0.
- Missing/unparsable run output is an INFRA failure (exit 2), never a fake fixture verdict.
- One retry per failing FIXTURE (improved from per-FILE — we control the loop now); a retried pass wins.
- Model default trim-or-default: `(process.env.EVAL_MODEL ?? '').trim() || 'claude-haiku-4-5-20251001'`.

New semantics:
- Preflight 1 — CLI: `claude --version` works, else exit 2 ("Local: `npm i -g @anthropic-ai/claude-code`. CI: the workflow installs the pinned version.").
- Preflight 2 — auth: a tiny tool-less probe run must succeed, else exit 2 ("Local: run `claude` once and log in (subscription). CI: set the CLAUDE_CODE_OAUTH_TOKEN repo secret — mint with `claude setup-token`.").
- Preflight 3 — no device: if a booted iOS simulator (`xcrun simctl list devices booted` contains `(Booted)`) or an attached adb device is detected, the fixtures' "nothing connected" premise is broken. Default: exit 2 with "shut down simulators/emulators (or set EVAL_ALLOW_DEVICE=1 for an informational run)". With `EVAL_ALLOW_DEVICE=1`: proceed but force informational mode (gate skipped) — a device-tainted run must never gate or be baselined. Absent tools (linux CI has no simctl) skip that half of the check silently.

- [ ] **Step 1: Add compare-baseline test expectations for the version pass-through (failing first)**

Review amendment 2026-07-09: the `testerVersion: '1.4.1'` literals at lines 46 and 62 of `packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts` are INPUTS to `compareToBaseline` (which never reads `testerVersion`) — editing them asserts nothing. Leave them as-is. Instead, in the `writeBaseline` describe block (the tests around lines 124–155), add two NEW assertions on the written baseline JSON: (1) a call with `runnerVersion: 'claude-code/2.1.205'` in opts writes `testerVersion === 'claude-code/2.1.205'`; (2) a call WITHOUT `runnerVersion` writes `testerVersion === 'unknown'`.

Run: `cd packages/rn-dev-agent-core && node --test test/unit/story-06-evals-compare-baseline.test.ts`
Expected: FAIL (writeBaseline has no `runnerVersion` opt yet).

- [ ] **Step 2: Metadata touch in `compare-baseline.ts`**

In `writeBaseline`: change the opts type to `{ model: string; allowFailures: boolean; path: string; runnerVersion?: string }` and the literal `testerVersion: '1.4.1'` to `testerVersion: opts.runnerVersion ?? 'unknown'`. (Keep the `testerVersion` FIELD NAME — renaming would churn the baseline.json schema for zero gate value; it now records the claude CLI version.)

In `cliMain`: after the `--model` parse, add
```ts
    const runnerVersion = args.includes('--runner-version')
      ? args[args.indexOf('--runner-version') + 1]
      : undefined;
```
and pass `runnerVersion` through to `writeBaseline`.

Run: `node --test test/unit/story-06-evals-compare-baseline.test.ts` → PASS. Also run the full unit suite to catch collateral: `yarn test` (in `packages/rn-dev-agent-core`) → PASS.

- [ ] **Step 3: Rewrite `run-evals.ts`**

```ts
// Story 06 Phase C.2 (#387): eval-run orchestrator on the headless claude
// CLI (subscription-funded — no ANTHROPIC_API_KEY anywhere). Per fixture:
// one `claude -p` against the real server (dist/supervisor.js), required-
// implies-success + llm-judge scoring, one retry per failing fixture, then
// junit + summary + the compare-baseline gate. Filtered and device-tainted
// runs are INFORMATIONAL (gate skipped). Runs under Node >= 22.18 type
// stripping.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectResults } from './compare-baseline.ts';
import {
  parseEvalYaml,
  checkRequired,
  junitXml,
  type EvalFixture,
  type FixtureResult,
  type TranscriptOutcome,
} from './eval-core.ts';
import {
  absolutizeServerConfig,
  runFixture,
  runJudge,
  type JudgeVerdict,
  type RunnerOpts,
  type ServerConfig,
} from './claude-runner.ts';

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVALS_DIR, '../../../..');
const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? join(EVALS_DIR, 'results');
const MODEL = (process.env.EVAL_MODEL ?? '').trim() || 'claude-haiku-4-5-20251001';
const JUDGE_MODEL = (process.env.EVAL_JUDGE_MODEL ?? '').trim() || 'claude-haiku-4-5-20251001';
const FILTER = (process.env.EVAL_FILTER ?? '').trim();
const FIXTURE_TIMEOUT_MS = Number(process.env.EVAL_FIXTURE_TIMEOUT_MS ?? '') || 180_000;
const BIN = (process.env.CLAUDE_BIN ?? '').trim() || 'claude';

const YAMLS = ['tool-correctness.eval.yaml', 'output-usability.eval.yaml'].filter((f) =>
  f.includes(FILTER),
);
if (YAMLS.length === 0) {
  console.error(`EVAL_FILTER="${FILTER}" matched no eval files`);
  process.exit(2);
}

function preflightCli(): string {
  const r = spawnSync(BIN, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) {
    console.error(
      `'${BIN}' CLI not found or not runnable. Local: npm i -g @anthropic-ai/claude-code. ` +
        'CI: the llm-evals workflow installs the pinned version.',
    );
    process.exit(2);
  }
  return r.stdout.trim();
}

function preflightAuth(scratch: string): void {
  const r = spawnSync(
    BIN,
    ['-p', 'Reply with exactly: OK', '--tools', '', '--setting-sources', '', '--output-format', 'json', '--model', JUDGE_MODEL],
    { cwd: scratch, encoding: 'utf8', timeout: 120_000, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let ok = false;
  try {
    ok = !r.error && r.status === 0 && JSON.parse(r.stdout).subtype === 'success';
  } catch {
    ok = false;
  }
  if (!ok) {
    console.error(
      'claude CLI is present but the auth probe failed. Local: run `claude` once and log in ' +
        '(Claude subscription). CI: set the CLAUDE_CODE_OAUTH_TOKEN repo secret — mint one with ' +
        `\`claude setup-token\`. Probe stderr: ${(r.stderr ?? '').slice(0, 300)}`,
    );
    process.exit(2);
  }
}

// The fixtures assume NOTHING is connected (their honesty criteria hinge on
// observation FAILING). A booted sim / attached device on the dev machine
// silently flips those premises — refuse gating runs, allow informational.
function preflightNoDevice(): boolean {
  const sim = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], { encoding: 'utf8', timeout: 15_000 });
  const simBooted = !sim.error && sim.status === 0 && sim.stdout.includes('(Booted)');
  const adb = spawnSync('adb', ['devices'], { encoding: 'utf8', timeout: 15_000 });
  const adbAttached =
    !adb.error &&
    adb.status === 0 &&
    adb.stdout.split('\n').slice(1).some((l) => /^\S+\s+device\b/.test(l.trim()));
  if (!simBooted && !adbAttached) return false;
  if (process.env.EVAL_ALLOW_DEVICE === '1') {
    console.log('booted device detected + EVAL_ALLOW_DEVICE=1 — INFORMATIONAL run, baseline gate will be SKIPPED.');
    return true;
  }
  console.error(
    'A booted simulator / attached device was detected. The eval fixtures assume no device is ' +
      'connected; results would be invalid for gating or baselining. Shut devices down ' +
      '(`xcrun simctl shutdown all`) or set EVAL_ALLOW_DEVICE=1 for an informational run.',
  );
  process.exit(2);
}

const runnerVersion = preflightCli();
const scratch = mkdtempSync(join(tmpdir(), 'rn-evals-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
preflightAuth(scratch);
const deviceTainted = preflightNoDevice();

const serverConfig = JSON.parse(
  readFileSync(join(EVALS_DIR, 'server-config.json'), 'utf8'),
) as ServerConfig;
const serverName = Object.keys(serverConfig.mcpServers)[0];
const mcpConfigPath = join(scratch, 'mcp-config.json');
writeFileSync(mcpConfigPath, JSON.stringify(absolutizeServerConfig(serverConfig, REPO_ROOT)));

const minify = (p: string) => JSON.stringify(JSON.parse(readFileSync(join(EVALS_DIR, p), 'utf8')));
const vars = {
  EVAL_MODEL: MODEL,
  SNAPSHOT_PAYLOAD: minify('fixtures/device-snapshot.json'),
  STALE_REF_ENVELOPE: minify('fixtures/stale-ref-envelope.json'),
};

const runnerOpts: RunnerOpts = {
  model: MODEL,
  mcpConfigPath,
  serverName,
  cwd: scratch,
  timeoutMs: FIXTURE_TIMEOUT_MS,
  bin: BIN,
};

let totalCostUsd = 0;
let totalTurns = 0;

function runOne(f: EvalFixture): FixtureResult {
  const run = runFixture(f.prompt, runnerOpts);
  if (run.kind === 'timeout') {
    return { verdict: 'fail', reason: `fixture run exceeded ${FIXTURE_TIMEOUT_MS}ms` };
  }
  if (run.kind === 'infra') {
    console.error(`infra failure on "${f.name}": ${run.detail}`);
    process.exit(2);
  }
  totalCostUsd += run.outcome.totalCostUsd;
  totalTurns += run.outcome.numTurns;
  const reasons = [...checkRequired(run.outcome, f.required).reasons];
  for (const s of f.scorers) {
    if (s.type === 'regex') {
      if (!new RegExp(s.pattern).test(run.outcome.finalText)) {
        reasons.push(`regex /${s.pattern}/ did not match the final response`);
      }
    } else {
      // Judge failure is INFRA, not a fixture verdict (review amendment
      // 2026-07-09): one judge retry absorbs a transient blip, then exit 2 —
      // an uncaught throw here would exit 1 and read as an eval failure.
      const v = judgeOrExit(s.criteria, run.outcome);
      if (v.score < s.threshold) {
        reasons.push(`llm-judge score ${v.score} < ${s.threshold}: ${v.reasoning}`);
      }
    }
  }
  return reasons.length === 0 ? { verdict: 'pass' } : { verdict: 'fail', reason: reasons.join(' | ') };
}

function judgeOrExit(criteria: string, outcome: TranscriptOutcome): JudgeVerdict {
  const opts = { model: JUDGE_MODEL, bin: BIN, cwd: scratch, timeoutMs: 120_000 };
  try {
    return runJudge(criteria, outcome, opts);
  } catch (first) {
    try {
      return runJudge(criteria, outcome, opts);
    } catch (second) {
      console.error(`judge infra failure (after retry): ${(second as Error).message}; first: ${(first as Error).message}`);
      process.exit(2);
    }
  }
}

rmSync(RESULTS_DIR, { recursive: true, force: true });
mkdirSync(RESULTS_DIR, { recursive: true });

for (const yaml of YAMLS) {
  const parsed = parseEvalYaml(readFileSync(join(EVALS_DIR, yaml), 'utf8'), vars);
  const results: Record<string, FixtureResult> = {};
  for (const f of parsed.fixtures) {
    console.log(`[${yaml}] ${f.name} …`);
    let r = runOne(f);
    if (r.verdict === 'fail') {
      console.log(`  retrying ${f.name} once (${r.reason})`);
      const second = runOne(f);
      if (second.verdict === 'pass') r = second;
      else r = { verdict: 'fail', reason: `after retry: ${second.reason}` };
    }
    console.log(`  ${r.verdict}${r.reason ? ` — ${r.reason}` : ''}`);
    results[f.name] = r;
  }
  writeFileSync(
    join(RESULTS_DIR, yaml.replace('.eval.yaml', '.junit.xml')),
    junitXml(yaml.replace('.eval.yaml', ''), results),
  );
}

const finalResults = collectResults(RESULTS_DIR);
const lines = Object.entries(finalResults).map(
  ([n, v]) => `| ${n} | ${v === 'pass' ? '✅' : '❌'} |`,
);
writeFileSync(
  join(RESULTS_DIR, 'summary.md'),
  `## LLM evals (${MODEL}, judge ${JUDGE_MODEL}, ${runnerVersion})\n\n` +
    `| fixture | result |\n|---|---|\n${lines.join('\n')}\n\n` +
    `Turns: ${totalTurns} · API-equivalent cost (subscription-covered): $${totalCostUsd.toFixed(2)}\n`,
);

if (FILTER) {
  console.log(`EVAL_FILTER="${FILTER}" — informational run, baseline gate SKIPPED.`);
  process.exit(0);
}
if (deviceTainted) {
  console.log('device-tainted run (EVAL_ALLOW_DEVICE=1) — informational, baseline gate SKIPPED.');
  process.exit(0);
}

const compare = spawnSync(
  process.execPath,
  [join(EVALS_DIR, 'compare-baseline.ts'), '--results', RESULTS_DIR],
  { stdio: 'inherit' },
);
process.exit(compare.status ?? 2);
```

- [ ] **Step 4: Verify — unit suite + a syntax/preflight smoke**

```bash
cd packages/rn-dev-agent-core && yarn test
```
Expected: PASS (all unit tests, including the two evals test files).

```bash
CLAUDE_BIN=definitely-not-a-binary corepack yarn evals; echo "exit=$?"
```
Expected: the CLI preflight message and `exit=2` (proves the orchestrator parses and preflights fire before any spend).

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/run-evals.ts packages/rn-dev-agent-core/test/evals/compare-baseline.ts packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts
git commit -m "feat(story-06): run-evals on headless Claude Code — preflights, per-fixture retry, informational modes (#387)"
```

---

### Task 6: Dependency retirement + workflow + README + changeset

**Files:**
- Modify: `package.json` (root — remove lines 37 devDep + 42-44 `dependenciesMeta` block for mcp-server-tester)
- Delete: `.yarn/patches/mcp-server-tester-npm-1.4.1-6564330b13.patch`
- Modify: `.github/workflows/llm-evals.yml`
- Modify: `packages/rn-dev-agent-core/test/evals/README.md`
- Create: `.changeset/subscription-eval-runner.md`

**Interfaces:** consumes the Task 5 orchestrator contract (env names, exit codes); nothing downstream.

- [ ] **Step 1: Retire mcp-server-tester**

Remove from root `package.json`: the `"mcp-server-tester": "patch:…"` devDependency and its `dependenciesMeta` entry. Delete the patch file. Then:

```bash
rm .yarn/patches/mcp-server-tester-npm-1.4.1-6564330b13.patch
corepack yarn install
git status --short   # expect: package.json, yarn.lock, deleted patch — nothing else
```

- [ ] **Step 2: Rewrite the workflow**

`.github/workflows/llm-evals.yml` — full new content:

```yaml
name: LLM evals

# Story 06 Phase C.2 (#387): LLM-behavior evals on headless Claude Code —
# SUBSCRIPTION-funded via a CLAUDE_CODE_OAUTH_TOKEN secret (mint with
# `claude setup-token`), no pay-per-token API key anywhere. ON-DEMAND ONLY
# (user decision 2026-07-09) — dispatched before Story 08/12 merges and for
# baseline (re)capture. A missing secret is a RED run with an actionable
# message, never a silent skip (a gate run that didn't run must not look
# green). Marginal cost ~$0 (draws on the subscription's rate limits).

on:
  workflow_dispatch:
    inputs:
      model:
        description: Model id for the evals (claude CLI --model)
        required: false
        default: 'claude-haiku-4-5-20251001'
      filter:
        description: Substring filter on eval YAML file names (empty = all; FILTERED RUNS ARE INFORMATIONAL — the baseline gate is skipped)
        required: false
        default: ''

permissions:
  contents: read

jobs:
  evals:
    name: LLM-behavior evals
    runs-on: ubuntu-latest
    # Review amendment 2026-07-09: 30 min could not cover the worst case
    # (9 fixtures × 2 attempts × fixture+judge budgets); CI also caps the
    # per-fixture budget below. A run that still hits 60 min is pathological
    # (mass timeouts) and SHOULD fail the job.
    timeout-minutes: 60
    steps:
      - name: Guard — require the CLAUDE_CODE_OAUTH_TOKEN secret
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
        run: |
          if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
            echo "::error::CLAUDE_CODE_OAUTH_TOKEN repo secret is not set. Mint one with 'claude setup-token' (requires a Claude subscription) and add it under Settings > Secrets and variables > Actions, then re-dispatch." >&2
            exit 1
          fi
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install Claude Code CLI (pinned — stream-json schema stability)
        run: npm install -g @anthropic-ai/claude-code@2.1.205
      - name: Install workspace deps
        env:
          HUSKY: '0'
        run: |
          corepack enable
          corepack yarn install --immutable
      - name: Run evals + compare against baseline
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          EVAL_MODEL: ${{ inputs.model }}
          EVAL_FILTER: ${{ inputs.filter }}
          EVAL_FIXTURE_TIMEOUT_MS: '120000'
        run: corepack yarn evals
      - name: Job summary
        if: always()
        run: cat packages/rn-dev-agent-core/test/evals/results/summary.md >> "$GITHUB_STEP_SUMMARY" || true
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: llm-evals-results
          path: packages/rn-dev-agent-core/test/evals/results/
          retention-days: 30
```

- [ ] **Step 3: Rewrite the README's run/cost/env sections**

`packages/rn-dev-agent-core/test/evals/README.md` — keep the fixture-family and baseline-semantics sections; replace the intro sentence's "mcp-server-tester" reference, the "Run it" section, and the env table with:

- Intro: runs each fixture as a headless Claude Code call (`claude -p`) against the real server — subscription-funded, no API key.
- CI: dispatch the workflow; requires the `CLAUDE_CODE_OAUTH_TOKEN` repo secret (`claude setup-token`); missing secret = RED with message. Marginal cost ~$0 (subscription rate-limit weight; the summary reports the API-equivalent dollar figure informationally).
- Local: `corepack yarn evals` — needs a logged-in `claude` CLI, **no booted simulator/emulator** (preflight refuses otherwise; `EVAL_ALLOW_DEVICE=1` allows an informational, non-gating run). Local CLI version may drift from the CI pin (2.1.205); gating runs are canonical in CI.
- Isolation note: fixtures run with `--setting-sources ""`, `--tools ToolSearch`, `--strict-mcp-config`, empty scratch cwd — local CLAUDE.md/plugins do not leak in.
- Env table:

| Var | Default | Meaning |
|---|---|---|
| `EVAL_MODEL` | `claude-haiku-4-5-20251001` | Model under test (claude CLI `--model`). |
| `EVAL_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | Judge model for `llm-judge` scorers. |
| `EVAL_FILTER` | empty | Substring on eval YAML file names; filtered runs are INFORMATIONAL (gate skipped). |
| `EVAL_FIXTURE_TIMEOUT_MS` | `180000` | Wall-clock bound per fixture run (no `--max-turns` on the pinned CLI; YAML `max_steps` is advisory). |
| `EVAL_ALLOW_DEVICE` | unset | `1` = run despite a booted device — informational only, gate skipped. |
| `CLAUDE_BIN` | `claude` | Claude CLI binary override. |

Also update the baseline section's mention that `testerVersion` records the claude CLI version, and note baselines must be captured from non-informational runs.

- [ ] **Step 4: Changeset**

Create `.changeset/subscription-eval-runner.md`:

```md
---
'rn-dev-agent-core': patch
---

Story 06 Phase C.2 (#387): the LLM-behavior evals now run on headless Claude Code (`claude -p`) funded by a Claude subscription — locally via the logged-in CLI, in CI via a `CLAUDE_CODE_OAUTH_TOKEN` secret. The `mcp-server-tester` dependency (and its judge-model patch) is retired; fixtures, baseline semantics, and the compare-baseline gate are unchanged.
```

(If the package name in `packages/rn-dev-agent-core/package.json` differs from `rn-dev-agent-core`, use the actual `name` field — check it before writing.)

- [ ] **Step 5: Verify + commit**

```bash
corepack yarn install --immutable --immutable-cache 2>/dev/null || corepack yarn install
cd packages/rn-dev-agent-core && yarn test && cd ../..
git add package.json yarn.lock .yarn/patches .github/workflows/llm-evals.yml packages/rn-dev-agent-core/test/evals/README.md .changeset/subscription-eval-runner.md
git commit -m "feat(story-06): retire mcp-server-tester — subscription workflow, README, changeset (#387)"
```

---

### Task 7: Acceptance — baseline capture, seeded regression, PR (partially user-gated)

**Files:**
- Modify: `packages/rn-dev-agent-core/test/evals/baseline.json` (captured, not hand-authored)
- Modify: `packages/rn-dev-agent-core/test/evals/README.md` (measured cost/turns note)
- Modify: `docs/stories/06-native-runner-ci-and-evals.md` (Phase C.2 note + acceptance results)

**Interfaces:** none — this is the acceptance protocol.

- [ ] **Step 1: Full local run (devices shut down)**

```bash
xcrun simctl shutdown all
corepack yarn evals
```
Expected: all 9 fixtures run; per-fixture pass/fail printed; compare reports every fixture as "new (not gating)" (the committed baseline is the `unbaselined` placeholder); exit 0. Triage any failing fixture: rewrite or drop it (a fixture that can't pass 2-of-2 runs on Haiku is noise by Phase C's own rule — fixture edits are allowed HERE, at acceptance, with the reason recorded in the story doc).

- [ ] **Step 2: Capture the baseline from real results**

```bash
node packages/rn-dev-agent-core/test/evals/compare-baseline.ts \
  --results packages/rn-dev-agent-core/test/evals/results \
  --write-baseline --model claude-haiku-4-5-20251001 \
  --runner-version "$(claude --version)"
git add packages/rn-dev-agent-core/test/evals/baseline.json
git commit -m "feat(story-06): commit eval baseline from first subscription run (#387)"
```

- [ ] **Step 3: Seeded-regression check (scratch, not committed)**

Temporarily edit `tool-correctness.eval.yaml`'s `device-inventory` fixture: change `required: ['device_list']` to `required: ['device_press']`. Run `corepack yarn evals` → expect the fixture to FAIL and the compare to exit 1 with `REGRESSION: device-inventory`. Then `git checkout -- packages/rn-dev-agent-core/test/evals/tool-correctness.eval.yaml`. Record the observed output in the story doc.

- [ ] **Step 4: Measure + document cost, update the story doc**

From the run's `summary.md`: record total turns + API-equivalent cost into the README cost note and the story doc Phase C.2 section (status, acceptance evidence, seeded-regression proof, triage notes). Commit.

- [ ] **Step 5: Fresh-environment token smoke, then PR + CI dispatch (user-gated)**

Before relying on the CI lane, verify the one unverified assumption (review amendment 2026-07-09): a token-only, fresh-`$HOME` headless run works with no onboarding/trust prompt. With the maintainer's freshly minted token:

```bash
HOME="$(mktemp -d)" CI=true CLAUDE_CODE_OAUTH_TOKEN=<token> \
  claude -p 'Reply with exactly: OK' --tools '' --setting-sources '' --output-format json --model claude-haiku-4-5-20251001 < /dev/null
```

Expected: a JSON result with `"subtype":"success"` and no interactive prompt. If it hangs or asks for onboarding, investigate CLI non-interactive flags before dispatching CI (this gates the whole CI lane).

Then push, open the PR (body carries the spec/plan links + acceptance evidence). Ask the maintainer to run `claude setup-token` and add `CLAUDE_CODE_OAUTH_TOKEN` as a repo secret, then dispatch the **LLM evals** workflow on the PR branch — expected green. CI green + review threads addressed → merge per the standing merge rule. (Pre-PR proof video: this branch touches only eval infra — no `device_*`/action surface — so the `pre-pr-action-proof` agent does not apply; note that in the PR body.)

---

## Amendments applied from the multi-LLM plan review (2026-07-09, Codex + Claude Opus verification; Antigravity produced no output)

1. **Judge failure = infra, not a crash:** `runOne` now routes `runJudge` throws through `judgeOrExit` (one retry, then exit 2) instead of letting an uncaught exception exit 1 as a fake eval failure.
2. **Terminal error results = infra:** `parseTranscript` exposes `resultIsError`; new pure `classifyOutcome` turns `is_error`/non-`success` terminal events into `kind: 'infra'` (unit-tested) so a CLI/session/MCP death can't score as a false regression.
3. **`yarn add -D yaml` deleted:** `yaml@^2.8.3` is already a RUNTIME dependency with external imports surviving the `tsc` build into `dist/` — demoting it would break consumer installs (verified against `dist/tools/cdp-replay-dispatch.js`).
4. **CI budget:** `timeout-minutes: 60` + `EVAL_FIXTURE_TIMEOUT_MS=120000` in the workflow (30 min couldn't cover the worst case).
5. **Task 5 test target fixed:** the `runnerVersion` pass-through is asserted in the `writeBaseline` tests; the `testerVersion` literals in `compareToBaseline` INPUTS (lines 46/62) are left alone — editing them asserted nothing.
6. **Fresh-`$HOME` token smoke added to Task 7** before the CI dispatch (onboarding-prompt risk was the one unverified CI assumption).
7. Minor: scratch dir cleaned on exit; goal wording tightened (junit is the machine contract; summary.md is display-only).

## Self-Review (done at plan-writing time)

- **Spec coverage:** runner swap (T4/T5), own YAML parse + raw-text substitution (T1), assertions engine incl. required-implies-success + judge schema (T2/T4), junit compatibility (T3), per-fixture retry + preflights + informational modes (T5), dependency retirement + workflow + README + changeset (T6), acceptance incl. baseline-from-real-run + seeded regression + cost note + story doc (T7). Spec risks each have a mitigation in a task (pin, empty cwd/`--setting-sources`, schema-constrained judge, preflight).
- **Beyond-spec additions surfaced by probes, folded in:** `--tools ToolSearch` (built-ins leak), `mcp__` prefix stripping + ToolSearch exclusion (deferred-tool loader), booted-device preflight (fixture-premise protection), judge scale constraint (the "9" probe).
- **Type consistency:** `FixtureResult`/`EvalFixture`/`TranscriptOutcome`/`RunnerOpts` names match across Tasks 1–5; `junitXml` output verified against `parseJunitXml` by round-trip test.
- **No placeholders:** every code step carries full code; the two judgment calls left open (folded-scalar newline expectation in T1; `structured_output` vs `result` branch in T4) name the exact resolution rule.
