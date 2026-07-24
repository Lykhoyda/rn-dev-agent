// Audit batch B5 — cross_platform_verify must signal ok:false on a real FAIL
// verdict (was warnResult/ok:true, so callers gating on the envelope flag read
// a failed cross-platform check as a pass).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCrossPlatformVerifyHandler } from '../../dist/tools/cross-platform-verify.js';
import { cacheSnapshot } from '../../dist/agent-device-wrapper.js';

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
