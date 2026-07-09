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
const lines = Object.entries(finalResults).map(
  ([n, v]) => `| ${n} | ${v === 'pass' ? '✅' : '❌'} |`,
);
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
