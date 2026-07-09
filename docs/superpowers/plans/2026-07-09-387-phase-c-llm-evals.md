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

## Verified interfaces (from source/README — do not re-derive)

- Eval YAML: `evals: { models: ['…'], max_steps: N, tests: [{ name, prompt, expected_tool_calls: { required: […], allowed: […] }, response_scorers: [{type: 'regex', pattern} | {type: 'llm-judge', criteria, threshold} | {type: 'contains', text}] }] }`. `${VAR}` env substitution works in ALL config values; a missing var fails config load.
- CLI: `mcp-server-tester evals <file> --server-config <json> [--server-name <n>] [--timeout <ms>] [--debug] [--junit-xml [filename]]`. Default `--timeout` is 10000 ms — too low for multi-turn LLM evals; use 120000.
- Server config: `{ "mcpServers": { "<name>": { "command": "node", "args": […] } } }`.
- Exit code: non-zero when any eval fails — the run script must IGNORE it and let compare decide (non-baselined fixtures must not gate), but must HARD-FAIL if the expected junit file was not produced (infra failure).
- Install landmine: `mcp-server-tester`'s postinstall invokes `patch-package` (probe-verified: plain `npm install` fails with "patch-package: command not found"). Under Yarn 4, disable its build script via `dependenciesMeta` (Task 3).
- STALE_REF enriched envelope (source: `rn-fast-runner-client.ts:1103-1113`, shape asserted in `test/unit/story-05-heal-stale-ref.test.ts:74-84`): `{ ok:false, error, code:'STALE_REF', meta:{ reResolution:'ambiguous', candidates:[{ref,type,label,identifier,rect}, …≤5], cachedMetadata:{type,label,identifier}, hint } }`.
- Recorded snapshot payloads exist locally at `/tmp/iosdbg3/smoke-ios-steps.json` and `/tmp/adbg3/smoke-android-steps.json` (Phase B CI debug artifacts); regenerable with `corepack yarn smoke:ios` against a booted sim (writes `$TMPDIR/rn-agent-smoke-debug/smoke-ios-steps.json`).

## File structure

```
packages/rn-dev-agent-core/test/evals/
  server-config.json            # spawns dist/supervisor.js over stdio
  tool-correctness.eval.yaml    # live server, no device — tool-selection behavior
  output-usability.eval.yaml    # recorded payloads embedded in prompts
  fixtures/ios-snapshot.json    # real device_snapshot envelope (from Phase B smoke)
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
- Produces: fixture names (exact, used by baseline + acceptance): `snapshot-first-observation`, `blank-screen-diagnosis`, `not-connected-recovery`, `tool-discovery`, `honest-press-failure`, `ref-selection-bottom-button`, `stale-ref-candidate-recovery`, `honest-uncertainty-missing-element`.

- [ ] **Step 1: Extract the real iOS snapshot payload**

The Phase B smoke debug JSON contains full envelopes. Extract the last full pre-keyboard snapshot (`snapshot-3`) and pin the bottom-button ref:

```bash
node -e "
const steps = require('/tmp/iosdbg3/smoke-ios-steps.json');
const snap = steps.find(s => s.name === 'snapshot-3') ?? steps.find(s => s.name === 'snapshot');
const env = snap.envelope;
require('fs').writeFileSync(
  'packages/rn-dev-agent-core/test/evals/fixtures/ios-snapshot.json',
  JSON.stringify(env, null, 2) + '\n');
const btn = env.data.nodes.find(n => n.identifier === 'fixture_bottom_button');
const ghost = env.data.nodes.find(n => n.identifier === 'settings_gear');
console.log('bottom button ref:', btn.ref, '| settings gear present:', Boolean(ghost));
"
```

Expected output: `bottom button ref: @eNN | settings gear present: false`. **Record the printed `@eNN`** — it is written into `output-usability.eval.yaml` in Step 4 (replace `__BOTTOM_REF__` below with the literal, e.g. `@e94`).
Fallback if `/tmp/iosdbg3` is gone: boot a simulator, `bash test-fixtures/ios-fixture/build.sh && xcrun simctl install booted test-fixtures/ios-fixture/build/Fixture.app`, run `corepack yarn smoke:ios`, then read `$TMPDIR/rn-agent-smoke-debug/smoke-ios-steps.json` with the same command.

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
# NO device connected. Assertions are about which tools the model reaches for
# and whether it reports errors honestly — never about tool success.
# Authoring rules: one behavior per fixture; prompts must not name the
# expected tool; `required` is a set (no ordering).
evals:
  models: ['${EVAL_MODEL}']
  max_steps: 6
  tests:
    - name: 'snapshot-first-observation'
      prompt: >
        You are operating a React Native app in a simulator through your tools.
        Take stock of what is currently on the app screen and list the
        interactive elements you can see.
      expected_tool_calls:
        required: ['device_snapshot']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The assistant attempted to observe the screen with a tool. Because
            no device/session is connected the tool returned an error; the
            assistant must honestly report that it could not read the screen
            and must NOT invent or hallucinate any UI elements.
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
        required: ['cdp_store_state']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The store read failed because nothing is connected. The assistant
            reacted to the error by checking or attempting the connection
            (e.g. a status or connect tool) or clearly explaining the exact
            recovery step — instead of repeating the identical failing call or
            inventing store contents.
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
      expected_tool_calls:
        required: ['device_press']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            The press failed (no session/device). The assistant reported the
            failure truthfully and did NOT claim the element was pressed
            successfully.
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
const MODEL = process.env.EVAL_MODEL ?? 'claude-haiku-4-5-20251001';
const FILTER = process.env.EVAL_FILTER ?? '';

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

const env = {
  ...process.env,
  EVAL_MODEL: MODEL,
  SNAPSHOT_PAYLOAD: readFileSync(join(EVALS_DIR, 'fixtures/ios-snapshot.json'), 'utf8'),
  STALE_REF_ENVELOPE: readFileSync(join(EVALS_DIR, 'fixtures/stale-ref-envelope.json'), 'utf8'),
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
        description: Substring filter on eval YAML file names (empty = all)
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

- [ ] **Step 2: README** — cover: what the two families test and why (Story 08/12 gate); how to run locally (`ANTHROPIC_API_KEY=… corepack yarn evals`, `EVAL_MODEL`/`EVAL_FILTER`); baseline semantics (per-model; regenerate with `node packages/rn-dev-agent-core/test/evals/compare-baseline.ts --results <dir> --write-baseline --model <m>`; re-baselining is a reviewed commit); fixture-authoring rules (one behavior per fixture, never name the expected tool in the prompt, `required` is a set, avoid `allowed`); cost placeholder filled by the acceptance task with the measured figure.

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

Inspect: every fixture SHOULD be `pass`; a consistently-failing fixture is rewritten or removed (spec's noise rule), not baselined as expected-fail without a comment. Commit `baseline.json` (+ README cost figure from the Anthropic console usage for that run, or the token estimate method documented inline) on a `chore/387-eval-baseline` branch → PR → merge.

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
- The wiring gate (T3 S5) deliberately uses an invalid API key: proves config parsing, env substitution, server spawn, junit production and compare flow with zero token spend.
