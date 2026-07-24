import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBuildReceipt, verifyBuildReceipt } from '../../../dist/session/build-receipt.js';

const input = {
  sessionId: 'session-a',
  sourceKey: 'source-a',
  worktreeKey: 'worktree-a',
  appRootKey: 'app-a',
  platform: 'ios',
  deviceId: 'IOS-UUID',
  appId: 'com.example.app',
  metroPort: 8341,
  artifactDigest: 'artifact-a',
  installGeneration: 'generation-a',
  buildGeneration: 2,
};

test('build receipts bind artifact, source, session, port, and exact device', () => {
  const receipt = createBuildReceipt(input, 'signer');
  const payload = verifyBuildReceipt(receipt, 'signer', input);

  assert.equal(payload.artifactDigest, 'artifact-a');
  assert.equal(payload.deviceId, 'IOS-UUID');
});

test('tampered or sibling-session build receipts are rejected', () => {
  const receipt = createBuildReceipt(input, 'signer');
  assert.throws(
    () => verifyBuildReceipt({ ...receipt, signature: '00' }, 'signer', input),
    /BUILD_RECEIPT_INVALID/,
  );
  assert.throws(
    () => verifyBuildReceipt(receipt, 'signer', { ...input, sessionId: 'session-b' }),
    /SESSION_BUILD_IDENTITY_CONFLICT/,
  );
});
