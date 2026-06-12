import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRestartHandler, _resetRestartHandlerStateForTest } from '../../dist/tools/restart.js';
import { parseEnvelope, expectOk, expectFail } from '../helpers/result-helpers.js';

// Reset module-scoped state (lastSeenBundleId cache, inflight guard) before
// every test — these would otherwise leak across cases and produce
// order-dependent failures (Codex review followup).
beforeEach(() => {
  _resetRestartHandlerStateForTest();
});

// Build a mock CDPClient — only the methods cdp_restart calls.
function makeMockClient({ port = 8081, connected = false, autoConnectImpl, disconnectImpl } = {}) {
  const calls = { disconnect: 0, autoConnect: 0 };
  const client = {
    get metroPort() { return port; },
    get isConnected() { return connected; },
    disconnect: async () => {
      calls.disconnect += 1;
      if (disconnectImpl) return disconnectImpl();
    },
    autoConnect: async (portHint, platform) => {
      calls.autoConnect += 1;
      calls.lastAutoConnect = { portHint, platform };
      if (autoConnectImpl) return autoConnectImpl(portHint, platform);
      connected = true;
      return 'Connected to test';
    },
  };
  return { client, calls };
}

// ── B76 / D644: cdp_restart tool ───────────────────────────────────────

test('cdp_restart: happy path — disconnects old client, creates fresh, reconnects (B76/D644)', async () => {
  const { client: oldClient, calls: oldCalls } = makeMockClient({ port: 8081 });
  const { client: newClient, calls: newCalls } = makeMockClient({ port: 8081 });

  let currentClient = oldClient;
  const getClient = () => currentClient;
  const setClient = (c) => { currentClient = c; };
  const createClient = (port) => { newClient.__requestedPort = port; return newClient; };

  const handler = createRestartHandler(getClient, setClient, createClient);
  const data = expectOk(await handler({}));

  assert.equal(oldCalls.disconnect, 1, 'old client disconnected');
  assert.equal(newCalls.autoConnect, 1, 'new client autoConnect called');
  assert.equal(data.restarted, true);
  assert.equal(data.connected, true);
  assert.equal(data.port, 8081);
  assert.equal(currentClient, newClient, 'setClient swapped to new instance');
});

test('cdp_restart: preserves port when not overridden (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient({ port: 19000 });
  const { client: newClient } = makeMockClient({ port: 19000 });

  let currentClient = oldClient;
  let requestedPort;
  const createClient = (port) => { requestedPort = port; return newClient; };

  const handler = createRestartHandler(() => currentClient, (c) => { currentClient = c; }, createClient);
  await handler({});

  assert.equal(requestedPort, 19000, 'new client uses preserved port');
});

test('cdp_restart: metroPort arg overrides preserved port (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient({ port: 8081 });
  const { client: newClient } = makeMockClient({ port: 8082 });

  let currentClient = oldClient;
  let requestedPort;
  const createClient = (port) => { requestedPort = port; return newClient; };

  const handler = createRestartHandler(() => currentClient, (c) => { currentClient = c; }, createClient);
  await handler({ metroPort: 8082 });

  assert.equal(requestedPort, 8082, 'new client uses overridden port');
});

test('cdp_restart: autoConnect failure returns okResult with connectError + connected:false (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient();
  const { client: newClient } = makeMockClient({
    autoConnectImpl: () => { throw new Error('Metro not found'); },
  });

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  const data = expectOk(await handler({}));

  assert.equal(data.restarted, true);
  assert.equal(data.connected, false);
  assert.match(data.connectError, /Metro not found/);
});

test('cdp_restart: old disconnect failure is non-fatal — new client still created (B76/D644)', async () => {
  const { client: oldClient, calls: oldCalls } = makeMockClient({
    disconnectImpl: async () => { throw new Error('ws already closed'); },
  });
  const { client: newClient, calls: newCalls } = makeMockClient();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  const data = expectOk(await handler({}));

  assert.equal(oldCalls.disconnect, 1, 'disconnect was attempted');
  assert.equal(newCalls.autoConnect, 1, 'new client still created and connected');
  assert.equal(data.restarted, true);
});

test('cdp_restart: passes platform filter through to autoConnect (B76/D644)', async () => {
  const { client: oldClient } = makeMockClient();
  const { client: newClient, calls: newCalls } = makeMockClient();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
  );
  await handler({ platform: 'ios' });

  assert.equal(newCalls.lastAutoConnect.platform, 'ios');
});

