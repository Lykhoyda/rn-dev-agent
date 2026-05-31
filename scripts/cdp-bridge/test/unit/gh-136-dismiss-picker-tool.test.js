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

import { createDismissDevClientPickerHandler } from '../../dist/tools/dev-client-picker.js';

const handle = createDismissDevClientPickerHandler();
const parse = (r) => JSON.parse(r.content[0].text);

test('handler: no session → DEV_CLIENT_PICKER_NO_SESSION', async () => {
  _setHasSessionForTest(false);
  try {
    const r = await handle({ platform: 'android' });
    assert.equal(r.isError, true);
    assert.equal(parse(r).code, 'DEV_CLIENT_PICKER_NO_SESSION');
  } finally { _resetHasSessionForTest(); }
});

test('handler: iOS → warn, dismissed:false, never calls runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => { calls.push(args); return { content: [{ type: 'text', text: '{}' }] }; });
  try {
    const r = await handle({ platform: 'ios' });
    assert.equal(r.isError, undefined);
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.data.platform, 'ios');
    assert.match(p.meta.warning, /manually/i);
    assert.equal(calls.length, 0);
  } finally { _resetRunAgentDeviceForTest(); }
});

test('handler: Android dismissed → ok dismissed:true with timings', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && (args[1] === 'Development servers' || args[1] === 'DEVELOPMENT SERVERS')) {
      findCount += 1;
      return findCount >= 2 ? { content: [{ type: 'text', text: 'gone' }], isError: true } : { content: [{ type: 'text', text: '{}' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const r = await handle({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, true);
    assert.ok(p.meta && typeof p.meta.timings_ms.total === 'number');
  } finally { _resetRunAgentDeviceForTest(); _resetHasSessionForTest(); }
});

test('handler: Android picker not detected → ok dismissed:false (no warning)', async () => {
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: 'not found' }], isError: true }));
  try {
    const r = await handle({ platform: 'android' });
    assert.equal(r.isError, undefined);
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.meta?.warning, undefined);
  } finally { _resetRunAgentDeviceForTest(); _resetHasSessionForTest(); }
});

test('handler: Android detected but no entry → warn dismissed:false', async () => {
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && (args[1] === 'Development servers' || args[1] === 'DEVELOPMENT SERVERS')) return { content: [{ type: 'text', text: '{}' }] };
    if (args[0] === 'snapshot') return { content: [{ type: 'text', text: 'Development servers\nEnter URL manually' }] };
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const r = await handle({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.match(p.meta.warning, /could not find|manually/i);
  } finally { _resetRunAgentDeviceForTest(); _resetHasSessionForTest(); }
});

import { annotatePicker } from '../../dist/tools/device-deeplink.js';

const okEnvelope = (data) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }] });

test('annotatePicker: null outcome → pickerChecked:false', () => {
  const r = annotatePicker(okEnvelope({ opened: true }), null);
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, false);
});

test('annotatePicker: dismissed outcome → pickerDismissed:true', () => {
  const r = annotatePicker(okEnvelope({ opened: true }), { dismissed: true, reason: 'tapped', platform: 'android' });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, true);
  assert.equal(p.meta.pickerDismissed, true);
});

test('annotatePicker: error result passes through untouched', () => {
  const err = { content: [{ type: 'text', text: '{"ok":false,"error":"x"}' }], isError: true };
  const r = annotatePicker(err, { dismissed: true, reason: 't' });
  assert.equal(r, err);
});
