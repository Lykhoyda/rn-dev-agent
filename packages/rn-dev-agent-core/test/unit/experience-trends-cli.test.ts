import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authorityRefusalSystemicKey } from '../../dist/experience/authority-refusal.js';
import { ExperienceRecorder, EXPERIENCE_STORE_NAME } from '../../dist/experience/evidence.js';
import type { ExperienceTrendReport } from '../../dist/experience/trends.js';

const CLI = fileURLToPath(new URL('../../dist/experience-trends.js', import.meta.url));
const HOST_CLI = fileURLToPath(
  new URL('../../../claude-plugin/rn-dev-agent-core/dist/experience-trends.js', import.meta.url),
);
const SINCE = '2026-06-01T00:00:00.000Z';
const NOW = new Date('2026-06-10T12:00:00.000Z');
const FUTURE = '2099-01-01T00:00:00.000Z';
const FACTS = { code: 'METRO_ORIGIN_MISMATCH', axis: 'M', cause: null } as const;

function tempDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'rn-trends-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t: TestContext) {
  const directory = tempDirectory(t);
  let time = NOW.getTime();
  const recorder = new ExperienceRecorder({
    directory,
    coreVersion: '1.0.0',
    now: () => new Date(time),
    schedule: (work) => work(),
  });
  for (const tool of ['rn_session', 'cdp_connect', 'device_find', 'rn_session', 'device_find']) {
    recorder.observe({
      tool,
      params: { platform: 'ios' },
      status: 'FAIL',
      latencyMs: 1,
      result: {
        ok: false,
        code: FACTS.code,
        error: 'origin refused',
        meta: { axis: FACTS.axis },
      },
    });
    time += 1000;
  }
  recorder.observe({
    tool: 'rn_session',
    params: {},
    status: 'FAIL',
    latencyMs: 1,
    result: { ok: false, code: 'NON_GIT_MANIFEST_REQUIRED', error: 'manifest required' },
  });
  recorder.observe({
    tool: 'custom_tool',
    params: {},
    status: 'FAIL',
    latencyMs: 1,
    result: { ok: false, code: 'FUTURE_CODE', error: 'ordinary failure' },
  });
  const path = join(directory, EXPERIENCE_STORE_NAME);
  utimesSync(path, NOW, NOW);
  return { directory, path, records: recorder.read() };
}

function runCli(directory: string, args: string[], cli = CLI) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    env: { ...process.env, RN_DEV_AGENT_EXPERIENCE_DIR: directory, RN_PROJECT_ROOT: directory },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function snapshot(directory: string, path: string) {
  return {
    bytes: readFileSync(path),
    mtimeNs: statSync(path, { bigint: true }).mtimeNs,
    files: readdirSync(directory).sort(),
  };
}

function assertNoRecoveryOrDeadEndClaim(output: string) {
  assert.doesNotMatch(
    output,
    /recovery verified|successful recoveries|no reachable exit|dead.end|unrecoverable.in.band|unresolved incident|session is (?:currently )?blocked/i,
  );
}

