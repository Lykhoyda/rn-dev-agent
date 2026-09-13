import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AUTHORITY_REFUSAL_CODES,
  MAX_AUTHORITY_ENVELOPE_BYTES,
  authorityRefusalSystemicKey,
} from '../../dist/experience/authority-refusal.js';
import {
  ExperienceRecorder,
  REDACTION_RULES_VERSION,
  pruneExperienceRecords,
  type ExperienceRecord,
} from '../../dist/experience/evidence.js';
import {
  buildExperienceTrendReport,
  type ExperienceTrendReport,
} from '../../dist/experience/trends.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');
const SINCE = new Date('2026-06-01T00:00:00.000Z');
const FACTS = { code: 'METRO_ORIGIN_MISMATCH', axis: 'M', cause: null } as const;

function recordFixture(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    signature: 'a',
    candidate: { pluginVersion: '1.0.0', coreVersion: '1.0.0' },
    environment: { os: 'darwin', node: 'v24' },
    platform: 'ios',
    device: null,
    runtime: null,
    phase: 'tool',
    trigger: 'FAIL reported by rn_session',
    maskingCondition: null,
    symptom: 'refusal observed',
    recovery: null,
    cleanup: null,
    classification: 'FF_METRO_ORIGIN_MISMATCH',
    evidencePointers: ['event:1'],
    tool: 'rn_session',
    status: 'FAIL',
    normalizedSymptomShape: 'refusal observed',
    count: 1,
    recoveryCount: 0,
    firstSeen: SINCE.toISOString(),
    lastSeen: NOW.toISOString(),
    lastRecoveredAt: null,
    unknownReasons: { recovery: 'recovery not verified' },
    redactionVersion: REDACTION_RULES_VERSION,
    authorityRefusal: FACTS,
    systemicKey: authorityRefusalSystemicKey(FACTS, 'ios'),
    ...overrides,
  };
}

function oldCollections(report: ExperienceTrendReport) {
  return {
    families: report.families,
    newSincePreviousReport: report.newSincePreviousReport,
    recurring: report.recurring,
  };
}

function legacyFixture(overrides: Partial<ExperienceRecord> = {}): ExperienceRecord {
  const record = recordFixture({ classification: 'UNKNOWN', ...overrides });
  delete record.authorityRefusal;
  delete record.systemicKey;
  return record;
}

const contentEnvelope = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

