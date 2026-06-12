// GH #262 (+ #194 BUG 2 residual): hardReset must not silently degrade to a
// soft reset when the bundleId cache is empty — the chain is now
// explicit arg > connectedTarget > cache > active-session appId > STRICT
// app.json (per-platform, NO iOS←Android fallback: feeding an Android
// package to iOS simctl would misreport APP_NOT_INSTALLED). simctl targets
// the active session's UDID when one exists ('booted' otherwise), failed
// launches are probe-classified, and a successful hardReset resets the
// detached-recovery budget.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRestartHandler, _resetRestartHandlerStateForTest,
} from '../../dist/tools/restart.js';
import { expectOk, expectFail, parseEnvelope } from '../helpers/result-helpers.js';

beforeEach(() => {
  _resetRestartHandlerStateForTest();
});

function makeMockClient({ port = 8081 } = {}) {
  let connected = false;
  return {
    get metroPort() { return port; },
    get isConnected() { return connected; },
    // connectedTarget intentionally undefined: the fresh-process case.
    disconnect: async () => {},
    autoConnect: async () => { connected = true; return 'Connected to test'; },
  };
}

function harness(deps) {
  const oldClient = makeMockClient();
  const newClient = makeMockClient();
  let current = oldClient;
  return createRestartHandler(
    () => current,
    (c) => { current = c; },
    () => newClient,
    { getSession: () => null, ...deps },
  );
}

test('hardReset: empty cache + no session → strict app.json fallback, simctl on booted', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: (platform) => {
      assert.equal(platform, 'ios');
      return 'com.fallback.app';
    },
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(simctl.some((c) => c === 'simctl terminate booted com.fallback.app'));
  assert.ok(simctl.some((c) => c === 'simctl launch booted com.fallback.app'));
  assert.ok(data.hardResetSteps.includes('simctl launch com.fallback.app:ok'));
  assert.ok(!data.hardResetSteps.some((s) => s.startsWith('skip-simctl')));
});

test('hardReset: active iOS session appId outranks app.json; simctl targets the session UDID', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    getSession: () => ({ deviceId: 'UDID-S', appId: 'com.session.app', platform: 'ios' }),
    resolveBundleIdStrict: () => 'com.fallback.app',
  });
  expectOk(await handler({ hardReset: true }));
  assert.ok(simctl.some((c) => c === 'simctl terminate UDID-S com.session.app'), `got: ${simctl}`);
  assert.ok(simctl.some((c) => c === 'simctl launch UDID-S com.session.app'));
});

