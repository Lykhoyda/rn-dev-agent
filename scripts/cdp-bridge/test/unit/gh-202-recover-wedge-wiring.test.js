import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const statusSrc = readFileSync(resolve(__dirname, '../../src/tools/status.ts'), 'utf8');
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');

test('GH#202 cdp_status calls recoverWedge in the isPaused path and branches on recovered', () => {
  assert.match(statusSrc, /recoverWedge\(client\)/);
  assert.match(statusSrc, /wedge\.recovered/);
  // recoverWedge runs only when still paused after softReconnect
  assert.match(
    statusSrc,
    /if\s*\(\s*status\.app\.isPaused\s*\)[\s\S]{0,500}recoverWedge\(client\)/,
  );
});

test('GH#202 device-open resets the wedge-recovery budget', () => {
  assert.match(sessionSrc, /resetWedgeRecoveryCounter\(\)/);
});
