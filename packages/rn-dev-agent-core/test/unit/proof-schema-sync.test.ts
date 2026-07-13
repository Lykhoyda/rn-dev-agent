import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';
import {
  finalProofReceiptSchema,
  mechanicalProofReceiptSchema,
} from '../../dist/domain/proof-receipt.js';

const coreRoot = resolve(import.meta.dirname, '../..');
const schemaPath = resolve(coreRoot, 'schemas/proof-receipt.schema.json');
const hash = 'a'.repeat(64);
const sourceTreeSha = 'b'.repeat(40);
const proofHeadSha = 'c'.repeat(40);

const acceptedReceipt = {
  schemaVersion: 1,
  runId: 'run-123',
  issue: { repository: 'Lykhoyda/rn-dev-agent', number: 123 },
  pullRequest: { number: 456, headSha: proofHeadSha },
  proofClass: 'feature',
  acceptanceMappings: [
    {
      criterion: 'The exact three-state feature flow reaches its accepted result',
      storyboardStepIds: ['start', 'form', 'result'],
    },
  ],
  git: {
    sourceTreeSha,
    proofHeadSha,
    dirty: false,
  },
  device: {
    id: 'simulator-1',
    platform: 'ios',
    model: 'iPhone 17',
    osVersion: '26.0',
  },
  runtime: {
    bundleId: 'dev.lykhoyda.rndevagent.proof',
    metroPort: 8_081,
    metroReady: true,
    pluginVersion: '0.64.0',
  },
  fixture: {
    name: 'rn-dev-agent-proof-fixture',
    version: '1.0.0',
  },
  action: {
    id: 'canonical-proof',
    version: '1',
    sha256: hash,
  },
  storyboard: {
    id: 'strict-factory-proof',
    sha256: hash,
  },
  rehearsal: {
    startedAt: '2026-07-12T10:00:00.000Z',
    finishedAt: '2026-07-12T10:00:20.000Z',
    durationMs: 20_000,
    clean: true,
  },
  video: {
    path: 'flow-ios.mp4',
    sha256: hash,
    durationMs: 22_000,
    sizeBytes: 20_000,
    codec: 'h264',
    width: 1_179,
    height: 2_556,
  },
  screenshots: ['start', 'form', 'result'].map((stepId, index) => ({
    stepId,
    path: `screenshots/0${index + 1}-${stepId}.png`,
    timestampMs: (index + 1) * 1_000,
    sha256: hash,
  })),
  assertions: ['start', 'form', 'result'].map((stepId) => ({
    stepId,
    tool: 'expect_visible_by_testid',
    ok: true,
    resultHash: hash,
  })),
  eventTrace: {
    allowedTools: ['cdp_run_action', 'proof_step', 'device_screenshot', 'expect_visible_by_testid'],
    observed: [
      { tool: 'cdp_run_action', ok: true, ts: 1_000, durationMs: 1_000, argsHash: hash },
      { tool: 'proof_step', ok: true, ts: 2_000, durationMs: 100, argsHash: hash },
      { tool: 'device_screenshot', ok: true, ts: 3_000, durationMs: 100, argsHash: hash },
    ],
  },
  frameMatches: ['start', 'form', 'result'].map((stepId, index) => ({
    stepId,
    screenshotSha256: hash,
    videoTimestampMs: (index + 1) * 1_000,
    score: 0.98,
  })),
  contactSheet: {
    path: 'contact-sheet.jpg',
    sha256: hash,
  },
  errorBaseline: {
    beforeSha256: hash,
    afterSha256: hash,
    beforeCount: 0,
    afterCount: 0,
    clean: true,
  },
  invalidationReasons: [],
  evidenceReview: {
    provider: 'review-provider',
    writerProvider: 'writer-provider',
    independent: true,
    exactFeature: true,
    irrelevantScreens: false,
    debuggingFriction: false,
    personalData: false,
    evidenceSha256: hash,
    resultHash: hash,
  },
  verdict: 'accepted',
} as const;

