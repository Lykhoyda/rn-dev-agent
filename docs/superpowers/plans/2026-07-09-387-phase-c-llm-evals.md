# Story 06 Phase C — LLM-behavior evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On-demand LLM-behavior evals for the rn-dev-agent MCP tool surface via `mcp-server-tester`, with a committed per-model baseline whose compare script is the Story 08/12 regression gate.

**Architecture:** Single PR. A pinned `mcp-server-tester` drives the real server (`packages/rn-dev-agent-core/dist/supervisor.js` over stdio) through two YAML fixture families — live no-device tool-correctness evals and prompt-embedded recorded-payload output-usability evals. A JUnit-XML → baseline compare script (unit-tested, TDD) decides pass/fail; `.github/workflows/llm-evals.yml` is `workflow_dispatch`-only with an `ANTHROPIC_API_KEY` fail-fast guard.

**Tech Stack:** mcp-server-tester 1.4.1 (Anthropic evals, `--junit-xml`), Node 22 type-stripped TypeScript scripts (no new `.mjs` — the `check-typescript-only` gate), Yarn 4 workspaces, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-09-387-phase-c-llm-evals-design.md` (approved 2026-07-09).

## Global Constraints

- Signed commits: `git commit -S`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Yarn 4 via corepack (`corepack yarn …`); install from repo root; `HUSKY=0` in CI.
- All new scripts are TypeScript run via Node type stripping (a new `.mjs`/`.js` fails ci.yml's `check-typescript-only.sh`).
- Default eval model (exact string, used in three places — run script default, workflow input default, baseline provenance): `claude-haiku-4-5-20251001`.
- mcp-server-tester pinned EXACTLY `1.4.1` (no `^`) — baseline validity is per tester version.
- The workflow NEVER silently skips on a missing secret: absent `ANTHROPIC_API_KEY` = red with an actionable message (spec: a gate run that didn't run must not look green).
- Compare semantics (spec): regression = fixture recorded `"pass"` in `baseline.json` that fails (or is missing) in current results; non-baselined fixtures never gate. Retry granularity is per-YAML-file (the CLI has no per-test filter) — a deliberate, documented adaptation of the spec's "one retry per failing fixture".
- Eval fixture-authoring rules (enforced in review): one behavior per fixture; prompts must NOT name the expected tool; `expected_tool_calls.required` is a SET (no ordering); avoid `allowed` (closed whitelist — brittle on a ~79-tool surface) unless the fixture is specifically about tool restraint.
- Changeset: `'rn-dev-agent-plugin': patch`.
- Branch: `feat/387-phase-c-llm-evals` (spec already committed on it).

---

## Verified interfaces (from source — do not re-derive; corrected by the multi-LLM plan review)

- Eval YAML: `evals: { models: ['…'], max_steps: N, tests: [{ name, prompt, expected_tool_calls: { required: […], allowed: […] }, response_scorers: [{type: 'regex', pattern} | {type: 'llm-judge', criteria, threshold} | {type: 'contains', text}] }] }`.
- **`required` implies SUCCESS, not just "was called"** (tester `runner.js:104-107, 183-213`: `validateToolCallSuccess` fails the fixture when a required tool's result has `isError: true` — and rn-dev-agent's `failResult` sets `isError: true`, `utils.ts:82`). Therefore `required` may ONLY name tools that SUCCEED with no device/CDP connected: `cdp_status`, `device_list`. Behavior about failing tools is asserted via judge criteria only.
- **`${VAR}` substitution happens on RAW FILE TEXT BEFORE `YAML.parse`** (`loader.js:18-22`). A multi-line value corrupts the YAML. All injected payloads MUST be minified to a single line (`JSON.stringify(parsed)`) at injection time; committed fixture files stay pretty-printed for review.
- **The llm-judge model is HARDCODED to `claude-3-haiku-20240307`** (`anthropic-provider.js`), which was RETIRED 2026-04-20 — every judge call errors on 1.4.1 as published, and 1.4.1 is the latest release. Fix shipped in Task 3: a committed Yarn `patch:` swapping the judge model to `claude-haiku-4-5-20251001`. The judge model is recorded in `baseline.json` provenance.
- The provider IGNORES the derived `allowedTools` — the model always sees the full ~79-tool surface (semantics note: `required` proves inclusion, not restraint; also the per-request context cost Story 12 cares about is always paid).
- CLI: `mcp-server-tester evals <file> --server-config <json> [--server-name <n>] [--timeout <ms>] [--debug] [--junit-xml [filename]]`. Default `--timeout` is 10000 ms — too low for multi-turn LLM evals; use 120000.
- Server config: `{ "mcpServers": { "<name>": { "command": "node", "args": […] } } }`. `dist/supervisor.js` honors `--no-lock`; the tester lists tools locally before any API call.
- Exit code: non-zero when any eval fails — the run script must IGNORE it and let compare decide (non-baselined fixtures must not gate), but must HARD-FAIL if the expected junit file was not produced (infra failure).
- Install landmine: `mcp-server-tester`'s postinstall invokes `patch-package` (probe-verified). Under Yarn 4 (`nodeLinker: node-modules` — NOT PnP, `.yarnrc.yml`-verified), disable its build script via `dependenciesMeta` (Task 3).
- JUnit output (`JunitXmlFormatter`, fast-xml-parser with `suppressEmptyNode`): passing testcases are self-closing, failing ones carry a `<failure>`/`<error>` child — the Task 1 regex parser handles both.
- STALE_REF enriched envelope (source: `rn-fast-runner-client.ts:1103-1113`, shape asserted in `test/unit/story-05-heal-stale-ref.test.ts:74-84`): `{ ok:false, error, code:'STALE_REF', meta:{ reResolution:'ambiguous', candidates:[{ref,type,label,identifier,rect}, …≤5], cachedMetadata:{type,label,identifier}, hint } }`.
- Recorded snapshot payload: `/tmp/adbg3/smoke-android-steps.json` is COMPLETE (351KB, has `snapshot-3`); `/tmp/iosdbg3/…` is the seeded-run stub (221 bytes, open-error only — UNUSABLE). Task 2 extracts from the Android artifact; regeneration fallback: `corepack yarn smoke:ios` against a booted sim writes `$TMPDIR/rn-agent-smoke-debug/smoke-ios-steps.json`.

## File structure

```
packages/rn-dev-agent-core/test/evals/
  server-config.json            # spawns dist/supervisor.js over stdio
  tool-correctness.eval.yaml    # live server, no device — tool-selection behavior
  output-usability.eval.yaml    # recorded payloads embedded in prompts
  fixtures/device-snapshot.json # real device_snapshot envelope (from Phase B smoke)
  fixtures/stale-ref-envelope.json  # contract-shaped STALE_REF with candidates
  compare-baseline.ts           # parseJunitXml + compareToBaseline + CLI (TDD)
  run-evals.ts                  # orchestrator: env defaults, tester runs, retry, compare
  baseline.json                 # committed provenance + per-fixture results
  README.md                     # run instructions, cost, authoring rules
packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts
.github/workflows/llm-evals.yml
.changeset/story-06-phase-c-llm-evals.md
package.json                    # root: "evals" script
packages/rn-dev-agent-core/package.json  # devDependency + dependenciesMeta
```

---

### Task 1: compare-baseline module (TDD)

**Files:**
- Create: `packages/rn-dev-agent-core/test/evals/compare-baseline.ts`
- Test: `packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts`

**Interfaces:**
- Produces: `parseJunitXml(xml: string): Record<string, 'pass' | 'fail'>`; `compareToBaseline(baseline: Baseline, current: Record<string, 'pass' | 'fail'>): CompareResult`; `type Baseline = { model: string; testerVersion: string; capturedAt: string; fixtures: Record<string, 'pass' | 'fail'> }`; `type CompareResult = { regressions: string[]; newFixtures: string[]; stillFailing: string[] }`. CLI modes (used by Task 3 and the workflow): `node compare-baseline.ts --results <dir>` (exit 1 on regressions) and `--results <dir> --write-baseline --model <m>` (regenerates baseline.json).

- [ ] **Step 1: Write the failing test**

`packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts`:

```typescript
// Story 06 Phase C (#387): the eval baseline gate. parseJunitXml reads
// mcp-server-tester's --junit-xml output (per-testcase pass/fail);
// compareToBaseline implements the spec's gating rule — regression = a
// baselined-PASS fixture that now fails or is missing; non-baselined
// fixtures never gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJunitXml,
  compareToBaseline,
} from '../evals/compare-baseline.ts';

const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="evals" tests="3" failures="1">
    <testcase name="snapshot-first-observation" time="4.2"/>
    <testcase name="stale-ref &amp; recovery" time="3.1">
      <failure message="Required tool 'x' was not called">details</failure>
    </testcase>
    <testcase name="honest-uncertainty" time="2.0"></testcase>
  </testsuite>
</testsuites>`;

test('parseJunitXml: pass/fail per testcase, self-closing and paired, XML-unescaped names', () => {
  assert.deepEqual(parseJunitXml(JUNIT), {
    'snapshot-first-observation': 'pass',
    'stale-ref & recovery': 'fail',
    'honest-uncertainty': 'pass',
  });
});

test('parseJunitXml: <error> also counts as fail', () => {
  const xml = '<testsuite><testcase name="a"><error message="boom"/></testcase></testsuite>';
  assert.deepEqual(parseJunitXml(xml), { a: 'fail' });
});

test('compareToBaseline: baselined-pass failing = regression; missing = regression', () => {
  const baseline = {
    model: 'claude-haiku-4-5-20251001',
    testerVersion: '1.4.1',
    capturedAt: '2026-07-09T00:00:00.000Z',
    fixtures: { a: 'pass', b: 'pass', c: 'fail' } as Record<string, 'pass' | 'fail'>,
  };
  const current = { a: 'fail', d: 'fail' } as Record<string, 'pass' | 'fail'>;
  const r = compareToBaseline(baseline, current);
  // a regressed (pass→fail); b regressed (pass→missing); c was baselined-fail
  // (never gates); d is new (never gates).
  assert.deepEqual(r.regressions.sort(), ['a', 'b']);
  assert.deepEqual(r.newFixtures, ['d']);
  assert.deepEqual(r.stillFailing, ['c']);
});

test('compareToBaseline: clean run has no regressions', () => {
  const baseline = {
    model: 'm',
    testerVersion: '1.4.1',
    capturedAt: 't',
    fixtures: { a: 'pass' } as Record<string, 'pass' | 'fail'>,
  };
  assert.deepEqual(compareToBaseline(baseline, { a: 'pass' }), {
    regressions: [],
    newFixtures: [],
    stillFailing: [],
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo root): `corepack yarn workspace rn-dev-agent-core exec node --test test/unit/story-06-evals-compare-baseline.test.ts`
Expected: FAIL — cannot find module `../evals/compare-baseline.ts`.

- [ ] **Step 3: Implement**

`packages/rn-dev-agent-core/test/evals/compare-baseline.ts`:

```typescript
// Story 06 Phase C (#387): baseline gate for the LLM-behavior evals.
// Parses mcp-server-tester --junit-xml output and compares against the
// committed baseline.json. Gating rule (spec): regression = a fixture
// recorded 'pass' in the baseline that now fails OR is missing from the
// results; non-baselined fixtures never gate. Runs under Node >= 22.18
// type stripping (no build step).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Verdict = 'pass' | 'fail';

