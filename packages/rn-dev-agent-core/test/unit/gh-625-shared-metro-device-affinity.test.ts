import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { selectTarget } from '../../dist/cdp/discovery.js';
import { discoverAndConnect, stickyPinnedDeviceFilters } from '../../dist/cdp/connect.js';
import type { ConnectContext, ConnectFilters } from '../../dist/cdp/connect.js';
import { captureClientState, forceReconnect } from '../../dist/tools/reload.js';
import type { HermesTarget } from '../../dist/types.js';

// GH #625: two simulators sharing one Metro port are indistinguishable under
// platform+bundle filters, and the pinned targetId is a volatile Metro page id
// that goes stale on every reload. Reconnect affinity must carry the pinned
// target's device identity (deviceName) and fail closed when it cannot be
// re-proven — never silently bind the sibling simulator.

function simTarget(id: string, deviceName: string): HermesTarget {
  return {
    id,
    title: `com.example.app (${deviceName})`,
    vm: 'Hermes',
    description: 'com.example.app',
    appId: 'com.example.app',
    deviceName,
    platform: 'ios',
    platformInference: 'probed',
    webSocketDebuggerUrl: `ws://127.0.0.1:8082/inspector/debug?device=${id}`,
  };
}

test('GH-625: stale pinned targetId re-resolves on the pinned device, never the sibling', () => {
  // Sibling sim A carries the NEWER page id, so an affinity-blind fallback
  // (drop stale pin → newest-page-first sort) would silently pick sim A.
  const simA = simTarget('10-9', 'iPhone 16');
  const simB = simTarget('12-3', 'iPhone 17 Pro');
  const result = selectTarget([simA, simB], {
    platform: 'ios',
    bundleId: 'com.example.app',
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 1, `expected exactly the pinned device's target`);
  assert.equal(result.targets[0]!.deviceName, 'iPhone 17 Pro');
  assert.match(
    result.warning ?? '',
    /stale/i,
    'must disclose that the stale pin was re-resolved by device affinity',
  );
});

test('GH-625: a reused page id on the wrong device cannot escape the pinned device', () => {
  // Metro device numbering can reset (Metro restart), so a stale id may now
  // belong to the SIBLING. Device affinity must outrank the id match.
  const simA = simTarget('10-9', 'iPhone 16');
  const simB = simTarget('12-3', 'iPhone 17 Pro');
  const result = selectTarget([simA, simB], {
    targetId: '10-9', // matches sim A's live id, but the pin was on sim B
    deviceName: 'iPhone 17 Pro',
    bundleId: 'com.example.app',
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]!.deviceName, 'iPhone 17 Pro');
});

test('GH-625: a stale pin without proven bundle identity refuses instead of guessing the app', () => {
  // A device can run several debuggable apps; deviceName alone must not
  // re-resolve a stale pin onto whichever app happens to be newest.
  const simB = simTarget('12-3', 'iPhone 17 Pro');
  const result = selectTarget([simB], {
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 0);
  assert.match(result.warning ?? '', /bundle identity/i);
});

test('GH-625: truthful refusal when the pinned device has no live target', () => {
  const simA = simTarget('10-9', 'iPhone 16');
  const result = selectTarget([simA], {
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 0, 'must not bind the sibling device');
  assert.match(result.warning ?? '', /pinned device/i, 'refusal must name the pinned device');
  assert.match(
    result.warning ?? '',
    /iPhone 16/,
    'refusal must list the live candidates so the caller can re-pin deliberately',
  );
});

test('GH-625: valid pinned targetId on the pinned device still wins exact selection', () => {
  const simA = simTarget('10-9', 'iPhone 16');
  const simB1 = simTarget('12-3', 'iPhone 17 Pro');
  const simB2 = simTarget('12-1', 'iPhone 17 Pro');
  const result = selectTarget([simA, simB1, simB2], {
    targetId: '12-1',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0]!.id, '12-1');
});

test('GH-625: ambiguous same-name devices refuse a device-affinity fallback', () => {
  // Two booted simulators can share a name; distinct live devices get distinct
  // Metro id prefixes. A stale-pin fallback must not guess between them.
  const cloneA = simTarget('12-3', 'iPhone 17 Pro');
  const cloneB = simTarget('13-1', 'iPhone 17 Pro');
  const result = selectTarget([cloneA, cloneB], {
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 0);
  assert.match(result.warning ?? '', /ambiguous/i);
});

test('GH-625: even a live id match refuses when same-name clones are indistinguishable', () => {
  // After a Metro restart page-id counters reset, so a persisted id can
  // collide with a sibling clone — an id match cannot prove device identity
  // when two live devices share the pinned name.
  const cloneA = simTarget('12-3', 'iPhone 17 Pro');
  const cloneB = simTarget('13-1', 'iPhone 17 Pro');
  const result = selectTarget([cloneA, cloneB], {
    targetId: '12-3',
    deviceName: 'iPhone 17 Pro',
  });
  assert.equal(result.targets.length, 0);
  assert.match(result.warning ?? '', /ambiguous/i);
});

test('GH-625: hyphenated device ids still distinguish live device connections', () => {
  const emulatorA = simTarget('emulator-5554-1', 'sdk_gphone64_arm64');
  const emulatorB = simTarget('emulator-5556-2', 'sdk_gphone64_arm64');
  const result = selectTarget([emulatorA, emulatorB], {
    targetId: 'emulator-5554-9',
    deviceName: 'sdk_gphone64_arm64',
  });
  assert.equal(result.targets.length, 0, 'two hyphenated device connections must stay ambiguous');
  assert.match(result.warning ?? '', /ambiguous/i);
});

test('GH-625: multiple pages of one device connection stay resolvable after a stale pin', () => {
  // Bridgeless apps expose several pages under ONE Metro device connection
  // (shared id prefix) — that is normal re-resolution, not ambiguity.
  const pageA = simTarget('12-1', 'iPhone 17 Pro');
  const pageB = simTarget('12-3', 'iPhone 17 Pro');
  const result = selectTarget([pageA, pageB], {
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
    bundleId: 'com.example.app',
  });
  assert.equal(result.targets.length, 2, 'both same-device pages remain candidates');
  assert.equal(result.targets[0]!.id, '12-3', 'newest page first');
});

test('GH-625: behavior without device affinity is unchanged (stale pin still refuses)', () => {
  const simA = simTarget('10-9', 'iPhone 16');
  const result = selectTarget([simA], { targetId: '3-1' });
  assert.equal(result.targets.length, 0);
  assert.match(result.warning ?? '', /targetId "3-1" not found/);
});

test('GH-625: same-device different-app target cannot satisfy a pinned affinity', () => {
  // A second RN app on the pinned simulator must not absorb a stale pin —
  // bundle identity travels with the device affinity.
  const otherApp: HermesTarget = {
    ...simTarget('15-2', 'iPhone 17 Pro'),
    title: 'com.other.app (iPhone 17 Pro)',
    description: 'com.other.app',
    appId: 'com.other.app',
  };
  const simA = simTarget('10-9', 'iPhone 16');
  const result = selectTarget([simA, otherApp], {
    targetId: '3-1',
    deviceName: 'iPhone 17 Pro',
    bundleId: 'com.example.app',
  });
  assert.equal(result.targets.length, 0, 'must refuse, not bind the other app');
});

test('GH-625: stickyPinnedDeviceFilters captures device + bundle identity for an explicit pin', () => {
  const connected = simTarget('12-3', 'iPhone 17 Pro');
  assert.deepEqual(
    stickyPinnedDeviceFilters({ platform: 'ios', targetId: '12-3' }, connected),
    {
      platform: 'ios',
      targetId: '12-3',
      deviceName: 'iPhone 17 Pro',
      bundleId: 'com.example.app',
    },
    'pinned connect must persist the durable device AND bundle identity',
  );
});

test('GH-625: stickyPinnedDeviceFilters refreshes a stale pin to the live target id', () => {
  const connected = simTarget('14-1', 'iPhone 17 Pro');
  assert.deepEqual(
    stickyPinnedDeviceFilters(
      { platform: 'ios', targetId: '12-3', deviceName: 'iPhone 17 Pro' },
      connected,
    ),
    {
      platform: 'ios',
      targetId: '14-1',
      deviceName: 'iPhone 17 Pro',
      bundleId: 'com.example.app',
    },
    'after a device-affinity re-resolve the persisted pin must track the live id',
  );
});

test('GH-625: stickyPinnedDeviceFilters never overwrites an explicit bundleId', () => {
  const connected = simTarget('12-3', 'iPhone 17 Pro');
  const result = stickyPinnedDeviceFilters(
    { platform: 'ios', targetId: '12-3', bundleId: 'com.pinned.app' },
    connected,
  );
  assert.equal(result?.bundleId, 'com.pinned.app');
});

test('GH-625: stickyPinnedDeviceFilters is a no-op when nothing changed', () => {
  const connected = simTarget('12-3', 'iPhone 17 Pro');
  assert.equal(
    stickyPinnedDeviceFilters(
      {
        platform: 'ios',
        targetId: '12-3',
        deviceName: 'iPhone 17 Pro',
        bundleId: 'com.example.app',
      },
      connected,
    ),
    null,
    'stable filters must not trigger redundant setConnectFilters churn',
  );
});

test('GH-625: stickyPinnedDeviceFilters is a no-op without an explicit pin', () => {
  const connected = simTarget('12-3', 'iPhone 17 Pro');
  assert.equal(
    stickyPinnedDeviceFilters({ platform: 'ios' }, connected),
    null,
    'un-pinned connects keep today’s free reconnect behavior',
  );
});

test('GH-625: stickyPinnedDeviceFilters is a no-op when Metro exposes no deviceName', () => {
  const connected: HermesTarget = {
    ...simTarget('12-3', 'iPhone 17 Pro'),
    deviceName: undefined,
  };
  assert.equal(
    stickyPinnedDeviceFilters(
      { platform: 'ios', targetId: '12-3', deviceName: undefined },
      connected,
    ),
    null,
    'no durable identity available — nothing to persist',
  );
});

test('GH-625: captureClientState preserves the pinned device affinity for reload recovery', () => {
  const fake = {
    metroPort: 8082,
    connectedTarget: simTarget('12-3', 'iPhone 17 Pro'),
    proxyDesired: false,
    pinnedDeviceName: 'iPhone 17 Pro',
  };
  const captured = captureClientState(fake as never);
  assert.equal(captured.deviceName, 'iPhone 17 Pro');
});

test('GH-625: forceReconnect without an authority target keeps the pinned device affinity', async () => {
  const seenFilters: ConnectFilters[] = [];
  const newClient = {
    autoConnect: async (_port: number, filters: ConnectFilters) => {
      seenFilters.push(filters);
      return 'connected';
    },
    disconnect: async () => {},
    connectedTarget: { platform: 'ios' },
  };
  const oldClient = { disconnect: async () => {} };
  const result = await forceReconnect(
    oldClient as never,
    () => {},
    () => newClient as never,
    {
      port: 8082,
      platform: 'ios',
      bundleId: 'com.example.app',
      deviceName: 'iPhone 17 Pro',
      proxyWasActive: false,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(
    seenFilters[0]?.deviceName,
    'iPhone 17 Pro',
    'recovery must not silently drop the device pin and bind a sibling simulator',
  );
});

// Connection-level regression: drive the REAL discoverAndConnect filter-merge
// path (the one softReconnect and the handleClose reconnect loop use with
// filters === undefined) against a live local WebSocket endpoint, so a
// regression that wipes or ignores the persisted affinity cannot pass.
const wss = new WebSocketServer({ port: 0 });
const sockets: import('ws').WebSocket[] = [];
wss.on('connection', (socket) => sockets.push(socket));
before(async () => {
  if (!wss.address()) await once(wss, 'listening');
});
after(
  () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.terminate();
      wss.close(() => resolve());
    }),
);

function wsUrl(): string {
  const address = wss.address();
  if (typeof address === 'string' || address === null) throw new Error('ws server not listening');
  return `ws://127.0.0.1:${address.port}`;
}

function liveTarget(id: string, deviceName: string): HermesTarget {
  return { ...simTarget(id, deviceName), webSocketDebuggerUrl: wsUrl() };
}

function fakeCtx() {
  const state = {
    filters: {} as ConnectFilters,
    connected: null as HermesTarget | null,
    ws: null as unknown,
    port: 8082,
    generation: 0,
  };
  const ctx: ConnectContext = {
    isDisposed: () => false,
    isReconnecting: () => false,
    isSoftReconnectRequested: () => false,
    getState: () => 'disconnected',
    setState: () => {},
    getPort: () => state.port,
    setPort: (v: number) => {
      state.port = v;
    },
    getConnectFilters: () => state.filters,
    setConnectFilters: (v: ConnectFilters) => {
      state.filters = v;
    },
    getWs: () => state.ws as never,
    setWs: (ws: unknown) => {
      state.ws = ws;
    },
    setHelpersInjected: () => {},
    setConnectedTarget: (t: HermesTarget | null) => {
      state.connected = t;
    },
    setConnectedAt: () => {},
    now: () => Date.now(),
    incrementConnectionGeneration: () => ++state.generation,
    evaluate: async () => ({ value: true }),
    sendWithTimeout: async () => ({}),
    handleMessage: () => {},
    handleClose: () => {},
    rejectAllPending: () => {},
    setup: async () => {},
    getProxyUrl: () => null,
  };
  return { ctx, state };
}

function fakeDiscover(targets: HermesTarget[]) {
  return async (port: number, filtersOrPlatform?: unknown) => {
    const filters = typeof filtersOrPlatform === 'string' ? {} : (filtersOrPlatform ?? {});
    const { targets: selected, warning, errorCode } = selectTarget(targets, filters);
    return {
      port,
      targets: selected,
      ...(warning ? { warning } : {}),
      ...(errorCode ? { errorCode, candidates: targets } : {}),
    };
  };
}

test('GH-625: reconnect with preserved filters re-binds the pinned device after ids churn', async () => {
  const { ctx, state } = fakeCtx();

  await discoverAndConnect(
    ctx,
    8082,
    { targetId: '12-3' },
    fakeDiscover([liveTarget('10-9', 'iPhone 16'), liveTarget('12-3', 'iPhone 17 Pro')]) as never,
  );
  assert.equal(state.connected?.deviceName, 'iPhone 17 Pro');
  assert.equal(state.filters.deviceName, 'iPhone 17 Pro', 'pin must persist device affinity');
  assert.equal(state.filters.platform, 'ios', 'sticky platform must compose with the device pin');
  assert.equal(state.filters.bundleId, 'com.example.app', 'bundle identity must persist too');

  // App reloads: every page id changes and the SIBLING now has the newest id.
  await discoverAndConnect(
    ctx,
    undefined,
    undefined, // softReconnect semantics — persisted filters drive selection
    fakeDiscover([liveTarget('13-9', 'iPhone 16'), liveTarget('14-1', 'iPhone 17 Pro')]) as never,
  );
  assert.equal(
    state.connected?.deviceName,
    'iPhone 17 Pro',
    'reconnect must re-bind the pinned device, never the sibling simulator',
  );
  assert.equal(state.filters.targetId, '14-1', 'persisted pin must track the live id');
});

test('GH-625: reconnect refuses truthfully when only the sibling device remains', async () => {
  const { ctx } = fakeCtx();
  await discoverAndConnect(
    ctx,
    8082,
    { targetId: '12-3' },
    fakeDiscover([liveTarget('12-3', 'iPhone 17 Pro')]) as never,
  );
  await assert.rejects(
    discoverAndConnect(
      ctx,
      undefined,
      undefined,
      fakeDiscover([liveTarget('13-9', 'iPhone 16')]) as never,
    ),
    // The propagated refusal must both name the pinned device AND disclose the
    // live sibling candidate so the caller can re-pin deliberately.
    /[Pp]inned device[\s\S]*iPhone 16/,
    'must surface the pinned-device refusal with candidates instead of binding the sibling',
  );
});
