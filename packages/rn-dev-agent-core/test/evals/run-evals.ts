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
    [
      '-p',
      'Reply with exactly: OK',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--output-format',
      'json',
      '--model',
      JUDGE_MODEL,
    ],
    {
      cwd: scratch,
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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
  const sim = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const simBooted = !sim.error && sim.status === 0 && sim.stdout.includes('(Booted)');
  const adb = spawnSync('adb', ['devices'], { encoding: 'utf8', timeout: 15_000 });
  const adbAttached =
    !adb.error &&
    adb.status === 0 &&
    adb.stdout
      .split('\n')
      .slice(1)
      .some((l) => /^\S+\s+device\b/.test(l.trim()));
  if (!simBooted && !adbAttached) return false;
  if (process.env.EVAL_ALLOW_DEVICE === '1') {
    console.log(
      'booted device detected + EVAL_ALLOW_DEVICE=1 — INFORMATIONAL run, baseline gate will be SKIPPED.',
    );
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
      const v = judgeOrExit(s.criteria, f.prompt, run.outcome);
      if (v.score < s.threshold) {
        reasons.push(`llm-judge score ${v.score} < ${s.threshold}: ${v.reasoning}`);
      }
    }
  }
  return reasons.length === 0
    ? { verdict: 'pass' }
    : { verdict: 'fail', reason: reasons.join(' | ') };
}

function judgeOrExit(
  criteria: string,
  taskPrompt: string,
  outcome: TranscriptOutcome,
): JudgeVerdict {
  const opts = { model: JUDGE_MODEL, bin: BIN, cwd: scratch, timeoutMs: 120_000 };
  try {
    return runJudge(criteria, taskPrompt, outcome, opts);
  } catch (first) {
    try {
      return runJudge(criteria, taskPrompt, outcome, opts);
    } catch (second) {
      console.error(
        `judge infra failure (after retry): ${(second as Error).message}; first: ${(first as Error).message}`,
      );
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
