import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDeviceRecordHandler } from '../../dist/tools/device-record.js';

const SCOPE = 'a'.repeat(64);

async function fakeRecorder(root: string, savedBytes: number, cadenceReason?: string) {
  const script = join(root, 'record_proof.sh');
  const stopLines = [
    ...(cadenceReason ? [`echo "Cadence normalization skipped: ${cadenceReason}"`] : []),
    `echo "Saved: ${join(root, 'proof.mp4')} (${savedBytes} bytes)"`,
  ].join('; ');
  await writeFile(
    script,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'case "$1" in',
      `  stop) ${stopLines} ;;`,
      '  status) echo "No active recordings" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  await chmod(script, 0o755);
  return script;
}

async function stopWithSavedSize(root: string, savedBytes: number, cadenceReason?: string) {
  const script = await fakeRecorder(root, savedBytes, cadenceReason);
  const runtime = {
    requireAvailable: () => ({ registry: { updateBindings: () => {} }, session: {} }),
    status: () => ({
      available: true,
      sessionId: 'session-a',
      claimEpoch: 1,
      bindings: {
        device: { platform: 'ios', deviceId: 'device-a' },
        recorder: {
          script,
          scope: SCOPE,
          pid: 4321,
          processBirth: 'birth-token',
          claimKey: 'recorder-a',
        },
      },
    }),
  };
  const handler = createDeviceRecordHandler({ runtime: runtime as never });
  const result = await handler({ action: 'stop' });
  return JSON.parse(result.content[0].text);
}

test('a stop result reports a proof video that exceeds the GitHub video attachment limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-oversize-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const envelope = await stopWithSavedSize(root, 125_829_120);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.saved[0].sizeBytes, 125_829_120);
  assert.match(envelope.meta.warning, /125829120 bytes/);
  assert.match(envelope.meta.warning, /104857600/);
  assert.match(envelope.meta.warning, /video attachment limit/);
  assert.match(envelope.meta.warning, /kept/);
});

test('a stop result for an attachable proof video carries no size warning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-attachable-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const envelope = await stopWithSavedSize(root, 100 * 1024 * 1024);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.saved[0].sizeBytes, 100 * 1024 * 1024);
  assert.equal(envelope.meta, undefined);
});

test('a stop result reports a recording whose cadence could not be normalized', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'record-cadence-skipped-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const envelope = await stopWithSavedSize(root, 4_096, 'capture duration unreadable');

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.saved[0].sizeBytes, 4_096);
  assert.equal(envelope.data.normalizationSkipped, 'capture duration unreadable');
  assert.match(envelope.meta.warning, /not normalized to 30 fps/);
  assert.match(envelope.meta.warning, /capture duration unreadable/);
  assert.match(envelope.meta.warning, /slideshow/);
});