for (const scenario of [
  {
    name: 'three merged tool patterns',
    tools: ['tool_c', 'tool_a', 'tool_c', 'tool_b', 'tool_a'],
    symptoms: Array<string>(5).fill('refusal observed'),
    patterns: 3,
    recurringPatterns: 2,
  },
  {
    name: 'five one-count tools',
    tools: ['tool_e', 'tool_a', 'tool_d', 'tool_b', 'tool_c'],
    symptoms: Array<string>(5).fill('refusal observed'),
    patterns: 5,
    recurringPatterns: 0,
  },
  {
    name: 'five one-count patterns across three tools',
    tools: ['tool_c', 'tool_a', 'tool_c', 'tool_b', 'tool_a'],
    symptoms: [
      'first refusal',
      'second refusal',
      'third refusal',
      'fourth refusal',
      'fifth refusal',
    ],
    patterns: 5,
    recurringPatterns: 0,
  },
]) {
  test(`five observations aggregate from ${scenario.name} without changing tool rows`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'rn-systemic-trends-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let time = NOW.getTime();
    const recorder = new ExperienceRecorder({
      directory,
      coreVersion: '1.0.0',
      now: () => new Date(time),
      schedule: (work) => work(),
    });
    for (const [index, tool] of scenario.tools.entries()) {
      recorder.observe({
        tool,
        params: { platform: 'ios' },
        status: 'FAIL',
        latencyMs: 1,
        result: {
          ok: false,
          code: FACTS.code,
          error: scenario.symptoms[index],
          meta: { axis: FACTS.axis },
        },
      });
      time += 1000;
    }
    const records = recorder.read();
    assert.equal(records.length, scenario.patterns);
    const before = structuredClone(records);
    const report = buildExperienceTrendReport(records, SINCE, NOW);
    assert.equal(report.newSincePreviousReport.length, scenario.patterns);
    assert.equal(report.recurring.length, scenario.recurringPatterns);
    assert.deepEqual(report.families, [
      { classification: 'FF_METRO_ORIGIN_MISMATCH', count: 5, patterns: scenario.patterns },
    ]);
    assert.deepEqual(report.systemicRefusals, [
      {
        systemicKey: authorityRefusalSystemicKey(FACTS, 'ios'),
        classification: 'FF_METRO_ORIGIN_MISMATCH',
        ...FACTS,
        platform: 'ios',
        count: 5,
        tools: [...new Set(scenario.tools)].sort(),
        memberSignatures: records.map((record) => record.signature).sort(),
        firstSeen: NOW.toISOString(),
        lastSeen: new Date(NOW.getTime() + 4000).toISOString(),
        recurring: true,
        recoveryEvidence: 'not-verified',
        currentAuthorityState: 'unknown',
        scope: 'retained-local-history',
        provenance: ['recorded'],
      },
    ]);
    const withoutExtensions = records.map((record) => ({
      ...record,
      authorityRefusal: undefined,
      systemicKey: undefined,
    }));
    assert.deepEqual(
      oldCollections(report),
      oldCollections(buildExperienceTrendReport(withoutExtensions, SINCE, NOW)),
    );
    assert.deepEqual(buildExperienceTrendReport(records, SINCE, NOW), report);
    assert.deepEqual(records, before);
  });
}

test('all recognized codes remain separate even under a shared stored classification', () => {
  const records = AUTHORITY_REFUSAL_CODES.map((code) =>
    recordFixture({
      signature: code,
      classification: 'UNKNOWN',
      authorityRefusal: { ...FACTS, code },
    }),
  );
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  assert.deepEqual(report.families, [{ classification: 'UNKNOWN', count: 6, patterns: 6 }]);
  assert.equal(report.systemicRefusals.length, 6);
  assert.deepEqual(
    report.systemicRefusals.map((row) => row.code).sort(),
    [...AUTHORITY_REFUSAL_CODES].sort(),
  );
  for (const row of report.systemicRefusals) {
    assert.equal(row.classification, `FF_${row.code}`);
    assert.equal(row.count, 1);
    assert.equal(row.recurring, false);
  }
});

test('each observed axis and unknown axis retain their own systemic bucket', () => {
  const axes = ['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R', 'P', null] as const;
  const records = axes.map((axis) =>
    recordFixture({ signature: String(axis), authorityRefusal: { ...FACTS, axis } }),
  );
  const rows = buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals;
  assert.equal(rows.length, axes.length);
  assert.equal(new Set(rows.map((row) => row.systemicKey)).size, axes.length);
  for (const axis of axes) assert.equal(rows.find((row) => row.axis === axis)?.count, 1);
});

test('known platforms, unknown platform, and the literal unknown string do not join', () => {
  const platforms = ['ios', 'android', null, 'unknown'];
  const records = platforms.map((platform) =>
    recordFixture({ signature: String(platform), platform }),
  );
  const rows = buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals;
  assert.equal(rows.length, platforms.length);
  for (const platform of platforms) {
    const row = rows.find((row) => row.platform === platform);
    assert.ok(row);
    assert.equal(row.count, 1);
    assert.equal(row.systemicKey, authorityRefusalSystemicKey(FACTS, platform));
  }
});

