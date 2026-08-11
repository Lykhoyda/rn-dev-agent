import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const script = new URL('../../../../scripts/check-physical-devices.sh', import.meta.url).pathname;

function runProbe(existingReverse: string, failList = false) {
  const root = mkdtempSync(join(tmpdir(), 'rn-physical-probe-'));
  const bin = join(root, 'bin');
  const calls = join(root, 'adb-calls.txt');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'adb'),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$ADB_CALLS"
if [ "$1" = devices ]; then
  printf 'List of devices attached\\nUSB-EXACT\\tdevice\\n'
  exit 0
fi
if [ "$1 $2 $3 $4" = '-s USB-EXACT reverse --list' ]; then
  ${failList ? 'exit 1' : `printf '%s' "$EXISTING_REVERSE"`}
  exit 0
fi
exit 91
`,
  );
  chmodSync(join(bin, 'adb'), 0o755);
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ADB_CALLS: calls,
      EXISTING_REVERSE: existingReverse,
    },
  });
  const observedCalls = readFileSync(calls, 'utf8').trim().split('\n');
  rmSync(root, { force: true, recursive: true });
  return { result, observedCalls };
}

test('physical Android doctor is read-only and leaves session reverse authority as sole writer', () => {
  const { result, observedCalls } = runProbe('');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[READY\] authorized adb serial USB-EXACT/);
  assert.match(result.stdout, /\[OK\] no pre-existing adb reverse forwards/);
  assert.deepEqual(observedCalls, ['devices', '-s USB-EXACT reverse --list']);
  assert.equal(
    observedCalls.some((call) => /reverse tcp:/.test(call)),
    false,
  );
  assert.equal(
    observedCalls.some((call) => /reverse --remove/.test(call)),
    false,
  );
});

test('physical Android doctor reports foreign forwards and ambiguous inspection without mutation', () => {
  const foreign = runProbe('UsbFfs tcp:8081 tcp:8081');
  assert.equal(foreign.result.status, 0, foreign.result.stderr);
  assert.match(foreign.result.stdout, /\[WARN\] pre-existing adb reverse forwards/);
  assert.match(foreign.result.stdout, /UsbFfs tcp:8081 tcp:8081/);
  assert.deepEqual(foreign.observedCalls, ['devices', '-s USB-EXACT reverse --list']);

  const ambiguous = runProbe('', true);
  assert.equal(ambiguous.result.status, 0, ambiguous.result.stderr);
  assert.match(ambiguous.result.stdout, /could not inspect existing adb reverse forwards/);
  assert.match(ambiguous.result.stdout, /session will verify or refuse exact reachability/);
  assert.deepEqual(ambiguous.observedCalls, ['devices', '-s USB-EXACT reverse --list']);
});
