import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ensureAndroidMetroReverse,
  removeAndroidMetroReverse,
  type AndroidMetroReverseBinding,
} from '../../../dist/session/android-metro-reverse.js';

interface AdbFixture {
  calls: string[][];
  execute(file: string, args: string[]): string;
  forwards: Map<string, string>;
}

function fixture(
  input: { qemu?: boolean; serial?: string; forwards?: Array<[string, string]> } = {},
): AdbFixture {
  const serial = input.serial ?? 'physical-serial';
  const calls: string[][] = [];
  const forwards = new Map(input.forwards ?? []);
  return {
    calls,
    forwards,
    execute(file, args) {
      assert.equal(file, 'adb');
      calls.push(args);
      assert.deepEqual(args.slice(0, 2), ['-s', serial]);
      const command = args.slice(2);
      if (command.join(' ') === 'shell getprop ro.kernel.qemu') {
        return input.qemu ? '1\n' : '\n';
      }
      if (command.join(' ') === 'reverse --list') {
        return [...forwards].map(([local, remote]) => `UsbFfs ${local} ${remote}`).join('\n');
      }
      if (command[0] === 'reverse' && command[1] === '--remove') {
        forwards.delete(command[2]!);
        return '';
      }
      if (command[0] === 'reverse' && command.length === 3) {
        forwards.set(command[1]!, command[2]!);
        return '';
      }
      throw new Error(`unexpected adb command: ${command.join(' ')}`);
    },
  };
}

function binding(deviceId = 'physical-serial', metroPort = 8397): AndroidMetroReverseBinding {
  return {
    platform: 'android',
    deviceId,
    metroPort,
    local: `tcp:${metroPort}`,
    remote: `tcp:${metroPort}`,
  };
}

test('physical Android establishes and verifies only the exact serial and Metro port', () => {
  const adb = fixture();
  const result = ensureAndroidMetroReverse({ deviceId: 'physical-serial', metroPort: 8397 }, adb);
  assert.deepEqual(result, { binding: binding(), created: true, physical: true });
  assert.equal(adb.forwards.get('tcp:8397'), 'tcp:8397');
  assert.equal(
    adb.calls.some((args) => args.join(' ') === '-s physical-serial reverse tcp:8397 tcp:8397'),
    true,
  );
  assert.equal(
    adb.calls.some((args) => args.includes('8081')),
    false,
  );
});

test('Android emulators preserve loopback behavior without inspecting or mutating reverse forwards', () => {
  const adb = fixture({ qemu: true, serial: 'emulator-5582' });
  assert.deepEqual(ensureAndroidMetroReverse({ deviceId: 'emulator-5582', metroPort: 8397 }, adb), {
    binding: null,
    created: false,
    physical: false,
  });
  assert.deepEqual(adb.calls, []);

  const named = fixture({ qemu: true, serial: 'third-party-emulator' });
  assert.equal(
    ensureAndroidMetroReverse({ deviceId: 'third-party-emulator', metroPort: 8397 }, named)
      .physical,
    false,
  );
  assert.equal(
    named.calls.some((args) => args.join(' ') === '-s third-party-emulator reverse --list'),
    false,
  );
});

test('foreign forwards are never adopted, replaced, or removed', () => {
  for (const remote of ['tcp:9000', 'tcp:8397']) {
    const adb = fixture({ forwards: [['tcp:8397', remote]] });
    assert.throws(
      () => ensureAndroidMetroReverse({ deviceId: 'physical-serial', metroPort: 8397 }, adb),
      /PHYSICAL_ANDROID_METRO_UNREACHABLE.*foreign adb reverse/,
    );
    assert.equal(adb.forwards.get('tcp:8397'), remote);
    assert.equal(
      adb.calls.some((args) => args.includes('--remove')),
      false,
    );
  }
});

test('a persisted run-owned forward is verified and exact cleanup preserves unrelated forwards', () => {
  const adb = fixture({
    forwards: [
      ['tcp:8397', 'tcp:8397'],
      ['tcp:9000', 'tcp:9001'],
    ],
  });
  assert.deepEqual(
    ensureAndroidMetroReverse(
      { deviceId: 'physical-serial', metroPort: 8397, binding: binding() },
      adb,
    ),
    { binding: binding(), created: false, physical: true },
  );
  removeAndroidMetroReverse(binding(), adb);
  assert.equal(adb.forwards.has('tcp:8397'), false);
  assert.equal(adb.forwards.get('tcp:9000'), 'tcp:9001');
});

test('cleanup refuses a run-owned local endpoint that changed to a foreign destination', () => {
  const adb = fixture({ forwards: [['tcp:8397', 'tcp:9000']] });
  assert.throws(
    () => removeAndroidMetroReverse(binding(), adb),
    /PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN.*foreign forward/,
  );
  assert.equal(adb.forwards.get('tcp:8397'), 'tcp:9000');
  assert.equal(
    adb.calls.some((args) => args.includes('--remove')),
    false,
  );
});
