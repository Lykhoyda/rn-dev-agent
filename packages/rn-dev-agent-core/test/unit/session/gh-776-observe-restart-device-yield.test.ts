import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  observeHandler,
  setObserveAuthorityDeps,
  startObserveServer,
  stopObserveServer,
} from '../../../dist/tools/observe.js';
import { createSessionHandler } from '../../../dist/tools/session.js';

// Pinned so this file cannot collide with the other Observe test file or the
// default 7333 under --test-concurrency.
process.env.RN_AGENT_OBSERVE_PORT = '51751';
const OBSERVE_PORT = 51751;

type Binding = Record<string, unknown> | null;

function harness() {
  const status: Record<string, unknown> = {
    sessionId: 'session-776',
    state: 'source_bound',
    claimEpoch: 1,
    authorityVersion: 5,
    leaseUntilMs: 100,
    source: { kind: 'git' },
    bindings: { observe: null, observePort: OBSERVE_PORT, metroPort: 8081 },
    claims: [
      { type: 'observe-port', key: String(OBSERVE_PORT), sessionId: 'session-776', claimEpoch: 1 },
    ],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const bindings = status.bindings as Record<string, Binding | number>;

  // Mirrors the production wiring in src/index.ts: the observe tool's bind dep
  // writes the caller-vs-autostart provenance straight into the session's
  // observe binding, which is the record bind_device later reads.
  setObserveAuthorityDeps({
    resolve: () => ({
      port: OBSERVE_PORT,
      authority: {
        sessionId: 'session-776',
        claimEpoch: 1,
        instanceId: 'observe-instance',
        capability: 'capability-test',
      },
    }),
    bind: ({ port, authority, autostarted }) => {
      bindings.observe = {
        port,
        sessionId: authority.sessionId,
        claimEpoch: authority.claimEpoch,
        instanceId: authority.instanceId,
        cleanupCapability: authority.capability,
        pid: 456,
        processBirth: 'observe-birth',
        autostarted,
      };
    },
    unbind: () => {
      bindings.observe = null;
    },
  });

  const handler = createSessionHandler(
    {
      status: () => ({ available: true, ...status }),
      requireOperational: () => ({
        registry: {
          getSessionStatus: () => status,
          updateBindings: (_session: unknown, update: { bindings: Record<string, unknown> }) => {
            Object.assign(bindings, update.bindings);
          },
          inspectDeviceAuthorityAvailability: () => {},
          replaceDeviceAuthority: () => {},
        },
        session: { sessionId: 'session-776', claimEpoch: 1 },
      }),
    } as never,
    {
      // The real yield stops the real Observe server through this dep.
      stopHandoffObserve: async () => {
        await stopObserveServer();
      },
      deviceExists: () => true,
    },
  );

  const bindDevice = async () =>
    JSON.parse(
      (
        await handler({
          action: 'bind_device',
          platform: 'android',
          deviceId: 'emulator-5554',
          appId: 'com.example.app',
        } as never)
      ).content[0]!.text,
    );

  return { bindings, bindDevice };
}

async function listening(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

test('an explicit observe restart forfeits the automatic bind_device device yield', async (t) => {
  const { bindings, bindDevice } = harness();
  t.after(async () => {
    await stopObserveServer();
    setObserveAuthorityDeps(undefined);
  });

  // 1. Session autostart — the documented "yields automatically" case.
  await startObserveServer({ autostarted: true });
  assert.equal((bindings.observe as Record<string, unknown>).autostarted, true);
  assert.equal(await listening(OBSERVE_PORT), true, 'autostarted Observe is serving');

  const yielded = await bindDevice();
  assert.equal(yielded.ok, true, JSON.stringify(yielded));
  assert.equal(yielded.data.observeYielded, true);
  assert.equal(yielded.data.observePort, OBSERVE_PORT);
  assert.equal(bindings.observe, null, 'the yield released the device axis');
  assert.equal(await listening(OBSERVE_PORT), false, 'the yield actually stopped the server');

  // 2. The caller brings Observe back with the documented `restart`.
  const restart = JSON.parse((await observeHandler({ action: 'restart' })).content[0]!.text);
  assert.equal(restart.ok, true, JSON.stringify(restart));
  assert.equal(restart.data.running, true);
  assert.equal(
    (bindings.observe as Record<string, unknown>).autostarted,
    false,
    'a caller-issued restart is recorded as caller-owned, not autostarted',
  );

  // 3. The next bind_device refuses instead of yielding again.
  const refused = await bindDevice();
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.match(String(refused.error), /explicitly started Observe/);
  assert.match(String(refused.meta?.nextAction ?? ''), /observe action "stop"/);
  assert.equal(refused.data?.observeYielded, undefined, 'no yield is reported on the refusal');
  assert.notEqual(bindings.observe, null, 'the refusal left the binding in place');
  assert.equal(await listening(OBSERVE_PORT), true, 'the refusal left Observe running');

  // 4. The documented remedy clears the refusal.
  await observeHandler({ action: 'stop' });
  assert.equal(bindings.observe, null);
  const afterStop = await bindDevice();
  assert.equal(afterStop.ok, true, JSON.stringify(afterStop));
  assert.equal(afterStop.data.observeYielded, undefined, 'nothing left to yield');
});

test('an explicit observe start forfeits the automatic bind_device device yield', async (t) => {
  const { bindings, bindDevice } = harness();
  t.after(async () => {
    await stopObserveServer();
    setObserveAuthorityDeps(undefined);
  });

  const start = JSON.parse((await observeHandler({ action: 'start' })).content[0]!.text);
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.equal((bindings.observe as Record<string, unknown>).autostarted, false);

  const refused = await bindDevice();
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.match(String(refused.meta?.nextAction ?? ''), /Only the session-autostarted Observe/);
  assert.equal(await listening(OBSERVE_PORT), true, 'the refusal left Observe running');
});