test('persisted axis and cause values are revalidated with an explicit unknown cause key slot', () => {
  const records: ExperienceRecord[] = [];
  for (const axis of [undefined, null, '', 'm', 'Metro', 1, {}, ['M']]) {
    for (const cause of [
      undefined,
      null,
      'private remedy',
      'managed-metro-stop-proof-missing',
      {},
      ['cause'],
    ]) {
      records.push(
        JSON.parse(
          JSON.stringify({
            ...recordFixture({ signature: String(records.length) }),
            authorityRefusal: { code: FACTS.code, axis, cause },
          }),
        ),
      );
    }
  }
  const rows = buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, records.length);
  assert.equal(rows[0].axis, null);
  assert.equal(rows[0].cause, null);
  assert.equal(
    rows[0].systemicKey,
    createHash('sha256')
      .update(JSON.stringify(['rn-dev-agent/authority-refusal/1', FACTS.code, null, null, 'ios']))
      .digest('hex'),
  );
  assert.doesNotMatch(JSON.stringify(rows), /private remedy|managed-metro-stop-proof-missing/);
});

test('malformed extensions cannot fall back to legacy symptoms, family, or a stored key', () => {
  const extensions: unknown[] = [
    null,
    false,
    42,
    FACTS.code,
    [],
    [FACTS],
    {},
    { code: 'FUTURE_CODE' },
    { code: null },
    { code: [FACTS.code] },
    { meta: FACTS },
  ];
  const records: ExperienceRecord[] = extensions.map((authorityRefusal, index) =>
    JSON.parse(
      JSON.stringify({
        ...recordFixture({
          signature: String(index),
          symptom: `${FACTS.code}: refusal observed`,
        }),
        authorityRefusal,
      }),
    ),
  );
  records.push(recordFixture({ authorityRefusal: undefined, symptom: `${FACTS.code}: refused` }));
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  assert.deepEqual(report.systemicRefusals, []);
  assert.deepEqual(report.families, [
    {
      classification: 'FF_METRO_ORIGIN_MISMATCH',
      count: records.length,
      patterns: records.length,
    },
  ]);
  assert.equal(report.newSincePreviousReport.length, records.length);
});

for (const code of AUTHORITY_REFUSAL_CODES) {
  test(`legacy ${code} joins through direct JSON, first MCP content, and anchored prefixes`, () => {
    const envelope = { ok: false, code, error: 'refused', meta: { axis: 'M', cause: 'private' } };
    for (const [index, symptom] of [
      JSON.stringify(envelope),
      JSON.stringify(contentEnvelope(envelope)),
      `${code}: refusal observed`,
      `${code}: refusal observed [TRUNCATED]`,
    ].entries()) {
      const record = legacyFixture({ symptom, status: index % 2 ? 'ERROR' : 'FAIL', count: 3 });
      const before = structuredClone(record);
      const report = buildExperienceTrendReport([record], SINCE, NOW);
      const facts = { code, axis: index < 2 ? ('M' as const) : null, cause: null };
      assert.deepEqual(report.systemicRefusals, [
        {
          systemicKey: authorityRefusalSystemicKey(facts, 'ios'),
          classification: `FF_${code}`,
          ...facts,
          platform: 'ios',
          count: 3,
          tools: [record.tool],
          memberSignatures: [record.signature],
          firstSeen: record.firstSeen,
          lastSeen: record.lastSeen,
          recurring: true,
          recoveryEvidence: 'not-verified',
          currentAuthorityState: 'unknown',
          scope: 'retained-local-history',
          provenance: ['legacy-derived'],
        },
      ]);
      assert.deepEqual(record, before);
      assert.deepEqual(report.families, [{ classification: 'UNKNOWN', count: 3, patterns: 1 }]);
    }
  });
}

