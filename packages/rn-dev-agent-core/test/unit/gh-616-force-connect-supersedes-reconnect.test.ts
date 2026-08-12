import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CDPClient } from '../../dist/cdp-client.js';
import { createConnectHandler } from '../../dist/tools/connection.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { reconnect } from '../../dist/cdp/reconnection.js';
import type { ReconnectContext } from '../../dist/cdp/reconnection.js';
import { selectTarget } from '../../dist/cdp/discovery.js';
import {
  stickyPinnedDeviceFilters,
  ConnectionSetupSupersededError,
} from '../../dist/cdp/connect.js';
import { connectExactSessionTarget } from '../../dist/session/connect-exact-session-target.js';
import type { HermesTarget } from '../../dist/types.js';

// GH #616: while a supervised reconnect is in flight, an explicit cdp_connect
// force=true must deterministically supersede it instead of dead-ending on the
// connect.ts "Already connecting to Metro..." guard, and a superseded storm
// must never overwrite the explicit connect's result. On current main the
// registered cdp_connect (pin_dev_client) already supersedes — iOS force
// disposes the storm client before connecting, Android always connects through
// fresh attempt clients — but nothing pinned those semantics, and the exported
// compatibility connector still dead-ended. This file fixes + pins the
// connector and pins the live-path ordering, serialization, and
// stale-completion protections. The second symptom in #616 (reconnect
// re-binding the wrong platform's target) is covered by the sticky device pin
// from GH #625 — pinned here for #616's exact cross-platform shape.

function androidTarget(id: string, deviceName = 'Pixel 8'): HermesTarget {
  return {
    id,
    title: `com.example.app (${deviceName})`,
    vm: 'Hermes',
    description: 'com.example.app',
    appId: 'com.example.app',
    deviceName,
    platform: 'android',
    platformInference: 'probed',
    webSocketDebuggerUrl: `ws://127.0.0.1:8081/inspector/debug?device=${id}`,
  };
}

function iosTarget(id: string, deviceName = 'iPhone 17 Pro'): HermesTarget {
  return {
    ...androidTarget(id, deviceName),
    platform: 'ios',
  };
}

interface StormHarnessOpts {
  reconnectActive?: boolean;
  stormState?: string;
}

function stormHarness(opts: StormHarnessOpts = {}) {
  const events: string[] = [];
  const stormClient = createMockClient({
    _isConnected: false,
    _connectedTarget: null,
    reconnectState: {
      active: opts.reconnectActive ?? true,
      lastAttempt: '2026-08-12T00:00:00.000Z',
      attemptCount: 3,
    },
    state: opts.stormState ?? 'reconnecting',
  });
  stormClient.disconnect = async () => {
    events.push('storm-disconnect');
    (stormClient as { _isConnected: boolean })._isConnected = false;
  };
  stormClient.autoConnect = async () => {
    // Faithful to the connect.ts guard: a client with an in-flight
    // connect/reconnect refuses a concurrent autoConnect.
    events.push('storm-autoConnect');
    throw new Error('Already connecting to Metro...');
  };

  let freshAutoConnectArgs: { port?: number; filters?: Record<string, unknown> } | null = null;
  const freshClient = createMockClient({
    _isConnected: false,
    _connectedTarget: null,
  });
  freshClient.autoConnect = async (port?: number, filters?: Record<string, unknown>) => {
    events.push('fresh-autoConnect');
    freshAutoConnectArgs = { port, filters };
    const mutable = freshClient as unknown as {
      _isConnected: boolean;
      _connectedTarget: HermesTarget;
    };
    mutable._isConnected = true;
    mutable._connectedTarget = androidTarget((filters?.targetId as string) ?? 'android-7-2');
    return 'connected';
  };

  let currentClient = stormClient;
  const handler = createConnectHandler(
    () => currentClient,
    (c) => {
      currentClient = c;
    },
    (port: number) => {
      events.push(`create-client:${port}`);
      return freshClient;
    },
  );
  return {
    handler,
    events,
    stormClient,
    freshClient,
    current: () => currentClient,
    freshArgs: () => freshAutoConnectArgs,
  };
}

