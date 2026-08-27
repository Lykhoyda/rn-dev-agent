import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedMetroProxyUrl } from '../../../dist/session/build-adapter.js';
import {
  AndroidExactTargetDeadlineError,
  exactCandidateMismatchError,
} from '../../../dist/session/connect-exact-session-target.js';
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
  const normalizedHandshakeRefusal =
    'BUNDLE_HANDSHAKE_UNAVAILABLE: the actual first bundle from this session Metro did not become available';
  const stageNamingLeaf = exactCandidateMismatchError(
    { metroPort: 8213, platform: 'android', appId: authority.appId, deviceId: physicalDeviceId },
    [{ id: 'a', title: 'other.app', url: 'ws://127.0.0.1:8213/a' }],
    [],
    [],
  );
  const cases: Array<{
    name: string;
    url: string;
    connectError?: Error;
    connectedMetroPort?: number;
    expectedRefusal: string;
    expectedEvents: string[];
  }> = [
    {
      name: 'wrong scheme: a caller-precached file bundle never reaches a Metro handshake',
      url: launchUrl('file:///tmp/caller-preloaded.bundle'),
      connectError: new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: no Metro bundle loaded'),
      expectedRefusal: 'BUNDLE_HANDSHAKE_UNAVAILABLE: no Metro bundle loaded',
      expectedEvents: ['launch'],
    },
    {
      name: 'wrong host: an existing typed origin refusal reaches the caller unchanged',
      url: launchUrl('http://192.0.2.10:8213'),
      connectError: new Error('METRO_ORIGIN_MISMATCH: first bundle origin is unproven'),
      expectedRefusal: 'METRO_ORIGIN_MISMATCH: first bundle origin is unproven',
      expectedEvents: ['launch'],
    },
    {
      name: 'wrong host: any other connect-stage failure normalizes but retains its named stage',
      url: launchUrl('http://192.0.2.10:8213'),
      connectError: stageNamingLeaf,
      expectedRefusal: `${normalizedHandshakeRefusal}. Exact-connect stage: ${stageNamingLeaf.message}`,
      expectedEvents: ['launch'],
    },
    {
      name: 'wrong port: the bind boundary itself rejects a sibling Metro origin',
      url: launchUrl('http://192.168.1.20:8081'),
      connectedMetroPort: 8081,
      expectedRefusal:
        'METRO_ORIGIN_MISMATCH: the actual first bundle did not originate from this session Metro port',
      expectedEvents: ['launch', 'cancel'],
    },
  ];

  for (const candidate of cases) {
    const result = await attempt({
      devClientUrl: candidate.url,
      connectedMetroPort: candidate.connectedMetroPort,
      connectError: candidate.connectError,
    });
    assert.equal(result.committed, false, `${candidate.name} must not commit bundle authority`);
    assert.equal(result.publishedBundle, null, candidate.name);
    assert.deepEqual(result.events, candidate.expectedEvents, candidate.name);
    assert.equal(
      String((result.error as Error)?.message),
      candidate.expectedRefusal,
      candidate.name,
    );
  }
});

test('the normalized handshake refusal carries the Android deadline leaf to the operator', async () => {
  const deadlineLeaf = new AndroidExactTargetDeadlineError(
    45_000,
    new Error('inspector handshook but failed Runtime.evaluate'),
  );
  const result = await attempt({ connectError: deadlineLeaf });

  assert.equal(result.committed, false);
  assert.equal(result.publishedBundle, null);
  assert.deepEqual(result.events, ['launch']);
  assert.equal(
    String((result.error as Error).message),
    'BUNDLE_HANDSHAKE_UNAVAILABLE: the actual first bundle from this session Metro did not become available. ' +
      'Exact-connect stage: CDP_TARGET_AUTHORITY_MISMATCH: Android exact-target readiness exceeded its ' +
      'absolute 45000ms deadline. Last exact-connect failure: inspector handshook but failed Runtime.evaluate',
  );
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

const wrongOriginLaunchData = {
  platform: authority.platform,
  deviceId: physicalDeviceId,
  metroPort: 8213,
  sessionId: authority.sessionId,
  devClientUrl: launchUrl('http://192.0.2.10:8081'),
};

function diagnosticVerdict(launchData: typeof wrongOriginLaunchData): string {
  try {
    return `accepted:${managedMetroProxyUrl(launchData)}`;
  } catch (caught) {
    return `refused:${String((caught as Error).message)}`;
  }
}

function authorityOutcome(result: Awaited<ReturnType<typeof attempt>>) {
  return {
    committed: result.committed,
    publishedBundle: result.publishedBundle,
    events: result.events,
    refusal: result.error === undefined ? null : String((result.error as Error).message),
  };
}

// pinExactDevClient consults managedMetroProxyUrl only on ios + expo-dev-client, where it returns
// http://127.0.0.1:<port> and cannot throw, so verdict-independence is the provable form of the clause.
test('a refusing and an accepting build-leg verdict both leave the authority boundary refusing with its own typed code', async () => {
  assert.equal(
    diagnosticVerdict(wrongOriginLaunchData),
    'refused:SESSION_BUILD_IDENTITY_CONFLICT: Dev Client URL contradicts the active managed Metro',
  );
  const afterRefusingDiagnostic = authorityOutcome(
    await attempt({
      metroPort: wrongOriginLaunchData.metroPort,
      devClientUrl: wrongOriginLaunchData.devClientUrl,
      connectedMetroPort: 8081,
    }),
  );
  assert.deepEqual(afterRefusingDiagnostic, {
    committed: false,
    publishedBundle: null,
    events: ['launch', 'cancel'],
    refusal:
      'METRO_ORIGIN_MISMATCH: the actual first bundle did not originate from this session Metro port',
  });

  const acceptedLaunchData = {
    ...wrongOriginLaunchData,
    devClientUrl: launchUrl(`http://192.168.1.20:${String(wrongOriginLaunchData.metroPort)}`),
  };
  assert.equal(diagnosticVerdict(acceptedLaunchData), 'accepted:http://192.168.1.20:8213');
  const afterAcceptingDiagnostic = authorityOutcome(
    await attempt({
      metroPort: acceptedLaunchData.metroPort,
      devClientUrl: acceptedLaunchData.devClientUrl,
      marker: buildSignedMetroMarker(
        { ...authority, sessionId: 'session-stale', metroInstanceId: 'metro-stale' },
        'signer-current',
      ),
    }),
  );
  assert.deepEqual(afterAcceptingDiagnostic, {
    committed: false,
    publishedBundle: null,
    events: ['launch', 'cancel'],
    refusal: 'BUNDLE_IDENTITY_MISMATCH: signed initial-bundle binding did not match',
  });
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