test('legacy membership rejects ambiguous, incomplete, nested, and conflicting evidence', () => {
  const code = FACTS.code;
  const symptoms: unknown[] = [
    undefined,
    null,
    42,
    {},
    [],
    '',
    'ordinary failure',
    code,
    `${code.toLowerCase()}: refused`,
    `${code}_EXTRA: refused`,
    `Error: ${code}: refused`,
    ` ${code}: refused`,
    `nested ${code}: refused`,
    `stack\n    at ${code}: refused`,
    `FUTURE_CODE: ${code}: refused`,
    `{"code":"${code}","meta": [TRUNCATED]`,
    JSON.stringify([{ code }]),
    JSON.stringify(code),
    'null',
    '42',
    JSON.stringify({ error: `${code}: refused`, meta: { code } }),
    JSON.stringify(contentEnvelope(contentEnvelope({ code }))),
    JSON.stringify({ content: [{ text: '{}' }, { text: JSON.stringify({ code }) }] }),
    JSON.stringify({ content: [{ text: '{truncated' }, { text: JSON.stringify({ code }) }] }),
    JSON.stringify({ content: [{ text: `${code}: refused` }] }),
    JSON.stringify(contentEnvelope([{ code }])),
    JSON.stringify(contentEnvelope(`{"code":"${code}"`)),
  ];
  for (const unknown of ['FUTURE_CODE', '', null, 42, {}, [code]]) {
    symptoms.push(
      JSON.stringify({ code: unknown, ...contentEnvelope({ code }) }),
      JSON.stringify(contentEnvelope({ code: unknown, error: `${code}: refused` })),
    );
  }
  const records: ExperienceRecord[] = symptoms.map((symptom, index) =>
    JSON.parse(
      JSON.stringify({
        ...legacyFixture({ signature: String(index), classification: `FF_${code}`, tool: code }),
        symptom,
        systemicKey: authorityRefusalSystemicKey(FACTS, 'ios'),
      }),
    ),
  );
  const before = structuredClone(records);
  assert.deepEqual(buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals, []);
  assert.deepEqual(records, before);
});

test('legacy JSON and prefixes are bounded by UTF-8 bytes before parsing', () => {
  const code = FACTS.code;
  const base = JSON.stringify({ code, padding: '' });
  const exact = JSON.stringify({
    code,
    padding: ' '.repeat(MAX_AUTHORITY_ENVELOPE_BYTES - Buffer.byteLength(base)),
  });
  const prefix = `${code}:`.padEnd(MAX_AUTHORITY_ENVELOPE_BYTES, ' ');
  for (const symptom of [exact, prefix]) {
    assert.equal(Buffer.byteLength(symptom), 16 * 1024);
    assert.equal(
      buildExperienceTrendReport([legacyFixture({ symptom })], SINCE, NOW).systemicRefusals.length,
      1,
    );
  }
  for (const symptom of [
    exact + ' ',
    prefix + ' ',
    JSON.stringify({ code, padding: '\u00e9'.repeat(9000) }),
  ]) {
    assert.deepEqual(
      buildExperienceTrendReport([legacyFixture({ symptom })], SINCE, NOW).systemicRefusals,
      [],
    );
  }
});

test('legacy precedence admits only observed allowlisted metadata and the record platform', () => {
  const envelope = {
    code: FACTS.code,
    error: 'SESSION_AUTHORITY_REQUIRED: redbox',
    meta: { axis: 'M', cause: 'managed-metro-stop-proof-missing', platform: 'android' },
    ...contentEnvelope({ code: 'SESSION_AUTHORITY_REQUIRED', meta: { axis: 'S' } }),
  };
  const records = [
    legacyFixture({ signature: 'direct', symptom: JSON.stringify(envelope) }),
    legacyFixture({ signature: 'mcp', symptom: JSON.stringify(contentEnvelope(envelope)) }),
  ];
  const row = buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals[0];
  assert.equal(row.code, FACTS.code);
  assert.equal(row.axis, 'M');
  assert.equal(row.cause, null);
  assert.equal(row.platform, 'ios');
  assert.equal(row.count, 2);
  for (const meta of [undefined, null, [], { axis: 'm' }, { axis: ['M'] }]) {
    const record = legacyFixture({
      platform: null,
      symptom: JSON.stringify({
        code: FACTS.code,
        meta,
        details: { axis: 'M', cause: 'private' },
        platform: 'ios',
      }),
    });
    const rows = buildExperienceTrendReport([record], SINCE, NOW).systemicRefusals;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].axis, null);
    assert.equal(rows[0].cause, null);
    assert.equal(rows[0].platform, null);
  }
});