test('GH-616: cdp_connect force=true supersedes an active reconnect instead of dead-ending', async () => {
  const h = stormHarness();
  const result = await h.handler({ targetId: 'android-7-2', force: true });
  const data = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    error?: string;
    data?: { connected?: boolean; target?: { id: string } };
  };
  assert.equal(data.ok, true, `expected supersede, got: ${data.error}`);
  assert.equal(data.data?.connected, true);
  assert.equal(data.data?.target?.id, 'android-7-2', 'caller-exact targetId must be preserved');
  assert.deepEqual(
    h.events,
    ['storm-disconnect', 'create-client:8081', 'fresh-autoConnect'],
    'must dispose the storm client BEFORE connecting fresh, and never call the guarded autoConnect',
  );
  assert.equal(h.freshArgs()?.filters?.targetId, 'android-7-2');
});

test('GH-616: a superseded storm cannot overwrite the explicit connect result', async () => {
  const h = stormHarness();
  await h.handler({ targetId: 'android-7-2', force: true });
  // Simulate the old storm loop completing late onto its own (discarded) client.
  const staleStorm = h.stormClient as unknown as {
    _isConnected: boolean;
    _connectedTarget: HermesTarget;
  };
  staleStorm._isConnected = true;
  staleStorm._connectedTarget = iosTarget('ios-13-9');
  assert.equal(
    h.current(),
    h.freshClient,
    'the session client must remain the explicit-connect client, not the storm client',
  );
  assert.equal(h.current().connectedTarget?.platform, 'android');
});

test('GH-616: cdp_connect without force during an active reconnect refuses actionably', async () => {
  const h = stormHarness();
  const result = await h.handler({ targetId: 'android-7-2' });
  const data = JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    error?: string;
    code?: string;
    meta?: { reconnect?: { active?: boolean } };
  };
  assert.equal(data.ok, false);
  assert.equal(
    data.code,
    'CONNECT_IN_FLIGHT',
    'the supersede contract must be machine-detectable, not prose-only',
  );
  assert.equal(data.meta?.reconnect?.active, true, 'the in-flight reconnect state must survive');
  assert.match(
    data.error ?? '',
    /force=true/,
    'refusal must tell the caller how to supersede instead of inviting blind retries',
  );
  assert.ok(
    !h.events.includes('storm-autoConnect'),
    'must refuse deterministically before hitting the low-level guard',
  );
});

test('GH-616: force=true supersedes a concurrent explicit connect (state connecting, no storm flag)', async () => {
  const h = stormHarness({ reconnectActive: false, stormState: 'connecting' });
  const result = await h.handler({ targetId: 'android-7-2', force: true });
  const data = JSON.parse(result.content[0]!.text) as { ok: boolean; error?: string };
  assert.equal(data.ok, true, `expected supersede, got: ${data.error}`);
  assert.deepEqual(h.events, ['storm-disconnect', 'create-client:8081', 'fresh-autoConnect']);
});

test('GH-616: uncontended force connect is unchanged (no disposal churn)', async () => {
  const h = stormHarness({ reconnectActive: false, stormState: 'disconnected' });
  const result = await h.handler({ targetId: 'android-7-2', force: true });
  const data = JSON.parse(result.content[0]!.text) as { ok: boolean; error?: string };
  assert.equal(data.ok, false, 'storm client autoConnect throws in this harness');
  assert.deepEqual(
    h.events,
    ['storm-autoConnect'],
    'a quiet client connects in place: no disconnect, no client recreation',
  );
});

test('GH-616: disposal mid-attempt aborts the supervised reconnect loop without stale completion', async () => {
  const calls = { discover: 0, afterReconnect: 0, states: [] as string[] };
  const state = { disposed: false, reconnecting: true, soft: false };
  const ctx = {
    isDisposed: () => state.disposed,
    isReconnecting: () => state.reconnecting,
    isSoftReconnectRequested: () => state.soft,
    setReconnecting: (v: boolean) => {
      state.reconnecting = v;
    },
    setSoftReconnectRequested: (v: boolean) => {
      state.soft = v;
    },
    setState: (s: string) => {
      calls.states.push(s);
    },
    setReconnectAttempt: () => {},
    closeWs: () => {},
    rejectAllPending: () => {},
    discoverAndConnect: async () => {
      calls.discover++;
      // Faithful to connect.ts: an explicit force connect disposes the client
      // mid-attempt and the attempt surfaces as a superseded error.
      state.disposed = true;
      throw new ConnectionSetupSupersededError();
    },
    getResettableState: () => ({}),
    getPort: () => 8081,
    setBgPollTimer: () => {},
    getBgPollTimer: () => null,
    isConnected: () => false,
    clearActiveState: () => {},
    afterReconnect: async () => {
      calls.afterReconnect++;
    },
  } as unknown as ReconnectContext;

  await reconnect(ctx);
  assert.equal(calls.discover, 1, 'no further attempts after disposal');
  assert.equal(calls.afterReconnect, 0, 'a superseded loop must not fire success hooks');
  assert.equal(state.reconnecting, false, 'loop must release the reconnecting flag');
  assert.ok(
    !calls.states.includes('connected'),
    'a superseded loop must never report a connected state',
  );
});

