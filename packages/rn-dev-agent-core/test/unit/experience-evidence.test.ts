import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  ExperienceRecorder,
  EXPERIENCE_FAMILY_IDS,
  EXPERIENCE_STORE_NAME,
  MAX_SYMPTOM_LENGTH,
  REDACTION_RULES_VERSION,
  classifyExperience,
  experienceSignature,
  normalizeSymptomShape,
  pruneExperienceRecords,
  sanitizeForEvidence,
  type ExperienceRecord,
} from '../../dist/experience/evidence.js';
import {
  buildExperienceTrendReport,
  readExperienceTrendReport,
} from '../../dist/experience/trends.js';
import { addToolObserver, instrumentTool } from '../../dist/observability/instrumentation.js';

const NOW = new Date('2026-06-10T12:00:00.000Z');

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'rn-experience-test-'));
}

function synchronousRecorder(
  directory: string,
  overrides: Partial<ConstructorParameters<typeof ExperienceRecorder>[0]> = {},
) {
  return new ExperienceRecorder({
    directory,
    coreVersion: '0.70.3',
    pluginVersion: '0.75.3',
    now: () => NOW,
    schedule: (work) => work(),
    ...overrides,
  });
}

function fail(tool: string, error: string, params: Record<string, unknown> = {}) {
  return { tool, params, status: 'FAIL' as const, latencyMs: 12, error };
}

function recordFixture(overrides: Partial<ExperienceRecord>): ExperienceRecord {
  return {
    signature: 'a',
    candidate: { pluginVersion: '1.0.0', coreVersion: '1.0.0' },
    environment: { os: 'darwin', node: 'v24' },
    platform: 'ios',
    device: null,
    runtime: null,
    phase: 'tool',
    trigger: 'FAIL reported by cdp_status',
    maskingCondition: null,
    symptom: 'failure',
    recovery: null,
    cleanup: null,
    classification: 'UNKNOWN',
    evidencePointers: ['event:1'],
    tool: 'cdp_status',
    status: 'FAIL',
    normalizedSymptomShape: 'failure',
    count: 1,
    recoveryCount: 0,
    firstSeen: '2026-06-01T00:00:00.000Z',
    lastSeen: '2026-06-01T00:00:00.000Z',
    lastRecoveredAt: null,
    unknownReasons: {},
    redactionVersion: REDACTION_RULES_VERSION,
    ...overrides,
  };
}

test('a meaningful failure writes exactly one fully sanitized structured record', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
  recorder.observe(
    fail(
      'cdp_status',
      `WebSocket close 1006 for ${secret} user@example.com at 192.168.1.20 and 8.8.8.8, localhost:8081, https://example.test:9090/path, ${homedir()}/private/project.ts, /Users/private/project/very-long-file.ts, com.example.privateapp`,
      { platform: 'ios', deviceId: 'PRIVATE-UDID', runtime: 'Hermes', port: 8081 },
    ),
  );

  const records = recorder.read();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.classification, 'FF_STALE_CDP');
  assert.equal(record.platform, 'ios');
  assert.equal(record.device, 'identified-device');
  assert.equal(record.runtime, 'Hermes');
  assert.equal(record.maskingCondition, null);
  assert.match(record.unknownReasons.maskingCondition, /not derivable/);

  const serialized = readFileSync(join(directory, EXPERIENCE_STORE_NAME), 'utf8');
  for (const privateValue of [
    secret,
    'user@example.com',
    '192.168.1.20',
    '8.8.8.8',
    'localhost:8081',
    `${homedir()}/private/project.ts`,
    '~/private/project.ts',
    '/Users/private/project/very-long-file.ts',
    'com.example.privateapp',
    'PRIVATE-UDID',
  ]) {
    assert.doesNotMatch(
      serialized,
      new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
  assert.doesNotMatch(record.symptom, /8081|9090/);
  assert.doesNotMatch(record.normalizedSymptomShape, /8081|9090/);
  assert.match(serialized, /REDACTED/);
});

