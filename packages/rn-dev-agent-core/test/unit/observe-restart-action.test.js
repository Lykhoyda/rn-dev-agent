import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservabilityServer } from '../../dist/observability/server.js';
import {
  observeHandler,
  setObserveAuthorityDeps,
  startObserveServer,
  stopObserveServer,
} from '../../dist/tools/observe.js';
import { observeStatePath } from '../../dist/observability/observe-state.js';
import { findProjectRoot } from '../../dist/nav-graph/storage.js';
import { recorder } from '../../dist/observability/recorder.js';

// Pin a unique port for this file so parallel test files can't collide on the
// default 7333 (which would flake via the EADDRINUSE ephemeral fallback).
process.env.RN_AGENT_OBSERVE_PORT = '51733';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test('restart on a running server keeps the recorder timeline and serves again', async () => {
  recorder.record({ tool: 'device_press', params: { testID: 'x' }, status: 'PASS', latencyMs: 5 });
  const before = recorder.snapshot().length;
  assert.ok(before >= 1, 'recorder has at least the seeded event');

  const start = parse(await observeHandler({ action: 'start' }));
  assert.equal(start.ok, true);
  assert.equal(start.data.port, 51733);

  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  assert.match(restart.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // The module-global recorder survives the HTTP server restart.
  assert.equal(recorder.snapshot().length, before);

  // The restarted server actually serves.
  const status = parse(await observeHandler({ action: 'status' }));
  assert.equal(status.data.running, true);

  await observeHandler({ action: 'stop' });
});

test('restart when nothing is running starts fresh', async () => {
  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  await observeHandler({ action: 'stop' });
});

test('startObserveServer is idempotent and returns the same port', async () => {
  const a = await startObserveServer();
  const b = await startObserveServer();
  assert.equal(a.port, b.port);
  await observeHandler({ action: 'stop' });
});

test('stop closes the listening port while the process stays alive', async () => {
  const start = parse(await observeHandler({ action: 'start' }));
  assert.equal(start.data.running, true);
  const url = start.data.url;
  // Listening while running: any HTTP status proves the socket is open
  // (200 = SPA served, 503 = SPA bundle not built in this checkout).
  const before = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
  assert.ok([200, 503].includes(before.status), `unexpected status ${before.status}`);
  const stop = parse(await observeHandler({ action: 'stop' }));
  assert.equal(stop.data.running, false);
  // After a tool-level stop — with this process still alive — the port must
  // refuse connections (fetch rejects with ECONNREFUSED under the hood).
  await assert.rejects(fetch(`${url}/`, { signal: AbortSignal.timeout(2000) }));
});

test('HTTP stop clears the module-owned Observe lifecycle', async () => {
  const start = parse(await observeHandler({ action: 'start' }));
  const response = await fetch(`${new URL(start.data.url).origin}/api/stop`, { method: 'POST' });
  assert.equal(response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const status = parse(await observeHandler({ action: 'status' }));
  assert.equal(status.data.running, false);
});

test('stop racing a pending start closes the server instead of orphaning it', async () => {
  // Deliberately NOT awaited: stop is issued while start's listen() is pending.
  const startP = startObserveServer();
  const stopP = observeHandler({ action: 'stop' });
  const [startRes] = await Promise.all([startP, stopP]);
  // After both settle nothing may be listening on the port start resolved to.
  await assert.rejects(
    fetch(`http://127.0.0.1:${startRes.port}/`, { signal: AbortSignal.timeout(2000) }),
  );
  const status = parse(await observeHandler({ action: 'status' }));
  assert.equal(status.data.running, false);
});

test('authority publication failure rolls back the listening server', async (t) => {
  const port = 51734;
  let unbound = 0;
  setObserveAuthorityDeps({
    resolve: () => ({
      port,
      authority: {
        sessionId: 'session-test',
        claimEpoch: 1,
        instanceId: 'observe-test',
        capability: 'capability-test',
      },
    }),
    bind: () => {
      throw new Error('binding failed');
    },
    unbind: (authority) => {
      if (authority.instanceId === 'observe-test') unbound += 1;
    },
  });
  t.after(async () => {
    await observeHandler({ action: 'stop' });
    setObserveAuthorityDeps(undefined);
  });

  await assert.rejects(startObserveServer(), /binding failed/);
  assert.equal(unbound, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }));
});

