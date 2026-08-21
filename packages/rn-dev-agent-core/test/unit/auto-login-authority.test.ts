import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPClient } from '../../dist/cdp-client.js';
import { handleAutoLogin } from '../../dist/tools/auto-login.js';

function authClient(): CDPClient {
  let reads = 0;
  return {
    isConnected: true,
    helpersInjected: true,
    bridgeDetected: true,
    evaluate: async () => ({
      value: JSON.stringify({ routeName: reads++ === 0 ? 'Login' : 'Home' }),
    }),
  } as unknown as CDPClient;
}

test('cdp_auto_login delegates to maestro_run on the authority-bound device', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-auto-login-authority-'));
  const flowDir = join(root, '.maestro', 'subflows');
  mkdirSync(flowDir, { recursive: true });
  writeFileSync(join(flowDir, 'login.yaml'), '- tapOn:\n    id: "login"\n', 'utf8');
  let replayArgs: Record<string, unknown> | null = null;

  const result = await handleAutoLogin(
    authClient(),
    { appId: 'com.test.app', platform: 'ios', deviceId: 'SIM-AUTHORITY' },
    {
      projectRoot: () => root,
      boundProjectRoot: () => root,
      maestroRun: async (args) => {
        replayArgs = args as unknown as Record<string, unknown>;
        return { content: [{ type: 'text', text: '{"ok":true,"data":{"passed":true}}' }] };
      },
    },
  );

  assert.equal(result?.loggedIn, true);
  assert.equal(replayArgs?.platform, 'ios');
  assert.equal(replayArgs?.deviceId, 'SIM-AUTHORITY');
  assert.equal(typeof replayArgs?.claimNativeOrigin, 'function');
  assert.equal(typeof replayArgs?.completeNativeOrigin, 'function');
  assert.equal(typeof replayArgs?.completeRunnerPark, 'function');
  assert.match(String(replayArgs?.inlineYaml), /id: login/);
});

test('cdp_auto_login refuses a platform without matching owned device authority', async () => {
  let replayed = false;
  const result = await handleAutoLogin(
    authClient(),
    { platform: 'android' },
    {
      maestroRun: async () => {
        replayed = true;
        return { content: [{ type: 'text', text: '{"ok":true,"data":{"passed":true}}' }] };
      },
    },
  );

  assert.equal(result?.loggedIn, false);
  assert.match(String(result?.reason), /owned android session/);
  assert.equal(replayed, false);
});

test('cdp_auto_login refuses symlinked legacy flow ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-auto-login-symlink-'));
  const external = mkdtempSync(join(tmpdir(), 'rn-auto-login-external-'));
  const flowDir = join(root, '.maestro', 'subflows');
  mkdirSync(flowDir, { recursive: true });
  const externalFlow = join(external, 'login.yaml');
  writeFileSync(externalFlow, '- tapOn:\n    id: "login"\n', 'utf8');
  symlinkSync(externalFlow, join(flowDir, 'login.yaml'));
  let replayed = false;

  const result = await handleAutoLogin(
    authClient(),
    { appId: 'com.test.app', platform: 'ios', deviceId: 'SIM-BOUND' },
    {
      projectRoot: () => root,
      boundProjectRoot: () => root,
      maestroRun: async () => {
        replayed = true;
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  );

  assert.equal(result?.loggedIn, false);
  assert.match(String(result?.reason), /symlink/);
  assert.equal(replayed, false);
});

test('cdp_auto_login refuses ambient project discovery outside session authority', async () => {
  const boundRoot = mkdtempSync(join(tmpdir(), 'rn-auto-login-bound-root-'));
  const ambientRoot = mkdtempSync(join(tmpdir(), 'rn-auto-login-ambient-root-'));
  const ambientFlows = join(ambientRoot, '.maestro', 'subflows');
  mkdirSync(ambientFlows, { recursive: true });
  writeFileSync(join(ambientFlows, 'login.yaml'), '- tapOn:\n    id: "login"\n', 'utf8');
  let replayed = false;

  const result = await handleAutoLogin(
    authClient(),
    { platform: 'ios', deviceId: 'SIM-BOUND' },
    {
      projectRoot: () => ambientRoot,
      boundProjectRoot: () => boundRoot,
      maestroRun: async () => {
        replayed = true;
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  );

  assert.equal(result?.loggedIn, false);
  assert.match(String(result?.reason), /does not match/);
  assert.equal(replayed, false);
});
