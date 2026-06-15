// Task 7: No ['find', ...] literal reaches agent-device dispatcher.
// Source-regex gate + behavioral tests for proof-step verifyText via orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '../../src/tools');

// ── Source-regex gate: no ['find', ...] literal in any of the four files ──

test("task7: no ['find' literal in proof-step.ts", () => {
  const src = readFileSync(join(SRC, 'proof-step.ts'), 'utf8');
  const lines = src.split('\n').filter(l => l.includes("['find'") && !l.trimStart().startsWith('//'));
  assert.equal(lines.length, 0, `Found ['find' in proof-step.ts:\n${lines.join('\n')}`);
});

test("task7: no ['find' literal in dev-client-picker.ts", () => {
  const src = readFileSync(join(SRC, 'dev-client-picker.ts'), 'utf8');
  const lines = src.split('\n').filter(l => l.includes("['find'") && !l.trimStart().startsWith('//'));
  assert.equal(lines.length, 0, `Found ['find' in dev-client-picker.ts:\n${lines.join('\n')}`);
});

test("task7: no ['find' literal in device-batch.ts", () => {
  const src = readFileSync(join(SRC, 'device-batch.ts'), 'utf8');
  const lines = src.split('\n').filter(l => l.includes("['find'") && !l.trimStart().startsWith('//'));
  assert.equal(lines.length, 0, `Found ['find' in device-batch.ts:\n${lines.join('\n')}`);
});

test("task7: no ['find' literal in device-interact.ts (dead legacy branch removed)", () => {
  const src = readFileSync(join(SRC, 'device-interact.ts'), 'utf8');
  const lines = src.split('\n').filter(l => l.includes("['find'") && !l.trimStart().startsWith('//'));
  assert.equal(lines.length, 0, `Found ['find' in device-interact.ts:\n${lines.join('\n')}`);
});

// ── Behavioral: proof-step verifyText uses orchestrator ──

import { createProofStepHandler } from '../../dist/tools/proof-step.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

test('task7: proof-step verifyText present → verified:true via orchestrator dep', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: undefined });
  const handler = createProofStepHandler(() => client, {
    hasSession: () => true,
    fetchCandidates: async (_text) => ({ ok: true, candidates: [{ ref: 'e1', label: 'Hello World' }] }),
    captureScreenshot: async () => ({ content: [{ type: 'text', text: '/tmp/shot.png' }] }),
  });
  const r = await handler({ verifyText: 'Hello World', waitMs: 0 });
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.verified, true);
  assert.match(env.data.verifyDetail, /Hello World/);
});

test('task7: proof-step verifyText absent → verified:false via orchestrator dep', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: undefined });
  const handler = createProofStepHandler(() => client, {
    hasSession: () => true,
    fetchCandidates: async (_text) => ({ ok: true, candidates: [] }),
    captureScreenshot: async () => ({ content: [{ type: 'text', text: '/tmp/shot.png' }] }),
  });
  const r = await handler({ verifyText: 'Missing Text', waitMs: 0 });
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.verified, false);
  assert.match(env.data.verifyDetail, /not found/i);
});

test('task7: proof-step verifyText snapshot-fail → verified:false', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: undefined });
  const handler = createProofStepHandler(() => client, {
    hasSession: () => true,
    fetchCandidates: async (_text) => ({ ok: false, reason: 'fetch-failed' }),
    captureScreenshot: async () => ({ content: [{ type: 'text', text: '/tmp/shot.png' }] }),
  });
  const r = await handler({ verifyText: 'Anything', waitMs: 0 });
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.verified, false);
});
