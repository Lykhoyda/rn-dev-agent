// A managed Metro restart is not a native rebuild: when the bound signed
// install receipt matches every session axis and the installed bytes re-prove
// on-device, the restarted instance keeps the receipt's buildGeneration so
// `pin_dev_client` provenance stays coherent. Every mismatch falls back to the
// bumped generation, which keeps the pin gate refusing fail-closed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveManagedMetroRestartGeneration } from '../../../dist/session/managed-metro-restart.js';

const SESSION = {
  sessionId: 'session-a',
  sourceKey: 'source-key',
  worktreeKey: 'worktree-key',
  appRootKey: 'app-root-key',
  metroPort: 8081,
};

const DEVICE = { platform: 'ios' as const, deviceId: 'SIM-1', appId: 'dev.example' };

const RECEIPT = {
  sessionId: SESSION.sessionId,
  sourceKey: SESSION.sourceKey,
  worktreeKey: SESSION.worktreeKey,
  appRootKey: SESSION.appRootKey,
  platform: DEVICE.platform,
  deviceId: DEVICE.deviceId,
  appId: DEVICE.appId,
  metroPort: SESSION.metroPort,
  artifactDigest: 'attested-digest',
  installGeneration: 'install-generation-1',
  buildGeneration: 4,
  buildKind: 'expo',
};

function captureReturning(artifactDigest: string, installGeneration: string) {
  return (target: { platform: 'ios' | 'android'; deviceId: string; appId: string }) => {
    assert.deepEqual(target, {
      platform: DEVICE.platform,
      deviceId: DEVICE.deviceId,
      appId: DEVICE.appId,
    });
    return { ...DEVICE, artifactDigest, installGeneration };
  };
}

function resolve(
  install: Record<string, unknown> | null,
  captureInstalled = captureReturning(RECEIPT.artifactDigest, RECEIPT.installGeneration),
) {
  return resolveManagedMetroRestartGeneration(
    { session: SESSION, device: DEVICE, install, fallbackGeneration: 5 },
    { captureInstalled },
  );
}

test('a byte-identical revalidated receipt preserves its generation across restart', () => {
  assert.deepEqual(resolve({ ...RECEIPT }), { buildGeneration: 4, receiptPreserved: true });
});

test('a bare-react-native receipt preserves its generation the same way', () => {
  assert.deepEqual(resolve({ ...RECEIPT, buildKind: 'bare-react-native' }), {
    buildGeneration: 4,
    receiptPreserved: true,
  });
});

test('a missing install falls back to the bumped generation', () => {
  assert.deepEqual(resolve(null), { buildGeneration: 5, receiptPreserved: false });
});

test('a changed installed artifact never preserves the receipt generation', () => {
  assert.deepEqual(
    resolve({ ...RECEIPT }, captureReturning('foreign-digest', RECEIPT.installGeneration)),
    { buildGeneration: 5, receiptPreserved: false },
  );
});

test('a rotated install generation never preserves the receipt generation', () => {
  assert.deepEqual(
    resolve({ ...RECEIPT }, captureReturning(RECEIPT.artifactDigest, 'install-generation-2')),
    { buildGeneration: 5, receiptPreserved: false },
  );
});

test('an unattestable install falls back instead of admitting the receipt', () => {
  assert.deepEqual(
    resolve({ ...RECEIPT }, () => {
      throw new Error('exact iOS app container was not found');
    }),
    { buildGeneration: 5, receiptPreserved: false },
  );
});

test('foreign or drifted receipt axes always fall back to the bumped generation', () => {
  const drifts: Array<Record<string, unknown>> = [
    { sessionId: 'session-b' },
    { sourceKey: 'other-source' },
    { worktreeKey: 'other-worktree' },
    { appRootKey: 'other-app-root' },
    { platform: 'android' },
    { deviceId: 'SIM-2' },
    { appId: 'dev.other' },
    { metroPort: 8082 },
    { buildKind: 'gradle' },
    { artifactDigest: undefined },
    { artifactDigest: '' },
    { installGeneration: undefined },
    { installGeneration: '' },
    { buildGeneration: 0 },
    { buildGeneration: 4.5 },
    { buildGeneration: '4' },
  ];
  for (const drift of drifts) {
    assert.deepEqual(
      resolve({ ...RECEIPT, ...drift }),
      { buildGeneration: 5, receiptPreserved: false },
      JSON.stringify(drift),
    );
  }
});

test('empty identity evidence refuses structurally, before any capture runs', () => {
  for (const drift of [{ artifactDigest: '' }, { installGeneration: '' }]) {
    let captured = false;
    const result = resolve({ ...RECEIPT, ...drift }, () => {
      captured = true;
      return { ...DEVICE, artifactDigest: '', installGeneration: '' };
    });
    assert.deepEqual(result, { buildGeneration: 5, receiptPreserved: false });
    assert.equal(captured, false, JSON.stringify(drift));
  }
});

test('an exact Android receipt preserves its generation with exact-target attestation', () => {
  const device = { platform: 'android' as const, deviceId: 'emulator-5554', appId: 'dev.example' };
  const receipt = { ...RECEIPT, platform: 'android', deviceId: device.deviceId };
  const result = resolveManagedMetroRestartGeneration(
    { session: SESSION, device, install: receipt, fallbackGeneration: 5 },
    {
      captureInstalled: (target) => {
        assert.deepEqual(target, device);
        return {
          ...device,
          artifactDigest: RECEIPT.artifactDigest,
          installGeneration: RECEIPT.installGeneration,
        };
      },
    },
  );
  assert.deepEqual(result, { buildGeneration: 4, receiptPreserved: true });
});

test('the structural gate refuses before any on-device capture runs', () => {
  let captured = false;
  const result = resolve({ ...RECEIPT, deviceId: 'SIM-2' }, () => {
    captured = true;
    return {
      ...DEVICE,
      artifactDigest: RECEIPT.artifactDigest,
      installGeneration: RECEIPT.installGeneration,
    };
  });
  assert.deepEqual(result, { buildGeneration: 5, receiptPreserved: false });
  assert.equal(captured, false);
});
