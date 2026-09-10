// GH #993 defect (3): cdp_auto_login answered "App is not on an auth screen"
// while cdp_navigation_state showed `auth › intro`, because only the leaf route
// was compared against the auth patterns. The whole route chain root→leaf is
// now compared, and the negative reason names what was compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CDPClient } from '../../dist/cdp-client.js';
import { handleAutoLogin, isOnAuthScreen } from '../../dist/tools/auto-login.js';

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

test('GH#993: a stale params.screen on a parent with a mounted child is not reported', async () => {
  // React Navigation keeps `{screen: 'Login'}` on Root after the user logged in
  // and the nested navigator moved to Home; the mounted child is the truth.
  const loggedIn = {
    routeName: 'Root',
    params: { screen: 'Login' },
    nested: { routeName: 'Home' },
  };
  assert.equal(await isOnAuthScreen(fakeClient(loggedIn)), false);
  const result = await handleAutoLogin(fakeClient(loggedIn), { platform: 'ios', deviceId: 'SIM' });
  assert.equal(result?.loggedIn, false);
  assert.equal(result?.reason, 'App is not on an auth screen (route: Root › Home)');
});

test('GH#993: the reported auth › intro state is an auth screen', async () => {
  assert.equal(await isOnAuthScreen(fakeClient(REPORTED)), true);
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

test('GH#993: an Authenticated ancestor that only contains a pattern is not an auth screen', async () => {
  // An `Authenticated` navigator that stays mounted after login contains `auth`
  // as a substring; as an ancestor that is not enough. As the leaf it still
  // matches — leaf substring matching is unchanged by the chain walk.
  assert.equal(await isOnAuthScreen(fakeClient({ routeName: 'Authenticated' })), true);
  assert.equal(
    await isOnAuthScreen(
      fakeClient({ routeName: 'AuthenticatedStack', nested: { routeName: 'Home' } }),
    ),
    false,
  );
  const result = await handleAutoLogin(
    fakeClient({ routeName: 'AuthenticatedStack', nested: { routeName: 'Home' } }),
    { platform: 'ios', deviceId: 'SIM' },
  );
  assert.equal(result?.loggedIn, false);
  assert.equal(result?.reason, 'App is not on an auth screen (route: AuthenticatedStack › Home)');
  // A parent literally named `auth` still matches — defect (3) stays fixed.
  assert.equal(await isOnAuthScreen(fakeClient(REPORTED)), true);
});

test('GH#993: a navigator whose child has not mounted is judged as the screen, not a container', async () => {
  // The window `params.screen` exists to serve: `AuthStack` has no mounted
  // child, so it is what the user is looking at and substring-matches `auth`.
  const unmounted = { routeName: 'AuthStack', params: { screen: 'Intro' } };
  assert.equal(await isOnAuthScreen(fakeClient(unmounted)), true);
  const result = await handleAutoLogin(fakeClient(unmounted), {
    platform: 'ios',
    deviceId: 'SIM',
  });
  assert.notEqual(result?.reason, 'App is not on an auth screen (route: AuthStack › Intro)');

  assert.equal(
    await isOnAuthScreen(fakeClient({ routeName: 'onboardingStack', params: { screen: 'Step1' } })),
    true,
  );
  // A mounted child still demotes its parent to a container.
  assert.equal(
    await isOnAuthScreen(fakeClient({ routeName: 'AuthStack', nested: { routeName: 'Home' } })),
    false,
  );
  // Accepted gap: a mounted `AuthStack › Intro` is not an auth screen, and the reason says so.
  const mountedIntro = { routeName: 'AuthStack', nested: { routeName: 'Intro' } };
  assert.equal(await isOnAuthScreen(fakeClient(mountedIntro)), false);
  const mountedResult = await handleAutoLogin(fakeClient(mountedIntro), {
    platform: 'ios',
    deviceId: 'SIM',
  });
  assert.equal(mountedResult?.reason, 'App is not on an auth screen (route: AuthStack › Intro)');
});

test('GH#993: the negative reason carries the whole observed chain root→leaf', async () => {
  const reason = async (navState: unknown): Promise<string | undefined> =>
    (await handleAutoLogin(fakeClient(navState), { platform: 'ios', deviceId: 'SIM' }))?.reason;

  assert.equal(
    await reason({
      routeName: '__root',
      nested: { routeName: 'app', nested: { routeName: 'home' } },
    }),
    'App is not on an auth screen (route: __root › app › home)',
  );
  // A navigator that has not mounted its child yet still names it via params.screen, once.
  assert.equal(
    await reason({ routeName: '__root', nested: { routeName: 'app', params: { screen: 'home' } } }),
    'App is not on an auth screen (route: __root › app › home)',
  );
  assert.equal(await reason({ routeName: 'app' }), 'App is not on an auth screen (route: app)');
  assert.equal(await reason({}), 'App is not on an auth screen (route: unavailable)');
});