const { evidenceReview: _evidenceReview, ...acceptedMechanicalFields } = acceptedReceipt;
const acceptedMechanicalReceipt = {
  ...acceptedMechanicalFields,
  verdict: 'mechanically_accepted',
} as const;

const rejectedReceipt = {
  ...acceptedMechanicalFields,
  rehearsal: { ...acceptedReceipt.rehearsal, clean: false },
  video: null,
  screenshots: [],
  assertions: [],
  eventTrace: { ...acceptedReceipt.eventTrace, observed: [] },
  frameMatches: [],
  contactSheet: null,
  errorBaseline: {
    ...acceptedReceipt.errorBaseline,
    afterCount: 1,
    clean: false,
  },
  invalidationReasons: ['OBSERVED_TOOL_FAILED'],
  verdict: 'rejected',
} as const;

function loadValidator() {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  return new Ajv({ strict: true }).compile(schema);
}

test('accepted and rejected receipt variants satisfy their strict Zod contracts', () => {
  assert.equal(finalProofReceiptSchema.safeParse(acceptedReceipt).success, true);
  assert.equal(mechanicalProofReceiptSchema.safeParse(acceptedMechanicalReceipt).success, true);
  assert.equal(mechanicalProofReceiptSchema.safeParse(rejectedReceipt).success, true);
});

test('external JSON Schema accepts only the final accepted receipt', () => {
  const validate = loadValidator();

  assert.equal(validate(acceptedReceipt), true, JSON.stringify(validate.errors));
  assert.equal(validate(rejectedReceipt), false);
});

test('accepted receipts reject failed assertions in Zod and JSON Schema', () => {
  const validate = loadValidator();
  const failedAssertionReceipt = {
    ...acceptedReceipt,
    assertions: [
      { ...acceptedReceipt.assertions[0], ok: false },
      ...acceptedReceipt.assertions.slice(1),
    ],
  };

  assert.deepEqual(
    {
      zod: finalProofReceiptSchema.safeParse(failedAssertionReceipt).success,
      jsonSchema: validate(failedAssertionReceipt),
    },
    { zod: false, jsonSchema: false },
    JSON.stringify(validate.errors),
  );
});

test('mechanical acceptance enforces clean evidence while rejection requires stable reasons', () => {
  assert.equal(
    mechanicalProofReceiptSchema.safeParse({
      ...acceptedMechanicalReceipt,
      rehearsal: { ...acceptedMechanicalReceipt.rehearsal, clean: false },
    }).success,
    false,
  );
  assert.equal(
    mechanicalProofReceiptSchema.safeParse({
      ...acceptedMechanicalReceipt,
      screenshots: acceptedMechanicalReceipt.screenshots.slice(0, 2),
    }).success,
    false,
  );
  assert.equal(
    mechanicalProofReceiptSchema.safeParse({ ...rejectedReceipt, invalidationReasons: [] }).success,
    false,
  );
  assert.equal(
    mechanicalProofReceiptSchema.safeParse({
      ...rejectedReceipt,
      invalidationReasons: ['not stable prose'],
    }).success,
    false,
  );
});

test('strict receipt schemas reject unknown fields at every object boundary', () => {
  const validate = loadValidator();
  const unknownTopLevel = { ...acceptedReceipt, unexpected: true };
  const unknownNested = {
    ...acceptedReceipt,
    device: { ...acceptedReceipt.device, unexpected: true },
  };

  for (const fixture of [unknownTopLevel, unknownNested]) {
    assert.equal(finalProofReceiptSchema.safeParse(fixture).success, false);
    assert.equal(validate(fixture), false);
  }
});

test('proof schema regeneration is byte-identical and reports its digest', () => {
  const bytes = readFileSync(schemaPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const result = spawnSync(process.execPath, ['scripts/export-proof-schema.mjs', '--check'], {
    cwd: coreRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), digest);
  assert.deepEqual(readFileSync(schemaPath), bytes);
});
