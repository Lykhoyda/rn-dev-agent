// GH #816: the Maestro fallback behind device_accept_system_dialog /
// device_dismiss_system_dialog defaulted to a required 120 s wait whenever
// the native runner path does not apply (Android, session-less iOS). With no
// dialog present, every call looked hung for two minutes before returning
// DIALOG_NOT_FOUND. Regression contract: the default presence timeout stays
// at most 15 s, explicit caller values up to 120 000 ms still pass through,
// and a no-dialog Android call returns the existing typed DIALOG_NOT_FOUND
// result within that default bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
  _setRunMaestroInlineForTest,
  _resetRunMaestroInlineForTest,
} from '../../dist/tools/device-system-dialog.js';

interface RecordedCall {
  yaml: string;
  timeoutMs?: number;
  slug?: string;
}

const MAESTRO_MISS = {
  passed: false as const,
  output: '',
  flowFile: '',
};

function installRecordingMaestro(calls: RecordedCall[], sleepMs: (ms: number) => void) {
  _setRunMaestroInlineForTest(async (_yaml, opts) => {
    calls.push({ yaml: _yaml, timeoutMs: opts.timeoutMs, slug: opts.slug });
    sleepMs(opts.timeoutMs ?? -1);
    return MAESTRO_MISS;
  });
}

test('#816 accept dialog on Android with no dialog returns typed DIALOG_NOT_FOUND inside the 15s default', async () => {
  const calls: RecordedCall[] = [];
  let waitedMs = 0;
  installRecordingMaestro(calls, (ms) => {
    waitedMs += ms;
  });
  const handler = createDeviceAcceptSystemDialogHandler();
  try {
    const result = await handler({ platform: 'android' });
    // The wait is bounded by the default, not by wall clock here — the seam
    // records what the real Maestro flow would have waited out.
    assert.ok(
      waitedMs > 0 && waitedMs <= 15_000,
      `default wait must be <= 15000ms, got ${waitedMs}`,
    );
    assert.equal(
      result.isError,
      undefined,
      'a missing dialog is a warning result, not a hard error',
    );
    const text = result.content?.map((c) => c.text).join('\n') ?? '';
    const envelope = JSON.parse(text);
    assert.equal(envelope.data?.tapped, false, 'no dialog was tapped');
    assert.equal(envelope.data?.platform, 'android');
    assert.equal(
      envelope.meta?.code,
      'DIALOG_NOT_FOUND',
      'the typed DIALOG_NOT_FOUND code must surface in meta.code',
    );
    assert.match(text, /DIALOG_NOT_FOUND/);
    assert.equal(calls.length, 1, 'exactly one combined-label Maestro probe runs');
    assert.equal(calls[0].slug, 'sys-accept');
  } finally {
    _resetRunMaestroInlineForTest();
  }
});

test('#816 dismiss dialog default timeout also stays within the 15s bound', async () => {
  const calls: RecordedCall[] = [];
  let waitedMs = 0;
  installRecordingMaestro(calls, (ms) => {
    waitedMs += ms;
  });
  const handler = createDeviceDismissSystemDialogHandler();
  try {
    await handler({ platform: 'android' });
    assert.ok(waitedMs <= 15_000, `default dismiss wait must be <= 15000ms, got ${waitedMs}`);
    assert.equal(calls[0].slug, 'sys-dismiss');
  } finally {
    _resetRunMaestroInlineForTest();
  }
});

test('#816 an explicit caller timeout through 120000ms is passed to Maestro unchanged', async () => {
  const calls: RecordedCall[] = [];
  let waitedMs = 0;
  installRecordingMaestro(calls, (ms) => {
    waitedMs += ms;
  });
  const handler = createDeviceAcceptSystemDialogHandler();
  try {
    await handler({ platform: 'android', timeoutMs: 120_000 });
    assert.equal(waitedMs, 120_000, 'explicit caller values up to 120000 must be honored');
  } finally {
    _resetRunMaestroInlineForTest();
  }
});
