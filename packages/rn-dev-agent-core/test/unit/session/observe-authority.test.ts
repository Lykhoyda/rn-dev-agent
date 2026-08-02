import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ObservabilityServer } from '../../../dist/observability/server.js';
import { Recorder } from '../../../dist/observability/recorder.js';

const authority = {
  sessionId: 'session-a',
  claimEpoch: 4,
  instanceId: 'observe-a',
  capability: 'capability-a',
};
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function headers(value = authority) {
  return {
    authorization: `Bearer ${value.capability}`,
    'x-rn-observe-instance': value.instanceId,
  };
}

test('Observe bootstraps authority in the URL fragment and protects every API', async () => {
  const server = new ObservabilityServer(
    new Recorder(),
    undefined,
    undefined,
    undefined,
    authority,
  );
  const { url } = await server.start();
  try {
    const launchUrl = new URL(url);
    assert.equal(launchUrl.hash, '#instance=observe-a&capability=capability-a');
    const root = await fetch(launchUrl.origin);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.match(root.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.doesNotMatch(await root.text(), /capability-a/);

    assert.equal((await fetch(`${launchUrl.origin}/api/authority`)).status, 403);
    assert.equal(
      (
        await fetch(`${launchUrl.origin}/api/authority`, {
          headers: headers({ ...authority, instanceId: 'observe-old' }),
        })
      ).status,
      403,
    );
    const response = await fetch(`${launchUrl.origin}/api/authority`, { headers: headers() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      sessionId: 'session-a',
      claimEpoch: 4,
      instanceId: 'observe-a',
    });

    const queryResponse = await fetch(
      `${launchUrl.origin}/api/authority?instance=${authority.instanceId}&capability=${authority.capability}`,
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

test('Observe retains fragment authority across browser refreshes', async () => {
  const [source, bundle] = await Promise.all([
    readFile(resolve(coreRoot, 'src/observability/web/src/authority.ts'), 'utf8'),
    readFile(resolve(coreRoot, 'dist/observability/web-dist/index.html'), 'utf8'),
  ]);
  assert.doesNotMatch(source, /history\\.replaceState/);
  assert.doesNotMatch(bundle, /history\\.replaceState/);
});

test('HTTP stop reports cleanup rejection without an unhandled promise', async () => {
  const reported: unknown[] = [];
  const server = new ObservabilityServer(
    new Recorder(),
    undefined,
    undefined,
    undefined,
    authority,
    async () => {
      throw new Error('cleanup failed');
    },
    (error) => {
      reported.push(error);
    },
  );
  const { url } = await server.start();
  try {
    const response = await fetch(`${new URL(url).origin}/api/stop`, {
      method: 'POST',
      headers: headers(),
    });
    assert.equal(response.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reported.length, 1);
    assert.match(String(reported[0]), /cleanup failed/);
  } finally {
    await server.stop();
  }
});
