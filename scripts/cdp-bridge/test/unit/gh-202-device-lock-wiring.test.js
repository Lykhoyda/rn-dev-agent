import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(__dirname, '../../src/tools/device-session.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#202 device-open acquires the UDID lock and refuses on conflict', () => {
  assert.match(sessionSrc, /acquireDeviceLockForSession\(deviceId, appId\)/);
  assert.match(sessionSrc, /DEVICE_BUSY/);
});

test('GH#202 conflict teardown closes BEFORE clearing the session (order matters)', () => {
  assert.match(
    sessionSrc,
    /runAgentDevice\(\['close'\]\)[\s\S]{0,200}clearActiveSession\(\)[\s\S]{0,300}DEVICE_BUSY/,
  );
});

test('GH#202 acquire helper is single-owner (releases prior lock first)', () => {
  assert.match(
    sessionSrc,
    /function acquireDeviceLockForSession[\s\S]{0,260}releaseDeviceLockForSession\(\)[\s\S]{0,160}new DeviceLock/,
  );
});

test('GH#202 a degraded (fs-error) lock acquire is surfaced as a warning', () => {
  assert.match(sessionSrc, /lockResult\.degraded/);
});

test('GH#202 device-close releases the UDID lock', () => {
  assert.match(sessionSrc, /releaseDeviceLockForSession\(\)/);
});

test('GH#202 process exit releases the UDID lock', () => {
  assert.match(indexSrc, /releaseDeviceLockForSession/);
});
