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
