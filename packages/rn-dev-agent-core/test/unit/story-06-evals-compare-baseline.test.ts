// Story 06 Phase C (#387): the eval baseline gate. parseJunitXml reads
// mcp-server-tester's --junit-xml output (per-testcase pass/fail);
// compareToBaseline implements the spec's gating rule — regression = a
// baselined-PASS fixture that now fails or is missing; non-baselined
// fixtures never gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseJunitXml,
  compareToBaseline,
  collectResults,
  writeBaseline,
} from '../evals/compare-baseline.ts';
import type { Baseline, Verdict } from '../evals/compare-baseline.ts';

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

function tempResultsDir(): string {
  return mkdtempSync(join(tmpdir(), 'evals-compare-'));
}

const CASE = (name: string, verdict: Verdict) =>
  verdict === 'fail'
    ? `<testsuite><testcase name="${name}"><failure message="x"/></testcase></testsuite>`
    : `<testsuite><testcase name="${name}"/></testsuite>`;

test('collectResults: merges verdicts across multiple junit files', () => {
  const dir = tempResultsDir();
  try {
    writeFileSync(join(dir, 'a.junit.xml'), CASE('alpha', 'pass'));
    writeFileSync(join(dir, 'b.junit.xml'), CASE('beta', 'fail'));
    assert.deepEqual(collectResults(dir), { alpha: 'pass', beta: 'fail' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectResults: throws on duplicate fixture name across junit files', () => {
  const dir = tempResultsDir();
  try {
    // 'dup' recorded pass in one file, fail in another — silent last-write-wins
    // would mask the FAIL and turn the gate green. Must throw instead.
    writeFileSync(join(dir, 'a.junit.xml'), CASE('dup', 'pass'));
    writeFileSync(join(dir, 'b.junit.xml'), CASE('dup', 'fail'));
    assert.throws(() => collectResults(dir), /duplicate fixture name across junit files: "dup"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBaseline: refuses when a fixture failed and allowFailures is absent', () => {
  const dir = tempResultsDir();
  try {
    const path = join(dir, 'baseline.json');
    assert.throws(
      () =>
        writeBaseline({ a: 'pass', b: 'fail' } as Record<string, Verdict>, {
          model: 'm',
          allowFailures: false,
          path,
        }),
      /refusing to write baseline.*failing fixture\(s\): b/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBaseline: writes when allowFailures is passed despite a failing fixture', () => {
  const dir = tempResultsDir();
  try {
    const path = join(dir, 'baseline.json');
    writeBaseline({ a: 'pass', b: 'fail' } as Record<string, Verdict>, {
      model: 'my-model',
      allowFailures: true,
      path,
    });
    const written = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    assert.equal(written.model, 'my-model');
    assert.deepEqual(written.fixtures, { a: 'pass', b: 'fail' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBaseline: writes normally when all fixtures pass', () => {
  const dir = tempResultsDir();
  try {
    const path = join(dir, 'baseline.json');
    writeBaseline({ a: 'pass', b: 'pass' } as Record<string, Verdict>, {
      model: 'm',
      allowFailures: false,
      path,
    });
    const written = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    assert.deepEqual(written.fixtures, { a: 'pass', b: 'pass' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBaseline: records runnerVersion as testerVersion when provided', () => {
  const dir = tempResultsDir();
  try {
    const path = join(dir, 'baseline.json');
    writeBaseline({ a: 'pass' } as Record<string, Verdict>, {
      model: 'm',
      allowFailures: false,
      path,
      runnerVersion: 'claude-code/2.1.205',
    });
    const written = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    assert.equal(written.testerVersion, 'claude-code/2.1.205');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeBaseline: testerVersion defaults to "unknown" without runnerVersion', () => {
  const dir = tempResultsDir();
  try {
    const path = join(dir, 'baseline.json');
    writeBaseline({ a: 'pass' } as Record<string, Verdict>, {
      model: 'm',
      allowFailures: false,
      path,
    });
    const written = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    assert.equal(written.testerVersion, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
