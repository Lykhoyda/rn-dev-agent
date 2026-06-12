// GH #262: when detached-recovery reports 'app-not-installed', cdp_status
// returns the distinct APP_NOT_INSTALLED code with install advice (incl. a
// shell-quoted snapshot reinstall line when a hint exists) — instead of the
// generic APP_DETACHED "relaunch manually / hardReset" advice that can never
// work for a missing bundle. status.ts also injects the tools-layer
// snapshotHint implementation into the recovery deps (layering rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import { AppDetachedError } from '../../dist/cdp/discovery.js';
import {
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeDetachedClient() {
  return createMockClient({
    _isConnected: false,
    _helpersInjected: true,
    reconnectState: { active: false, lastAttempt: null, attemptCount: 0 },
    autoConnect: async () => { throw new AppDetachedError(8081); },
  });
}

function makeHandler(recovery, capture) {
  const client = makeDetachedClient();
  return createStatusHandler(() => client, () => {}, () => client, {
    recoverDetached: async (c, rdeps) => { if (capture) capture(rdeps); return recovery; },
  });
}

test('cdp_status: app-not-installed → APP_NOT_INSTALLED with quoted snapshot advice', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({
      recovered: false,
      reason: 'app-not-installed',
      attempt: 1,
      error: 'FBSOpenApplicationServiceErrorDomain, code=4',
      udid: 'UDID-A',
      appId: 'com.example.app',
      snapshotHint: { path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 7 },
    });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.ok, false);
    assert.equal(env.code, 'APP_NOT_INSTALLED');
    assert.match(env.error, /com\.example\.app is not installed on simulator UDID-A/);
    assert.match(env.error, /7 min ago/);
    assert.match(env.error, /xcrun simctl install 'UDID-A' '\/tmp\/rn-appfile-snapshots\/My App\.app'/);
    assert.equal(env.meta.recovery.reason, 'app-not-installed');
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: app-not-installed without hint → rebuild advice, no install line', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({
      recovered: false,
      reason: 'app-not-installed',
      attempt: 1,
      udid: 'UDID-A',
      appId: 'com.example.app',
    });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.code, 'APP_NOT_INSTALLED');
    assert.match(env.error, /npx expo run:ios/);
    assert.doesNotMatch(env.error, /simctl install/);
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: injects a tools-layer snapshotHint fn into the recovery deps', async () => {
  _setHasSessionForTest(false);
  try {
    let rdeps;
    const handler = makeHandler(
      { recovered: false, reason: 'still-detached', attempt: 1 },
      (d) => { rdeps = d; },
    );
    await handler({});
    assert.equal(typeof rdeps?.snapshotHint, 'function', 'status.ts must inject snapshotHint (layering rule)');
  } finally {
    _resetHasSessionForTest();
  }
});

test('cdp_status: still-detached keeps the existing APP_DETACHED code (no regression)', async () => {
  _setHasSessionForTest(false);
  try {
    const handler = makeHandler({ recovered: false, reason: 'still-detached', attempt: 1 });
    const env = parseEnvelope(await handler({}));
    assert.equal(env.code, 'APP_DETACHED');
  } finally {
    _resetHasSessionForTest();
  }
});
