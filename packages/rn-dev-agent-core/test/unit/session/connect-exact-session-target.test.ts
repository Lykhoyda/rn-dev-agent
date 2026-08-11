import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPClient } from '../../../dist/cdp-client.js';
import { CDPProbeTimeoutError } from '../../../dist/cdp/connect.js';
import {
  AndroidExactTargetDeadlineError,
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

class FakeDeadlineClock {
  nowMs = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;
  setTimer = (callback: () => void, ms: number): number => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowMs + ms, callback });
    return id;
  };
  clearTimer = (id: unknown): void => {
    this.timers.delete(id as number);
  };
  advance(ms: number): void {
    this.nowMs += ms;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= this.nowMs)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue;
      timer.callback();
    }
  }
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
}

function deadlineFixture(overrides: {
  listTargetsExact?: () => Promise<unknown>;
  connectExact?: () => Promise<void>;
  execute?: (file: string, args: string[]) => Promise<{ stdout: string }>;
}) {
  const clock = new FakeDeadlineClock();
  const target = {
    id: 'deadline-exact-1',
    title: `${appId} (OnePlus ${model})`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8191/exact',
    deviceName: preservedDeviceName,
    platform: 'android' as const,
    platformInference: 'probed' as const,
  };
  const ambient = {
    metroPort: 8191,
    disconnectCalls: 0,
    disconnect: async () => {
      ambient.disconnectCalls += 1;
    },
  };
  const clients: Array<{
    metroPort: number;
    connectedTarget: typeof target | null;
    connectionGeneration: number;
    readonly isConnected: boolean;
    disconnectCalls: number;
    listTargetsExact(port: number): Promise<unknown>;
    connectExact(): Promise<void>;
    disconnect(): Promise<void>;
  }> = [];
  let current = ambient as unknown as CDPClient;
  const createClient = () => {
    const client = {
      metroPort: 8191,
      connectedTarget: null as typeof target | null,
      connectionGeneration: 1,
      get isConnected() {
        return client.connectedTarget !== null;
      },
      disconnectCalls: 0,
      listTargetsExact: async (port: number) =>
        overrides.listTargetsExact?.() ?? { port, targets: [target] },
      connectExact: async () => {
        if (overrides.connectExact) return overrides.connectExact();
        client.connectedTarget = target;
      },
      disconnect: async () => {
        client.disconnectCalls += 1;
        client.connectedTarget = null;
      },
      publishLifecycleState: () => {},
    };
    clients.push(client);
    return client as unknown as CDPClient;
  };
  return {
    clock,
    target,
    ambient,
    clients,
    get current() {
      return current;
    },
    dependencies: {
      getClient: () => current,
      setClient: (client: CDPClient) => {
        current = client;
      },
      createClient,
      execute:
        overrides.execute ??
        (async (_file: string, args: string[]) => ({
          stdout:
            args[0] === 'devices' ? `List of devices attached\n${serial}\tdevice\n` : `${model}\n`,
        })),
      now: clock.now,
      setDeadlineTimer: clock.setTimer,
      clearDeadlineTimer: clock.clearTimer,
      wait: async (ms: number) => {
        clock.advance(ms);
      },
    },
  };
}

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
    connected.publish();
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
    connected.publish();
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
      get isConnected() {
        return client.connectedTarget !== null;
      },
      publishLifecycleState: () => {},
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
  current = {
    metroPort: 8191,
    disconnect: async () => assert.fail('ambient client must not be closed'),
  } as unknown as CDPClient;

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
  assert.equal(current.metroPort, 8191, 'the ambient client remains published before commit');
  connected.cancel();
  assert.deepEqual(lifecycle, [
    'preflight-responsive',
    'context-created',
    'setup-stalled',
    'same-target-responsive',
  ]);
  assert.deepEqual(listedPorts, [8191, 8191]);
  assert.deepEqual(connectedTargetIds, [exactTarget.id, exactTarget.id]);
  assert.deepEqual(disconnectedAttempts, [0, 1]);
  assert.ok(now > 15_000, 'the recovery must exercise more than the legacy 15s readiness window');
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