test('a bare app display name and slug from app.json are redacted', (t) => {
  const projectRoot = tempDirectory();
  writeFileSync(
    join(projectRoot, 'app.json'),
    JSON.stringify({ expo: { name: 'AcmeBanking', slug: 'acme-banking-private' } }),
  );
  const previousRoot = process.env.RN_PROJECT_ROOT;
  process.env.RN_PROJECT_ROOT = projectRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.RN_PROJECT_ROOT;
    else process.env.RN_PROJECT_ROOT = previousRoot;
  });

  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('launchApp', 'Failed to launch AcmeBanking (acme-banking-private)'));

  const serialized = readFileSync(join(directory, EXPERIENCE_STORE_NAME), 'utf8');
  assert.doesNotMatch(serialized, /AcmeBanking|acme-banking-private/);
  assert.match(serialized, /\[APP_NAME_REDACTED\]/);
  assert.match(serialized, /\[APP_SLUG_REDACTED\]/);
});

test('a malformed app.json fails closed instead of shipping raw symptoms', (t) => {
  const projectRoot = tempDirectory();
  writeFileSync(join(projectRoot, 'app.json'), '{ not valid json');
  const previousRoot = process.env.RN_PROJECT_ROOT;
  process.env.RN_PROJECT_ROOT = projectRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.RN_PROJECT_ROOT;
    else process.env.RN_PROJECT_ROOT = previousRoot;
  });

  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('launchApp', 'Failed to launch AcmeBanking'));

  const serialized = readFileSync(join(directory, EXPERIENCE_STORE_NAME), 'utf8');
  assert.doesNotMatch(serialized, /AcmeBanking/);
  assert.deepEqual(recorder.read(), []);
});

test('a payload-heavy symptom is bounded before it reaches the store', { timeout: 10_000 }, () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('device_snapshot', `hierarchy ${'x'.repeat(200_000)}`));

  const record = recorder.read()[0];
  assert.ok(record.symptom.length <= MAX_SYMPTOM_LENGTH + '[TRUNCATED]'.length);
  assert.match(record.symptom, /\[TRUNCATED\]$/);
  assert.ok(readFileSync(join(directory, EXPERIENCE_STORE_NAME), 'utf8').length < 10_000);
});

test('a corrupt store line is dropped instead of disabling recording forever', () => {
  const directory = tempDirectory();
  const path = join(directory, EXPERIENCE_STORE_NAME);
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"signature":"truncated`);

  recorder.observe(fail('device_find', 'unrecognized failure', { platform: 'android' }));

  const records = recorder.read();
  assert.equal(records.length, 2);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /truncated/);
});

test('a record stored under older redaction rules is re-sanitized before rewrite', (t) => {
  const projectRoot = tempDirectory();
  writeFileSync(
    join(projectRoot, 'app.json'),
    JSON.stringify({ expo: { name: 'AcmeBanking', slug: 'acme-banking-private' } }),
  );
  const previousRoot = process.env.RN_PROJECT_ROOT;
  process.env.RN_PROJECT_ROOT = projectRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.RN_PROJECT_ROOT;
    else process.env.RN_PROJECT_ROOT = previousRoot;
  });

  const directory = tempDirectory();
  const path = join(directory, EXPERIENCE_STORE_NAME);
  const legacy = recordFixture({
    signature: 'legacy',
    symptom: 'Failed to launch AcmeBanking for owner@example.com',
    lastSeen: '2026-06-09T00:00:00.000Z',
    redactionVersion: REDACTION_RULES_VERSION - 1,
  });
  writeFileSync(path, `${JSON.stringify(legacy)}\n`);

  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('device_find', 'unrecognized failure', { platform: 'android' }));

  const stored = recorder.read().find((record) => record.signature === 'legacy');
  assert.ok(stored);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /AcmeBanking|owner@example\.com/);
  assert.match(stored.symptom, /\[APP_NAME_REDACTED\]/);
  assert.equal(stored.redactionVersion, REDACTION_RULES_VERSION);
});

