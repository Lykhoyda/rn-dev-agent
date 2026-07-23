import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureMetroBinding } from '../../../dist/session/metro-binding.js';

test('Metro binding requires exact port, process birth, serving root, and instance', async () => {
  const binding = await captureMetroBinding(
    {
      port: 8341,
      pid: 202,
      instanceId: 'metro-a',
      sourceRoot: '/repo/worktree',
      buildGeneration: 3,
    },
    {
      readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
      fetchStatus: async (port) =>
        port === 8341 ? 'packager-status:running' : 'packager-status:unknown',
      servingRoot: () => '/repo/worktree/apps/mobile',
    },
  );

  assert.deepEqual(binding, {
    port: 8341,
    pid: 202,
    birth: 'metro-birth',
    instanceId: 'metro-a',
    servingRoot: '/repo/worktree/apps/mobile',
    buildGeneration: 3,
  });
});

test('Metro binding fails closed when serving-root provenance is unavailable', async () => {
  await assert.rejects(
    captureMetroBinding(
      {
        port: 8341,
        pid: 202,
        instanceId: 'metro-a',
        sourceRoot: '/repo/worktree',
        buildGeneration: 3,
      },
      {
        readBirth: () => ({ pid: 202, source: 'darwin-ps', token: 'metro-birth' }),
        fetchStatus: async () => 'packager-status:running',
        servingRoot: () => null,
      },
    ),
    /METRO_AUTHORITY_MISMATCH/,
  );
});
