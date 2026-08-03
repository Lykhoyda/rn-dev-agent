import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRegisteredConnectHandler } from '../../dist/session/registered-connect.js';

function parse(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

function status() {
  return {
    available: true as const,
    sessionId: 'session-a',
    claimEpoch: 2,
    authorityVersion: 3,
    state: 'ready',
    source: {},
    bindings: {
      metroPort: 8341,
      device: { platform: 'ios', deviceId: 'IOS-BOUND', appId: 'com.example.app' },
      bundle: { targetId: 'target-bound' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
}

test('actually registered cdp_connect handler rejects authority mismatches before pinning', async () => {
  const calls: unknown[] = [];
  const handler = createRegisteredConnectHandler({ status }, async (input) => {
    calls.push(input);
    return { content: [{ type: 'text', text: '{"ok":true}' }] };
  });

  assert.equal(parse(await handler({ metroPort: 8081 })).code, 'METRO_AUTHORITY_MISMATCH');
  assert.equal(parse(await handler({ platform: 'android' })).code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(
    parse(await handler({ targetId: 'ambient-default-target' })).code,
    'CDP_TARGET_AUTHORITY_MISMATCH',
  );
  assert.deepEqual(calls, [], 'no launch, port fallback, or target fallback may run on conflict');

  const matching = parse(
    await handler({ metroPort: 8341, platform: 'ios', targetId: 'target-bound', force: true }),
  );
  assert.equal(matching.ok, true);
  assert.deepEqual(calls, [{ action: 'pin_dev_client', force: true }]);
});

test('index registers cdp_connect through the tested exact-bound factory, never legacy discovery', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    'utf8',
  );
  assert.match(
    source,
    /const connectBoundSession = createRegisteredConnectHandler\(authorityRuntime, sessionHandler\)/,
  );
  const block = source.slice(
    source.indexOf("trackedTool(\n  'cdp_connect'"),
    source.indexOf("trackedTool(\n  'cdp_disconnect'"),
  );
  assert.match(block, /connectBoundSession/);
  assert.doesNotMatch(block, /createConnectHandler|discover|selectTarget/);
});
