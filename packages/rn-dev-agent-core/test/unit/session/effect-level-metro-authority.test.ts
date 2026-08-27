import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedMetroProxyUrl } from '../../../dist/session/build-adapter.js';
import { pinExactDevClient } from '../../../dist/session/dev-client-authority.js';
import { buildSignedMetroMarker } from '../../../dist/session/metro-authority.js';

const authority = {
  sessionId: 'session-current',
  metroInstanceId: 'metro-current',
  worktreeKey: 'worktree-current',
  appId: 'com.example.app',
  platform: 'android' as const,
  buildGeneration: 7,
};

const physicalDeviceId = 'physical-android-device';

function launchUrl(origin: string): string {
  return `rndatest://expo-development-client/?url=${encodeURIComponent(origin)}`;
}

function stagedConnection(input: { metroPort: number; events: string[]; deviceId?: string }) {
  return {
    targetId: 'target-current',
    connectionGeneration: 3,
    deviceId: input.deviceId ?? physicalDeviceId,
    metroPort: input.metroPort,
    client: {} as never,
    assertActive: () => input.events.push('assert'),
    run: async (operation) => operation(),
    publish: () => input.events.push('publish'),
    cancel: () => input.events.push('cancel'),
  };
}

async function attempt(input: {
  metroPort?: number;
  devClientUrl?: string;
  connectedMetroPort?: number;
  marker?: ReturnType<typeof buildSignedMetroMarker> | null;
  connectError?: Error;
  callerPreload?: () => void;
}) {
  const metroPort = input.metroPort ?? 8213;
  const events: string[] = [];
  let committed = false;
  let publishedBundle: Awaited<ReturnType<typeof pinExactDevClient>> | null = null;
  let error: unknown;
  try {
    publishedBundle = await pinExactDevClient(
      {
        ...authority,
        deviceId: physicalDeviceId,
        metroPort,
        devClientUrl: input.devClientUrl ?? launchUrl(`http://192.168.1.20:${metroPort}`),
        runtimeKind: 'expo-dev-client',
        signerCapability: 'signer-current',
      },
      {
        openUrl: async () => {
          events.push('launch');
          input.callerPreload?.();
        },
        launchExactApp: async () => assert.fail('Expo launch must carry its endpoint as data'),
        launchExactAppWithInitialUrl: async () =>
          assert.fail('Android must use its Dev Client URL'),
        acceptIosOpenDialog: async () => {},
        connectExact: async () => {
          if (input.connectError) throw input.connectError;
          return stagedConnection({
            metroPort: input.connectedMetroPort ?? metroPort,
            events,
          });
        },
        readMarker: async () => {
          const marker =
            input.marker === undefined
              ? buildSignedMetroMarker(authority, 'signer-current')
              : input.marker;
          return marker ? { status: 'signed' as const, marker } : null;
        },
        commitBundle: (bundle, promotion) => {
          promotion.assertActive();
          committed = true;
          promotion.publish();
          publishedBundle = bundle;
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  return { committed, error, events, publishedBundle };
}

test('wrong scheme, host, and port effects refuse at the bundle bind and leave no authority', async () => {
  const cases = [
    {
      name: 'scheme',
      url: launchUrl('file:///tmp/caller-preloaded.bundle'),
      error: new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: no Metro bundle loaded'),
    },
    {
      name: 'host',
      url: launchUrl('http://192.0.2.10:8213'),
      error: new Error('METRO_ORIGIN_MISMATCH: first bundle origin is unproven'),
    },
    {
      name: 'port',
      url: launchUrl('http://192.168.1.20:8081'),
      connectedMetroPort: 8081,
    },
  ];

  for (const candidate of cases) {
    const result = await attempt({
      devClientUrl: candidate.url,
      connectedMetroPort: candidate.connectedMetroPort,
      connectError: candidate.error,
    });
    assert.equal(result.committed, false, `${candidate.name} must not commit bundle authority`);
    assert.equal(result.publishedBundle, null);
    assert.equal(result.events.includes('publish'), false);
    assert.match(
      String((result.error as Error)?.message),
      /^(BUNDLE_HANDSHAKE_UNAVAILABLE|METRO_ORIGIN_MISMATCH):/,
    );
  }
});

test('a signed marker from a stale session identity refuses and cancels staged publication', async () => {
  const result = await attempt({
    marker: buildSignedMetroMarker(
      { ...authority, sessionId: 'session-stale', metroInstanceId: 'metro-stale' },
      'signer-current',
    ),
  });

  assert.equal(result.committed, false);
  assert.equal(result.publishedBundle, null);
  assert.deepEqual(result.events, ['launch', 'cancel']);
  assert.match(String((result.error as Error)?.message), /^BUNDLE_IDENTITY_MISMATCH:/);
});

test('caller preload and precache effects cannot replace the first-bundle marker', async () => {
  let callerPreloaded = false;
  const result = await attempt({
    marker: null,
    callerPreload: () => {
      callerPreloaded = true;
    },
  });

  assert.equal(callerPreloaded, true);
  assert.equal(result.committed, false);
  assert.equal(result.publishedBundle, null);
  assert.deepEqual(result.events, ['launch', 'cancel']);
  assert.match(String((result.error as Error)?.message), /^BUNDLE_HANDSHAKE_UNAVAILABLE:/);
});

test('suppressing launch diagnostics leaves the wrong-origin authority outcome identical', async () => {
  let diagnosticAuthorityBound = false;
  assert.throws(() => {
    managedMetroProxyUrl({
      platform: 'android',
      deviceId: physicalDeviceId,
      metroPort: 8213,
      sessionId: authority.sessionId,
      devClientUrl: launchUrl('http://192.0.2.10:8081'),
    });
    diagnosticAuthorityBound = true;
  }, /SESSION_BUILD_IDENTITY_CONFLICT/);
  const diagnosticsSuppressed = await attempt({
    devClientUrl: launchUrl('http://192.0.2.10:8081'),
    connectedMetroPort: 8081,
  });

  assert.equal(diagnosticAuthorityBound, diagnosticsSuppressed.committed);
  assert.equal(diagnosticsSuppressed.publishedBundle, null);
  assert.deepEqual(diagnosticsSuppressed.events, ['launch', 'cancel']);
  assert.match(String((diagnosticsSuppressed.error as Error)?.message), /^METRO_ORIGIN_MISMATCH:/);
});

test('a correct physical LAN launch binds without manifest or pre-install origin proof', async () => {
  const result = await attempt({
    devClientUrl: launchUrl('http://192.168.1.20:8213'),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.committed, true);
  assert.equal(result.publishedBundle.metroPort, 8213);
  assert.equal(result.publishedBundle.metroInstanceId, 'metro-current');
  assert.deepEqual(result.events, ['launch', 'assert', 'assert', 'publish']);
});

test('default and non-default allocated ports bind at the same authoritative boundary', async () => {
  for (const metroPort of [8081, 8213]) {
    const result = await attempt({
      metroPort,
      devClientUrl: launchUrl(`http://192.168.1.20:${metroPort}`),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.committed, true);
    assert.equal(result.publishedBundle.metroPort, metroPort);
  }
});