test('compiled CLI JSON exposes systemic evidence alongside unchanged tool rows without writing', (t) => {
  const { directory, path, records } = fixture(t);
  const before = snapshot(directory, path);
  const result = runCli(directory, ['--since', SINCE, '--json']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report: ExperienceTrendReport = JSON.parse(result.stdout);
  assert.ok(Number.isFinite(Date.parse(report.generatedAt)));
  assert.equal(report.since, SINCE);
  assert.equal(report.newSincePreviousReport.length, 5);
  assert.equal(report.recurring.length, 2);
  assert.deepEqual(report.families, [
    { classification: 'FF_METRO_ORIGIN_MISMATCH', count: 5, patterns: 3 },
    { classification: 'FF_NON_GIT_MANIFEST_REQUIRED', count: 1, patterns: 1 },
    { classification: 'UNKNOWN', count: 1, patterns: 1 },
  ]);
  for (const row of report.newSincePreviousReport) {
    const record = records.find((record) => record.signature === row.signature);
    assert.ok(record);
    assert.deepEqual(row, {
      signature: record.signature,
      classification: record.classification,
      tool: record.tool,
      count: record.count,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
    });
  }
  assert.equal(report.systemicRefusals.length, 2);
  assert.deepEqual(report.systemicRefusals[0], {
    systemicKey: authorityRefusalSystemicKey(FACTS, 'ios'),
    classification: 'FF_METRO_ORIGIN_MISMATCH',
    ...FACTS,
    platform: 'ios',
    count: 5,
    tools: ['cdp_connect', 'device_find', 'rn_session'],
    memberSignatures: records
      .filter((record) => record.authorityRefusal?.code === FACTS.code)
      .map((record) => record.signature)
      .sort(),
    firstSeen: NOW.toISOString(),
    lastSeen: '2026-06-10T12:00:04.000Z',
    recurring: true,
    recoveryEvidence: 'not-verified',
    currentAuthorityState: 'unknown',
    scope: 'retained-local-history',
    provenance: ['recorded'],
  });
  const unknown = report.systemicRefusals[1];
  assert.equal(unknown.code, 'NON_GIT_MANIFEST_REQUIRED');
  assert.equal(unknown.axis, null);
  assert.equal(unknown.cause, null);
  assert.equal(unknown.platform, null);
  assert.equal(unknown.count, 1);
  assert.equal(unknown.recurring, false);
  assert.equal(unknown.recoveryEvidence, 'not-verified');
  assert.equal(unknown.currentAuthorityState, 'unknown');
  assert.equal(unknown.scope, 'retained-local-history');
  assert.deepEqual(unknown.provenance, ['recorded']);
  assertNoRecoveryOrDeadEndClaim(result.stdout);
  assert.deepEqual(snapshot(directory, path), before);
});

for (const legacyOnly of [false, true]) {
  test(`core and the shipped host CLI agree on ${legacyOnly ? 'legacy-only' : 'mixed'} evidence without rewriting history`, (t) => {
    const { directory, path, records } = fixture(t);
    const template = records.find((record) => record.classification === 'UNKNOWN');
    assert.ok(template);
    const legacyBase = { ...template };
    delete legacyBase.authorityRefusal;
    delete legacyBase.systemicKey;
    const envelope = { ok: false, code: FACTS.code, meta: { axis: 'M', cause: 'private' } };
    const legacy = [
      {
        signature: 'legacy-direct',
        tool: 'old_direct',
        count: 3,
        symptom: JSON.stringify(envelope),
      },
      {
        signature: 'legacy-mcp',
        tool: 'old_mcp',
        count: 2,
        symptom: JSON.stringify({ content: [{ text: JSON.stringify(envelope) }] }),
      },
      {
        signature: 'legacy-prefix',
        tool: 'old_prefix',
        count: 1,
        symptom: `${FACTS.code}: refused`,
      },
      {
        signature: 'legacy-ambiguous',
        tool: 'old_ambiguous',
        count: 1,
        symptom: `nested ${FACTS.code}: refused`,
      },
      {
        signature: 'legacy-malformed',
        tool: 'old_malformed',
        count: 1,
        symptom: JSON.stringify(envelope),
        authorityRefusal: null,
      },
      {
        signature: 'legacy-truncated',
        tool: 'old_truncated',
        count: 1,
        symptom: `{"code":"${FACTS.code}","meta": [TRUNCATED]`,
      },
    ].map((fields) => ({
      ...legacyBase,
      platform: 'ios',
      firstSeen: '2026-05-01T00:00:00.000Z',
      recovery: `PASS immediately followed FAIL for ${fields.tool}`,
      recoveryCount: 1,
      lastRecoveredAt: NOW.toISOString(),
      unknownReasons: {},
      ...fields,
    }));
    const stored = [...(legacyOnly ? [] : records), ...legacy];
    writeFileSync(path, `${stored.map((record) => JSON.stringify(record)).join('\n')}\n`);
    utimesSync(path, NOW, NOW);
    const before = snapshot(directory, path);
    for (const since of [SINCE, FUTURE]) {
      let expectedJson: Omit<ExperienceTrendReport, 'generatedAt'> | undefined;
      let expectedText: string | undefined;
      for (const cli of [CLI, HOST_CLI]) {
        const json = runCli(directory, ['--since', since, '--json'], cli);
        assert.equal(json.status, 0, cli);
        assert.equal(json.stderr, '', cli);
        const { generatedAt, ...report }: ExperienceTrendReport = JSON.parse(json.stdout);
        assert.ok(Number.isFinite(Date.parse(generatedAt)));
        if (expectedJson) assert.deepEqual(report, expectedJson, cli);
        else expectedJson = report;
        const row = report.systemicRefusals[0];
        assert.equal(row.count, legacyOnly ? 6 : 11);
        assert.equal(row.code, FACTS.code);
        assert.equal(row.axis, null);
        assert.equal(row.cause, null);
        assert.deepEqual(
          row.provenance,
          legacyOnly ? ['legacy-derived'] : ['legacy-derived', 'recorded'],
        );
        assert.equal(row.firstSeen, legacy[0].firstSeen);
        assert.equal(row.recoveryEvidence, 'not-verified');
        assert.equal(row.currentAuthorityState, 'unknown');
        assert.equal(report.systemicRefusals.length, legacyOnly ? 1 : 2);
        assert.equal(
          report.systemicRefusals.some((row) => row.memberSignatures.includes('legacy-malformed')),
          false,
        );
        assert.equal(
          report.families.find((row) => row.classification === 'UNKNOWN')?.count,
          legacyOnly ? 9 : 10,
        );
        assert.equal(
          report.recurring.find((row) => row.signature === 'legacy-direct')?.classification,
          'UNKNOWN',
        );
        if (since === FUTURE || legacyOnly) assert.deepEqual(report.newSincePreviousReport, []);
        assertNoRecoveryOrDeadEndClaim(json.stdout);
        assert.deepEqual(snapshot(directory, path), before, cli);

        const text = runCli(directory, ['--since', since], cli);
        assert.equal(text.status, 0, cli);
        assert.equal(text.stderr, '', cli);
        assert.match(
          text.stdout,
          /^Report generated at [^\n]+; pass this value to --since next time\.$/m,
        );
        const normalized = text.stdout.replace(
          /^Report generated at [^;]+;/m,
          'Report generated at <timestamp>;',
        );
        if (expectedText) assert.equal(normalized, expectedText, cli);
        else expectedText = normalized;
        assert.match(text.stdout, /recovery not verified/);
        assertNoRecoveryOrDeadEndClaim(text.stdout);
        assert.deepEqual(snapshot(directory, path), before, cli);
      }
    }
    assert.deepEqual(
      JSON.parse(`[${before.bytes.toString('utf8').trim().split('\n').join(',')}]`),
      stored,
    );
  });
}

test('compiled CLI text prints occurrences, contributors, observations, unknowns, and evidence limits', (t) => {
  const { directory, path } = fixture(t);
  const before = snapshot(directory, path);
  const result = runCli(directory, ['--since', SINCE]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Families by frequency\n/);
  assert.match(result.stdout, /New since previous report\n/);
  assert.match(result.stdout, /Recurring\n/);
  assert.match(
    result.stdout,
    /Systemic, family, and recurring totals cover retained local history, not exact time-window counts\./,
  );
  assert.match(result.stdout, /--since affects only new-pattern selection\./);
  const section = result.stdout.split(
    '\nSystemic authority refusals (retained local history)\n',
  )[1];
  assert.ok(section);
  assert.match(
    section,
    /Current authority state: unknown; historical observations do not establish a currently blocked session\./,
  );
  assert.match(section, /METRO_ORIGIN_MISMATCH \| axis: M \| cause: unknown \| platform: ios/);
  assert.match(
    section,
    /5 occurrence\(s\) \| tools: cdp_connect, device_find, rn_session \| recurring: yes \| recovery not verified/,
  );
  assert.match(
    section,
    /first seen: 2026-06-10T12:00:00\.000Z \| last seen: 2026-06-10T12:00:04\.000Z/,
  );
  assert.match(
    section,
    /NON_GIT_MANIFEST_REQUIRED \| axis: unknown \| cause: unknown \| platform: unknown/,
  );
  assert.match(
    section,
    /1 occurrence\(s\) \| tools: rn_session \| recurring: no \| recovery not verified/,
  );
  assert.doesNotMatch(section, /[a-f0-9]{64}/);
  assertNoRecoveryOrDeadEndClaim(result.stdout);
  assert.deepEqual(snapshot(directory, path), before);
});

test('compiled CLI future since leaves retained systemic, family, and recurring totals unchanged', (t) => {
  const { directory, path } = fixture(t);
  const before = snapshot(directory, path);
  const previous = runCli(directory, ['--since', SINCE, '--json']);
  const result = runCli(directory, ['--json', '--since', FUTURE]);
  assert.equal(previous.status, 0);
  assert.equal(result.status, 0);
  assert.equal(previous.stderr, '');
  assert.equal(result.stderr, '');
  const report: ExperienceTrendReport = JSON.parse(previous.stdout);
  const future: ExperienceTrendReport = JSON.parse(result.stdout);
  assert.equal(future.since, FUTURE);
  assert.deepEqual(future.newSincePreviousReport, []);
  assert.deepEqual(future.systemicRefusals, report.systemicRefusals);
  assert.deepEqual(future.families, report.families);
  assert.deepEqual(future.recurring, report.recurring);
  const text = runCli(directory, ['--since', FUTURE]);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /New since previous report\n  none\n/);
  assert.match(text.stdout, /5 occurrence\(s\) \| tools: cdp_connect, device_find, rn_session/);
  assertNoRecoveryOrDeadEndClaim(text.stdout);
  assert.deepEqual(snapshot(directory, path), before);
});

