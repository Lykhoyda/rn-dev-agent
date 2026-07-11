// GH #545: SpringBoard dialogs (deeplink "Open in <app>?" confirmation,
// permission prompts) are invisible to Maestro's iOS driver — the runner-first
// path routes accept/dismiss through rn-fast-runner snapshot+press instead.
// Drives every branch via the device-system-dialog test seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tapSystemDialogViaRunner,
  acceptDeeplinkOpenConfirmation,
  createDeviceAcceptSystemDialogHandler,
  _setFetchSnapshotNodesForTest,
  _resetFetchSnapshotNodesForTest,
  _setPressCandidateForTest,
  _resetPressCandidateForTest,
  _setIosSessionActiveForTest,
  _resetIosSessionActiveForTest,
  _setSleepForTest,
  _resetSleepForTest,
} from '../../dist/tools/device-system-dialog.js';
import { annotatePicker } from '../../dist/tools/device-deeplink.js';

const ALERT_SNAPSHOT = {
  ok: true,
  nodes: [
    { ref: '@e1', type: 'Alert', label: 'Open in “MyApp”?' },
    { ref: '@e2', type: 'Button', label: 'Cancel' },
    { ref: '@e3', type: 'Button', label: 'Open' },
  ],
};

const APP_SNAPSHOT = {
  ok: true,
  nodes: [
    { ref: '@e1', type: 'Application', label: 'MyApp' },
    { ref: '@e2', type: 'Button', label: 'Open' },
  ],
};

function resetSeams() {
  _resetFetchSnapshotNodesForTest();
  _resetPressCandidateForTest();
  _resetIosSessionActiveForTest();
  _resetSleepForTest();
}

test('runner path: no iOS session returns null (Maestro fallback applies)', async () => {
  _setIosSessionActiveForTest(false);
  const snapshots = [];
  _setFetchSnapshotNodesForTest(async () => {
    snapshots.push(1);
    return ALERT_SNAPSHOT;
  });
  try {
    const out = await tapSystemDialogViaRunner(['Open']);
    assert.equal(out, null);
    assert.equal(snapshots.length, 0, 'no snapshot without an iOS session');
  } finally {
    resetSeams();
  }
});

test('runner path: non-Alert snapshot root returns null (in-app screen, not SpringBoard)', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => APP_SNAPSHOT);
  const presses = [];
  _setPressCandidateForTest(async (c) => {
    presses.push(c);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const out = await tapSystemDialogViaRunner(['Open']);
    assert.equal(out, null);
    assert.equal(presses.length, 0, 'must not tap in-app "Open" buttons');
  } finally {
    resetSeams();
  }
});

test('runner path: failed snapshot returns null', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ({ ok: false, reason: 'fetch-failed' }));
  try {
    assert.equal(await tapSystemDialogViaRunner(['Open']), null);
  } finally {
    resetSeams();
  }
});

test('runner path: taps the first matching label on an Alert payload', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ALERT_SNAPSHOT);
  const presses = [];
  _setPressCandidateForTest(async (candidate, action) => {
    presses.push({ candidate, action });
    return { content: [{ type: 'text', text: '{"ok":true}' }] };
  });
  try {
    const out = await tapSystemDialogViaRunner(['Allow', 'Open']);
    assert.equal(out.tapped, true);
    assert.equal(out.matchedLabel, 'Open');
    assert.equal(out.dialogTitle, 'Open in “MyApp”?');
    assert.equal(presses.length, 1);
    assert.equal(presses[0].candidate.ref, '@e3');
    assert.equal(presses[0].action, 'click');
  } finally {
    resetSeams();
  }
});

test('runner path: Alert up but no label match reports availableButtons', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ALERT_SNAPSHOT);
  const presses = [];
  _setPressCandidateForTest(async (c) => {
    presses.push(c);
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const out = await tapSystemDialogViaRunner(['Allow', 'OK']);
    assert.equal(out.tapped, false);
    assert.deepEqual(out.availableButtons, ['Cancel', 'Open']);
    assert.equal(out.dialogTitle, 'Open in “MyApp”?');
    assert.equal(presses.length, 0);
  } finally {
    resetSeams();
  }
});