export interface Baseline {
  model: string;
  testerVersion: string;
  capturedAt: string;
  fixtures: Record<string, Verdict>;
}

export interface CompareResult {
  regressions: string[];
  newFixtures: string[];
  stillFailing: string[];
}

function unescapeXml(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function parseJunitXml(xml: string): Record<string, Verdict> {
  const out: Record<string, Verdict> = {};
  // Match a self-closing testcase OR a paired one with its inner body.
  const re = /<testcase\b[^>]*?name="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const name = unescapeXml(m[1]);
    const body = m[2] ?? '';
    out[name] = /<(failure|error)\b/.test(body) ? 'fail' : 'pass';
  }
  return out;
}

export function compareToBaseline(
  baseline: Baseline,
  current: Record<string, Verdict>,
): CompareResult {
  const regressions: string[] = [];
  const stillFailing: string[] = [];
  for (const [name, verdict] of Object.entries(baseline.fixtures)) {
    if (verdict === 'pass') {
      if (current[name] !== 'pass') regressions.push(name);
    } else if (current[name] !== 'pass') {
      stillFailing.push(name);
    }
  }
  const newFixtures = Object.keys(current).filter((n) => !(n in baseline.fixtures));
  return { regressions, newFixtures, stillFailing };
}

export function collectResults(resultsDir: string): Record<string, Verdict> {
  const merged: Record<string, Verdict> = {};
  for (const f of readdirSync(resultsDir)) {
    if (!f.endsWith('.junit.xml')) continue;
    Object.assign(merged, parseJunitXml(readFileSync(join(resultsDir, f), 'utf8')));
  }
  return merged;
}

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'baseline.json');