test('Android non-returning connect is detached at the absolute deadline and only its owned client closes', async () => {
  const fixture = deadlineFixture({ connectExact: () => new Promise<void>(() => {}) });
  const pending = connectExactSessionTarget(
    exactInput(8191),
    exactSessionTargetReadinessTimeoutMs('android'),
    fixture.dependencies,
  );
  await flushPromises();
  fixture.clock.advance(119_999);
  await flushPromises();
  assert.equal(fixture.clients[0]?.disconnectCalls, 0);
  fixture.clock.advance(1);
  await assert.rejects(pending, AndroidExactTargetDeadlineError);
  assert.equal(fixture.clock.nowMs, 120_000, 'fake scheduler has zero deadline tolerance');
  assert.equal(fixture.clients[0]?.disconnectCalls, 1);
  assert.equal(fixture.ambient.disconnectCalls, 0, 'foreign ambient resources remain untouched');
  assert.equal(fixture.current, fixture.ambient, 'late attempt state must not remain accepted');
});

test('Android rejects list success delivered after expiry and cleans only the exact owned client', async () => {
  let releaseList!: (value: unknown) => void;
  const fixture = deadlineFixture({
    listTargetsExact: () => new Promise((resolve) => (releaseList = resolve)),
  });
  const pending = connectExactSessionTarget(exactInput(8191), 120_000, fixture.dependencies);
  await flushPromises();
  fixture.clock.advance(120_000);
  releaseList({ port: 8191, targets: [fixture.target] });
  await assert.rejects(pending, AndroidExactTargetDeadlineError);
  await flushPromises();
  assert.equal(fixture.clients[0]?.disconnectCalls, 1);
  assert.equal(fixture.clients[0]?.connectedTarget, null);
  assert.equal(fixture.ambient.disconnectCalls, 0);
  assert.equal(fixture.current, fixture.ambient);
});

test('Android filter cancellation does not start a follow-on device query after expiry', async () => {
  let releaseDevices!: (value: { stdout: string }) => void;
  const calls: string[][] = [];
  const fixture = deadlineFixture({
    execute: async (_file, args) => {
      calls.push(args);
      return new Promise((resolve) => (releaseDevices = resolve));
    },
  });
  const pending = connectExactSessionTarget(exactInput(8191), 120_000, fixture.dependencies);
  await flushPromises();
  fixture.clock.advance(120_000);
  releaseDevices({ stdout: `List of devices attached\n${serial}\tdevice\n` });
  await assert.rejects(pending, AndroidExactTargetDeadlineError);
  await flushPromises();
  assert.deepEqual(calls, [['devices']], 'no getprop operation may start after cancellation');
  assert.equal(fixture.current, fixture.ambient);
});

test('Android rejects connect/setup success delivered after expiry and rolls back late client state', async () => {
  let releaseSetup!: () => void;
  const fixture = deadlineFixture({
    connectExact: () =>
      new Promise<void>((resolve) => {
        releaseSetup = () => {
          fixture.clients[0]!.connectedTarget = fixture.target;
          resolve();
        };
      }),
  });
  const pending = connectExactSessionTarget(exactInput(8191), 120_000, fixture.dependencies);
  await flushPromises();
  assert.equal(typeof releaseSetup, 'function');
  fixture.clock.advance(120_000);
  releaseSetup();
  await assert.rejects(pending, AndroidExactTargetDeadlineError);
  await flushPromises();
  assert.equal(fixture.clients[0]?.disconnectCalls, 1);
  assert.equal(fixture.current, fixture.ambient, 'late setup may mutate only its detached client');
});

test('Android rejects device-proof success after expiry and cannot accept a late target mutation', async () => {
  let modelCalls = 0;
  let releaseProof!: (value: { stdout: string }) => void;
  const fixture = deadlineFixture({
    execute: async (_file, args) => {
      if (args[0] === 'devices') return { stdout: `List of devices attached\n${serial}\tdevice\n` };
      modelCalls += 1;
      if (modelCalls === 1) return { stdout: `${model}\n` };
      return new Promise((resolve) => (releaseProof = resolve));
    },
  });
  const pending = connectExactSessionTarget(exactInput(8191), 120_000, fixture.dependencies);
  await flushPromises();
  assert.equal(typeof releaseProof, 'function', 'the final device-proof await must be in flight');
  fixture.clock.advance(120_000);
  releaseProof({ stdout: `${model}\n` });
  await assert.rejects(pending, AndroidExactTargetDeadlineError);
  await flushPromises();
  assert.equal(fixture.clients[0]?.connectedTarget, null);
  assert.equal(fixture.current, fixture.ambient);
});