test('hardReset: strict resolver also unresolvable → existing skip-simctl step (unchanged)', async () => {
  const handler = harness({
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => null,
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(data.hardResetSteps.includes('skip-simctl:no-bundleId-on-connectedTarget-or-cache'));
});

test('hardReset: launch fails + probe FALSE → APP_NOT_INSTALLED step with quoted advice', async () => {
  const handler = harness({
    execFile: async (cmd, args) => {
      if (args.includes('launch')) throw new Error('FBSOpenApplicationServiceErrorDomain, code=4');
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => 'com.fallback.app',
    probeAppInstalled: async (udid, appId) => {
      assert.equal(udid, 'booted');
      assert.equal(appId, 'com.fallback.app');
      return false;
    },
    snapshotHint: () => ({ path: '/tmp/rn-appfile-snapshots/My App.app', ageMinutes: 3 }),
  });
  const data = expectOk(await handler({ hardReset: true }));
  const step = data.hardResetSteps.find((s) => s.includes('APP_NOT_INSTALLED'));
  assert.ok(step, `expected an APP_NOT_INSTALLED step, got: ${JSON.stringify(data.hardResetSteps)}`);
  assert.match(step, /com\.fallback\.app is not installed/);
  assert.match(step, /xcrun simctl install 'booted' '\/tmp\/rn-appfile-snapshots\/My App\.app'/);
});

test('hardReset: launch fails + probe NULL → raw launch:err step (fail open, unchanged)', async () => {
  const handler = harness({
    execFile: async (cmd, args) => {
      if (args.includes('launch')) throw new Error('some transient failure');
      return { stdout: '', stderr: '' };
    },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => 'com.fallback.app',
    probeAppInstalled: async () => null,
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(data.hardResetSteps.some((s) => s.startsWith('simctl launch:err(') && !s.includes('APP_NOT_INSTALLED')));
});

test('hardReset: android-cached bundleId is NOT used for an iOS target (platform-keyed cache)', async () => {
  // 1st restart: android connectedTarget populates the cache.
  const androidClient = {
    get metroPort() { return 8081; },
    get isConnected() { return false; },
    connectedTarget: { description: 'com.android.pkg', platform: 'android' },
    disconnect: async () => {},
    autoConnect: async () => 'Connected',
  };
  const plainClient = {
    get metroPort() { return 8081; },
    get isConnected() { return false; },
    disconnect: async () => {},
    autoConnect: async () => 'Connected',
  };
  let current = androidClient;
  const simctl = [];
  const handler = createRestartHandler(
    () => current,
    (c) => {},
    () => plainClient,
    {
      getSession: () => null,
      execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
      stopFastRunner: () => {},
      sleep: async () => {},
      resolveBundleIdStrict: () => null,
    },
  );
  expectOk(await handler({})); // android-flavored soft restart populates the cache
  current = plainClient; // fresh-process-like state: no connectedTarget

  // Same-platform control: an android-targeted hardReset (current client has
  // NO connectedTarget) must FIND the android cache entry and proceed to the
  // 'android-not-yet-supported' skip — NOT the 'no-bundleId' skip. This proves
  // the android entry was actually populated (and would fail if the
  // platform-keyed Map were reverted to a single shared slot: the later
  // iOS lookup below would then evict/overwrite it — see note in report).
  const androidData = expectOk(await handler({ hardReset: true, platform: 'android' }));
  assert.ok(
    !androidData.hardResetSteps.includes('skip-simctl:no-bundleId-on-connectedTarget-or-cache'),
    `android cache entry should have been found — got: ${JSON.stringify(androidData.hardResetSteps)}`,
  );
  assert.ok(
    androidData.hardResetSteps.includes('skip-simctl:platform=android-not-yet-supported'),
    `android cache hit should fall through to the android-not-supported skip — got: ${JSON.stringify(androidData.hardResetSteps)}`,
  );

  const data = expectOk(await handler({ hardReset: true, platform: 'ios' }));
  assert.ok(
    !simctl.some((c) => c.includes('com.android.pkg')),
    `android package must never reach iOS simctl — got: ${JSON.stringify(simctl)}`,
  );
  assert.ok(data.hardResetSteps.includes('skip-simctl:no-bundleId-on-connectedTarget-or-cache'));
});

test('codex-pair Fix 1: explicit invalid bundleId arg fails fast, simctl never called', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => 'com.fallback.app',
  });
  const err = expectFail(await handler({ hardReset: true, bundleId: 'rm -rf /; echo pwned' }));
  assert.match(err, /invalid bundleId argument/);
  const env = parseEnvelope(await handler({ hardReset: true, bundleId: 'not a bundle' }));
  assert.equal(env.code, 'INVALID_BUNDLE_ID');
  assert.equal(simctl.length, 0, `simctl must never run with an invalid explicit bundleId — got: ${JSON.stringify(simctl)}`);
});

test('codex-pair Fix 1: invalid cached/config bundleId → skip-simctl step, never reaches simctl argv', async () => {
  const simctl = [];
  const handler = harness({
    execFile: async (cmd, args) => { simctl.push(args.join(' ')); return { stdout: '', stderr: '' }; },
    stopFastRunner: () => {},
    sleep: async () => {},
    // A corrupted app.json / config value resolved from a NON-arg source.
    resolveBundleIdStrict: () => 'com.evil.app; rm -rf /',
  });
  const data = expectOk(await handler({ hardReset: true }));
  assert.ok(
    data.hardResetSteps.includes('skip-simctl:invalid-bundleId-from-cache-or-config'),
    `expected the invalid-from-cache skip step — got: ${JSON.stringify(data.hardResetSteps)}`,
  );
  assert.equal(simctl.length, 0, `simctl must never run with an invalid resolved bundleId — got: ${JSON.stringify(simctl)}`);
  // bundleId nulled out → omitted from the envelope (never echoed back as valid).
  assert.equal(data.bundleId, undefined);
});

test('hardReset success resets the detached-recovery budget', async () => {
  let resets = 0;
  const handler = harness({
    execFile: async () => ({ stdout: '', stderr: '' }),
    stopFastRunner: () => {},
    sleep: async () => {},
    resolveBundleIdStrict: () => 'com.fallback.app',
    resetDetachedBudget: () => { resets += 1; },
  });
  expectOk(await handler({ hardReset: true }));
  assert.equal(resets, 1, 'a successful manual hard reset is a working recovery — budget must reset');
});