test('a later event fills a previously unknown device without losing the record', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));
  recorder.observe(
    fail('cdp_status', 'WebSocket close 1006', {
      platform: 'ios',
      deviceName: 'iPhone 17',
      runtime: 'Hermes',
    }),
  );

  const records = recorder.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
  assert.equal(records[0].device, 'iPhone 17');
  assert.equal(records[0].runtime, 'Hermes');
  assert.equal(records[0].unknownReasons.device, undefined);
  assert.equal(records[0].unknownReasons.runtime, undefined);
});

test('an ERROR occurrence is not downgraded by a later FAIL with the same shape', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe({
    tool: 'cdp_status',
    params: { platform: 'ios' },
    status: 'ERROR',
    latencyMs: 3,
    error: 'WebSocket close 1006',
  });
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));

  const records = recorder.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'ERROR');
  assert.match(records[0].trigger, /^ERROR reported by/);
});

test('a thrown-tool ERROR writes one meaningful record', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe({
    tool: 'device_find',
    params: {},
    status: 'ERROR',
    latencyMs: 4,
    error: 'unexpected device transport error',
  });

  const records = recorder.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'ERROR');
  assert.equal(records[0].classification, 'UNKNOWN');
});

test('redaction failures fail closed with a placeholder, never raw content', () => {
  const raw = { symptom: 'token-super-secret-private-value', nested: ['private@example.com'] };
  const sanitized = sanitizeForEvidence(raw, () => {
    throw new Error('redactor unavailable');
  });
  assert.deepEqual(sanitized, { symptom: '[REDACTION_FAILED]', nested: ['[REDACTION_FAILED]'] });
  assert.doesNotMatch(JSON.stringify(sanitized), /super-secret|private@example/);
});

test('classification only emits ids that exist in real seed-experience YAML', () => {
  const seedRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'seed-experience',
  );
  const ids = new Set<string>();
  for (const file of [
    'common-failures.yaml',
    'expo-gotchas.yaml',
    'platform-quirks.yaml',
    'recovery-playbook.yaml',
  ]) {
    const value = parse(readFileSync(join(seedRoot, file), 'utf8')) as Record<string, unknown>;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) for (const item of node) visit(item);
      else if (node && typeof node === 'object') {
        const object = node as Record<string, unknown>;
        if (typeof object.id === 'string') ids.add(object.id);
        for (const nested of Object.values(object)) visit(nested);
      }
    };
    visit(value);
  }

  const classification = classifyExperience(
    'UNAVAILABLE: io exception in AndroidDriver gRPC',
    'maestro_run',
    'android',
  );
  assert.equal(classification, 'FF_MAESTRO_GRPC_ANDROID');
  assert.deepEqual(
    EXPERIENCE_FAMILY_IDS.filter((id) => !ids.has(id)),
    [],
  );
  assert.equal(classifyExperience('unrecognized private failure', 'custom_tool', null), 'UNKNOWN');
});

test('FAIL then immediate PASS on the same tool updates the failure as a recovery', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));
  recorder.observe({
    tool: 'cdp_status',
    params: { platform: 'ios' },
    status: 'PASS',
    latencyMs: 2,
  });

  const records = recorder.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].count, 1);
  assert.equal(records[0].recoveryCount, 1);
  assert.match(records[0].recovery ?? '', /PASS immediately followed FAIL/);
  assert.equal(records[0].unknownReasons.recovery, undefined);
});

test('ordinary PASS and a non-immediate PASS are not recorded as recoveries', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  assert.deepEqual(recorder.read(), []);

  recorder.observe(fail('cdp_status', 'WebSocket close 1006'));
  recorder.observe({ tool: 'device_find', params: {}, status: 'PASS', latencyMs: 1 });
  recorder.observe({ tool: 'cdp_status', params: {}, status: 'PASS', latencyMs: 1 });
  assert.equal(recorder.read()[0].recoveryCount, 0);
});

