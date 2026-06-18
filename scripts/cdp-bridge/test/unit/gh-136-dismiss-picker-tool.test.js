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
  _setFetchCandidatesForTest,
  _resetFetchCandidatesForTest,
  _setPressCandidateForTest,
  _resetPressCandidateForTest,
} from '../../dist/tools/dev-client-picker.js';

test('helper: iOS is guarded — skips without calling runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: '{}' }] };
  });
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
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers' || text === 'DEVELOPMENT SERVERS') {
      findCount += 1;
      // 1st find = detected; 2nd find (dismissPicker re-probe) = gone → auto-advanced
      return findCount >= 2
        ? { ok: true, candidates: [] }
        : { ok: true, candidates: [{ ref: 'e1', label: text }] };
    }
    return { ok: true, candidates: [] };
  });
  try {
    const out = await clearDevClientPickerIfPresent('android');
    assert.ok(out);
    assert.equal(out.dismissed, true);
    assert.equal(out.platform, 'android');
  } finally {
    _resetFetchCandidatesForTest();
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
  } finally {
    _resetHasSessionForTest();
  }
});

test('handler: iOS → warn, dismissed:false, never calls runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const r = await handle({ platform: 'ios' });
    assert.equal(r.isError, undefined);
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.data.platform, 'ios');
    assert.match(p.meta.warning, /manually/i);
    assert.equal(calls.length, 0);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});

test('handler: Android dismissed → ok dismissed:true with timings', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers' || text === 'DEVELOPMENT SERVERS') {
      findCount += 1;
      // 1st call = detected; 2nd call (dismissPicker re-probe) = gone → auto-advanced
      return findCount >= 2
        ? { ok: true, candidates: [] }
        : { ok: true, candidates: [{ ref: 'e1', label: text }] };
    }
    return { ok: true, candidates: [] };
  });
  try {
    const r = await handle({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, true);
    assert.ok(p.meta && typeof p.meta.timings_ms.total === 'number');
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

test('handler: Android picker not detected → ok dismissed:false (no warning)', async () => {
  _setHasSessionForTest(true);
  // find goes through fetchCandidatesFn — no candidates means picker not detected
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
  try {
    const r = await handle({ platform: 'android' });
    assert.equal(r.isError, undefined);
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.meta?.warning, undefined);
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

test('handler: Android detected but no entry → warn dismissed:false', async () => {
  _setHasSessionForTest(true);
  // snapshot still routes through runAgentDeviceFn
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot')
      return { content: [{ type: 'text', text: 'Development servers\nEnter URL manually' }] };
    return { content: [{ type: 'text', text: '{}' }] };
  });
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers' || text === 'DEVELOPMENT SERVERS') {
      // Picker detected on first probe; auto-advance re-probe also finds it.
      return { ok: true, candidates: [{ ref: 'e1', label: text }] };
    }
    // No match for the server entry extracted from snapshot text
    return { ok: true, candidates: [] };
  });
  try {
    const r = await handle({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.match(p.meta.warning, /could not find|manually/i);
  } finally {
    _resetRunAgentDeviceForTest();
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

import { annotatePicker } from '../../dist/tools/device-deeplink.js';

const okEnvelope = (data) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
});

test('annotatePicker: null outcome → pickerChecked:false', () => {
  const r = annotatePicker(okEnvelope({ opened: true }), null);
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, false);
});

test('annotatePicker: dismissed outcome → pickerDismissed:true', () => {
  const r = annotatePicker(okEnvelope({ opened: true }), {
    dismissed: true,
    reason: 'tapped',
    platform: 'android',
  });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, true);
  assert.equal(p.meta.pickerDismissed, true);
});

test('annotatePicker: error result passes through untouched', () => {
  const err = { content: [{ type: 'text', text: '{"ok":false,"error":"x"}' }], isError: true };
  const r = annotatePicker(err, { dismissed: true, reason: 't' });
  assert.equal(r, err);
});
