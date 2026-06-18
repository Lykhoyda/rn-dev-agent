import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runE2eSuiteCore, makeRunId } from '../../dist/tools/run-e2e-suite.js';
import { loadIndex } from '../../dist/domain/e2e-run.js';

function parse(r) { return JSON.parse(r.content[0].text); }
const passEnv = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow PASSED' } }) }] });
const failEnv = (out) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: out, meta: { output: out } }) }], isError: true });

function lockedFixture(id, params) {
  return { id, intent: `do ${id}`, flow: 'appId: com.x\n---\n- launchApp\n', params, appId: 'com.x', filePath: `/x/${id}.yaml`, status: 'locked', sourceActionId: id, lockedAt: '', lockedGitSha: null, sourceContentHash: '' };
}
function baseDeps(ids, maestroByPath, loadOverride) {
  return {
    discover: () => ids,
    load: loadOverride ?? ((_root, id) => lockedFixture(id)),
    maestroRun: async (a) => maestroByPath(a.flowPath),
    getGitInfo: () => ({ sha: 's', dirty: false }),
    getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
    now: () => new Date('2026-06-18T00:00:00Z'),
    makeRunId: () => 'run-test-1',
    runReload: async () => false,
  };
}

test('all pass → verdict green, record persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(['login', 'checkout'], () => passEnv())));
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.passed, 2);
    assert.equal(loadIndex(root)[0].verdict, 'green');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selector failure (real maestro string) → red + regression', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const byPath = (fp) => (fp.includes('checkout') ? failEnv("Element not found: id='payBtn'") : passEnv());
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps(['login', 'checkout'], byPath)));
    assert.equal(res.data.verdict, 'red');
    assert.equal(res.data.results.find((r) => r.testId === 'checkout').classification, 'regression');
    assert.deepEqual(res.data.newlyFailing, ['checkout']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('param-needing locked test → skipped, not counted as failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    let maestroCalls = 0;
    const load = (_root, id) => lockedFixture(id, id === 'paid' ? ['EMAIL'] : undefined);
    const deps = baseDeps(['free', 'paid'], () => { maestroCalls++; return passEnv(); }, load);
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, deps));
    assert.equal(res.data.verdict, 'green');
    assert.equal(res.data.totals.skipped, 1);
    assert.equal(res.data.results.find((r) => r.testId === 'paid').classification, 'skipped');
    assert.equal(maestroCalls, 1, 'maestroRun called only for free, not for paid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty suite → warn, NO record written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-'));
  try {
    const res = parse(await runE2eSuiteCore({ projectRoot: root }, baseDeps([], () => passEnv())));
    assert.equal(res.ok, true);
    assert.equal(res.data.totals.total, 0);
    assert.equal(loadIndex(root).length, 0); // no false-green record
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('makeRunId is a path-safe slug', () => {
  assert.match(makeRunId(() => new Date('2026-06-18T12:34:56Z'), () => 'ab12'), /^run-[0-9TZ-]+-ab12$/);
});
