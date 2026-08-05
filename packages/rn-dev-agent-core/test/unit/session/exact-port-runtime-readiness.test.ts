import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CDPClient } from '../../../dist/cdp-client.js';
import { discoverExactPort, listTargetsOnExactPort } from '../../../dist/cdp/discovery.js';

const managedPort = 8341;
const ambientPort = 8081;

function bridgelessTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: 'managed-target',
    title: 'com.example.app (Owned Simulator)',
    description: 'React Native Bridgeless [C++ connection]',
    appId: 'com.example.app',
    type: 'node',
    webSocketDebuggerUrl: `ws://127.0.0.1:${managedPort}/inspector/debug?device=owned&page=1`,
    deviceName: 'Owned Simulator',
    ...overrides,
  };
}

test('exact-port discovery recognizes modern Bridgeless Hermes metadata without probing ambient Metro', async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return {
      json: async () => [bridgelessTarget()],
    } as Response;
  }) as typeof fetch;
  try {
    const result = await discoverExactPort(managedPort, {
      bundleId: 'com.example.app',
      targetId: 'managed-target',
    });
    assert.equal(result.port, managedPort);
    assert.equal(result.targets.length, 1);
    assert.equal(result.targets[0]?.vm, undefined);
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);
    assert.equal(
      requested.some((url) => url.includes(`:${ambientPort}/`)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact-port listing rejects a target whose debugger URL escapes the managed Metro port', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    json: async () => [
      bridgelessTarget({
        webSocketDebuggerUrl: `ws://127.0.0.1:${ambientPort}/inspector/debug?page=1`,
      }),
    ],
  })) as typeof fetch;
  try {
    const result = await listTargetsOnExactPort(managedPort);
    assert.deepEqual(result, { port: managedPort, targets: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('exact-port discovery survives reconnects until an ordinary connect replaces it', async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const requestUrl = String(url);
    requested.push(requestUrl);
    if (requestUrl.endsWith('/status')) {
      return { text: async () => 'packager-status:running' } as Response;
    }
    return { json: async () => [] } as unknown as Response;
  }) as typeof fetch;
  const client = new CDPClient(managedPort);
  try {
    const filters = { bundleId: 'com.example.app', targetId: 'managed-target' };
    await assert.rejects(client.connectExact(managedPort, filters));

    requested.length = 0;
    await assert.rejects(client.softReconnect());
    assert.deepEqual(requested, [`http://127.0.0.1:${managedPort}/json/list`]);

    requested.length = 0;
    await assert.rejects(client.autoConnect(ambientPort, filters));
    assert.equal(requested.some((url) => url.endsWith(`:${ambientPort}/status`)), true);
  } finally {
    await client.disconnect();
    globalThis.fetch = originalFetch;
  }
});
