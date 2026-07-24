import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservabilityServer } from '../../../dist/observability/server.js';
import { Recorder } from '../../../dist/observability/recorder.js';

const authority = {
  sessionId: 'session-a',
  claimEpoch: 4,
  instanceId: 'observe-a',
  capability: 'capability-a',
};

function headers(value = authority) {
  return {
    authorization: `Bearer ${value.capability}`,
    'x-rn-observe-instance': value.instanceId,
  };
}

test('Observe bootstraps one capability but protects every API by session instance', async () => {
  const server = new ObservabilityServer(
    new Recorder(),
    undefined,
    undefined,
    undefined,
    authority,
  );
  const { url } = await server.start();
  try {
    const root = await fetch(url);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.match(root.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await root.text(), /__RN_OBSERVE_AUTHORITY__/);

    assert.equal((await fetch(`${url}/api/authority`)).status, 403);
    assert.equal(
      (
        await fetch(`${url}/api/authority`, {
          headers: headers({ ...authority, instanceId: 'observe-old' }),
        })
      ).status,
      403,
    );
    const response = await fetch(`${url}/api/authority`, { headers: headers() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: 'session-a',
      claimEpoch: 4,
      instanceId: 'observe-a',
    });

    const queryResponse = await fetch(
      `${url}/api/authority?instance=${authority.instanceId}&capability=${authority.capability}`,
    );
    assert.equal(queryResponse.status, 200);
  } finally {
    await server.stop();
  }
});

test('Observe refuses an occupied allocated port and never falls back', async () => {
  const owner = new ObservabilityServer(new Recorder());
  const { port } = await owner.start();
  const contender = new ObservabilityServer(new Recorder());
  try {
    await assert.rejects(contender.start(port), /OBSERVE_PORT_CLAIM_CONFLICT/);
  } finally {
    await contender.stop();
    await owner.stop();
  }
});
