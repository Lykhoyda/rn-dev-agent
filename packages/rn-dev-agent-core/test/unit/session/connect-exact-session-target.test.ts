import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPClient } from '../../../dist/cdp-client.js';
import {
  connectExactSessionTarget,
  exactSessionTargetReadinessTimeoutMs,
} from '../../../dist/session/connect-exact-session-target.js';

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

test('Android cold setup re-lists only the same exact target within its readiness budget', async () => {
  const exactTarget = {
    id: 'cold-exact-1',
    title: `${appId} (OnePlus ${model})`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8191/exact',
    deviceName: preservedDeviceName,
    platform: 'android' as const,
    platformInference: 'probed' as const,
  };
  const foreignApp = {
    ...exactTarget,
    id: 'foreign-app-1',
    appId: 'com.foreign.app',
    title: `com.foreign.app (OnePlus ${model})`,
    webSocketDebuggerUrl: 'ws://127.0.0.1:8191/foreign-app',
  };
  const foreignDevice = {
    ...exactTarget,
    id: 'foreign-device-1',
    deviceName: 'Pixel 9 - 15 - API 35',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8191/foreign-device',
  };
  let now = 0;
  let attempt = 0;
  let current: CDPClient;
  const listedPorts: number[] = [];
  const connectedTargetIds: string[] = [];
  const lifecycle: string[] = [];
  const disconnectedAttempts: number[] = [];

  const createFixtureClient = (): CDPClient => {
    const clientAttempt = attempt++;
    const client = {
      metroPort: 8191,
      connectedTarget: null as typeof exactTarget | null,
      connectionGeneration: clientAttempt,
      listTargetsExact: async (port: number) => {
        listedPorts.push(port);
        return { port, targets: [exactTarget, foreignApp, foreignDevice] };
      },
      connectExact: async (
        port: number,
        filters: { targetId?: string },
        intent: string,
        retries: number,
      ) => {
        assert.equal(port, 8191);
        assert.equal(intent, 'default');
        assert.equal(retries, 1);
        assert.equal(filters.targetId, exactTarget.id);
        connectedTargetIds.push(filters.targetId);
        if (clientAttempt === 0) {
          lifecycle.push('preflight-responsive', 'context-created', 'setup-stalled');
          now += 53_000;
          throw new Error('CDP timeout (10000ms): Runtime.evaluate during cold setup');
        }
        lifecycle.push('same-target-responsive');
        client.connectedTarget = exactTarget;
      },
      disconnect: async () => {
        disconnectedAttempts.push(clientAttempt);
      },
    };
    return client as unknown as CDPClient;
  };
  current = createFixtureClient();

  const connected = await connectExactSessionTarget(
    exactInput(8191),
    exactSessionTargetReadinessTimeoutMs('android'),
    {
      getClient: () => current,
      setClient: (client) => {
        current = client;
      },
      createClient: () => createFixtureClient(),
      execute: async (file, args) => {
        assert.equal(file, 'adb');
        if (args[0] === 'devices') {
          return { stdout: `List of devices attached\n${serial}\tdevice\n` };
        }
        assert.deepEqual(args, ['-s', serial, 'shell', 'getprop', 'ro.product.model']);
        return { stdout: `${model}\n` };
      },
      now: () => now,
      wait: async (ms) => {
        now += ms;
      },
    },
  );

  assert.equal(exactSessionTargetReadinessTimeoutMs('android'), 120_000);
  assert.equal(connected.targetId, exactTarget.id);
  assert.equal(connected.deviceId, serial);
  assert.deepEqual(lifecycle, [
    'preflight-responsive',
    'context-created',
    'setup-stalled',
    'same-target-responsive',
  ]);
  assert.deepEqual(listedPorts, [8191, 8191]);
  assert.deepEqual(connectedTargetIds, [exactTarget.id, exactTarget.id]);
  assert.deepEqual(disconnectedAttempts, [0]);
  assert.ok(now > 15_000, 'the recovery must exercise more than the iOS readiness budget');
  assert.ok(now < 120_000, 'the Android cold-start recovery must remain bounded');
});

test('Android cold setup failure retains the final actionable leaf when its budget expires', async () => {
  let now = 0;
  const leaf = new Error('CDP timeout (10000ms): Runtime.evaluate during cold setup');
  const target = {
    id: 'cold-exact-1',
    title: `${appId} (OnePlus ${model})`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8191/exact',
    deviceName: preservedDeviceName,
    platform: 'android' as const,
    platformInference: 'probed' as const,
  };
  const client = {
    metroPort: 8191,
    connectedTarget: null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({ port: 8191, targets: [target] }),
    connectExact: async () => {
      now = exactSessionTargetReadinessTimeoutMs('android') + 1;
      throw leaf;
    },
    disconnect: async () => {},
  };

  await assert.rejects(
    connectExactSessionTarget(exactInput(8191), exactSessionTargetReadinessTimeoutMs('android'), {
      getClient: () => client as unknown as CDPClient,
      setClient: () => {},
      createClient: () => client as unknown as CDPClient,
      execute: async (file, args) => {
        assert.equal(file, 'adb');
        if (args[0] === 'devices') {
          return { stdout: `List of devices attached\n${serial}\tdevice\n` };
        }
        return { stdout: `${model}\n` };
      },
      now: () => now,
      wait: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^CDP_TARGET_AUTHORITY_MISMATCH:/);
      assert.match(error.message, /Runtime\.evaluate during cold setup/);
      assert.equal(error.cause, leaf);
      return true;
    },
  );
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
  assert.equal(exactSessionTargetReadinessTimeoutMs('ios'), 15_000);
  assert.deepEqual(retryBudgets, [5, 5]);
  assert.equal(disconnectCalls, 0);
  assert.equal(createCalls, 0);
});