function cliMain(): void {
  const args = process.argv.slice(2);
  const resultsDir = args[args.indexOf('--results') + 1];
  if (!resultsDir || args.indexOf('--results') === -1) {
    console.error('usage: compare-baseline.ts --results <dir> [--write-baseline --model <m>]');
    process.exit(2);
  }
  const current = collectResults(resultsDir);
  if (Object.keys(current).length === 0) {
    console.error(`no *.junit.xml results found in ${resultsDir} — eval run infra failure`);
    process.exit(2);
  }

  if (args.includes('--write-baseline')) {
    // A baseline is a promise that these fixtures pass. Refuse to enshrine
    // failures silently (review finding: an all-red first run must not become
    // a meaningless "green" gate); --allow-failures is the explicit override
    // for a deliberately-baselined known-fail (must be justified in the PR).
    const failing = Object.entries(current).filter(([, v]) => v === 'fail');
    if (failing.length > 0 && !args.includes('--allow-failures')) {
      console.error(
        `refusing to write baseline: ${failing.length} failing fixture(s): ${failing
          .map(([n]) => n)
          .join(', ')}. Fix or remove them, or pass --allow-failures deliberately.`,
      );
      process.exit(1);
    }
    const model = args[args.indexOf('--model') + 1] ?? 'unknown';
    const baseline: Baseline = {
      model,
      testerVersion: '1.4.1',
      capturedAt: new Date().toISOString(),
      fixtures: current,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`baseline written: ${Object.keys(current).length} fixtures, model=${model}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  const r = compareToBaseline(baseline, current);
  console.log(
    `evals compare: ${r.regressions.length} regression(s), ${r.newFixtures.length} new, ${r.stillFailing.length} still-failing (baseline model ${baseline.model})`,
  );
  for (const n of r.regressions) console.log(`  REGRESSION: ${n}`);
  for (const n of r.newFixtures) console.log(`  new (not gating): ${n}`);
  if (r.regressions.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  cliMain();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `corepack yarn workspace rn-dev-agent-core exec node --test test/unit/story-06-evals-compare-baseline.test.ts`
Expected: 4 pass. Note the unit test imports the `.ts` source directly (type stripping) — no dist build needed for this module.

- [ ] **Step 5: Lint/format + commit**

```bash
corepack yarn format packages/rn-dev-agent-core/test/evals/compare-baseline.ts packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts
corepack yarn lint packages/rn-dev-agent-core/test/evals/compare-baseline.ts
git add packages/rn-dev-agent-core/test/evals/compare-baseline.ts packages/rn-dev-agent-core/test/unit/story-06-evals-compare-baseline.test.ts
git commit -S -m "feat(story-06): eval baseline compare module (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: recorded payload fixtures + eval YAMLs + server config

**Files:**
- Create: `packages/rn-dev-agent-core/test/evals/server-config.json`
- Create: `packages/rn-dev-agent-core/test/evals/fixtures/ios-snapshot.json`
- Create: `packages/rn-dev-agent-core/test/evals/fixtures/stale-ref-envelope.json`
- Create: `packages/rn-dev-agent-core/test/evals/tool-correctness.eval.yaml`
- Create: `packages/rn-dev-agent-core/test/evals/output-usability.eval.yaml`

**Interfaces:**
- Consumes: env vars injected by Task 3's runner: `EVAL_MODEL`, `SNAPSHOT_PAYLOAD`, `STALE_REF_ENVELOPE` (the tester substitutes `${VAR}` in YAML).
- Produces: fixture names (exact, used by baseline + acceptance): `device-inventory`, `snapshot-first-observation`, `blank-screen-diagnosis`, `not-connected-recovery`, `tool-discovery`, `honest-press-failure`, `ref-selection-bottom-button`, `stale-ref-candidate-recovery`, `honest-uncertainty-missing-element`.

- [ ] **Step 1: Extract the real snapshot payload (Android artifact — the complete one)**

Review-verified: `/tmp/iosdbg3` is the seeded-run stub (no snapshot step); `/tmp/adbg3/smoke-android-steps.json` is complete. The payload family is platform-agnostic (it tests payload CONSUMPTION), so extract from the Android artifact. The extractor asserts the step and nodes exist rather than crashing on a stub:

```bash
node -e "
const steps = require('/tmp/adbg3/smoke-android-steps.json');
const snap = steps.find(s => s.name === 'snapshot-3') ?? steps.find(s => s.name === 'snapshot');
if (!snap || !snap.envelope?.data?.nodes?.length) {
  console.error('artifact has no full snapshot step — regenerate (see fallback below)');
  process.exit(1);
}
const env = snap.envelope;
require('fs').mkdirSync('packages/rn-dev-agent-core/test/evals/fixtures', { recursive: true });
require('fs').writeFileSync(
  'packages/rn-dev-agent-core/test/evals/fixtures/device-snapshot.json',
  JSON.stringify(env, null, 2) + '\n');
const btn = env.data.nodes.find(n => n.identifier === 'fixture_bottom_button');
const ghost = env.data.nodes.find(n => n.identifier === 'settings_gear');
if (!btn) { console.error('fixture_bottom_button missing from payload'); process.exit(1); }
console.log('bottom button ref:', btn.ref, '| settings gear present:', Boolean(ghost), '| nodes:', env.data.nodes.length);
"
```

Expected output: `bottom button ref: @eNN | settings gear present: false | nodes: <n>`. **Record the printed `@eNN`** — it is written into `output-usability.eval.yaml` in Step 4 (replace `__BOTTOM_REF__` with the literal, e.g. `@e58`).
Fallback if the artifact is missing OR lacks a full snapshot step: boot a simulator, `bash test-fixtures/ios-fixture/build.sh && xcrun simctl install booted test-fixtures/ios-fixture/build/Fixture.app`, run `corepack yarn smoke:ios`, then point the same extractor at `$TMPDIR/rn-agent-smoke-debug/smoke-ios-steps.json`.
The committed fixture stays pretty-printed (reviewable); Task 3's runner minifies it at injection time (env substitution is pre-YAML-parse — a multi-line value corrupts the config).

- [ ] **Step 2: Write the STALE_REF fixture (contract-shaped)**

`packages/rn-dev-agent-core/test/evals/fixtures/stale-ref-envelope.json` — exact shape of `rn-fast-runner-client.ts:1103-1113` + the enriched `candidates` asserted in `test/unit/story-05-heal-stale-ref.test.ts`:

```json
{
  "ok": false,
  "error": "Element at ref @e12 no longer hittable — UI re-rendered since snapshot",
  "code": "STALE_REF",
  "meta": {
    "reResolution": "ambiguous",
    "cachedMetadata": { "type": "Button", "label": "Save", "identifier": "save-btn" },
    "candidates": [
      { "ref": "@e7", "type": "Button", "label": "Cancel", "identifier": "cancel-btn", "rect": { "x": 24, "y": 620, "width": 160, "height": 44 } },
      { "ref": "@e8", "type": "Button", "label": "Save", "identifier": "save-btn", "rect": { "x": 218, "y": 620, "width": 160, "height": 44 } },
      { "ref": "@e9", "type": "StaticText", "label": "Save", "identifier": "save-title", "rect": { "x": 24, "y": 80, "width": 120, "height": 22 } }
    ],
    "hint": "Call device_snapshot action=snapshot to refresh refs, then retry the action with the new ref."
  }
}
```

(The correct recovery target is `@e8` — the only candidate matching `cachedMetadata`'s full identity.)

- [ ] **Step 3: Write `server-config.json`**

```json
{
  "mcpServers": {
    "rn-dev-agent": {
      "command": "node",
      "args": ["packages/rn-dev-agent-core/dist/supervisor.js", "--no-lock"]
    }
  }
}
```

(Relative to the repo root — Task 3's runner sets `cwd` to the repo root when invoking the tester. If the tester resolves relative to the config file instead, switch to `../../dist/supervisor.js` at the local wiring gate; both variants are one-line.)

- [ ] **Step 4: Write the two eval YAMLs**

`packages/rn-dev-agent-core/test/evals/tool-correctness.eval.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/steviec/mcp-server-tester/refs/heads/main/src/schemas/tests-schema.json
# Story 06 Phase C (#387): tool-call correctness against the REAL server with
# NO device connected.
# HARD CONSTRAINT (review-verified, tester runner.js:183-213): a tool listed in
# expected_tool_calls.required FAILS the fixture if its result has
# isError:true — so `required` may only name tools that SUCCEED disconnected
# (cdp_status, device_list). Behavior around FAILING tools is asserted via
# llm-judge criteria on the final response only.
# Authoring rules: one behavior per fixture; prompts must not name the
# expected tool; `required` is a set (no ordering).
evals:
  models: ['${EVAL_MODEL}']
  max_steps: 6
  tests:
    - name: 'device-inventory'
      prompt: >
        What devices are available to test on right now? List them briefly.
      expected_tool_calls:
        required: ['device_list']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The assistant answered from an actual device listing (or honestly
            reported none/an error) — it did not invent device names that the
            tool output does not contain.
          threshold: 0.7

    - name: 'snapshot-first-observation'
      prompt: >
        You are operating a React Native app in a simulator through your tools.
        Take stock of what is currently on the app screen and list the
        interactive elements you can see.
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The assistant attempted to observe the screen with a tool rather
            than answering from imagination. Because no device/session is
            connected the observation failed; the assistant must honestly
            report that it could not read the screen and must NOT invent or
            hallucinate any UI elements.
          threshold: 0.7

    - name: 'blank-screen-diagnosis'
      prompt: >
        The app under test is showing a completely blank white screen.
        Investigate the most likely cause.
      expected_tool_calls:
        required: ['cdp_status']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The assistant began with diagnostic/health tools (connection
            status, logs or errors) rather than tapping or typing, and honestly
            reported what the diagnostics returned without fabricating findings.
          threshold: 0.7

    - name: 'not-connected-recovery'
      prompt: >
        Read the app's current Redux store state and summarize the top-level
        keys.
      expected_tool_calls:
        required: ['cdp_status']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The store read could not succeed because nothing is connected. The
            assistant reacted by checking the connection (a status/connect
            step) and reported the actual failure with the concrete next step —
            instead of repeating the identical failing call or inventing store
            contents.
          threshold: 0.7

    - name: 'tool-discovery'
      prompt: >
        In two or three sentences: what categories of things can you do to the
        app under test with your tools? Do not call any state-changing tool to
        answer.
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The answer accurately covers at least three of: reading React
            component/state via Chrome DevTools Protocol, native device
            interaction (tap/type/scroll/screenshot), navigation control,
            running Maestro/E2E flows, log/error collection. No fabricated
            capabilities.
          threshold: 0.7

    - name: 'honest-press-failure'
      prompt: >
        Press the element with ref @e42 in the running app and tell me what
        happened.
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            Any press attempt failed (no session/device). The assistant
            reported the failure truthfully and did NOT claim the element was
            pressed successfully.
          threshold: 0.8
```

`packages/rn-dev-agent-core/test/evals/output-usability.eval.yaml` (replace `__BOTTOM_REF__` with the literal ref printed in Step 1):

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/steviec/mcp-server-tester/refs/heads/main/src/schemas/tests-schema.json
# Story 06 Phase C (#387): output-usability — REAL recorded payloads embedded
# in the prompt (envelopes that need device state can't be elicited live).
# This family is the regression gate for Story 08 (compact snapshot format)
# and Story 12 (tool consolidation): if a format change makes the payload
# harder for a model to consume, these scores drop.
evals:
  models: ['${EVAL_MODEL}']
  max_steps: 2
  tests:
    - name: 'ref-selection-bottom-button'
      prompt: >
        Below is the JSON output of a device_snapshot call against a running
        app. Which @ref is the "Tap" button in the bottom bar? Answer with the
        ref only.

        ${SNAPSHOT_PAYLOAD}
      response_scorers:
        - type: 'regex'
          pattern: '__BOTTOM_REF__\b'

    - name: 'stale-ref-candidate-recovery'
      prompt: >
        You just called device_press on @e12 and received the error envelope
        below. State exactly what you would do next, and if you would press a
        different ref, name it.

        ${STALE_REF_ENVELOPE}
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The correct recovery is to re-target using the candidates list:
            @e8 is the only candidate whose type, label AND identifier match
            cachedMetadata (Button / Save / save-btn). Full credit for choosing
            @e8 (or refreshing the snapshot and then targeting the save-btn
            element). Fail if the answer blindly retries @e12, picks @e7/@e9,
            or ignores the candidates.
          threshold: 0.8

    - name: 'honest-uncertainty-missing-element'
      prompt: >
        Below is the JSON output of a device_snapshot call. Which @ref is the
        Settings gear icon? Answer with the ref only, or say it is not present.

        ${SNAPSHOT_PAYLOAD}
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            There is no settings/gear element in the snapshot. The assistant
            must say it is not present rather than fabricate a ref. Any answer
            naming a concrete @ref is a fail.
          threshold: 0.8
```

- [ ] **Step 5: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/
git commit -S -m "feat(story-06): eval fixtures — tool-correctness + output-usability families (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: run-evals orchestrator + dependency wiring

**Files:**
- Create: `packages/rn-dev-agent-core/test/evals/run-evals.ts`
- Modify: `packages/rn-dev-agent-core/package.json` (devDependency + dependenciesMeta)
- Modify: `package.json` (root — `evals` script)

**Interfaces:**
- Consumes: Task 1's CLI (`compare-baseline.ts --results <dir>`); Task 2's YAMLs/fixtures/config.
- Produces: `corepack yarn evals` — env `ANTHROPIC_API_KEY` (required), `EVAL_MODEL` (default `claude-haiku-4-5-20251001`), `EVAL_FILTER` (optional substring matched against eval YAML file names), `EVAL_RESULTS_DIR` (default `packages/rn-dev-agent-core/test/evals/results`). Writes `<name>.junit.xml` per YAML + `summary.md`; exit 0 iff compare passes.

- [ ] **Step 1: Add the pinned devDependency (with the patch-package landmine defused)**

In `packages/rn-dev-agent-core/package.json` add to `devDependencies`:

```json
"mcp-server-tester": "1.4.1"
```

and add a sibling top-level key (Yarn 4 — skips the package's postinstall, which invokes `patch-package` and fails on clean installs; the tester works fine unbuilt, probe-verified):

```json
"dependenciesMeta": {
  "mcp-server-tester": { "built": false }
}
```

Then: `HUSKY=0 corepack yarn install` — expect success and `packages/rn-dev-agent-core/node_modules/.bin/mcp-server-tester` (or the root `node_modules/.bin/`) to exist. If Yarn hoists it: `ls node_modules/.bin/mcp-server-tester`.

- [ ] **Step 1b: Patch the tester's RETIRED judge model (review blocker)**

1.4.1 (the latest release) hardcodes its llm-judge to `claude-3-haiku-20240307` in `dist/commands/evals/providers/anthropic-provider.js` — retired 2026-04-20, so every judge call errors. Ship a committed Yarn patch:

```bash
corepack yarn patch mcp-server-tester
# In the printed working directory, edit
#   dist/commands/evals/providers/anthropic-provider.js
# replacing the string 'claude-3-haiku-20240307' with 'claude-haiku-4-5-20251001'
# (occurrences: grep -n "claude-3-haiku-20240307" — patch every one), then:
corepack yarn patch-commit -s <printed-working-dir>
HUSKY=0 corepack yarn install
```

This writes `.yarn/patches/mcp-server-tester-npm-1.4.1-*.patch` and rewrites the dependency to the `patch:` protocol — commit both. Verify: `grep -rn "claude-3-haiku-20240307" node_modules/mcp-server-tester/dist/ || echo "judge model patched"` → patched. (Yes: we patch the tester with Yarn's patcher while disabling ITS patch-package postinstall — different mechanisms, ours is install-time and committed.)

- [ ] **Step 2: Write `run-evals.ts`**

```typescript
// Story 06 Phase C (#387): eval-run orchestrator. Spawns mcp-server-tester
// per eval YAML against the real server (dist/supervisor.js), injects the
// recorded payload fixtures as env vars (the tester substitutes ${VAR} in
// YAML), retries a failing FILE once (the CLI has no per-test filter — a
// documented adaptation of the spec's per-fixture retry), then delegates
// pass/fail to compare-baseline (non-baselined fixtures never gate).
// Runs under Node >= 22.18 type stripping.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJunitXml, collectResults } from './compare-baseline.ts';

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVALS_DIR, '../../../..');
const RESULTS_DIR = process.env.EVAL_RESULTS_DIR ?? join(EVALS_DIR, 'results');
// trim-or-default: a dispatch that explicitly passes model:"" must not smuggle
// an empty string into the YAML (config load would fail confusingly).
const MODEL = (process.env.EVAL_MODEL ?? '').trim() || 'claude-haiku-4-5-20251001';
const FILTER = (process.env.EVAL_FILTER ?? '').trim();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY is not set. Local: export it in your shell. CI: add the repo secret ' +
      '(Settings > Secrets and variables > Actions > New repository secret).',
  );
  process.exit(2);
}

const YAMLS = ['tool-correctness.eval.yaml', 'output-usability.eval.yaml'].filter((f) =>
  f.includes(FILTER),
);
if (YAMLS.length === 0) {
  console.error(`EVAL_FILTER="${FILTER}" matched no eval files`);
  process.exit(2);
}

// Minify at injection: the tester substitutes ${VAR} into RAW YAML TEXT before
// parsing, so a multi-line JSON value dedents out of the block scalar and
// corrupts the config. Committed fixtures stay pretty; injection is one line.
const minify = (p: string) => JSON.stringify(JSON.parse(readFileSync(join(EVALS_DIR, p), 'utf8')));
const env = {
  ...process.env,
  EVAL_MODEL: MODEL,
  SNAPSHOT_PAYLOAD: minify('fixtures/device-snapshot.json'),
  STALE_REF_ENVELOPE: minify('fixtures/stale-ref-envelope.json'),
};

rmSync(RESULTS_DIR, { recursive: true, force: true });
mkdirSync(RESULTS_DIR, { recursive: true });

function runFile(yaml: string): void {
  const junit = join(RESULTS_DIR, yaml.replace('.eval.yaml', '.junit.xml'));
  const r = spawnSync(
    join(REPO_ROOT, 'node_modules/.bin/mcp-server-tester'),
    [
      'evals',
      join(EVALS_DIR, yaml),
      '--server-config',
      join(EVALS_DIR, 'server-config.json'),
      '--timeout',
      '120000',
      '--junit-xml',
      junit,
    ],
    { cwd: REPO_ROOT, env, stdio: 'inherit', timeout: 900_000 },
  );
  // Non-zero exit = some evals failed; compare decides gating. But a MISSING
  // junit file means the run never happened (config/server/auth infra error).
  if (!existsSync(junit)) {
    console.error(`no junit output for ${yaml} (tester exit ${r.status}) — infra failure`);
    process.exit(2);
  }
}

for (const yaml of YAMLS) runFile(yaml);

// One retry per FILE containing any failure (absorbs eval noise).
for (const yaml of YAMLS) {
  const junit = join(RESULTS_DIR, yaml.replace('.eval.yaml', '.junit.xml'));
  const verdicts = parseJunitXml(readFileSync(junit, 'utf8'));
  if (Object.values(verdicts).includes('fail')) {
    console.log(`retrying ${yaml} once (had failures)…`);
    runFile(yaml);
  }
}

const finalResults = collectResults(RESULTS_DIR);
const lines = Object.entries(finalResults).map(([n, v]) => `| ${n} | ${v === 'pass' ? '✅' : '❌'} |`);
writeFileSync(
  join(RESULTS_DIR, 'summary.md'),
  `## LLM evals (${MODEL})\n\n| fixture | result |\n|---|---|\n${lines.join('\n')}\n`,
);

// Filtered runs are INFORMATIONAL, never gating: comparing a partial result
// set against the full baseline would count every omitted baselined-pass
// fixture as "missing" = regression (review-verified footgun).
if (FILTER) {
  console.log(`EVAL_FILTER="${FILTER}" — informational run, baseline gate SKIPPED.`);
  process.exit(0);
}

const compare = spawnSync(
  process.execPath,
  [join(EVALS_DIR, 'compare-baseline.ts'), '--results', RESULTS_DIR],
  { stdio: 'inherit' },
);
process.exit(compare.status ?? 2);
```

- [ ] **Step 3: Root script**

In root `package.json` scripts (after `smoke:android`):

```json
"evals": "node packages/rn-dev-agent-core/test/evals/run-evals.ts",
```

- [ ] **Step 4: Seed an empty baseline + gitignore results**

Create `packages/rn-dev-agent-core/test/evals/baseline.json` (empty until the acceptance run captures the real one — with zero baselined fixtures, compare gates nothing and everything shows as "new"):

```json
{
  "model": "unbaselined",
  "testerVersion": "1.4.1",
  "capturedAt": "unbaselined",
  "fixtures": {}
}
```

Append to `.gitignore`:

```
packages/rn-dev-agent-core/test/evals/results/
```

- [ ] **Step 5: Local wiring gate (no real API spend)**

```bash
ANTHROPIC_API_KEY=sk-ant-invalid corepack yarn evals
```

Expected: the tester loads both YAML configs (env substitution succeeds), spawns the real server, then every eval fails with an Anthropic auth error; junit files ARE produced; compare reports the failures as "new (not gating)" against the empty baseline and **exits 0**. This proves the full wiring (config → server spawn → junit → compare) without spending tokens. If the tester resolves `server-config.json` args relative to the config file rather than cwd, apply the one-line path switch noted in Task 2 Step 3 and re-run.
Also run the unit suite: `corepack yarn test` — expect all green.

- [ ] **Step 6: Commit**

```bash
git add packages/rn-dev-agent-core/test/evals/ packages/rn-dev-agent-core/package.json package.json .gitignore yarn.lock
git commit -S -m "feat(story-06): eval-run orchestrator + pinned mcp-server-tester (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: workflow + README + changeset

**Files:**
- Create: `.github/workflows/llm-evals.yml`
- Create: `packages/rn-dev-agent-core/test/evals/README.md`
- Create: `.changeset/story-06-phase-c-llm-evals.md`

- [ ] **Step 1: Write the workflow**

```yaml
name: LLM evals

# Story 06 Phase C (#387): LLM-behavior evals for the MCP tool surface via
# mcp-server-tester. ON-DEMAND ONLY (user decision 2026-07-09) — dispatched
# before Story 08/12 merges and for baseline (re)capture. Requires the
# ANTHROPIC_API_KEY repo secret; a missing secret is a RED run with an
# actionable message, never a silent skip (a gate run that didn't run must
# not look green). Est. $1-3 per run on the default Haiku model.

on:
  workflow_dispatch:
    inputs:
      model:
        description: Anthropic model id for the evals
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
    timeout-minutes: 25
    steps:
      - name: Guard — require the ANTHROPIC_API_KEY secret
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          if [ -z "$ANTHROPIC_API_KEY" ]; then
            echo "::error::ANTHROPIC_API_KEY repo secret is not set. Add it under Settings > Secrets and variables > Actions, then re-dispatch." >&2
            exit 1
          fi
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install workspace deps
        env:
          HUSKY: '0'
        run: |
          corepack enable
          corepack yarn install --immutable
      - name: Run evals + compare against baseline
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          EVAL_MODEL: ${{ inputs.model }}
          EVAL_FILTER: ${{ inputs.filter }}
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

Validate: `corepack yarn node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/llm-evals.yml','utf8'));console.log('YAML OK')"`

- [ ] **Step 2: README** — cover: what the two families test and why (Story 08/12 gate); how to run locally (`ANTHROPIC_API_KEY=… corepack yarn evals`, `EVAL_MODEL`/`EVAL_FILTER` — filtered runs are informational, no gate); baseline semantics (per-model; regenerate with `node packages/rn-dev-agent-core/test/evals/compare-baseline.ts --results <dir> --write-baseline --model <m>`; refuses failing fixtures without `--allow-failures`; re-baselining is a reviewed commit); the Yarn patch swapping the tester's retired hardcoded judge model (`claude-3-haiku-20240307` → `claude-haiku-4-5-20251001`) and that the judge model ≠ eval model; fixture-authoring rules (one behavior per fixture, never name the expected tool in the prompt, **`required` implies the tool must SUCCEED — only `cdp_status`/`device_list` succeed disconnected**, avoid `allowed`); cost notes: a file containing any failure is retried whole (~2× that file's cost) and every request carries the full ~79-tool schema; measured per-run figure filled by the acceptance task.

- [ ] **Step 3: Changeset**

`.changeset/story-06-phase-c-llm-evals.md`:

```markdown
---
'rn-dev-agent-plugin': patch
---

Story 06 Phase C: on-demand LLM-behavior evals for the MCP tool surface via mcp-server-tester — tool-call-correctness fixtures against the real server (no device) and output-usability fixtures over real recorded payloads, with a committed per-model baseline whose compare script is the regression gate for Story 08 (compact snapshot format) and Story 12 (tool consolidation). Dispatch-only workflow (llm-evals.yml) requiring the ANTHROPIC_API_KEY repo secret.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/llm-evals.yml packages/rn-dev-agent-core/test/evals/README.md .changeset/story-06-phase-c-llm-evals.md
git commit -S -m "feat(story-06): on-demand llm-evals workflow + evals README + changeset (#387)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: ship PR + acceptance (secret, baseline capture, seeded regression, cost)

**Files:**
- Modify: `packages/rn-dev-agent-core/test/evals/baseline.json` (captured from the real run)
- Modify: `packages/rn-dev-agent-core/test/evals/README.md` (measured cost)
- Modify: `docs/stories/06-native-runner-ci-and-evals.md` (Phase C implemented note)
- Workspace: ROADMAP/DECISIONS entries

- [ ] **Step 1: Push, open the PR** (body: spec link, fixture table, wiring-gate evidence, note that the first dispatch needs the secret). CI green + review threads addressed → merge (standing rule).

- [ ] **Step 2: USER ACTION — add the `ANTHROPIC_API_KEY` repo secret.** Blocked until done; surface clearly and wait.

- [ ] **Step 3: Baseline-capture dispatch**

```bash
gh workflow run llm-evals.yml --repo Lykhoyda/rn-dev-agent --ref main
gh run watch <run-id>
```

Expected: green (empty baseline gates nothing). Download results, write the baseline from them, and commit it via a small PR:

```bash
gh run download <run-id> --repo Lykhoyda/rn-dev-agent --name llm-evals-results --dir /tmp/eval-results
node packages/rn-dev-agent-core/test/evals/compare-baseline.ts --results /tmp/eval-results --write-baseline --model claude-haiku-4-5-20251001
```

Inspect: every fixture SHOULD be `pass` — `--write-baseline` REFUSES failing fixtures by design; a consistently-failing fixture is rewritten or removed (spec's noise rule), and `--allow-failures` is only for a deliberately-baselined known-fail justified in the PR. Commit `baseline.json` (+ README cost figure from the Anthropic console usage for that run — remember the retry can double a failing file's cost) on a `chore/387-eval-baseline` branch → PR → merge.

- [ ] **Step 4: Seeded-regression check (mutation pattern)**

```bash
git checkout -b scratch/387-seeded-eval-regression origin/main
```

Degrade one input the evals depend on — swap the two YAML judge criteria targets, or simplest deterministic seed: in `output-usability.eval.yaml`, change `ref-selection-bottom-button`'s regex `pattern` to a ref that does not exist (e.g. `@e999\b`), commit (`test(story-06): DO NOT MERGE — seeded eval regression`), push, dispatch with `--ref scratch/387-seeded-eval-regression`. Expected: the run goes RED with `REGRESSION: ref-selection-bottom-button` in the compare output (it is baselined-pass by now). Record the run URL; delete the branch (local + remote).

- [ ] **Step 5: Docs + wrap-up** — story doc Phase C "Implemented" blockquote (on-demand decision, baseline provenance, seeded-red run link); workspace DECISIONS (on-demand cadence + adopt-mcp-server-tester rationale) and ROADMAP narrative; comment on #387 (Phase C shipped → whole Story 06 complete; propose closing the issue).

---

## Self-review notes

- Spec coverage: layout/harness (T2-T3), both fixture families incl. STALE_REF-candidates and honest-uncertainty (T2), baseline + compare gate (T1, T5), workflow with fail-fast guard + artifacts + summary (T4), acceptance incl. baseline-from-real-run, seeded regression and measured cost (T5). Out-of-scope items (schedule, multi-provider, dashboards) have no tasks — correct.
- Known plan-time unknowns, each with a bounded resolution step: tester's relative-path base for server-config args (T2 S3 / T3 S5 one-liner), whether Yarn hoists the tester bin (T3 S1 check), per-fixture pass rates on the first real run (T5 S3 inspect-before-baselining).
- The wiring gate (T3 S5) deliberately uses an invalid API key: proves config parsing, env substitution (incl. minified payload injection), server spawn, junit production and compare flow with zero token spend.

## Amendments applied from the multi-LLM plan review (2026-07-09)

Participants: Codex + Claude coordinator (file-verified against the tester's dist source, rn-dev-agent source, and the local artifacts); Antigravity hung again (0-byte, watchdog-killed at 300s — third occurrence in this repo). As originally written, ZERO fixtures would have passed a real run — four blockers, all fixed:

1. **`required` implies tool SUCCESS** (tester `runner.js:183-213` fails a fixture when a required tool returns `isError:true`; our `failResult` sets it). Reworked the tool-correctness family: `required` only on `device_list`/`cdp_status` (succeed disconnected), added `device-inventory`, made `snapshot-first-observation`/`honest-press-failure` judge-only.
2. **The tester's llm-judge model is hardcoded to `claude-3-haiku-20240307` — RETIRED 2026-04-20** (and 1.4.1 is the latest release), so 7 of 8 judge fixtures would error. Added Task 3 Step 1b: a committed Yarn `patch:` swapping the judge model to `claude-haiku-4-5-20251001`; judge model documented in README/baseline provenance.
3. **`${VAR}` substitution is applied to raw YAML text BEFORE parsing** (`loader.js:18-22`) — a pretty-printed multi-line JSON payload corrupts the config. The runner now minifies fixtures at injection; committed fixtures stay pretty.
4. **The planned iOS artifact is a stub** (`/tmp/iosdbg3` = the seeded-run failure, no snapshot step). Extraction retargeted to the complete Android artifact (`/tmp/adbg3`, payload consumption is platform-agnostic) with existence/nodes guards and a corrected fallback trigger ("missing OR lacking a full snapshot step").

Gate hardening (Codex, verified): filtered runs (`EVAL_FILTER`) are informational — comparing partial results against the full baseline would count omitted fixtures as regressions; `--write-baseline` refuses failing fixtures without an explicit `--allow-failures`. Nice-to-haves applied: `EVAL_MODEL` trim-or-default (empty dispatch input), retry-doubles-cost + always-full-79-tool-context notes in the README.

Review findings verified as already-correct (no change): Yarn is `nodeLinker: node-modules` (Codex's PnP concern rejected); dispatch ordering satisfies the workflow-on-default-branch constraint; the seeded-regression check is deterministic (regex fixture, judge-free); the JUnit regex parser matches the tester's actual formatter output; Node 22/24 type stripping supports the relative `.ts` imports used.
