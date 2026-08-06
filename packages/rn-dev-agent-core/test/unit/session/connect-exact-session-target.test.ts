import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPClient } from '../../../dist/cdp-client.js';
import { connectExactSessionTarget } from '../../../dist/session/connect-exact-session-target.js';

const serial = '46828c2c';
const model = 'BE2013';
const appId = 'com.rndevagent.testapp';
const preservedDeviceName = 'BE2013 - 11 - API 30';

type FixtureMode = 'responsive' | 'reregister' | 'stalled';

interface SyntheticMetro {
  port: number;
  connections: string[];
  get listCount(): number;
  get staleClosed(): boolean;
  close(): Promise<void>;
}

async function startSyntheticMetro(mode: FixtureMode): Promise<SyntheticMetro> {
  let port = 0;
  let listCount = 0;
  let staleProbeSeen = false;
  let staleClosed = false;
  let duplicateAdvertised = false;
  const connections: string[] = [];
  const clients = new Set<WebSocket>();

  const target = (id: string, path: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `${appId} (OnePlus ${model})`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path}`,
    deviceName: preservedDeviceName,
    reactNative: {
      logicalDeviceId: id.split('-')[0],
      capabilities: { supportsMultipleDebuggers: false },
    },
    ...overrides,
  });

  const server: Server = createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    listCount += 1;
    let targets: Array<Record<string, unknown>>;
    if (mode === 'responsive') {
      targets = [target('responsive-exact-1', '/responsive')];
    } else if (!staleProbeSeen) {
      targets = [target('stale-exact-1', '/stale')];
    } else if (mode === 'stalled') {
      targets = [];
    } else if (!duplicateAdvertised) {
      duplicateAdvertised = true;
      targets = [
        target('responsive-exact-2', '/responsive'),
        target('duplicate-exact-2', '/duplicate'),
        target('foreign-app-2', '/foreign-app', {
          appId: 'com.foreign.app',
          title: 'com.foreign.app (OnePlus BE2013)',
        }),
        target('foreign-device-2', '/foreign-device', {
          deviceName: 'Pixel 9 - 15 - API 35',
        }),
        target('foreign-metro-2', '/foreign-metro', {
          webSocketDebuggerUrl: `ws://127.0.0.1:${port + 1}/foreign-metro`,
        }),
      ];
    } else {
      targets = [
        target('responsive-exact-2', '/responsive'),
        target('foreign-app-2', '/foreign-app', {
          appId: 'com.foreign.app',
          title: 'com.foreign.app (OnePlus BE2013)',
        }),
        target('foreign-device-2', '/foreign-device', {
          deviceName: 'Pixel 9 - 15 - API 35',
        }),
        target('foreign-metro-2', '/foreign-metro', {
          webSocketDebuggerUrl: `ws://127.0.0.1:${port + 1}/foreign-metro`,
        }),
      ];
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(targets));
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    const path = request.url ?? '';
    if (path !== '/events') connections.push(path);
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
      if (path === '/stale') staleClosed = true;
    });
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as {
        id: number;
        method: string;
        params?: { expression?: string };
      };
      if (path === '/stale' && message.method === 'Runtime.evaluate') {
        if (message.params?.expression === '1+1') staleProbeSeen = true;
        return;
      }
      socket.send(
        JSON.stringify({
          id: message.id,
          result:
            message.method === 'Runtime.evaluate'
              ? { result: { type: 'boolean', value: true } }
              : {},
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    connections,
    get listCount() {
      return listCount;
    },
    get staleClosed() {
      return staleClosed;
    },
    async close() {
      for (const socket of clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function fixtureDependencies(initial: CDPClient) {
  let current = initial;
  return {
    get current() {
      return current;
    },
    dependencies: {
      getClient: () => current,
      setClient: (next: CDPClient) => {
        current = next;
      },
      createClient: (port: number) => new CDPClient(port),
      execute: async (file: string, args: string[]) => {
        assert.equal(file, 'adb');
        if (args[0] === 'devices')
          return { stdout: `List of devices attached\n${serial}\tdevice\n` };
        assert.deepEqual(args, ['-s', serial, 'shell', 'getprop', 'ro.product.model']);
        return { stdout: `${model}\n` };
      },
    },
  };
}

const exactInput = (port: number) => ({
  metroPort: port,
  platform: 'android' as const,
  appId,
  deviceId: serial,
});

test('production exact-session wrapper connects preserved Android metadata immediately', async () => {
  const metro = await startSyntheticMetro('responsive');
  const fixture = fixtureDependencies(new CDPClient(metro.port));
  try {
    const connected = await connectExactSessionTarget(
      exactInput(metro.port),
      5_000,
      fixture.dependencies,
    );
    assert.equal(connected.targetId, 'responsive-exact-1');
    assert.equal(connected.deviceId, serial);
    assert.deepEqual(metro.connections, ['/responsive']);
  } finally {
    await fixture.current.disconnect();
    await metro.close();
  }
});

test('production wrapper resets a stalled probe and accepts only exact responsive re-registration', async () => {
  const metro = await startSyntheticMetro('reregister');
  const fixture = fixtureDependencies(new CDPClient(metro.port));
  try {
    const connected = await connectExactSessionTarget(
      exactInput(metro.port),
      7_000,
      fixture.dependencies,
    );
    assert.equal(connected.targetId, 'responsive-exact-2');
    assert.ok(metro.staleClosed, 'the failed debugger must disconnect before recovery');
    assert.ok(metro.listCount >= 5, 'the allocated Metro must be re-listed after reset');
    assert.deepEqual(
      metro.connections,
      ['/stale', '/responsive'],
      'foreign, off-Metro, and duplicate candidates must never receive a debugger connection',
    );
  } finally {
    await fixture.current.disconnect();
    await metro.close();
  }
});

test('production wrapper preserves the probe-timeout leaf in its public authority error', async () => {
  const metro = await startSyntheticMetro('stalled');
  const fixture = fixtureDependencies(new CDPClient(metro.port));
  const startedAt = Date.now();
  try {
    await assert.rejects(
      connectExactSessionTarget(exactInput(metro.port), 3_400, fixture.dependencies),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^CDP_TARGET_AUTHORITY_MISMATCH:/);
        assert.match(error.message, /CDP probe timeout after 1 attempts/);
        assert.match(error.message, /Runtime\.evaluate\('1\+1'\)/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /CDP probe timeout/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5_500, 'stale targets must remain bounded');
    assert.deepEqual(metro.connections, ['/stale']);
    assert.ok(metro.listCount >= 2, 'the wrapper must re-list after the stale target disappears');
  } finally {
    await fixture.current.disconnect();
    await metro.close();
  }
});

test('iOS retains the existing retry budget without replacing the exact client', async () => {
  const target = {
    id: 'ios-exact-1',
    title: appId,
    description: 'React Native',
    appId,
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/ios',
    deviceName: 'iPhone 16',
    platform: 'ios',
    platformInference: 'explicit',
  };
  let connectCalls = 0;
  let disconnectCalls = 0;
  let createCalls = 0;
  const retryBudgets: number[] = [];
  const client = {
    metroPort: 8081,
    connectedTarget: null as typeof target | null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({ port: 8081, targets: [target] }),
    connectExact: async (_port: number, _filters: unknown, _intent: string, retries: number) => {
      retryBudgets.push(retries);
      connectCalls += 1;
      if (connectCalls === 1) throw new Error('first retry window exhausted');
      client.connectedTarget = target;
      client.connectionGeneration = 1;
      return 'connected';
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
  };
  let now = 0;

  const connected = await connectExactSessionTarget(
    {
      metroPort: 8081,
      platform: 'ios',
      appId,
      deviceId: 'ios-device-id',
    },
    1_000,
    {
      getClient: () => client as unknown as CDPClient,
      setClient: () => assert.fail('iOS must retain the existing exact client'),
      createClient: () => {
        createCalls += 1;
        return client as unknown as CDPClient;
      },
      execute: async (file, args) => {
        assert.equal(file, 'xcrun');
        assert.deepEqual(args, ['simctl', 'list', 'devices', '--json']);
        return {
          stdout: JSON.stringify({
            devices: {
              runtime: [{ udid: 'ios-device-id', name: 'iPhone 16', state: 'Booted' }],
            },
          }),
        };
      },
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    },
  );

  assert.equal(connected.targetId, target.id);
  assert.deepEqual(retryBudgets, [5, 5]);
  assert.equal(disconnectCalls, 0);
  assert.equal(createCalls, 0);
});
