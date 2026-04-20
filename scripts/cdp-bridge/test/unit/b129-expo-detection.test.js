import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectExpoManifestResponse,
  MetroEventsClient,
} from '../../dist/metro/events-client.js';

/**
 * B129 (D658) regression: MetroEventsClient must detect Expo CLI's /events
 * endpoint (which serves the manifest protocol) and short-circuit instead
 * of holding open a WS that never produces reporter events.
 */

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

function makeFetchReturning(body, ok = true) {
  return async () => ({
    ok,
    text: async () => body,
  });
}

function makeFetchThrowing() {
  return async () => { throw new Error('network error'); };
}

test('MetroEventsClient: Expo /events detection short-circuits before WS (B129)', async () => {
  const expoBody = JSON.stringify({
    runtimeVersion: 'exposdk:52.0.0',
    launchAsset: { url: 'http://x' },
  });
  const client = new MetroEventsClient({
    port: 12345,
    fetchFn: makeFetchReturning(expoBody),
  });

  await client.start();

  assert.equal(client.isConnected, false, 'WS never opened — incompatible endpoint');
  assert.equal(client.incompatibleReason, 'expo-cli-incompatible');
  assert.equal(client.events.size, 0);

  // Second start() call is a no-op; don't retry known-incompatible endpoints
  await client.start();
  assert.equal(client.isConnected, false);
  assert.equal(client.incompatibleReason, 'expo-cli-incompatible');

  client.stop();
});

test('MetroEventsClient: probe failure falls through to WS attempt (not flagged as incompatible)', async () => {
  // Simulates a bare-Metro HTTP GET that errors or times out — we should
  // still try the WS (where bare Metro will accept the upgrade).
  const client = new MetroEventsClient({
    port: 59998, // unreachable; WS will fail too, but probe failure alone mustn't mark incompatible
    fetchFn: makeFetchThrowing(),
    maxReconnectAttempts: 1,
  });

  await client.start();

  // Probe threw → state did NOT become 'incompatible'. WS attempt then failed
  // too (port 59998 unreachable) → reconnect scheduled once, then max exceeded.
  assert.equal(client.incompatibleReason, null, 'probe failure does not mark incompatible');
  assert.equal(client.isConnected, false);
  client.stop();
});

test('MetroEventsClient: non-200 probe response falls through to WS', async () => {
  // Bare Metro may return 426 Upgrade Required on HTTP GET /events. Response
  // is NOT Expo-shaped AND status is non-200 → let the WS handshake proceed.
  const client = new MetroEventsClient({
    port: 59997,
    fetchFn: makeFetchReturning('', false),
    maxReconnectAttempts: 1,
  });

  await client.start();

  assert.equal(client.incompatibleReason, null);
  client.stop();
});

test('MetroEventsClient: L1 — stop() clears incompatibleReason, allowing re-probe on next start()', async () => {
  // Multi-review follow-up from Phase 103 pass: before this fix, stop() left
  // _incompatibleReason set, so if a caller ever called stop()+start() on the
  // same instance (e.g. after Metro restart from Expo to bare), the second
  // start() would short-circuit on the stale reason without re-probing.
  let callCount = 0;
  const expoBody = JSON.stringify({ runtimeVersion: 'exposdk:52.0.0' });
  const bareBody = JSON.stringify({ reporter: 'metro' });
  const fetchFn = async () => ({
    ok: true,
    text: async () => (callCount++ === 0 ? expoBody : bareBody),
  });

  const client = new MetroEventsClient({ port: 59995, fetchFn, maxReconnectAttempts: 1 });

  // First start: Expo detected
  await client.start();
  assert.equal(client.incompatibleReason, 'expo-cli-incompatible');

  // stop() should clear the reason so a subsequent start() re-probes cleanly
  client.stop();
  assert.equal(client.incompatibleReason, null, 'stop() clears incompatibleReason');

  // Second start: bareBody returned this time → probe succeeds → WS attempted
  // (WS will fail because port 59995 is unreachable, but incompatibleReason
  // stays null because this probe returned the non-Expo shape)
  await client.start();
  assert.equal(client.incompatibleReason, null, 'second probe re-runs and returns null on non-Expo body');

  client.stop();
});

test('MetroEventsClient: skipIncompatibilityProbe bypasses the probe', async () => {
  // Tests targeting bare Metro fixtures can skip the probe to go straight
  // to the WS. If the probe would have marked incompatible, skipping lets
  // the WS attempt run.
  let probeCalled = false;
  const client = new MetroEventsClient({
    port: 59996,
    skipIncompatibilityProbe: true,
    fetchFn: async () => { probeCalled = true; return { ok: true, text: async () => 'x' }; },
    maxReconnectAttempts: 1,
  });

  await client.start();

  assert.equal(probeCalled, false, 'probe never invoked when skip flag set');
  client.stop();
});
