import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  _resetForTest,
  _setForTest,
  captureIosScreenshot,
  tryRawScreenshot,
} from '../../dist/tools/device-screenshot-raw.js';
import {
  publicDeviceIdentity,
  sanitizeAutomationProcessLines,
  sanitizePublicDiagnostic,
} from '../../dist/util/public-diagnostics.js';
import { captureAndResizeScreenshot } from '../../dist/tools/device-list.js';

const UDID = '7A6033C8-9291-4B0B-80B9-46024EEDF7D7';

test('iOS screenshot failure preserves structured backend evidence without cross-device resolution', async () => {
  let resolverCalls = 0;
  _setForTest({
    iosResolver: async () => {
      resolverCalls += 1;
      return 'WRONG-DEVICE';
    },
    iosCapturer: async (id, path) => ({
      ok: false,
      backend: 'simctl',
      argv: ['simctl', 'io', publicDeviceIdentity(id), 'screenshot', '--type=jpeg', path],
      exitCode: 2,
      signal: null,
      timedOut: false,
      stderr: sanitizePublicDiagnostic(
        `failure /Users/alice/Library/Developer/CoreSimulator/Devices/${id}/data`,
        { deviceIds: [id] },
      ),
      outputPath: path,
      format: 'jpeg',
      device: publicDeviceIdentity(id),
      localDiagnostic: {
        identitySource: 'authority-session-state',
        instruction: 'resolve exact identity locally',
      },
    }),
  });
  try {
    const localPath = '/Users/alice/checkout/proof/failure.jpg';
    const result = await tryRawScreenshot('ios', localPath, UDID);
    assert.equal(result.ok, false);
    assert.equal(resolverCalls, 0);
    assert.equal(result.capture?.backend, 'simctl');
    assert.equal(result.capture?.exitCode, 2);
    assert.equal(result.capture?.outputPath, '<local-path>/failure.jpg');
    assert.equal(result.capture?.argv.at(-1), '<output-path>');
    assert.equal(result.capture?.format, 'jpeg');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(UDID));
    assert.doesNotMatch(JSON.stringify(result), /Users\/alice|checkout\/proof/);
  } finally {
    _resetForTest();
  }
});

test('public screenshot failure sanitizes every absolute path evidence field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-public-shot-'));
  const path = join(dir, 'private-checkout', 'failure.png');
  _setForTest({
    iosCapturer: async (id, outputPath) => ({
      ok: false,
      backend: 'simctl',
      argv: ['xcrun', 'simctl', 'io', id, 'screenshot', outputPath],
      exitCode: 1,
      signal: null,
      timedOut: false,
      stderr: `permission denied at ${outputPath}`,
      outputPath,
      format: 'png',
      device: id,
      localDiagnostic: {
        identitySource: 'authority-session-state',
        instruction: 'resolve exact identity locally',
      },
    }),
  });
  try {
    const result = await captureAndResizeScreenshot({
      path,
      platform: 'ios',
      platformExplicit: true,
      deviceId: UDID,
    });
    const envelope = JSON.parse(result.content[0]!.text) as Record<string, any>;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.meta.capture.outputPath, '<local-path>/failure.png');
    assert.equal(envelope.meta.capture.argv.at(-1), '<output-path>');
    assert.doesNotMatch(JSON.stringify(envelope), new RegExp(dir));
    assert.doesNotMatch(JSON.stringify(envelope), new RegExp(UDID));
  } finally {
    _resetForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('default iOS capturer preserves exit/signal/timeout and validates a non-empty file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rn-584-shot-'));
  const path = join(dir, 'shot.png');
  try {
    const failure = await captureIosScreenshot(UDID, path, async () => {
      throw Object.assign(new Error('failed'), {
        code: 9,
        signal: 'SIGTERM',
        killed: true,
        stderr: `bad /Users/alice/Library/Developer/CoreSimulator/Devices/${UDID}`,
      });
    });
    assert.equal(failure.ok, false);
    assert.equal(failure.exitCode, 9);
    assert.equal(failure.signal, 'SIGTERM');
    assert.equal(failure.timedOut, true);
    assert.equal(failure.outputPath, `<local-path>/shot.png`);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(dir));
    assert.doesNotMatch(failure.stderr, /Users\/alice|7A6033C8/);

    const empty = await captureIosScreenshot(UDID, path, async () => ({ stdout: '', stderr: '' }));
    assert.equal(empty.ok, false);
    assert.match(empty.stderr, /non-empty output file/);

    const success = await captureIosScreenshot(UDID, path, async () => {
      writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: '', stderr: '' };
    });
    assert.equal(success.ok, true);
    assert.equal(success.bytes, 4);
    assert.deepEqual(success.argv.slice(0, 3), ['xcrun', 'simctl', 'io']);
    assert.equal(success.argv.at(-1), '<output-path>');
    assert.doesNotMatch(JSON.stringify(success.argv), new RegExp(path));
    assert.equal(success.format, 'png');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared public sanitizer strips foreign automation paths, usernames, and full IDs', () => {
  const raw = `81263 /Users/antonlykhoyda/My Project/Devices/${UDID}/WebDriverAgentRunner-Runner`;
  const lines = sanitizeAutomationProcessLines([raw], UDID);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /pid=81263 executable=WebDriverAgentRunner-Runner device-/);
  assert.doesNotMatch(lines[0]!, /antonlykhoyda|7A6033C8|\/Users\//);

  const diagnostic = sanitizePublicDiagnostic(
    'capture /workspace/repo/output.png: failed beside /Users/alice/My Project/failure.png',
  );
  assert.equal(
    diagnostic,
    'capture <local-path>/output.png: failed beside <local-path>/failure.png',
  );
});
