// Audit batch B5 — cross_platform_verify must signal ok:false on a real FAIL
// verdict (was warnResult/ok:true, so callers gating on the envelope flag read
// a failed cross-platform check as a pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCrossPlatformVerifyHandler } from '../../dist/tools/cross-platform-verify.js';
import {
  cacheSnapshot,
  setSnapshotAuthorityProvider,
  validateCachedSnapshotEvidenceAuthority,
} from '../../dist/agent-device-wrapper.js';

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test('cross_platform_verify returns ok:false when elements differ across platforms', async () => {
  cacheSnapshot('ios', [
    { ref: '@1', identifier: 'shared' },
    { ref: '@2', identifier: 'ios-only' },
  ]);
  cacheSnapshot('android', [{ ref: '@1', identifier: 'shared' }]);
  const handler = createCrossPlatformVerifyHandler();
  const result = await handler({ elements: ['shared', 'ios-only'], matchBy: 'testID' });
  const env = parse(result);
  assert.equal(env.ok, false, 'FAIL verdict must be ok:false');
  assert.equal(result.isError, true, 'FAIL verdict must be isError');
  assert.equal(env.code, 'CROSS_PLATFORM_MISMATCH');
  assert.equal(env.meta.summary.verdict, 'FAIL');
});

test('cross_platform_verify returns ok:true when all elements match', async () => {
  cacheSnapshot('ios', [{ ref: '@1', identifier: 'shared' }]);
  cacheSnapshot('android', [{ ref: '@1', identifier: 'shared' }]);
  const handler = createCrossPlatformVerifyHandler();
  const result = await handler({ elements: ['shared'], matchBy: 'testID' });
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.data.verdict, 'PASS');
});

test('cross_platform_verify refuses PASS when retained live authority is unavailable', async () => {
  cacheSnapshot('ios', [{ ref: '@1', identifier: 'shared' }]);
  cacheSnapshot('android', [{ ref: '@1', identifier: 'shared' }]);
  const handler = createCrossPlatformVerifyHandler({
    validateAuthority: async (platform) => platform === 'android',
  });
  const result = await handler({ elements: ['shared'], matchBy: 'testID' });
  const env = parse(result);

  assert.notEqual(env.data?.verdict, 'PASS');
  assert.equal(env.meta?.authoritative, undefined);
});

test('cross_platform_verify validates each platform evidence once', async () => {
  const reads = new Map();
  const handler = createCrossPlatformVerifyHandler({
    getEvidence: (platform) => {
      reads.set(platform, (reads.get(platform) ?? 0) + 1);
      return {
        capturedAt: `${platform}-time`,
        nodes: [{ ref: '@1', identifier: 'shared' }],
      };
    },
  });

  const result = await handler({ elements: ['shared'], matchBy: 'testID' });

  assert.equal(parse(result).ok, true);
  assert.deepEqual(Object.fromEntries(reads), { ios: 1, android: 1 });
});

test('cross_platform_verify rejects stale iOS origin after rebinding to Android', async () => {
  let currentPlatform = 'ios';
  const validatedOrigins = [];
  setSnapshotAuthorityProvider({
    current: () => ({
      sessionId: 'session-a',
      claimEpoch: 1,
      sourceKey: 'source-a',
      worktreeKey: 'worktree-a',
      appRootKey: 'app-a',
      platform: currentPlatform,
      deviceId: `${currentPlatform}-device`,
      appId: 'dev.example',
      buildGeneration: 1,
      installGeneration: `${currentPlatform}-install`,
      artifactDigest: `${currentPlatform}-artifact`,
      runnerInstanceId: `${currentPlatform}-runner`,
      runnerPid: 123,
      runnerProcessBirth: `${currentPlatform}-birth`,
      runnerCapabilityHash: `${currentPlatform}-capability`,
      runnerPort: currentPlatform === 'ios' ? 9100 : 9200,
      runnerClaim: `${currentPlatform}:runner`,
      deviceClaim: `${currentPlatform}:device`,
    }),
    record: () => {},
    validate: () => true,
    validateEvidence: () => true,
    validateLive: async () => true,
    validateOrigin: async (receipt) => {
      validatedOrigins.push(receipt.platform);
      return receipt.platform === 'android';
    },
  });

  try {
    cacheSnapshot('ios', [{ ref: '@1', identifier: 'shared' }]);
    currentPlatform = 'android';
    cacheSnapshot('android', [{ ref: '@1', identifier: 'shared' }]);
    const handler = createCrossPlatformVerifyHandler({
      validateAuthority: validateCachedSnapshotEvidenceAuthority,
    });

    const result = await handler({ elements: ['shared'], matchBy: 'testID' });

    assert.notEqual(parse(result).data?.verdict, 'PASS');
    assert.deepEqual(validatedOrigins.sort(), ['android', 'ios']);
  } finally {
    setSnapshotAuthorityProvider(null);
  }
});

test('production registration wires retained snapshot authority validation', () => {
  const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

  assert.match(
    indexSource,
    /createCrossPlatformVerifyHandler\(\{\s*validateAuthority: validateCachedSnapshotEvidenceAuthority,\s*\}\)/,
  );
});
