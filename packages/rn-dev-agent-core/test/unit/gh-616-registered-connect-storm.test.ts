import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { CDPClient } from '../../dist/cdp-client.js';
import { createRegisteredConnectHandler } from '../../dist/session/registered-connect.js';
import { createSessionHandler } from '../../dist/tools/session.js';
import { pinExactDevClient } from '../../dist/session/dev-client-authority.js';
import { connectExactSessionTarget } from '../../dist/session/connect-exact-session-target.js';
import { buildSignedMetroMarker } from '../../dist/session/metro-authority.js';

// GH #616 reconciliation: the dead-end the user reported ("Already connecting
// to Metro..." rejecting cdp_connect force=true) was filed against v0.70.10,
// where cdp_connect was still registered through the ambient discovery handler
// (the session-bound registration only landed in GH #621). This file drives
// the ACTUAL registered chain — createRegisteredConnectHandler → the real
// session handler's pin_dev_client → the real pinExactDevClient → the real
// connectExactSessionTarget — over a real CDPClient whose supervised reconnect
// is genuinely in flight against a live synthetic Metro, and proves the
// registered tool cannot reproduce that dead-end. Deliberately worst-case: the
// storming client is used as-is with NO disposal, which is strictly weaker
// than the production iOS force path (pinSessionDevClient in index.ts disposes
// the client first — pinned below by source assertion, gh-584 precedent,
// because that function is module-private).

const appId = 'com.example.app';
const deviceId = 'ios-device-id';
const deviceName = 'iPhone 16';
const signerCapability = randomBytes(32).toString('base64url');
const sessionId = 'gh616-session';
const metroInstanceId = 'gh616-metro';
const worktreeKey = 'gh616-worktree';
const buildGeneration = 1;

let port = 0;
let appAlive = true;
let pageSerial = 0;
let currentPageId = '';
const sockets = new Set<WebSocket>();

function registerPage(): string {
  pageSerial += 1;
  currentPageId = `7-${pageSerial}`;
  return currentPageId;
}

