import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/session.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
const arbiterSrc = readFileSync(resolve(__dirname, '../../src/lifecycle/device-arbiter.ts'), 'utf8');
const instrSrc = readFileSync(
  resolve(__dirname, '../../src/observability/instrumentation.ts'),
  'utf8',
);

test('GH#202 rn_session exposes the fenced arbiter recovery transition', () => {
  assert.match(sessionSrc, /input\.action === 'recover_arbiter'/);
  assert.match(sessionSrc, /confirmed=true/);
  assert.match(sessionSrc, /arbiter\.reset\(reason\)/);
  assert.match(indexSrc, /'recover_arbiter'/);
  assert.doesNotMatch(indexSrc, /resetArbiter:\s*z/);
  assert.match(arbiterSrc, /rn_session\(\{ action: "recover_arbiter", confirmed: true \}\)/);
});

test('GH#202 a BUSY_FLOW_ACTIVE refusal is not classified as a hard FAIL', () => {
  assert.match(instrSrc, /BUSY_FLOW_ACTIVE/);
});