// --- Live registered-connect path (pin_dev_client → connectExactSessionTarget) ---

const androidSerial = '46828c2c';
const androidModel = 'BE2013';
const androidDeviceName = `${androidModel} - 11 - API 30`;
const sessionAppId = 'com.example.app';

function exactAndroidTarget(id: string): HermesTarget {
  return {
    id,
    title: `${sessionAppId} (OnePlus ${androidModel})`,
    vm: 'Hermes',
    description: 'React Native Bridgeless [C++ connection]',
    appId: sessionAppId,
    deviceName: androidDeviceName,
    platform: 'android',
    platformInference: 'probed',
    webSocketDebuggerUrl: `ws://127.0.0.1:8191/inspector/debug?device=${id}`,
  };
}

const adbExecute = async (file: string, args: string[]) => {
  assert.equal(file, 'adb');
  if (args[0] === 'devices') {
    return { stdout: `List of devices attached\n${androidSerial}\tdevice\n` };
  }
  assert.deepEqual(args, ['-s', androidSerial, 'shell', 'getprop', 'ro.product.model']);
  return { stdout: `${androidModel}\n` };
};

function androidStormFixture() {
  const target = exactAndroidTarget('exact-9-1');
  const ambient = {
    metroPort: 8191,
    disconnectCalls: 0,
    reconnectState: { active: true, lastAttempt: '2026-08-12T00:00:00.000Z', attemptCount: 4 },
    connectExact: async () => {
      assert.fail('the storm-bound ambient client must never be used for an exact connect');
    },
    disconnect: async () => {
      ambient.disconnectCalls += 1;
    },
  };
  const attemptClients: Array<{ disconnectCalls: number }> = [];
  let now = 0;
  let current = ambient as unknown as CDPClient;
  const createAttemptClient = () => {
    const client = {
      metroPort: 8191,
      connectedTarget: null as HermesTarget | null,
      connectionGeneration: attemptClients.length + 1,
      disconnectCalls: 0,
      get isConnected() {
        return client.connectedTarget !== null;
      },
      listTargetsExact: async (port: number) => ({ port, targets: [target] }),
      connectExact: async () => {
        client.connectedTarget = target;
      },
      disconnect: async () => {
        client.disconnectCalls += 1;
        client.connectedTarget = null;
      },
      publishLifecycleState: () => {},
    };
    attemptClients.push(client);
    return client as unknown as CDPClient;
  };
  const dependencies = {
    getClient: () => current,
    setClient: (client: CDPClient) => {
      current = client;
    },
    createClient: createAttemptClient,
    execute: adbExecute,
    now: () => now,
    wait: async (ms: number) => {
      now += ms;
    },
  };
  return {
    target,
    ambient,
    attemptClients,
    dependencies,
    current: () => current,
  };
}

test('GH-616: an Android exact pin connects through fresh clients and supersedes the storm only at publish', async () => {
  const f = androidStormFixture();
  const connected = await connectExactSessionTarget(
    { metroPort: 8191, platform: 'android', appId: sessionAppId, deviceId: androidSerial },
    120_000,
    f.dependencies,
  );
  assert.equal(connected.targetId, f.target.id);
  assert.equal(f.ambient.disconnectCalls, 0, 'the storm client must survive until publish');
  assert.equal(f.current(), f.ambient as unknown as CDPClient, 'no swap before publish');
  connected.publish();
  assert.equal(f.current(), connected.client, 'publish must install the exact client');
  assert.equal(f.ambient.disconnectCalls, 1, 'publish must dispose the superseded storm client');
});

