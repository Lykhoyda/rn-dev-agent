import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJev, JEV_MODEL } from '../../dist/qa/jev.js';
import { summarizeJev } from '../../dist/qa/ledger.js';
import { parsePlanWithJev } from '../../dist/qa/plan.js';
import { decideScreen, CHECK } from '../../dist/qa/resolve.js';
import { JevError, type Judge } from '../../dist/qa/questions.js';
import type { Screen } from '../../dist/qa/screen.js';

export interface EvalCase {
  screen: Screen;
  line: string;
  typedValues?: string[];
  expected:
    | { kind: 'target'; ref: string }
    | { kind: 'target'; scroll: 'up' | 'down' }
    | { kind: 'target'; refuse: string }
    | { kind: 'check'; verdict: 'pass' | 'fail' | 'unsure' };
}

export async function evaluateCase(
  input: EvalCase,
  judge: Judge,
): Promise<{ pass: boolean; actual: unknown }> {
  const parsed = await parsePlanWithJev(
    input.line.startsWith('✓') ? input.line : `1. ${input.line}`,
    judge,
  );
  const item = parsed.blocks?.[0]?.items[0];
  if (!item || parsed.blocks?.length !== 1 || parsed.blocks[0].items.length !== 1)
    return { pass: false, actual: 'PLAN_UNPARSEABLE' };
  const typed = [...(input.typedValues ?? []), ...(item.kind === 'fill' ? [item.text] : [])];
  let decision = await decideScreen(
    input.screen,
    judge,
    item.kind === 'check' ? item : undefined,
    item.kind === 'check' ? undefined : item,
    typed,
  );
  for (let i = 0; decision.check === 'unsure' && i < CHECK.reasks; i++)
    decision = await decideScreen(
      input.screen,
      judge,
      item.kind === 'check' ? item : undefined,
      undefined,
      typed,
    );
  const actual =
    input.expected.kind === 'check'
      ? { kind: 'check', verdict: decision.check }
      : decision.target && 'ref' in decision.target
        ? { kind: 'target', ref: decision.target.ref }
        : decision.target && 'scroll' in decision.target
          ? { kind: 'target', scroll: decision.target.scroll }
          : {
              kind: 'target',
              refuse:
                decision.target && 'refuse' in decision.target
                  ? decision.target.refuse
                  : 'NO_TARGET',
            };
  return { pass: JSON.stringify(actual) === JSON.stringify(input.expected), actual };
}

async function main(): Promise<void> {
  if (!process.env.TYPESAFE_API_KEY?.trim()) throw new JevError('JEV_AUTH_FAILED');
  const judge = createJev();
  const root = join(dirname(fileURLToPath(import.meta.url)), 'cases');
  const names = (await readdir(root)).filter((n) => n.endsWith('.json')).sort();
  if (!names.length) throw new Error('no frozen-screen cases found');
  let misses = 0;
  for (const name of names) {
    try {
      const result = await evaluateCase(
        JSON.parse(await readFile(join(root, name), 'utf8')),
        judge,
      );
      if (!result.pass) misses++;
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(result.actual)}`);
    } catch (error) {
      misses++;
      console.log(
        `FAIL ${name}: ${error instanceof JevError ? error.code : 'invalid evaluation fixture'}`,
      );
    }
  }
  const summary = summarizeJev(judge.calls);
  console.log(
    JSON.stringify({
      model: JEV_MODEL,
      cases: names.length,
      passed: names.length - misses,
      failed: misses,
      ...summary,
    }),
  );
  process.exitCode = misses ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof JevError ? error.code : 'evaluation runner failed');
    process.exitCode = 1;
  });
}
