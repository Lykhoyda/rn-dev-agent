import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { persistRunPolicy, VERDICT_WITHHELD } from '../../../dist/qa/privacy-projection.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';

const entry = fileURLToPath(new URL('../../../dist/qa/walk.js', import.meta.url));
const project = (policy: string, verdict: string): string =>
  JSON.parse(
    execFileSync(process.execPath, [entry, '--project-verdict', policy, verdict], {
      encoding: 'utf8',
    }),
  ).text;

test('the executable projects verdict prose using the persisted run policy', () => {
  const runId = 'check-projection';
  const run = join(mkdtempSync(join(tmpdir(), 'qaren-project-')), runId);
  const cwd = join(run, 'wt');
  mkdirSync(cwd, { recursive: true });
  const privacy = new ObservedPrivacy(['hunter-canary-77', '47']);
  privacy.concealFallback(' Café ');
  privacy.concealFallback('1234567890');
  persistRunPolicy(privacy.privateSet(), cwd, `${runId}:token`);
  const policy = join(run, 'privacy-policy.json');
  assert.equal(statSync(policy).mode & 0o777, 0o600);
  const verdict = join(run, 'verdict.md');
  writeFileSync(verdict, 'Fill with hunter-canary-77 failed; 47, Café, 1234 5678 90. Step 1 of 2.');
  assert.equal(project(policy, verdict), 'Fill with ••• failed; •••, •••, •••. Step 1 of 2.');
  for (const corrupt of ['{}', '{', '{"schema":"qaren-privacy/1","values":[],"contexts":[{}]}']) {
    writeFileSync(policy, corrupt);
    assert.equal(project(policy, verdict), VERDICT_WITHHELD);
  }
  assert.equal(project(join(run, 'missing.json'), verdict), VERDICT_WITHHELD);
});

test('a managed walk persists preclassified values for later verdict projection', async () => {
  const runId = 'check-walker-projection';
  const run = join(mkdtempSync(join(tmpdir(), 'qaren-project-')), runId);
  const cwd = join(run, 'wt');
  mkdirSync(cwd, { recursive: true });
  const originalCwd = process.cwd();
  const originalLease = process.env.QAREN_DEVICE_LEASE;
  try {
    process.chdir(cwd);
    process.env.QAREN_DEVICE_LEASE = `${runId}:token`;
    const blocks = parsePlan(
      '## QA\n\n### Fail\n✓ "Missing"\n\n### Fill later\n1. Fill "input" with "47"\n',
    ).blocks;
    assert.ok(blocks);
    const f = walker(
      [screen([element('@visible', '47', { kind: 'text' })])],
      scriptedJudge(() => ({})),
    );
    const ledger = await runPlan(blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
  } finally {
    process.chdir(originalCwd);
    if (originalLease === undefined) delete process.env.QAREN_DEVICE_LEASE;
    else process.env.QAREN_DEVICE_LEASE = originalLease;
  }
  const verdict = join(run, 'verdict.md');
  writeFileSync(verdict, 'The later fill of 47 was never dispatched.');
  assert.equal(
    project(join(run, 'privacy-policy.json'), verdict),
    'The later fill of ••• was never dispatched.',
  );
});