// The discovery record is keyed by the resolved RN project root and written
// under the state dir, so both are pinned into tmp for these two tests.
function isolatedDiscoveryRecord(t) {
  const stateHome = mkdtempSync(join(tmpdir(), 'rn-observe-state-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'rn-observe-project-'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'observe-fixture', dependencies: { 'react-native': '0.81.0' } }),
  );
  const priorStateHome = process.env.XDG_STATE_HOME;
  const priorProjectRoot = process.env.RN_PROJECT_ROOT;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.RN_PROJECT_ROOT = projectRoot;
  t.after(() => {
    if (priorStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = priorStateHome;
    if (priorProjectRoot === undefined) delete process.env.RN_PROJECT_ROOT;
    else process.env.RN_PROJECT_ROOT = priorProjectRoot;
    rmSync(stateHome, { force: true, recursive: true });
    rmSync(projectRoot, { force: true, recursive: true });
  });
}

test('an operation-fenced unbind rejection still completes Observe teardown', async (t) => {
  isolatedDiscoveryRecord(t);
  const port = 51735;
  let unbindAttempts = 0;
  setObserveAuthorityDeps({
    resolve: () => ({
      port,
      authority: {
        sessionId: 'session-test',
        claimEpoch: 1,
        instanceId: 'observe-fenced',
        capability: 'capability-test',
      },
    }),
    bind: () => {},
    // The bind_device yield reaches this stop owner through the HTTP route,
    // outside its operation's async context, so the registry rejects the unbind.
    unbind: () => {
      unbindAttempts += 1;
      const error = new Error('authority mutation is not owned by the active operation fence');
      error.code = 'AUTHORITY_LOST_DURING_OPERATION';
      throw error;
    },
  });
  t.after(async () => {
    setObserveAuthorityDeps(undefined);
    await observeHandler({ action: 'stop' });
  });

  const started = await startObserveServer({ autostarted: true });
  const statePath = observeStatePath(findProjectRoot());
  assert.equal(existsSync(statePath), true, 'start publishes the discovery record');

  await stopObserveServer();

  assert.equal(unbindAttempts, 1);
  assert.equal(existsSync(statePath), false, 'the stale discovery record must be removed');
  await assert.rejects(
    fetch(`http://127.0.0.1:${started.port}/`, { signal: AbortSignal.timeout(2000) }),
  );
  // The authority is torn down locally, so a second stop must not retry it.
  await stopObserveServer();
  assert.equal(unbindAttempts, 1);
});

test('an unexpected unbind failure completes teardown and still surfaces', async (t) => {
  isolatedDiscoveryRecord(t);
  const port = 51736;
  setObserveAuthorityDeps({
    resolve: () => ({
      port,
      authority: {
        sessionId: 'session-test',
        claimEpoch: 1,
        instanceId: 'observe-broken',
        capability: 'capability-test',
      },
    }),
    bind: () => {},
    unbind: () => {
      throw new Error('registry unavailable');
    },
  });
  t.after(async () => {
    setObserveAuthorityDeps(undefined);
    await observeHandler({ action: 'stop' });
  });

  await startObserveServer({ autostarted: true });
  const statePath = observeStatePath(findProjectRoot());

  await assert.rejects(stopObserveServer(), /registry unavailable/);
  assert.equal(existsSync(statePath), false);
  const status = JSON.parse((await observeHandler({ action: 'status' })).content[0].text);
  assert.equal(status.data.running, false);
});

test('listen failure preserves a pre-existing Observe binding and state', async (t) => {
  const owner = new ObservabilityServer(recorder);
  const { port } = await owner.start();
  let binding = 'observe-existing';
  let unbound = 0;
  setObserveAuthorityDeps({
    resolve: () => ({
      port,
      authority: {
        sessionId: 'session-test',
        claimEpoch: 1,
        instanceId: 'observe-contender',
        capability: 'capability-test',
      },
    }),
    bind: () => {
      binding = 'observe-contender';
    },
    unbind: (authority) => {
      unbound += 1;
      if (binding === authority.instanceId) binding = '';
    },
  });
  t.after(async () => {
    await owner.stop();
    setObserveAuthorityDeps(undefined);
  });

  await assert.rejects(startObserveServer(), /OBSERVE_PORT_CLAIM_CONFLICT/);
  assert.equal(binding, 'observe-existing');
  assert.equal(unbound, 0);
});