// ── GH #105 follow-up: cdp_restart hardReset ─────────────────────────────

/** Build a mock CDPClient that also exposes a connectedTarget for hardReset. */
function makeMockClientWithTarget({ port = 8081, bundleId = 'com.example.app', platform = 'ios' } = {}) {
  const inner = makeMockClient({ port });
  inner.client.connectedTarget = bundleId ? { description: bundleId, platform } : null;
  return inner;
}

/** Capture execFile invocations + return successful stdouts. */
function makeMockExecFile() {
  const calls = [];
  const execFile = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { stdout: '', stderr: '' };
  };
  return { execFile, calls };
}

test('cdp_restart hardReset:true → stops fast-runner + simctl terminate + simctl launch + sleeps + soft-resets (GH #105)', async () => {
  const { client: oldClient } = makeMockClientWithTarget({ port: 8081, bundleId: 'com.rndevagent.testapp' });
  const { client: newClient } = makeMockClient({ port: 8081 });
  const { execFile, calls: execCalls } = makeMockExecFile();
  let stopFastRunnerCalls = 0;
  let sleepCalls = 0;

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    {
      execFile,
      stopFastRunner: () => { stopFastRunnerCalls += 1; },
      sleep: async () => { sleepCalls += 1; },
    },
  );

  const data = expectOk(await handler({ hardReset: true }));

  assert.equal(stopFastRunnerCalls, 1, 'fast-runner killed exactly once');
  assert.equal(execCalls.length, 2, 'simctl invoked twice (terminate + launch)');
  assert.deepEqual(execCalls[0].args, ['simctl', 'terminate', 'booted', 'com.rndevagent.testapp']);
  assert.deepEqual(execCalls[1].args, ['simctl', 'launch', 'booted', 'com.rndevagent.testapp']);
  assert.equal(sleepCalls, 1, 'one sleep after simctl launch, before reconnect');
  assert.equal(data.hardReset, true);
  assert.ok(Array.isArray(data.hardResetSteps), 'reports per-step outcomes');
  assert.match(data.hardResetSteps.join('|'), /stopFastRunner:ok/);
  assert.match(data.hardResetSteps.join('|'), /terminate com\.rndevagent\.testapp:ok/);
  assert.match(data.hardResetSteps.join('|'), /launch com\.rndevagent\.testapp:ok/);
  assert.equal(data.restarted, true);
  assert.equal(data.connected, true, 'soft-reset path still runs after hard-reset');
});

test('cdp_restart hardReset:true skips simctl when bundleId unknown (no connectedTarget)', async () => {
  const { client: oldClient } = makeMockClientWithTarget({ bundleId: null });
  const { client: newClient } = makeMockClient();
  const { execFile, calls: execCalls } = makeMockExecFile();
  let stopFastRunnerCalls = 0;

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    {
      execFile,
      stopFastRunner: () => { stopFastRunnerCalls += 1; },
      sleep: async () => {},
      // GH #262: pin the new strict-app.json fallback + active-session lookups
      // off so this case keeps asserting the genuine no-bundleId skip path —
      // a developer's open session or RN-project cwd must not resolve a real id.
      resolveBundleIdStrict: () => null,
      getSession: () => null,
    },
  );

  const data = expectOk(await handler({ hardReset: true }));

  // stopFastRunner still fires (it's safe to call when no runner is alive)
  // but simctl is skipped because we don't know which bundle to terminate.
  assert.equal(stopFastRunnerCalls, 1);
  assert.equal(execCalls.length, 0, 'no simctl invocations without bundleId');
  assert.match(data.hardResetSteps.join('|'), /skip-simctl:no-bundleId/);
});

test('cdp_restart hardReset:true on android skips simctl (iOS-only for phase 1)', async () => {
  const { client: oldClient } = makeMockClientWithTarget({ bundleId: 'com.example.app', platform: 'android' });
  const { client: newClient } = makeMockClient();
  const { execFile, calls: execCalls } = makeMockExecFile();

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    { execFile, stopFastRunner: () => {}, sleep: async () => {} },
  );

  const data = expectOk(await handler({ hardReset: true }));
  assert.equal(execCalls.length, 0, 'no xcrun simctl on android');
  assert.match(data.hardResetSteps.join('|'), /skip-simctl:platform=android/);
});

