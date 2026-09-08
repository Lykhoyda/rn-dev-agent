// GH #979: snapshot/find surfaces printed bare `eN` refs while candidate/diff
// lists printed pinned `@eN`. A press of the bare form never attached the
// frame-authorised pin fields, so the runner refused a copy-paste from the
// surface agents read most often.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRefMap,
  pinnedElementRef,
  updateRefMapFromFlat,
} from '../../dist/fast-runner-ref-map.js';
import {
  buildRunAndroidArgs,
  buildRunIOSArgs,
  healStaleRef,
  _setActiveSessionForTest,
  _setRunAgentDeviceForTest,
} from '../../dist/agent-device-wrapper.js';
import { createDeviceBatchHandler, salientizeSnapshotData } from '../../dist/tools/device-batch.js';
import { okResult } from '../../dist/utils.js';

const node = {
  ref: '@e0',
  type: 'Button',
  label: 'Save',
  identifier: 'save-btn',
  rect: { x: 10, y: 20, width: 100, height: 40 },
};

test('GH-979: pinnedElementRef is the single printed form', () => {
  assert.equal(pinnedElementRef('e3'), '@e3');
  assert.equal(pinnedElementRef('@e3'), '@e3');
  assert.equal(pinnedElementRef('save-btn'), 'save-btn');
});

test('GH-979: a bare positional press attaches the same pin fields as @eN', () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 41, keyboardVisible: false });
  const pinned = buildRunIOSArgs(['press', '@e0']);
  const bare = buildRunIOSArgs(['press', 'e0']);
  assert.equal(bare.snapshotGeneration, 41);
  assert.deepEqual(bare, pinned);
});

test('GH-979: Android bare positional press resolves like @eN', () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 7, keyboardVisible: false });
  assert.deepEqual(buildRunAndroidArgs(['press', 'e0']), buildRunAndroidArgs(['press', '@e0']));
});

test('GH-979: salient snapshot output pins bare positional refs', () => {
  const out = salientizeSnapshotData({
    nodes: [
      { ref: 'e2', type: 'Button', label: 'Submit', identifier: 'submit-btn' },
      { ref: '@e3', type: 'TextField', identifier: 'email' },
    ],
  }) as { nodes: Array<{ ref: string }> };
  assert.deepEqual(
    out.nodes.map((n) => n.ref),
    ['@e2', '@e3'],
  );
});

test('GH-979: batch find prints resolved in the same pinned form as candidates', async () => {
  _setActiveSessionForTest({ platform: 'ios', deviceId: 'TEST-UDID', appId: 'com.test' });
  _setRunAgentDeviceForTest(async (cliArgs) => {
    if (cliArgs[0] === 'snapshot') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              data: {
                nodes: [
                  { ref: '@e0', identifier: 'row' },
                  { ref: '@e1', identifier: 'row' },
                ],
              },
            }),
          },
        ],
      };
    }
    return okResult({});
  });
  try {
    const result = await createDeviceBatchHandler()({
      steps: [{ action: 'find', testID: 'row' }],
      screenshotOn: 'none',
    });
    const env = JSON.parse(result.content[0].text) as {
      data?: { results?: Array<{ data?: { resolved?: string; candidates?: string[] } }> };
      meta?: { results?: Array<{ data?: { resolved?: string; candidates?: string[] } }> };
    };
    const step = env.data?.results?.[0] ?? env.meta?.results?.[0];
    assert.equal(step?.data?.resolved, '@e0');
    assert.deepEqual(step?.data?.candidates, ['@e0', '@e1']);
  } finally {
    _setRunAgentDeviceForTest(null);
    _setActiveSessionForTest(null);
  }
});

test('GH-979: STALE_REF refusal echoes the pinned form even when the caller used eN', async () => {
  clearRefMap();
  updateRefMapFromFlat([node], { snapshotGeneration: 1, keyboardVisible: false });
  const out = await healStaleRef('e0', async () =>
    okResult({
      nodes: [{ ref: '@e0', type: 'Other', rect: { x: 0, y: 0, width: 10, height: 10 } }],
    }),
  );
  assert.equal(out.kind, 'failed');
  const env = JSON.parse(out.result.content[0].text) as { code?: string; error?: string };
  assert.equal(env.code, 'STALE_REF');
  assert.match(env.error ?? '', /Element at ref @e0 /);
});
