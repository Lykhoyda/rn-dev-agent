import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { evaluateCase, type EvalCase } from '../../jev-evals/run.ts';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

test('committed frozen-screen fixtures exercise the eval runner offline through a scripted judge', async () => {
  const root = new URL('../../jev-evals/cases/', import.meta.url);
  const names = readdirSync(root).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 11);
  for (const name of names) {
    const fixture: EvalCase = JSON.parse(readFileSync(new URL(name, root), 'utf8'));
    const judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, q]) => {
          if (id.startsWith('verb')) return [id, choice(q, 'press')];
          if (q.type === 'noul')
            return [
              id,
              {
                type: 'noul',
                noul:
                  fixture.expected.kind === 'check' && fixture.expected.verdict === 'pass'
                    ? 0.9
                    : 0.1,
              },
            ];
          const expected = fixture.expected;
          const candidates = fixture.screen.elements.filter(
            (e) => !fixture.line.startsWith('Type') || e.kind === 'input',
          );
          const index =
            expected.kind === 'target' && 'ref' in expected
              ? candidates.findIndex((e) => e.ref === expected.ref)
              : expected.kind === 'target' && 'scroll' in expected
                ? candidates.findIndex((e) => e.offscreen)
                : -1;
          return [id, choice(q, index < 0 ? 'none' : `e${index}`)];
        }),
      ),
    );
    assert.equal((await evaluateCase(fixture, judge)).pass, true, name);
    assert.ok(
      judge.requests.length > 0 ||
        (fixture.expected.kind === 'check' && fixture.expected.verdict === 'unsure'),
    );
    for (const value of fixture.typedValues ?? [])
      assert.ok(!JSON.stringify(judge.requests).includes(value), name);
  }
});

test('eval mismatches are failures and an uncertain frozen check is re-asked only once', async () => {
  const fixture: EvalCase = {
    screen: { front: 'app', elements: [], visibleText: [] },
    line: '✓ Ready',
    expected: { kind: 'check', verdict: 'pass' },
  };
  const judge = scriptedJudge((q) =>
    Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul', noul: 0.5 }])),
  );
  assert.deepEqual(await evaluateCase(fixture, judge), {
    pass: false,
    actual: { kind: 'check', verdict: 'unsure' },
  });
  assert.equal(judge.requests.length, 2);
});
