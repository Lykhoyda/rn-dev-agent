import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLegacyAgentDevice } from '../../../dist/runners/external-runner-detect.js';

test('detectLegacyAgentDevice: returns null when no daemon file', async () => {
  const result = await detectLegacyAgentDevice({ readDaemonFile: async () => null });
  assert.equal(result, null);
});

test('detectLegacyAgentDevice: returns warning when daemon file present', async () => {
  const result = await detectLegacyAgentDevice({
    readDaemonFile: async () => ({ pid: 12345, port: 64700 }),
  });
  assert.ok(result);
  assert.match(result.message, /globally-installed external runner/);
  assert.equal(result.pid, 12345);
  assert.equal(result.port, 64700);
});

test('detectLegacyAgentDevice: returns null on file read error', async () => {
  const result = await detectLegacyAgentDevice({
    readDaemonFile: async () => { throw new Error('ENOENT'); },
  });
  assert.equal(result, null);
});
