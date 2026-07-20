import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectHandler } from '../../dist/tools/connection.js';
import { selectTarget } from '../../dist/cdp/discovery.js';

function envelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function client(startConnected: boolean) {
  let disconnects = 0;
  let evaluations = 0;
  const target = {
    id: 'android-only',
    title: 'Pixel 9',
    vm: 'Hermes',
    description: 'dev.fixture',
    platform: 'android' as const,
    platformInference: 'probed' as const,
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/android-only',
  };
  const fake = {
    isConnected: startConnected,
    metroPort: 8081,
    connectedTarget: startConnected ? target : null,
    disconnect: async () => {
      disconnects += 1;
      fake.isConnected = false;
    },
    autoConnect: async () => {
      fake.isConnected = true;
      fake.connectedTarget = target;
      return 'connected';
    },
    evaluate: async () => {
      evaluations += 1;
      return { value: true };
    },
  };
  return { fake, counts: () => ({ disconnects, evaluations }) };
}

for (const connected of [false, true]) {
  test(`GH-588 Slice A: cdp_connect refuses a single Android target for explicit iOS (${connected ? 'connected' : 'disconnected'} start)`, async () => {
    const h = client(connected);
    const handler = createConnectHandler(
      () => h.fake as never,
      () => undefined,
      () => h.fake as never,
    );
    const result = await handler({ platform: 'ios', force: connected });
    const body = envelope(result);
    assert.equal(body.code, 'PLATFORM_TARGET_NOT_FOUND');
    assert.equal(h.fake.isConnected, false);
    assert.equal(h.counts().evaluations, 0, 'no helper injection/evaluation may mask affinity');
  });
}

test('GH-588 Slice A: defaulted iOS identity is unproven; filterless Android remains best-available', () => {
  const unproven = selectTarget(
    [
      {
        id: 'cpp',
        title: 'React Native Bridgeless [C++ connection]',
        platform: 'ios',
        platformInference: 'defaulted',
      } as never,
    ],
    { platform: 'ios' },
  );
  assert.equal(unproven.errorCode, 'PLATFORM_TARGET_NOT_FOUND');
  assert.match(unproven.warning!, /confidence=defaulted/);

  const filterless = selectTarget([
    { id: 'android', title: 'Pixel', platform: 'android', platformInference: 'probed' } as never,
  ]);
  assert.equal(filterless.targets.length, 1);
  assert.match(filterless.warning!, /No platform filter/);
});

test('GH-588 Slice A: exact targetId cannot override platform authority', () => {
  const result = selectTarget(
    [{ id: 'android', title: 'Pixel', platform: 'android', platformInference: 'probed' } as never],
    { targetId: 'android', platform: 'ios' },
  );
  assert.equal(result.errorCode, 'TARGET_PLATFORM_CONFLICT');
  assert.equal(result.targets.length, 0);
});