test('runner path: a failed press falls through to the next matching label', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ({
    ok: true,
    nodes: [
      { ref: '@e1', type: 'Alert', label: 'Allow access?' },
      { ref: '@e2', type: 'Button', label: 'Allow' },
      { ref: '@e3', type: 'Button', label: 'OK' },
    ],
  }));
  const presses = [];
  _setPressCandidateForTest(async (candidate) => {
    presses.push(candidate.ref);
    if (candidate.ref === '@e2') {
      return { isError: true, content: [{ type: 'text', text: 'press failed' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  });
  try {
    const out = await tapSystemDialogViaRunner(['Allow', 'OK']);
    assert.equal(out.tapped, true);
    assert.equal(out.matchedLabel, 'OK');
    assert.deepEqual(presses, ['@e2', '@e3']);
  } finally {
    resetSeams();
  }
});

test('deeplink confirmation: retries once (sleeping the animation window) when the dialog has not appeared yet', async () => {
  _setIosSessionActiveForTest(true);
  let calls = 0;
  _setFetchSnapshotNodesForTest(async () => {
    calls += 1;
    return calls === 1 ? APP_SNAPSHOT : ALERT_SNAPSHOT;
  });
  _setPressCandidateForTest(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  const sleeps: number[] = [];
  _setSleepForTest(async (ms) => {
    sleeps.push(ms);
  });
  try {
    const out = await acceptDeeplinkOpenConfirmation();
    assert.equal(out.tapped, true);
    assert.equal(out.matchedLabel, 'Open');
    assert.equal(calls, 2, 'one retry after the animation window');
    assert.deepEqual(sleeps, [750], 'the retry waits the animation window exactly once');
  } finally {
    resetSeams();
  }
});

test('deeplink confirmation: no iOS session bails before the retry sleep is ever scheduled', async () => {
  _setIosSessionActiveForTest(false);
  let calls = 0;
  _setFetchSnapshotNodesForTest(async () => {
    calls += 1;
    return ALERT_SNAPSHOT;
  });
  let slept = false;
  _setSleepForTest(async () => {
    slept = true;
  });
  try {
    const out = await acceptDeeplinkOpenConfirmation();
    assert.equal(out, null);
    assert.equal(calls, 0, 'no snapshot without a session');
    // The sleep seam directly proves the no-delay property: the guard returns
    // before the retry sleep is ever scheduled (calls===0 alone would still
    // pass an impl that slept first, then bailed).
    assert.equal(slept, false, 'the retry sleep must not run on a session-less deeplink');
  } finally {
    resetSeams();
  }
});

test('deeplink confirmation: first-probe outcome is returned without a retry (no sleep)', async () => {
  _setIosSessionActiveForTest(true);
  let calls = 0;
  _setFetchSnapshotNodesForTest(async () => {
    calls += 1;
    return ALERT_SNAPSHOT;
  });
  _setPressCandidateForTest(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  let slept = false;
  _setSleepForTest(async () => {
    slept = true;
  });
  try {
    const out = await acceptDeeplinkOpenConfirmation();
    assert.equal(out.tapped, true);
    assert.equal(calls, 1, 'no retry when the first probe resolves');
    assert.equal(slept, false, 'no sleep when the first probe already tapped');
  } finally {
    resetSeams();
  }
});

test('accept handler: iOS runner tap short-circuits Maestro with via:rn-fast-runner', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ALERT_SNAPSHOT);
  _setPressCandidateForTest(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  try {
    const handle = createDeviceAcceptSystemDialogHandler();
    const result = await handle({ platform: 'ios' });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.tapped, true);
    assert.equal(envelope.data.matchedLabel, 'Open');
    assert.equal(envelope.data.via, 'rn-fast-runner');
  } finally {
    resetSeams();
  }
});

test('accept handler: dialog present but unmatched labels warn with DIALOG_BUTTON_NOT_FOUND', async () => {
  _setIosSessionActiveForTest(true);
  _setFetchSnapshotNodesForTest(async () => ({
    ok: true,
    nodes: [
      { ref: '@e1', type: 'Alert', label: 'Sign in required' },
      { ref: '@e2', type: 'Button', label: 'Sign In' },
    ],
  }));
  _setPressCandidateForTest(async () => ({ content: [{ type: 'text', text: '{}' }] }));
  try {
    const handle = createDeviceAcceptSystemDialogHandler();
    const result = await handle({ platform: 'ios' });
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.tapped, false);
    assert.equal(envelope.meta.code, 'DIALOG_BUTTON_NOT_FOUND');
    assert.match(envelope.meta.warning, /availableButtons/);
    assert.deepEqual(envelope.data.availableButtons, ['Sign In']);
  } finally {
    resetSeams();
  }
});

test('annotatePicker: surfaces openDialogTapped only when a confirmation outcome exists', () => {
  const base = () => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { opened: true } }) }],
  });
  const withConfirmation = annotatePicker(
    base(),
    { dismissed: true, reason: 'tapped' },
    { tapped: true, matchedLabel: 'Open' },
  );
  const meta = JSON.parse(withConfirmation.content[0].text).meta;
  assert.equal(meta.openDialogTapped, true);
  assert.equal(meta.pickerChecked, true);
  assert.equal(meta.pickerDismissed, true);

  const withoutConfirmation = annotatePicker(base(), null, null);
  const meta2 = JSON.parse(withoutConfirmation.content[0].text).meta;
  assert.equal(meta2.pickerChecked, false);
  assert.equal('openDialogTapped' in meta2, false);
});
