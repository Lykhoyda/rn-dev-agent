// GH #628 reproduction: a saved park-state action whose prologue opens with
// `launchApp: { stopApp: false }` destroys its own start screen. The launch
// stage unconditionally triggers the managed native-origin relaunch
// (executeMaestroAuthorityStages → relaunchManagedApp → simctl launch
// --initialUrl / dev-client deeplink), which reloads the Expo dev client's JS
// world even when the native process is not terminated — so the parked
// navigation stack is gone before the action's first assertVisible runs.
//
// The cold-entry control shows why this stayed masked: a cold action asserts
// the initial route, which a fresh bundle boot lands on anyway.
//
// Pre-correction this file PROVES the destruction (the parked scenario fails
// its own first assertion). The correction makes this exact artifact shape
// (entry: parked + launchApp in the body) refuse before any stage runs; the
// parked test here is then superseded by the refusal contract tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeMaestroAuthorityStages } from '../../dist/tools/maestro-run.js';

interface DeviceModel {
  screen: string;
  relaunches: Array<{ stopApp: boolean }>;
}

const PARK_ANCHOR = 'mandate-sign-anchor';
const INITIAL_ROUTE_ANCHOR = 'home-anchor';

function parkStateFlow(anchor: string): unknown[] {
  return [{ launchApp: { stopApp: false } }, { assertVisible: { id: anchor } }];
}

function stageExecutor(device: DeviceModel) {
  return async (commands: readonly unknown[]): Promise<string> => {
    for (const command of commands) {
      const assertStep = (command as { assertVisible?: { id?: string } }).assertVisible;
      if (assertStep?.id && assertStep.id !== device.screen) {
        throw new Error(
          `ASSERTION_FAILED: expected "${assertStep.id}" but screen shows "${device.screen}"`,
        );
      }
    }
    return 'ok';
  };
}

// Models the managed relaunch against an Expo dev client: delivering the dev
// server URL reloads the JS bundle and resets navigation to the initial route
// regardless of stopApp (stopApp only controls native process termination).
function devClientRelaunch(device: DeviceModel) {
  return async (stopApp?: boolean): Promise<void> => {
    device.relaunches.push({ stopApp: stopApp === true });
    device.screen = INITIAL_ROUTE_ANCHOR;
  };
}

const noop = async (): Promise<void> => {};

test('GH #628: park-state action with launchApp stopApp:false prologue destroys its own start screen', async () => {
  const device: DeviceModel = { screen: PARK_ANCHOR, relaunches: [] };

  await assert.rejects(
    executeMaestroAuthorityStages(
      parkStateFlow(PARK_ANCHOR),
      stageExecutor(device),
      noop,
      noop,
      devClientRelaunch(device),
      noop,
    ),
    (error: unknown) => {
      const detail = error instanceof Error ? (error.cause ?? error) : error;
      const stageError = (detail as { stageError?: unknown }).stageError ?? detail;
      return String(stageError).includes(PARK_ANCHOR);
    },
    'the first assertion must fail because the prologue reset the parked screen',
  );

  assert.equal(device.relaunches.length, 1, 'the launchApp stage triggered the managed relaunch');
  assert.equal(
    device.relaunches[0]?.stopApp,
    false,
    'stopApp:false was honoured for the native process yet the JS world still reset',
  );
  assert.equal(device.screen, INITIAL_ROUTE_ANCHOR, 'the park screen is gone before step 1');
});

test('GH #628 control: cold-entry action with the same prologue passes — the reset is masked', async () => {
  const device: DeviceModel = { screen: 'cold-boot-splash', relaunches: [] };

  const results = await executeMaestroAuthorityStages(
    parkStateFlow(INITIAL_ROUTE_ANCHOR),
    stageExecutor(device),
    noop,
    noop,
    devClientRelaunch(device),
    noop,
  );

  assert.equal(results.length, 2);
  assert.equal(device.relaunches.length, 1);
  assert.equal(device.screen, INITIAL_ROUTE_ANCHOR, 'cold entry lands on the asserted route anyway');
});
