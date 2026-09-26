import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearRefMap, refCenter } from '../../../dist/fast-runner-ref-map.js';
import {
  _setFetchForTest,
  _setRunnerStateForTest,
  runIOS,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';

test('runIOS snapshot preserves evidenced native hierarchy and coverage without changing refs or exposing values', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });

  async function snapshot(data: Record<string, unknown>) {
    _setFetchForTest(async () => Response.json({ ok: true, data }));
    const result = await runIOS({ command: 'snapshot' });
    assert.equal(result.isError, undefined);
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, true);
    return envelope;
  }

  const rect = { x: 10, y: 20, width: 100, height: 40 };
  const root = { index: 0, type: 'Application', rect, depth: 0 };
  const branch = { index: 1, type: 'Other', rect, depth: 1, parentIndex: 0 };
  const capture = await snapshot({
    nodes: [
      root,
      branch,
      { index: 2, type: 'Other', depth: 2, parentIndex: 1 },
      {
        index: 3,
        type: 'Button',
        label: 'Continue',
        identifier: 'continue',
        rect,
        enabled: false,
        hittable: false,
        depth: 4,
        parentIndex: 1,
        value: 'private-input',
        focused: true,
      },
    ],
    truncated: true,
    keyboardVisible: false,
    snapshotGeneration: 17,
  });
  assert.deepEqual(capture.data, {
    nodes: [
      { ref: '@e0', ...root },
      { ref: '@e1', ...branch },
      {
        ref: '@e3',
        index: 3,
        type: 'Button',
        label: 'Continue',
        identifier: 'continue',
        rect,
        enabled: false,
        hittable: false,
        depth: 4,
        parentIndex: 1,
      },
    ],
    normalizationDroppedNodes: 1,
    truncated: true,
    keyboardVisible: false,
    snapshotGeneration: 17,
  });
  assert.equal(capture.meta?.snapshotVerdict?.state, 'ok');
  assert.equal(capture.meta?.snapshotVerdict?.refMapUpdated, true);
  assert.deepEqual(refCenter('@e3'), { x: 60, y: 40 });
  assert.equal(refCenter('@e2'), null);

  const legacyNodes = [
    { type: 'Button', rect },
    { type: 'Other' },
    { index: 7, type: 'Other', rect },
    { type: 'TextField', rect, value: 'private-input', focused: false },
  ];
  const legacy = await snapshot({ nodes: legacyNodes });
  assert.deepEqual(legacy.data, {
    nodes: [
      { ref: '@e0', type: 'Button', rect },
      { ref: '@e7', index: 7, type: 'Other', rect },
      { ref: '@e1', type: 'TextField', rect },
    ],
    normalizationDroppedNodes: 1,
  });
  assert.deepEqual(refCenter('@e7'), { x: 60, y: 40 });
  assert.deepEqual(refCenter('@e1'), { x: 60, y: 40 });

  for (const truncated of [true, false, undefined, null, 0, 1, 'false']) {
    const envelope = await snapshot({ nodes: [root], truncated });
    assert.equal(envelope.data.normalizationDroppedNodes, 0);
    if (typeof truncated === 'boolean') {
      assert.equal(envelope.data.truncated, truncated);
    } else {
      assert.equal(Object.hasOwn(envelope.data, 'truncated'), false);
    }
  }

  for (const field of ['index', 'parentIndex', 'depth']) {
    for (const invalid of [null, '1', true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const envelope = await snapshot({ nodes: [root, { ...branch, [field]: invalid }] });
      assert.equal(envelope.data.normalizationDroppedNodes, 0);
      assert.equal(
        Object.hasOwn(envelope.data.nodes[1], field),
        false,
        `${field} must not retain ${JSON.stringify(invalid)}`,
      );
    }
  }

  for (const nodes of [
    [root, { ...branch, parentIndex: 1 }],
    [root, { ...branch, parentIndex: 2 }],
    [root, { ...branch, index: 3, parentIndex: 2 }],
    [{ index: 0, type: 'Other' }, branch],
    [{ type: 'Other', rect }, branch],
    [root, { type: 'Button', rect, parentIndex: 0 }],
  ]) {
    const envelope = await snapshot({ nodes });
    assert.equal(
      Object.hasOwn(envelope.data.nodes.at(-1), 'parentIndex'),
      false,
      'no self, forward, dangling or synthetic-index parent relationships',
    );
  }

  const empty = await snapshot({ nodes: [], truncated: false });
  assert.deepEqual(empty.data, { nodes: [], normalizationDroppedNodes: 0, truncated: false });
  assert.equal(empty.meta?.snapshotVerdict?.state, 'degraded');
  assert.equal(empty.meta?.snapshotVerdict?.refMapUpdated, false);
  assert.deepEqual(refCenter('@e0'), { x: 60, y: 40 });
});

test('runIOS snapshot reports a rectless observation dropped from 31 native nodes without changing truncation', async (t) => {
  clearRefMap();
  _setRunnerStateForTest({
    port: 22088,
    pid: 999999,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
  t.after(() => {
    _setFetchForTest(globalThis.fetch);
    _setRunnerStateForTest(null);
    clearRefMap();
  });

  const rect = { x: 10, y: 20, width: 100, height: 40 };
  const nodes = Array.from({ length: 31 }, (_, index) => ({
    index,
    type: 'Button',
    ...(index === 15 ? {} : { rect }),
  }));
  _setFetchForTest(async () => Response.json({ ok: true, data: { nodes, truncated: false } }));

  const result = await runIOS({ command: 'snapshot' });
  assert.equal(result.isError, undefined);
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.nodes.length, 30);
  assert.equal(envelope.data.truncated, false);
  assert.equal(envelope.data.normalizationDroppedNodes, 1);
  assert.equal(envelope.data.nodes[14].ref, '@e14');
  assert.equal(envelope.data.nodes[15].ref, '@e16');
  assert.equal(refCenter('@e15'), null);
  assert.deepEqual(refCenter('@e16'), { x: 60, y: 40 });
});