test('dedupe signature is stable across runs, paths, ports, timestamps, and ids', () => {
  const directory = tempDirectory();
  const first = synchronousRecorder(directory);
  first.observe(
    fail(
      'cdp_status',
      `WebSocket close 1006 at localhost:8081 ${homedir()}/first/private-file.ts run ABCDEF1234567890`,
      { platform: 'ios' },
    ),
  );
  const firstSignature = first.read()[0].signature;

  const second = synchronousRecorder(directory);
  second.observe(
    fail(
      'cdp_status',
      `WebSocket close 1006 at localhost:9090 ${homedir()}/second/another-file.ts run FEDCBA0987654321`,
      { platform: 'ios' },
    ),
  );
  const records = second.read();

  assert.equal(records.length, 1);
  assert.equal(records[0].count, 2);
  assert.equal(records[0].signature, firstSignature);
  assert.equal(
    experienceSignature({
      classification: 'FF_STALE_CDP',
      tool: 'cdp_status',
      normalizedSymptomShape: normalizeSymptomShape(records[0].symptom),
      platform: 'ios',
    }),
    firstSignature,
  );
});

test('a throwing or arbitrarily slow recorder is outside the tool path', async (t) => {
  const directory = tempDirectory();
  const blockedDirectory = join(directory, 'not-a-directory');
  writeFileSync(blockedDirectory, 'occupied');
  let queued: (() => void) | undefined;
  const recorder = new ExperienceRecorder({
    directory: blockedDirectory,
    coreVersion: '1.0.0',
    pluginVersion: '1.0.0',
    schedule: (work) => {
      queued = work;
    },
  });
  const detach = addToolObserver((event) => recorder.observe(event));
  t.after(detach);
  const expected = { ok: false, error: 'failure stays unchanged' };

  const result = await instrumentTool('cdp_status', async () => expected)({});

  assert.strictEqual(result, expected);
  assert.ok(queued, 'slow persistence was queued rather than awaited');
  assert.equal(existsStore(blockedDirectory), false);
  assert.doesNotThrow(() => queued?.(), 'an unwritable store is swallowed outside the tool path');
});

test('pruning is deterministic by age, recency, then signature', () => {
  const records = [
    recordFixture({ signature: 'old', lastSeen: '2026-05-01T00:00:00.000Z' }),
    recordFixture({ signature: 'b', lastSeen: '2026-06-09T00:00:00.000Z' }),
    recordFixture({ signature: 'a', lastSeen: '2026-06-09T00:00:00.000Z' }),
    recordFixture({ signature: 'newest', lastSeen: '2026-06-10T00:00:00.000Z' }),
  ];
  const pruned = pruneExperienceRecords(records, NOW, 2, 14 * 24 * 60 * 60 * 1000);
  assert.deepEqual(
    pruned.map((record) => record.signature),
    ['a', 'newest'],
  );
  assert.deepEqual(
    pruneExperienceRecords([...records].reverse(), NOW, 2, 14 * 24 * 60 * 60 * 1000),
    pruned,
  );
});

test('trend report is read-only and exposes frequency, new, and recurring patterns', () => {
  const directory = tempDirectory();
  const recorder = synchronousRecorder(directory);
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));
  recorder.observe(fail('cdp_status', 'WebSocket close 1006', { platform: 'ios' }));
  recorder.observe(fail('device_find', 'unrecognized failure', { platform: 'android' }));
  const path = join(directory, EXPERIENCE_STORE_NAME);
  const before = readFileSync(path, 'utf8');
  const beforeStat = statSync(path);

  const report = readExperienceTrendReport({
    directory,
    since: new Date('2026-06-10T00:00:00.000Z'),
  });

  assert.deepEqual(
    report.families.map(({ classification, count }) => ({ classification, count })),
    [
      { classification: 'FF_STALE_CDP', count: 2 },
      { classification: 'UNKNOWN', count: 1 },
    ],
  );
  assert.equal(report.newSincePreviousReport.length, 2);
  assert.equal(report.recurring.length, 1);
  assert.equal(report.recurring[0].count, 2);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(statSync(path).mtimeMs, beforeStat.mtimeMs);

  assert.deepEqual(
    buildExperienceTrendReport(recorder.read(), new Date('2026-06-11T00:00:00.000Z'))
      .newSincePreviousReport,
    [],
  );
});

function existsStore(directory: string): boolean {
  try {
    readFileSync(join(directory, EXPERIENCE_STORE_NAME));
    return true;
  } catch {
    return false;
  }
}