test('mixed provenance aggregates once without promoting historical recoveries or changing old projections', () => {
  const records = [
    recordFixture({
      signature: 'recorded',
      count: 2,
      symptom: 'SESSION_AUTHORITY_REQUIRED: conflict',
    }),
    legacyFixture({
      signature: 'legacy',
      tool: 'old_tool',
      count: 3,
      symptom: JSON.stringify({ code: FACTS.code, meta: { axis: 'M' } }),
      firstSeen: '2026-05-01T00:00:00.000Z',
      recovery: 'PASS immediately followed FAIL for old_tool',
      recoveryCount: 2,
      lastRecoveredAt: NOW.toISOString(),
      unknownReasons: {},
    }),
    legacyFixture({ signature: 'unknown-axis', symptom: `${FACTS.code}: refused` }),
    legacyFixture({
      signature: 'unknown-platform',
      platform: null,
      symptom: JSON.stringify({ code: FACTS.code, meta: { axis: 'M' } }),
    }),
  ];
  const before = structuredClone(records);
  for (const record of records) Object.freeze(record);
  Object.freeze(records);
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  assert.equal(report.systemicRefusals.length, 3);
  const row = report.systemicRefusals[0];
  assert.equal(row.count, 5);
  assert.deepEqual(row.tools, ['old_tool', 'rn_session']);
  assert.deepEqual(row.memberSignatures, ['legacy', 'recorded']);
  assert.deepEqual(row.provenance, ['legacy-derived', 'recorded']);
  assert.equal(row.firstSeen, records[1].firstSeen);
  assert.equal(row.recoveryEvidence, 'not-verified');
  assert.equal(row.currentAuthorityState, 'unknown');
  const withoutEligibleEvidence = records.map((record) => ({
    ...record,
    authorityRefusal: undefined,
    symptom: 'ordinary failure',
  }));
  assert.deepEqual(
    oldCollections(report),
    oldCollections(buildExperienceTrendReport(withoutEligibleEvidence, SINCE, NOW)),
  );
  assert.deepEqual(report.families, [
    { classification: 'UNKNOWN', count: 5, patterns: 3 },
    { classification: 'FF_METRO_ORIGIN_MISMATCH', count: 2, patterns: 1 },
  ]);
  assert.equal(
    report.recurring.find((row) => row.signature === 'legacy')?.classification,
    'UNKNOWN',
  );
  for (const input of [
    records,
    [...records].reverse(),
    [records[2], records[0], records[3], records[1]],
  ]) {
    assert.deepEqual(buildExperienceTrendReport(input, SINCE, NOW), report);
  }
  assert.deepEqual(records, before);
});

test('tampered, missing, and shared stored keys cannot split or merge validated groups', () => {
  const records = [
    recordFixture({ signature: 'a', systemicKey: 'tampered-key' }),
    recordFixture({ signature: 'b', systemicKey: undefined }),
    recordFixture({ signature: 'c', systemicKey: 'tampered-key', platform: 'android' }),
  ];
  const rows = buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].count, 2);
  assert.deepEqual(rows[0].memberSignatures, ['a', 'b']);
  assert.equal(rows[0].systemicKey, authorityRefusalSystemicKey(FACTS, 'ios'));
  assert.equal(rows[1].systemicKey, authorityRefusalSystemicKey(FACTS, 'android'));
  assert.doesNotMatch(JSON.stringify(rows), /tampered-key/);
});

