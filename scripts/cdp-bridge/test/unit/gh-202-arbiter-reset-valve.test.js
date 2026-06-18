import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusSrc = readFileSync(resolve(__dirname, '../../src/tools/status.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');
const instrSrc = readFileSync(
  resolve(__dirname, '../../src/observability/instrumentation.ts'),
  'utf8',
);

test('GH#202 cdp_status exposes the arbiter reset escape hatch', () => {
  assert.match(statusSrc, /resetArbiter/);
  assert.match(statusSrc, /arbiter\.reset\(/);
  assert.match(indexSrc, /resetArbiter:\s*z[\s\S]{0,30}\.boolean\(\)[\s\S]{0,30}\.optional\(\)/);
});

test('GH#202 a BUSY_FLOW_ACTIVE refusal is not classified as a hard FAIL', () => {
  assert.match(instrSrc, /BUSY_FLOW_ACTIVE/);
});