test('Android refuses a staged client whose socket closes during final device proof', async () => {
  let modelCalls = 0;
  const fixture = deadlineFixture({
    execute: async (_file, args) => {
      if (args[0] === 'devices') return { stdout: `List of devices attached\n${serial}\tdevice\n` };
      modelCalls += 1;
      if (modelCalls === 2) fixture.clients[0]!.connectedTarget = null;
      return { stdout: `${model}\n` };
    },
  });

  const connected = await connectExactSessionTarget(
    exactInput(8191),
    120_000,
    fixture.dependencies,
  );
  assert.equal(fixture.clients.length, 2, 'the disconnected staged client must not be accepted');
  assert.equal(fixture.clients[0]?.disconnectCalls, 1);
  assert.equal(connected.client, fixture.clients[1] as unknown as CDPClient);
  assert.equal(fixture.current, fixture.ambient);
  connected.cancel();
});

test('Android deadline preserves an earlier probe-timeout authority leaf over a late failure', async () => {
  const strongLeaf = new CDPProbeTimeoutError('CDP probe timeout: exact target JS thread paused');
  let connectCalls = 0;
  const fixture = deadlineFixture({
    connectExact: async () => {
      connectCalls += 1;
      if (connectCalls === 1) throw strongLeaf;
      return new Promise<void>((_resolve, reject) => {
        fixture.clock.setTimer(() => reject(new Error('late generic setup failure')), 120_000);
      });
    },
  });
  const pending = connectExactSessionTarget(exactInput(8191), 120_000, fixture.dependencies);
  await flushPromises();
  fixture.clock.advance(120_000);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AndroidExactTargetDeadlineError);
    assert.match(error.message, /CDP probe timeout: exact target JS thread paused/);
    assert.equal(error.cause, strongLeaf);
    return true;
  });
});

test('Android success strictly before expiry remains accepted', async () => {
  const fixture = deadlineFixture({});
  const connected = await connectExactSessionTarget(
    exactInput(8191),
    120_000,
    fixture.dependencies,
  );
  assert.equal(connected.targetId, fixture.target.id);
  assert.equal(fixture.clients[0]?.disconnectCalls, 0);
  assert.equal(fixture.current, fixture.ambient, 'success remains staged before publication');
  connected.publish();
  assert.equal(fixture.current, fixture.clients[0] as unknown as CDPClient);
  assert.equal(fixture.ambient.disconnectCalls, 1);
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
  assert.equal(exactSessionTargetReadinessTimeoutMs('ios'), 120_000);
  assert.deepEqual(retryBudgets, [5, 5]);
  assert.equal(disconnectCalls, 0);
  assert.equal(createCalls, 0);
});

// GH #750: Expo dev-client re-registration after the managed terminate+relaunch
// exceeded the old 15s iOS window, so every cdp_connect reported "found 0" for
// a target cdp_targets could prove moments later. The readiness budget must
// outlast a >15s re-registration on the exact device.
test('iOS admits the sole exact-device target that re-registers after more than 15 seconds', async () => {
  const target = {
    id: 'ios-late-exact-1',
    title: `${appId} (iPhone 17 Pro)`,
    description: 'React Native Bridgeless [C++ connection]',
    appId,
    type: 'node',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/ios-late',
    deviceName: 'iPhone 17 Pro',
    platform: 'ios',
    platformInference: 'probed',
  };
  let now = 0;
  const registrationAtMs = 40_000;
  const client = {
    metroPort: 8081,
    connectedTarget: null as typeof target | null,
    connectionGeneration: 0,
    listTargetsExact: async () => ({
      port: 8081,
      targets: now >= registrationAtMs ? [target] : [],
    }),
    connectExact: async () => {
      client.connectedTarget = target;
      client.connectionGeneration = 1;
    },
    disconnect: async () => {},
  };

  const connected = await connectExactSessionTarget(
    { metroPort: 8081, platform: 'ios', appId, deviceId: 'ios-device-id' },
    exactSessionTargetReadinessTimeoutMs('ios'),
    {
      getClient: () => client as unknown as CDPClient,
      setClient: () => assert.fail('iOS must retain the existing exact client'),
      createClient: () => client as unknown as CDPClient,
      execute: async (file, args) => {
        assert.equal(file, 'xcrun');
        assert.deepEqual(args, ['simctl', 'list', 'devices', '--json']);
        return {
          stdout: JSON.stringify({
            devices: {
              runtime: [{ udid: 'ios-device-id', name: 'iPhone 17 Pro', state: 'Booted' }],
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
  assert.equal(connected.deviceId, 'ios-device-id');
  assert.ok(now >= registrationAtMs, 'admission must have waited for the late re-registration');
  assert.ok(now < 120_000, 'the iOS readiness budget must remain bounded');
});