const server: Server = createServer((request, response) => {
  if (!request.url?.startsWith('/json')) {
    response.writeHead(404).end();
    return;
  }
  const targets = appAlive
    ? [
        {
          id: currentPageId,
          title: `${appId} (${deviceName})`,
          description: appId,
          appId,
          vm: 'Hermes',
          type: 'node',
          deviceName,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=${currentPageId}`,
        },
      ]
    : [];
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(targets));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as { id: number; method: string };
    socket.send(
      JSON.stringify({
        id: message.id,
        result:
          message.method === 'Runtime.evaluate' ? { result: { type: 'boolean', value: true } } : {},
      }),
    );
  });
});

await new Promise<void>((resolve, reject) => {
  server.listen(0, '127.0.0.1', resolve);
  server.once('error', reject);
});
port = (server.address() as AddressInfo).port;
registerPage();

after(async () => {
  for (const socket of sockets) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const execute = async (file: string, args: string[]) => {
  assert.equal(file, 'xcrun');
  assert.deepEqual(args, ['simctl', 'list', 'devices', '--json']);
  return {
    stdout: JSON.stringify({
      devices: { runtime: [{ udid: deviceId, name: deviceName, state: 'Booted' }] },
    }),
  };
};

interface Harness {
  client: CDPClient;
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registryCalls: string[];
}

async function stormHarness(): Promise<Harness> {
  appAlive = true;
  registerPage();
  const client = new CDPClient(port);
  await client.connectExact(port, { targetId: currentPageId }, 'default', 5);
  assert.equal(client.isConnected, true, 'storm harness must start from a live connection');

  // Kill the app: server-side sockets drop, Metro lists no targets, and the
  // REAL supervised reconnect loop starts failing attempts with backoff.
  appAlive = false;
  for (const socket of sockets) socket.terminate();
  const stormDeadline = Date.now() + 10_000;
  while (Date.now() < stormDeadline && !client.reconnectState.active) await sleep(50);
  assert.equal(client.reconnectState.active, true, 'supervised reconnect must be in flight');

  const registryCalls: string[] = [];
  const status = () => ({
    available: true as const,
    sessionId,
    claimEpoch: 1,
    authorityVersion: 3,
    state: 'ready',
    source: { kind: 'git', appRoot: '/project', contentRoot: '/project' },
    worktreeKey,
    bindings: {
      metroPort: port,
      install: {
        platform: 'ios',
        deviceId,
        appId,
        metroPort: port,
        buildGeneration,
        buildKind: 'bare-react-native',
        artifactDigest: 'digest',
      },
      metro: { port, instanceId: metroInstanceId, buildGeneration, mode: 'external' },
      device: { platform: 'ios', deviceId, appId },
      bundle: { targetId: 'stale-target-0' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  });
  const registry = {
    getSessionStatus: () => status(),
    releaseResources: (_session: unknown, resources: Array<{ key: string }>) => {
      registryCalls.push(`release:${resources[0]!.key}`);
    },
    claimResources: () => registryCalls.push('claim'),
    updateBindings: (
      _session: unknown,
      update: {
        bindings: { bundle?: unknown };
        assertBeforeCommit?: () => void;
        onCommitted?: () => void;
      },
    ) => {
      update.assertBeforeCommit?.();
      update.onCommitted?.();
      registryCalls.push(update.bindings.bundle === null ? 'clear-bundle' : 'bind-bundle');
    },
  };
  const runtime = {
    status,
    requireOperational: () => ({ registry, session: { sessionId, claimEpoch: 1 } }),
    refreshRecoveryHandles: () => {},
  };

  // Faithful pinSessionDevClient delegation MINUS its iOS-force disposal: the
  // storming client stays in place, so the registered chain is exercised in a
  // strictly harder configuration than production force semantics.
  const pinDevClient = async (
    pinStatus: { bindings: Record<string, unknown> },
    _options: { force: boolean },
    commitBundle: (bundle: unknown, promotion: unknown) => void,
  ) => {
    const device = pinStatus.bindings.device as {
      platform: 'ios';
      deviceId: string;
      appId: string;
    };
    const metro = pinStatus.bindings.metro as { port: number; instanceId: string };
    return pinExactDevClient(
      {
        sessionId,
        metroInstanceId: metro.instanceId,
        worktreeKey,
        appId: device.appId,
        platform: device.platform,
        buildGeneration,
        deviceId: device.deviceId,
        metroPort: metro.port,
        runtimeKind: 'bare-react-native',
        signerCapability,
      },
      {
        openUrl: async () => assert.fail('bare runtime must not deep-link'),
        launchExactAppWithInitialUrl: async () => assert.fail('bare runtime has no initial URL'),
        acceptIosOpenDialog: async () => {},
        launchExactApp: async () => {
          appAlive = true;
          registerPage();
        },
        connectExact: (input) =>
          connectExactSessionTarget(input, 30_000, {
            getClient: () => client,
            setClient: () => assert.fail('iOS exact connect must retain the existing client'),
            createClient: () => assert.fail('no replacement client on the iOS path') as never,
            execute,
          }),
        readMarker: async () => ({
          status: 'signed' as const,
          marker: buildSignedMetroMarker(
            { sessionId, metroInstanceId, worktreeKey, appId, platform: 'ios', buildGeneration },
            signerCapability,
          ),
        }),
        commitBundle: (bundle, promotion) => commitBundle(bundle, promotion),
      },
    );
  };

  const sessionHandler = createSessionHandler(runtime as never, { pinDevClient } as never);
  const handler = createRegisteredConnectHandler(runtime as never, (input) =>
    sessionHandler(input as never),
  );
  return { client, handler, registryCalls };
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

test('registered cdp_connect force=true completes over an in-flight supervised reconnect', async () => {
  const h = await stormHarness();
  try {
    const raw = await h.handler({ force: true });
    const data = parse(raw);
    assert.equal(
      data.ok,
      true,
      `registered force connect must not dead-end: ${JSON.stringify(data)}`,
    );
    assert.ok(
      !raw.content[0]!.text.includes('Already connecting'),
      'the low-level guard error must never surface through the registered tool',
    );
    assert.equal(h.client.isConnected, true, 'the session client must end connected');
    assert.equal(h.client.connectedTarget?.id, currentPageId, 'must bind the live exact target');
    assert.ok(h.registryCalls.includes('bind-bundle'), 'the pin must commit the bundle binding');
  } finally {
    await h.client.disconnect().catch(() => {});
  }
});

test('registered cdp_connect without force also completes over the storm (serializes, no dead-end)', async () => {
  const h = await stormHarness();
  try {
    const raw = await h.handler({});
    const data = parse(raw);
    assert.equal(data.ok, true, `registered non-force connect dead-ended: ${JSON.stringify(data)}`);
    assert.ok(!raw.content[0]!.text.includes('Already connecting'));
    assert.equal(h.client.connectedTarget?.id, currentPageId);
  } finally {
    await h.client.disconnect().catch(() => {});
  }
});

test('index.ts production pin disposes the storm-bound client before an iOS force connect', () => {
  // pinSessionDevClient is module-private in index.ts, so its storm-relevant
  // disposal seam is pinned by source assertion (gh-584 precedent). Production
  // force is therefore strictly SAFER than the storm-in-place configuration
  // the two tests above already prove cannot dead-end.
  const source = readFileSync(
    fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    'utf8',
  );
  const pin = source.slice(source.indexOf('async function pinSessionDevClient'));
  const disposal = pin.slice(0, pin.indexOf('pinExactDevClient'));
  assert.match(disposal, /if \(options\.force\) \{\s*await current\.disconnect\(\);/);
  assert.match(disposal, /setClient\(createClient\(metro\.port\)\);/);
});
