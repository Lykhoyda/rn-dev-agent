// GH #993 defect (3): cdp_auto_login answered "App is not on an auth screen"
// while cdp_navigation_state showed `auth › intro`, because only the leaf route
// was compared against the auth patterns. The whole route chain root→leaf is
// now compared, and the negative reason names what was compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CDPClient } from '../../dist/cdp-client.js';
import {
  handleAutoLogin,
  isAuthRouteChain,
  isOnAuthScreen,
  routeChain,
} from '../../dist/tools/auto-login.js';

function fakeClient(navState: unknown): CDPClient {
  return {
    isConnected: true,
    helpersInjected: true,
    bridgeDetected: true,
    evaluate: async () => ({ value: JSON.stringify(navState) }),
  } as unknown as CDPClient;
}

// The exact nav state from #993: __root > auth(params.screen=intro) > intro.
const REPORTED = {
  routeName: '__root',
  nested: { routeName: 'auth', params: { screen: 'intro' }, nested: { routeName: 'intro' } },
};

test('GH#993: routeChain walks root→leaf and includes params.screen once', () => {
  assert.deepEqual(routeChain(REPORTED), ['__root', 'auth', 'intro']);
  // A navigator that has not mounted its child yet still names it via params.screen.
  assert.deepEqual(
    routeChain({ routeName: '__root', nested: { routeName: 'auth', params: { screen: 'intro' } } }),
    ['__root', 'auth', 'intro'],
  );
  assert.deepEqual(routeChain({ routeName: 'auth' }), ['auth']);
  assert.deepEqual(routeChain({}), []);
});

test('GH#993: the reported auth › intro state is an auth screen', async () => {
  assert.equal(await isOnAuthScreen(fakeClient(REPORTED)), true);
  assert.equal(isAuthRouteChain(['__root', 'auth', 'intro']), true);
});

test('GH#993: controls — flat login/auth still match, non-auth nesting does not', async () => {
  assert.equal(
    await isOnAuthScreen(fakeClient({ routeName: '__root', nested: { routeName: 'login' } })),
    true,
  );
  assert.equal(await isOnAuthScreen(fakeClient({ routeName: 'auth' })), true);
  assert.equal(
    await isOnAuthScreen(
      fakeClient({
        routeName: '__root',
        nested: { routeName: 'auth', nested: { routeName: 'sign-in' } },
      }),
    ),
    true,
  );
  assert.equal(
    await isOnAuthScreen(
      fakeClient({
        routeName: '__root',
        nested: { routeName: 'app', nested: { routeName: 'home' } },
      }),
    ),
    false,
  );
  // No app-specific leaf name was added: `intro` alone is still not an auth screen.
  assert.equal(await isOnAuthScreen(fakeClient({ routeName: 'intro' })), false);
  assert.equal(await isOnAuthScreen(fakeClient({ error: 'nav state unavailable' })), false);
});

test('GH#993: the negative reason carries the observed route chain', async () => {
  const result = await handleAutoLogin(
    fakeClient({
      routeName: '__root',
      nested: { routeName: 'app', nested: { routeName: 'home' } },
    }),
    { platform: 'ios', deviceId: 'SIM' },
  );
  assert.ok(result);
  assert.equal(result.loggedIn, false);
  assert.equal(result.reason, 'App is not on an auth screen (route: __root › app › home)');
});
