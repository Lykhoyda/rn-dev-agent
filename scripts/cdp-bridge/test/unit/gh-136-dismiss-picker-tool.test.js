// GH #136 sub-3: cdp_dismiss_dev_client_picker tool + clearDevClientPickerIfPresent
// helper + device_deeplink picker annotation. Drives every branch via the
// agent-device wrapper test seams (_setRunAgentDeviceForTest / _setHasSessionForTest).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDevClientPickerIfPresent,
  _setRunAgentDeviceForTest,
  _setHasSessionForTest,
  _resetRunAgentDeviceForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

test('helper: iOS is guarded — skips without calling runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => { calls.push(args); return { content: [{ type: 'text', text: '{}' }] }; });
  try {
    const out = await clearDevClientPickerIfPresent('ios');
    assert.equal(calls.length, 0, 'runAgentDevice must never be called on iOS');
    assert.equal(out.skipped, true);
    assert.equal(out.dismissed, false);
    assert.equal(out.platform, 'ios');
    assert.match(out.reason, /manually/i);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});

test('helper: Android with no session returns null', async () => {
  _setHasSessionForTest(false);
  try {
    const out = await clearDevClientPickerIfPresent('android');
    assert.equal(out, null);
  } finally {
    _resetHasSessionForTest();
  }
});

test('helper: Android delegates to handleDevClientPicker (auto-advance → dismissed)', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && (args[1] === 'Development servers' || args[1] === 'DEVELOPMENT SERVERS')) {
      findCount += 1;
      // 1st find = detected; 2nd find (dismissPicker re-probe) = gone → auto-advanced
      return findCount >= 2
        ? { content: [{ type: 'text', text: 'not found' }], isError: true }
        : { content: [{ type: 'text', text: '{}' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const out = await clearDevClientPickerIfPresent('android');
    assert.ok(out);
    assert.equal(out.dismissed, true);
    assert.equal(out.platform, 'android');
  } finally {
    _resetRunAgentDeviceForTest();
    _resetHasSessionForTest();
  }
});