test('compiled CLI reads a missing store as empty without creating it', (t) => {
  const directory = tempDirectory(t);
  for (const json of [true, false]) {
    const result = runCli(directory, ['--since', SINCE, ...(json ? ['--json'] : [])]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    if (json) {
      const report: ExperienceTrendReport = JSON.parse(result.stdout);
      assert.deepEqual(report.families, []);
      assert.deepEqual(report.newSincePreviousReport, []);
      assert.deepEqual(report.recurring, []);
      assert.deepEqual(report.systemicRefusals, []);
    } else {
      assert.match(
        result.stdout,
        /Systemic authority refusals \(retained local history\)\n[^\n]+\n  none\n/,
      );
    }
  }
  assert.equal(existsSync(join(directory, EXPERIENCE_STORE_NAME)), false);
  assert.deepEqual(readdirSync(directory), []);
});

test('compiled CLI usage explains retained scope and since selection without reading or writing', (t) => {
  const { directory, path } = fixture(t);
  const before = snapshot(directory, path);
  for (const args of [['--help'], ['--since', 'not-a-date']]) {
    const result = runCli(directory, args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage: rn-experience-trends/);
    assert.match(result.stderr, /--since affects only new-pattern selection\./);
    assert.match(
      result.stderr,
      /Systemic, family, and recurring totals cover retained local history, not exact time-window counts\./,
    );
    assert.match(result.stderr, /Current authority state is unknown/);
    assert.match(result.stderr, /RN_DEV_AGENT_EXPERIENCE_DIR/);
    assertNoRecoveryOrDeadEndClaim(result.stderr);
  }
  assert.deepEqual(snapshot(directory, path), before);
});