test('cdp_restart hardReset:true — simctl terminate failure is non-fatal, launch still attempted', async () => {
  const { client: oldClient } = makeMockClientWithTarget({ bundleId: 'com.example.app' });
  const { client: newClient } = makeMockClient();
  const execCalls = [];
  const execFile = async (cmd, args) => {
    execCalls.push(args);
    if (args[1] === 'terminate') throw new Error('app not running');
    return { stdout: '', stderr: '' };
  };

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    { execFile, stopFastRunner: () => {}, sleep: async () => {} },
  );

  const data = expectOk(await handler({ hardReset: true }));
  assert.equal(execCalls.length, 2, 'launch still attempted after terminate failure');
  assert.match(data.hardResetSteps.join('|'), /simctl terminate:warn/);
  assert.match(data.hardResetSteps.join('|'), /launch com\.example\.app:ok/);
});

test('cdp_restart hardReset omitted/false → no hard-reset side effects (default behavior preserved)', async () => {
  const { client: oldClient } = makeMockClientWithTarget({ bundleId: 'com.example.app' });
  const { client: newClient } = makeMockClient();
  const { execFile, calls: execCalls } = makeMockExecFile();
  let stopFastRunnerCalls = 0;

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    {
      execFile,
      stopFastRunner: () => { stopFastRunnerCalls += 1; },
      sleep: async () => {},
    },
  );

  const data = expectOk(await handler({}));
  assert.equal(stopFastRunnerCalls, 0, 'fast-runner untouched in soft-reset path');
  assert.equal(execCalls.length, 0, 'no simctl in soft-reset path');
  assert.equal(data.hardReset, false);
  assert.equal(data.hardResetSteps, undefined, 'hardResetSteps omitted when not used');
  assert.equal(data.restarted, true);
});

// ── Codex review followup: harden hardReset against second-recovery scenario ──

// Codex #1 (conf 92): after a first hardReset, the new CDPClient's
// connectedTarget is null until autoConnect succeeds. If autoConnect fails
// (Hermes still re-registering on Metro), a second hardReset must still
// know which bundle to terminate. The module-scoped lastSeenBundleId cache
// closes that hole.
test('cdp_restart hardReset: bundleId is cached across calls — second call still drives simctl after first autoConnect fails (Codex #1)', async () => {
  // First call: connectedTarget present → simctl fires + bundleId cached.
  const firstOld = makeMockClientWithTarget({ bundleId: 'com.example.app' }).client;
  const firstNew = makeMockClient({
    autoConnectImpl: () => { throw new Error('Hermes not yet registered'); },
  }).client;
  // Second call's "old" client has no connectedTarget — simulates the post-
  // first-failure state where setClient swapped in a fresh disconnected client.
  const secondOld = makeMockClientWithTarget({ bundleId: null }).client;
  const secondNew = makeMockClient().client;

  const execCalls = [];
  const execFile = async (cmd, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; };

  let currentClient = firstOld;
  let nextNew = firstNew;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => nextNew,
    { execFile, stopFastRunner: () => {}, sleep: async () => {} },
  );

  // First call.
  const first = expectOk(await handler({ hardReset: true }));
  assert.equal(first.connected, false, 'first autoConnect failed as designed');
  assert.equal(first.bundleId, 'com.example.app', 'first call records bundleId in result');
  assert.ok(execCalls.some((a) => a[1] === 'terminate' && a[3] === 'com.example.app'), 'first call did simctl terminate');

  // Prep second call: "old" client now has null target (post-first-failure state).
  currentClient = secondOld;
  nextNew = secondNew;
  execCalls.length = 0;

  const second = expectOk(await handler({ hardReset: true }));
  // The cache MUST keep the bundleId alive so simctl still fires.
  assert.equal(second.bundleId, 'com.example.app', 'second call resolves bundleId from cache, not null target');
  assert.equal(execCalls.length, 2, 'second call still issues simctl terminate + launch from cache');
  assert.ok(!second.hardResetSteps.join('|').includes('skip-simctl:no-bundleId'),
    'second call must NOT degrade to no-bundleId skip');
});

