import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { detectExpoManifestResponse, MetroEventsClient } from '../../dist/metro/events-client.js';

// ── Pure detector (detectExpoManifestResponse) ──

test('detectExpoManifestResponse: detects Expo manifest by runtimeVersion', () => {
  const body = JSON.stringify({
    id: 'abc-123',
    createdAt: '2026-04-20T12:00:00Z',
    runtimeVersion: 'exposdk:52.0.0',
    launchAsset: { url: 'http://localhost:8081/bundle' },
  });
  assert.equal(detectExpoManifestResponse(body), true);
});

test('detectExpoManifestResponse: detects Expo manifest by launchAsset.url', () => {
  // No runtimeVersion, but launchAsset.url is present — still Expo
  const body = JSON.stringify({
    id: 'xyz',
    launchAsset: { key: 'bundle', url: 'http://localhost:8081/index.bundle' },
  });
  assert.equal(detectExpoManifestResponse(body), true);
});

test('detectExpoManifestResponse: real Expo SDK 52 manifest shape from test-app', () => {
  // Verbatim shape captured from Story 2 execution against the test-app
  const body = JSON.stringify({
    id: '39cfc49b-ead1-4aa5-9634-2b9580d6e598',
    createdAt: '2026-04-20T16:49:30.983Z',
    runtimeVersion: 'exposdk:52.0.0',
    launchAsset: {
      key: 'bundle',
      contentType: 'application/javascript',
      url: 'http://127.0.0.1:8081/node_modules/expo/AppEntry.bundle?platform=ios',
    },
    assets: [],
    extra: { eas: {}, expoClient: { name: 'rn-dev-agent-test' } },
  });
  assert.equal(detectExpoManifestResponse(body), true);
});

test('detectExpoManifestResponse: non-Expo bodies return false', () => {
  // Empty body
  assert.equal(detectExpoManifestResponse(''), false);
  // Plain text (bare Metro 426 Upgrade Required)
  assert.equal(detectExpoManifestResponse('Upgrade Required'), false);
  // JSON but not Expo-shaped
  assert.equal(detectExpoManifestResponse(JSON.stringify({ reporter: 'ok' })), false);
  // Malformed JSON
  assert.equal(detectExpoManifestResponse('{not valid'), false);
  // Array (not an object — can't be a manifest)
  assert.equal(detectExpoManifestResponse(JSON.stringify([{ runtimeVersion: 'x' }])), false);
});

test('detectExpoManifestResponse: ignores whitespace prefix', () => {
  const body = `   \n\t${JSON.stringify({ runtimeVersion: 'exposdk:52' })}`;
  assert.equal(detectExpoManifestResponse(body), true);
});

test('detectExpoManifestResponse: launchAsset without url field is not enough', () => {
  // A real Metro reporter event might have nested objects; `launchAsset` alone
  // without a string `url` shouldn't trigger the detector.
  const body = JSON.stringify({ launchAsset: { key: 'bundle' } });
  assert.equal(detectExpoManifestResponse(body), false);
});

// ── MetroEventsClient integration ──

test('MetroEventsClient: Expo manifest HTTP response does not block reporter WebSocket', async () => {
  const expoBody = JSON.stringify({
    runtimeVersion: 'exposdk:52.0.0',
    launchAsset: { url: 'http://x' },
  });
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(expoBody);
  });
  const wss = new WebSocketServer({ server, path: '/events' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'bundle_build_done' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = new MetroEventsClient({
    port,
  });
  try {
    await client.start();
    await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (client.events.size > 0) {
          clearTimeout(deadline);
          clearInterval(poll);
          resolve();
        }
      }, 10);
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('Expo reporter event timeout'));
      }, 2_000);
    });
    assert.equal(client.isConnected, true);
    assert.equal(client.lastBuild?.status, 'done');
  } finally {
    client.stop();
    for (const socket of wss.clients) socket.terminate();
    server.closeAllConnections();
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('MetroEventsClient: WebSocket failure resolves and remains stoppable', async () => {
  const client = new MetroEventsClient({
    port: 59998,
    maxReconnectAttempts: 1,
  });

  await client.start();

  assert.equal(client.isConnected, false);
  client.stop();
});
