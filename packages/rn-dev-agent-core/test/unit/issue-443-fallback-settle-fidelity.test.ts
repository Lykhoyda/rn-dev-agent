import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearRefMap } from '../../dist/fast-runner-ref-map.js';
import { hashSnapshotNodes } from '../../dist/lifecycle/settle-hash.js';
import {
  _setFetchForTest as setAndroidFetch,
  _setAndroidRunnerStateForTest,
  androidSnapshotNodesViaProbe,
} from '../../dist/runners/rn-android-runner-client.js';
import {
  _setFetchForTest as setIosFetch,
  _setRunnerStateForTest,
  runIOS,
} from '../../dist/runners/rn-fast-runner-client.js';

const rect = { x: 20, y: 40, width: 200, height: 48 };

function jsonReply(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  setAndroidFetch(globalThis.fetch);
  setIosFetch(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  _setRunnerStateForTest(null);
  clearRefMap();
});

test('GH #443: value-only and focus-only changes alter the fallback settle hash', () => {
  const base = { ref: '@e0', type: 'TextField', identifier: 'title', rect };

  assert.notEqual(
    hashSnapshotNodes([{ ...base, value: 'draft', focused: false }]),
    hashSnapshotNodes([{ ...base, value: 'ready', focused: false }]),
  );
  assert.notEqual(
    hashSnapshotNodes([{ ...base, value: 'draft', focused: false }]),
    hashSnapshotNodes([{ ...base, value: 'draft', focused: true }]),
  );
});

test('GH #443: iOS runner mapping preserves value and focused fields', async () => {
  _setRunnerStateForTest({
    schemaVersion: 1,
    port: 22088,
    pid: process.pid,
    deviceId: 'fixture-ios',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 2,
  });
  setIosFetch(async () =>
    jsonReply({
      ok: true,
      data: {
        nodes: [
          {
            index: 0,
            type: 'TextField',
            identifier: 'title',
            value: 'ready',
            focused: true,
            rect,
          },
        ],
      },
    }),
  );

  const result = await runIOS({ command: 'snapshot' });
  const envelope = JSON.parse(result.content[0].text) as {
    data: { nodes: Array<{ value?: string; focused?: boolean }> };
  };
  assert.deepEqual(envelope.data.nodes[0], {
    ref: '@e0',
    type: 'TextField',
    rect,
    identifier: 'title',
    value: 'ready',
    focused: true,
  });
});

test('GH #443: Android runner mapping preserves value and focused fields', async () => {
  _setAndroidRunnerStateForTest({
    schemaVersion: 1,
    hostPort: 22111,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'emulator-5554',
    bundleId: 'dev.fixture',
    startedAt: new Date(0).toISOString(),
    protocolVersion: 1,
  });
  setAndroidFetch(async () =>
    jsonReply({
      ok: true,
      data: {
        nodes: [
          {
            index: 0,
            type: 'android.widget.EditText',
            identifier: 'title',
            value: 'ready',
            focused: true,
            packageName: 'dev.fixture',
            rect,
          },
        ],
      },
    }),
  );

  const nodes = await androidSnapshotNodesViaProbe('dev.fixture', 22111);
  assert.deepEqual(nodes, [
    {
      ref: '@e0',
      type: 'android.widget.EditText',
      rect,
      identifier: 'title',
      value: 'ready',
      focused: true,
      packageName: 'dev.fixture',
    },
  ]);
});
