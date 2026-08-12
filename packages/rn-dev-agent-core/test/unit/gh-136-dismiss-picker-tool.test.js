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

// GH #523 sub-3: the iOS short-circuit is gone — iOS takes the same dismiss
// path as Android (rn-fast-runner backs snapshot/press there now, so the
// D1219 legacy-daemon concern no longer applies).
test('helper: iOS with no session returns null (parity with Android)', async () => {
  _setHasSessionForTest(false);
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => {
    calls.push(args);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const out = await clearDevClientPickerIfPresent('ios', 8081);
    assert.equal(out, null);
    assert.equal(calls.length, 0, 'no snapshot without a session');
  } finally {
    _resetRunAgentDeviceForTest();
    _resetHasSessionForTest();
  }
});

test('helper: Android with no session returns null', async () => {
  _setHasSessionForTest(false);
  try {
    const out = await clearDevClientPickerIfPresent('android', 8081);
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
    const out = await clearDevClientPickerIfPresent('android', 8081);
    assert.ok(out);
    assert.equal(out.dismissed, true);
    assert.equal(out.platform, 'android');
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

import { createDismissDevClientPickerHandler } from '../../dist/tools/dev-client-picker.js';

const handle = createDismissDevClientPickerHandler(() => 8081);
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

// GH #523 sub-3: iOS is a first-class platform for the tool — with a session
// open and nothing on screen it reports a clean not-detected result.
test('handler: iOS with nothing on screen → ok, dismissed:false, no snapshot', async () => {
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
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
    assert.match(p.data.reason, /not detected/i);
    assert.equal(calls.length, 0, 'no snapshot when no picker/dialog is present');
  } finally {
    _resetRunAgentDeviceForTest();
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
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
  const originCalls = [];
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    reproveOrigin: async () => {
      originCalls.push('reprove');
    },
    completeOrigin: async (_args, targetExpected) => {
      originCalls.push(`complete:${targetExpected}`);
    },
  });
  try {
    const r = await handleWithOrigin({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, true);
    assert.ok(p.meta && typeof p.meta.timings_ms.total === 'number');
    assert.deepEqual(originCalls, ['reprove', 'complete:true']);
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// GH #750: the picker tool exists for the stranded-picker state where B is
// unbound, so its profile admits it without A/B — but a successful dismissal
// must then reconnect the exact target and prove A/B via the managed origin.
test('GH #750 handler: dismissal without a picker performs no origin proof', async () => {
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
  const originCalls = [];
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    reproveOrigin: async () => {
      originCalls.push('reprove');
    },
    completeOrigin: async () => {
      originCalls.push('complete');
    },
  });
  try {
    const r = await handleWithOrigin({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.deepEqual(originCalls, [], 'an untouched screen must not re-pin authority');
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

test('GH #750 handler: a failed post-dismissal proof surfaces instead of a silent ok', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers' || text === 'DEVELOPMENT SERVERS') {
      findCount += 1;
      return findCount >= 2
        ? { ok: true, candidates: [] }
        : { ok: true, candidates: [{ ref: 'e1', label: text }] };
    }
    return { ok: true, candidates: [] };
  });
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    reproveOrigin: async () => {},
    completeOrigin: async () => {
      throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: reattachment proof failed');
    },
  });
  try {
    await assert.rejects(handleWithOrigin({ platform: 'android' }), /BUNDLE_HANDSHAKE_UNAVAILABLE/);
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// GH #750: the proof can fail after the picker was already tapped away. The
// retry then finds no picker at all, so it must still re-prove B instead of
// returning ok with the authority the tool exists to repair still unbound.
test('GH #750 handler: a retry after a failed proof still re-proves an unbound bundle', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setFetchCandidatesForTest(async (text) => {
    if (text === 'Development servers' || text === 'DEVELOPMENT SERVERS') {
      findCount += 1;
      return findCount >= 2
        ? { ok: true, candidates: [] }
        : { ok: true, candidates: [{ ref: 'e1', label: text }] };
    }
    return { ok: true, candidates: [] };
  });
  const originCalls = [];
  const reproveBudgets = [];
  let bundleBound = false;
  let proofFails = true;
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    isBundleBound: () => bundleBound,
    reproveOrigin: async (_args, options) => {
      originCalls.push('reprove');
      reproveBudgets.push(options?.readinessTimeoutMs);
    },
    completeOrigin: async (_args, targetExpected) => {
      if (proofFails) throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: reattachment proof failed');
      originCalls.push(`complete:${targetExpected}`);
      bundleBound = true;
    },
  });
  try {
    await assert.rejects(handleWithOrigin({ platform: 'android' }), /BUNDLE_HANDSHAKE_UNAVAILABLE/);
    assert.equal(bundleBound, false);

    proofFails = false;
    const retry = await handleWithOrigin({ platform: 'android' });
    const p = parse(retry);
    assert.equal(retry.isError, undefined);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.data.reproved, true);
    assert.deepEqual(originCalls, ['reprove', 'reprove', 'complete:true']);
    assert.deepEqual(
      reproveBudgets,
      [undefined, undefined],
      'a retry after a real dismissal keeps the full exact-target readiness budget',
    );
    assert.equal(bundleBound, true, 'the retry must leave B bound');

    const settled = await handleWithOrigin({ platform: 'android' });
    assert.equal(parse(settled).data.reproved, undefined, 'a bound bundle is not re-proved');
    assert.deepEqual(originCalls, ['reprove', 'reprove', 'complete:true']);

    bundleBound = false;
    await handleWithOrigin({ platform: 'android' });
    assert.equal(
      reproveBudgets.at(-1),
      45_000,
      'once B was bound again the retry window must not stay sticky',
    );
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// GH #750: a probe on a device that advertises no session target and whose app
// is provably not running fails fast instead of burning the exact-target budget.
test('GH #750 handler: a no-picker probe fails fast when the session runtime is absent', async () => {
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
  const reproveBudgets = [];
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    isBundleBound: () => false,
    isSessionRuntimeAbsent: async () => true,
    reproveOrigin: async (_args, options) => {
      reproveBudgets.push(options?.readinessTimeoutMs);
    },
    completeOrigin: async () => {},
  });
  try {
    const r = await handleWithOrigin({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.data.reproved, true);
    assert.deepEqual(reproveBudgets, [15_000]);
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// GH #750: a dev-client that is still re-registering (the ~40s bridgeless
// window this branch models) must be repairable by the same probe, so it keeps
// a budget wider than the re-registration window instead of refusing at 15s.
test('GH #750 handler: a no-picker probe outlasts a slow bridgeless re-registration', async () => {
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
  const reproveBudgets = [];
  let bundleBound = false;
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    isBundleBound: () => bundleBound,
    isSessionRuntimeAbsent: async () => false,
    reproveOrigin: async (_args, options) => {
      reproveBudgets.push(options?.readinessTimeoutMs);
    },
    completeOrigin: async () => {
      bundleBound = true;
    },
  });
  try {
    const r = await handleWithOrigin({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.reproved, true);
    assert.equal(reproveBudgets.length, 1);
    assert.ok(
      reproveBudgets[0] > 40_000,
      `the probe must outlast the modeled re-registration window, saw ${String(reproveBudgets[0])}`,
    );
    assert.ok(reproveBudgets[0] < 120_000, 'the 120s budget stays reserved for cdp_connect');
    assert.equal(bundleBound, true);
  } finally {
    _resetFetchCandidatesForTest();
    _resetHasSessionForTest();
  }
});

// GH #750: an inconclusive or failing runtime probe must not shorten the budget.
test('GH #750 handler: an unavailable runtime probe keeps the wider repair budget', async () => {
  _setHasSessionForTest(true);
  _setFetchCandidatesForTest(async () => ({ ok: true, candidates: [] }));
  const reproveBudgets = [];
  const handleWithOrigin = createDismissDevClientPickerHandler(() => 8081, {
    isBundleBound: () => false,
    isSessionRuntimeAbsent: async () => {
      throw new Error('simctl unavailable');
    },
    reproveOrigin: async (_args, options) => {
      reproveBudgets.push(options?.readinessTimeoutMs);
    },
    completeOrigin: async () => {},
  });
  try {
    const r = await handleWithOrigin({ platform: 'android' });
    const p = parse(r);
    assert.equal(p.data.dismissed, false);
    assert.equal(p.data.reproved, true);
    assert.deepEqual(reproveBudgets, [45_000]);
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
