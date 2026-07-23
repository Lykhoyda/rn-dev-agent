import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRestartHandler } from '../../dist/tools/restart.js';

test('persisted bundle state is diagnostic-only and cannot drive a hard reset', async () => {
  let persistedReads = 0;
  let execCalls = 0;
  const oldClient = {
    metroPort: 8193,
    isConnected: true,
    connectedTarget: null,
    async disconnect() {},
  };
  const nextClient = {
    metroPort: 8193,
    isConnected: true,
    connectedTarget: null,
    async autoConnect() {},
  };
  const handler = createRestartHandler(
    () => oldClient as never,
    () => {},
    () => nextClient as never,
    {
      loadPersistedBundleId: () => {
        persistedReads += 1;
        return 'com.persisted.app';
      },
      execFile: async () => {
        execCalls += 1;
        return { stdout: '', stderr: '' };
      },
      stopFastRunner: () => {},
    },
  );

  const result = await handler({
    hardReset: true,
    platform: 'ios',
    deviceId: 'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
  });
  const parsed = JSON.parse(result.content[0].text) as {
    ok: boolean;
    code?: string;
  };

  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.equal(persistedReads, 0);
  assert.equal(execCalls, 0);
});