test('shuffled inputs and count ties produce deterministic rows and sorted member unions', () => {
  const records = [
    recordFixture({ signature: 'z', tool: 'tool_z', count: 3 }),
    recordFixture({ signature: 'a', tool: 'tool_a', count: 2 }),
    recordFixture({ signature: 'z', tool: 'tool_z' }),
    recordFixture({ signature: 'android', platform: 'android', count: 2 }),
    recordFixture({ signature: 'unknown', platform: null, count: 2 }),
  ];
  const before = structuredClone(records);
  for (const record of records) Object.freeze(record);
  Object.freeze(records);
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  for (const permutation of [
    [...records].reverse(),
    [records[2], records[4], records[0], records[3], records[1]],
  ])
    assert.deepEqual(buildExperienceTrendReport(permutation, SINCE, NOW), report);
  const rows = report.systemicRefusals;
  assert.deepEqual(
    rows.map((row) => row.count),
    [6, 2, 2],
  );
  assert.deepEqual(rows[0].tools, ['tool_a', 'tool_z']);
  assert.deepEqual(rows[0].memberSignatures, ['a', 'z']);
  assert.deepEqual(rows[0].provenance, ['recorded']);
  assert.ok(rows[1].systemicKey < rows[2].systemicKey);
  assert.deepEqual(records, before);
});

test('first and last observations are chronological even with timestamp offsets', () => {
  const records = [
    recordFixture({
      signature: 'a',
      firstSeen: '2026-06-10T01:00:00+02:00',
      lastSeen: '2026-06-10T00:30:00-02:00',
    }),
    recordFixture({
      signature: 'b',
      firstSeen: '2026-06-09T23:30:00.000Z',
      lastSeen: '2026-06-10T02:00:00.000Z',
    }),
  ];
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  assert.equal(report.systemicRefusals[0].firstSeen, records[0].firstSeen);
  assert.equal(report.systemicRefusals[0].lastSeen, records[0].lastSeen);
  assert.deepEqual(buildExperienceTrendReport([...records].reverse(), SINCE, NOW), report);
});

test('empty history has all four empty collections', () => {
  assert.deepEqual(buildExperienceTrendReport([], SINCE, NOW), {
    generatedAt: NOW.toISOString(),
    since: SINCE.toISOString(),
    families: [],
    newSincePreviousReport: [],
    recurring: [],
    systemicRefusals: [],
  });
});

test('a future since changes only new-pattern selection, not retained occurrence totals', () => {
  const records = [
    recordFixture({ count: 4 }),
    recordFixture({ signature: 'b', tool: 'other_tool' }),
  ];
  const report = buildExperienceTrendReport(records, SINCE, NOW);
  const future = buildExperienceTrendReport(records, new Date('2099-01-01T00:00:00.000Z'), NOW);
  assert.deepEqual(future.newSincePreviousReport, []);
  assert.deepEqual(future.systemicRefusals, report.systemicRefusals);
  assert.deepEqual(future.families, report.families);
  assert.deepEqual(future.recurring, report.recurring);
  assert.equal(future.systemicRefusals[0].count, 5);
});

test('retention-pruned totals include only retained records and reporting does not prune again', () => {
  const records = [
    recordFixture({ signature: 'expired', count: 100, lastSeen: '2026-05-01T00:00:00.000Z' }),
    recordFixture({ signature: 'capped', count: 50, lastSeen: '2026-06-01T00:00:00.000Z' }),
    recordFixture({ signature: 'kept_a', tool: 'tool_a', count: 2 }),
    recordFixture({ signature: 'kept_b', tool: 'tool_b', count: 3 }),
  ];
  const retained = pruneExperienceRecords(records, NOW, 2);
  const report = buildExperienceTrendReport(retained, SINCE, new Date('2099-01-01T00:00:00.000Z'));
  assert.equal(report.systemicRefusals[0].count, 5);
  assert.deepEqual(report.systemicRefusals[0].memberSignatures, ['kept_a', 'kept_b']);
  assert.deepEqual(report.systemicRefusals[0].tools, ['tool_a', 'tool_b']);
  assert.equal(report.families[0].count, 5);
  assert.equal(buildExperienceTrendReport(records, SINCE, NOW).systemicRefusals[0].count, 155);
});