// Codex #1 follow-on: explicit bundleId arg also wins, even if cache is empty.
test('cdp_restart hardReset: explicit bundleId arg overrides everything (Codex #1)', async () => {
  const oldNoTarget = makeMockClientWithTarget({ bundleId: null }).client;
  const newClient = makeMockClient().client;
  const execCalls = [];
  const execFile = async (cmd, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; };

  let currentClient = oldNoTarget;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    { execFile, stopFastRunner: () => {}, sleep: async () => {} },
  );

  const data = expectOk(await handler({ hardReset: true, bundleId: 'com.manual.override' }));
  assert.equal(execCalls.length, 2);
  assert.deepEqual(execCalls[0], ['simctl', 'terminate', 'booted', 'com.manual.override']);
  assert.equal(data.bundleId, 'com.manual.override');
});

// Codex #2 (conf 82): two concurrent hardReset calls must not race on
// simctl side effects + setClient. The second call returns early with a
// clear "in progress" envelope so the user knows to wait.
test('cdp_restart: concurrent calls — second caller short-circuits to restart-in-progress (Codex #2)', async () => {
  const oldClient = makeMockClientWithTarget({ bundleId: 'com.example.app' }).client;
  const newClient = makeMockClient().client;
  const execCalls = [];
  const execFile = async (cmd, args) => { execCalls.push(args); return { stdout: '', stderr: '' }; };
  // Block the 3s sleep step in hardReset so the first call is provably
  // in-flight when the second call lands. sleep is awaited unconditionally
  // in the iOS hardReset path, so we know doRestart pauses here.
  let resolveSleep;
  const sleep = () => new Promise((r) => { resolveSleep = r; });

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    { execFile, stopFastRunner: () => {}, sleep },
  );

  const firstPromise = handler({ hardReset: true });
  // Yield until doRestart has reached the sleep step. Polling because each
  // earlier await consumes a microtask and we don't know exactly how many.
  for (let i = 0; i < 50 && !resolveSleep; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(resolveSleep, 'first call should have reached the sleep step');

  // Second call lands while first is paused on sleep — must short-circuit.
  const second = expectOk(await handler({ hardReset: true }));
  assert.equal(second.restarted, false, 'second caller does not actually restart');
  assert.equal(second.reason, 'restart-in-progress');
  assert.match(second.hint, /already running/);

  // Release sleep, let first finish.
  resolveSleep();
  const first = expectOk(await firstPromise);
  assert.equal(first.restarted, true);
  // The second call must not have triggered any extra simctl side-effects.
  // First call's pair (terminate + launch) is the only one we expect.
  assert.equal(execCalls.filter((a) => a[1] === 'terminate').length, 1, 'simctl terminate fired exactly once across the pair');
  assert.equal(execCalls.filter((a) => a[1] === 'launch').length, 1, 'simctl launch fired exactly once across the pair');
});

// Codex #3 (conf 85): the realistic failure shape — simctl succeeds, but
// Hermes hasn't re-registered when autoConnect runs. Result must include
// hardResetSteps AND connectError together, and connected:false.
test('cdp_restart hardReset + autoConnect failure → reports both hardResetSteps and connectError (Codex #3)', async () => {
  const oldClient = makeMockClientWithTarget({ bundleId: 'com.example.app' }).client;
  const newClient = makeMockClient({
    autoConnectImpl: () => { throw new Error('Failed to connect after 5 attempts.'); },
  }).client;
  const execFile = async () => ({ stdout: '', stderr: '' });

  let currentClient = oldClient;
  const handler = createRestartHandler(
    () => currentClient,
    (c) => { currentClient = c; },
    () => newClient,
    { execFile, stopFastRunner: () => {}, sleep: async () => {} },
  );

  const data = expectOk(await handler({ hardReset: true }));
  assert.equal(data.connected, false);
  assert.match(data.connectError, /Failed to connect/);
  // Both pieces of telemetry must coexist — the user needs to see that the
  // simctl + fast-runner steps DID run, even though the final connect was
  // unsuccessful. Without this, the user can't tell whether to retry
  // (transient) or escalate (something deeper is wrong).
  assert.ok(Array.isArray(data.hardResetSteps), 'hardResetSteps still present despite connect failure');
  assert.match(data.hardResetSteps.join('|'), /stopFastRunner:ok/);
  assert.match(data.hardResetSteps.join('|'), /terminate com\.example\.app:ok/);
  assert.match(data.hardResetSteps.join('|'), /launch com\.example\.app:ok/);
  assert.equal(data.restarted, true, 'restart attempted even if final reconnect failed');
});