test('GH-616: a staged exact connect refuses to publish over a concurrently superseded client', async () => {
  const f = androidStormFixture();
  const connected = await connectExactSessionTarget(
    { metroPort: 8191, platform: 'android', appId: sessionAppId, deviceId: androidSerial },
    120_000,
    f.dependencies,
  );
  const intruder = { metroPort: 8191 } as unknown as CDPClient;
  f.dependencies.setClient(intruder);
  assert.throws(() => connected.publish(), /CDP_TARGET_AUTHORITY_MISMATCH/);
  assert.equal(
    f.current(),
    intruder,
    'a stale staged result must never overwrite the newer client',
  );
  assert.equal(f.ambient.disconnectCalls, 0, 'the refused publish must not touch the old ambient');
  const staged = f.attemptClients.at(-1)!;
  assert.equal(staged.disconnectCalls, 1, 'the refused staged client must be closed');
});

test('GH-616: an iOS exact pin serializes behind the storm guard instead of dead-ending', async () => {
  const target: HermesTarget = {
    id: 'ios-exact-3',
    title: `${sessionAppId} (iPhone 16)`,
    vm: 'Hermes',
    description: 'React Native Bridgeless [C++ connection]',
    appId: sessionAppId,
    deviceName: 'iPhone 16',
    platform: 'ios',
    platformInference: 'probed',
    webSocketDebuggerUrl: 'ws://127.0.0.1:8081/ios-exact',
  };
  let stormSettled = false;
  let guardRejections = 0;
  const client = {
    metroPort: 8081,
    connectedTarget: null as HermesTarget | null,
    connectionGeneration: 0,
    listTargetsExact: async (port: number) => ({ port, targets: [target] }),
    connectExact: async () => {
      if (!stormSettled) {
        guardRejections += 1;
        if (guardRejections >= 2) stormSettled = true;
        throw new Error('Already connecting to Metro...');
      }
      client.connectedTarget = target;
      client.connectionGeneration = 1;
    },
    disconnect: async () => {
      assert.fail('serialization must not destroy the ambient client');
    },
  };
  let now = 0;
  const connected = await connectExactSessionTarget(
    { metroPort: 8081, platform: 'ios', appId: sessionAppId, deviceId: 'ios-device-id' },
    120_000,
    {
      getClient: () => client as unknown as CDPClient,
      setClient: () => assert.fail('iOS must retain the existing exact client'),
      createClient: () => assert.fail('no replacement client while serializing') as never,
      execute: async (file, args) => {
        assert.equal(file, 'xcrun');
        assert.deepEqual(args, ['simctl', 'list', 'devices', '--json']);
        return {
          stdout: JSON.stringify({
            devices: { runtime: [{ udid: 'ios-device-id', name: 'iPhone 16', state: 'Booted' }] },
          }),
        };
      },
      now: () => now,
      wait: async (ms: number) => {
        now += ms;
      },
    },
  );
  assert.equal(connected.targetId, target.id, 'the exact target must be honored after the storm');
  assert.equal(guardRejections, 2, 'guard rejections must be absorbed, not surfaced as a dead-end');
  assert.ok(now < 120_000, 'serialization must finish well inside the readiness deadline');
});

// --- Symptom 1 of #616 (wrong-platform re-bind) — proof it is closed by GH #625 ---

test('GH-616: a stale Android device pin never re-resolves onto the iOS simulator sibling', () => {
  // Issue 616 journey: Android physical device pinned explicitly, iOS simulator
  // on the SAME Metro holds the newest page id after the Android app restarts.
  const ios = iosTarget('13-9', 'iPhone 17 Pro');
  const android = androidTarget('7-2', 'Pixel 8');
  const result = selectTarget([ios, android], {
    platform: 'android',
    bundleId: 'com.example.app',
    targetId: '3-1', // stale pin from before the restart
    deviceName: 'Pixel 8',
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]!.deviceName, 'Pixel 8');
  assert.equal(result.targets[0]!.platform, 'android');
});

test('GH-616: an explicit Android pin captures durable cross-platform affinity for reconnects', () => {
  const android = androidTarget('7-2', 'Pixel 8');
  const persisted = stickyPinnedDeviceFilters({ targetId: '7-2' }, android);
  assert.ok(persisted, 'an explicit pin with a deviceName must persist affinity');
  assert.equal(persisted!.deviceName, 'Pixel 8');
  assert.equal(persisted!.bundleId, 'com.example.app');
  // The persisted pin plus the sticky platform keeps a later reconnect off the
  // iOS sibling even when the Android page id churned.
  const churned = [iosTarget('14-1', 'iPhone 17 Pro'), androidTarget('9-4', 'Pixel 8')];
  const result = selectTarget(churned, { ...persisted!, platform: 'android' });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]!.id, '9-4');
  assert.equal(result.targets[0]!.platform, 'android');
});
