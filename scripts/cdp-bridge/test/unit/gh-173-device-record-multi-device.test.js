// GH #173 sub-issue 1: device_record silently captured the wrong simulator
// when more than one was booted, costing the reporter a 175s recording.
// PR-1 adds a pre-flight resolver — refuse to auto-pick when 2+ candidates,
// require explicit deviceId to disambiguate, echo the picked id back so
// callers can verify they got the device they meant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAllBootedIosDevices,
  parseAllAdbDevices,
  resolveTargetDevice,
} from '../../dist/tools/device-record.js';

// ─────────────────────────────────────────────────────────────────────────────
// parseAllBootedIosDevices
// ─────────────────────────────────────────────────────────────────────────────

test('parseAllBootedIosDevices: returns every Booted device, skips Shutdown', () => {
  const json = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
        { udid: 'AAA-SHUT', state: 'Shutdown', name: 'iPhone 16' },
        { udid: 'BBB-BOOTED', state: 'Booted', name: 'iPhone 17 Pro' },
        { udid: 'CCC-BOOTED', state: 'Booted', name: 'iPhone 15 Pro' },
      ],
    },
  });
  const out = parseAllBootedIosDevices(json);
  assert.equal(out.length, 2, 'should return both booted devices');
  assert.deepEqual(out.map((d) => d.udid).sort(), ['BBB-BOOTED', 'CCC-BOOTED']);
  // Friendly name preserved for the ambiguity error message.
  const bbb = out.find((d) => d.udid === 'BBB-BOOTED');
  assert.equal(bbb.name, 'iPhone 17 Pro');
});

test('parseAllBootedIosDevices: empty / malformed JSON yields empty list', () => {
  assert.deepEqual(parseAllBootedIosDevices('not-json'), []);
  assert.deepEqual(parseAllBootedIosDevices('{}'), []);
  assert.deepEqual(parseAllBootedIosDevices(JSON.stringify({ devices: {} })), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAllAdbDevices
// ─────────────────────────────────────────────────────────────────────────────

test('parseAllAdbDevices: returns emulators AND physical devices (multi-device disambiguation)', () => {
  // Note: parseAdbDevicesEmu in device-screenshot-raw.ts only matches
  // emulator-* — for device_record's multi-device check we need physical
  // devices to count too. This test pins that distinction.
  const stdout =
    'List of devices attached\n' +
    'emulator-5554\tdevice\n' +
    'R3CW70BFGAA\tdevice\n' +
    'emulator-5556\toffline\n' +
    'emulator-5558\tunauthorized\n';
  const out = parseAllAdbDevices(stdout);
  // All four lines are surfaced — the resolver caller filters by state.
  assert.equal(out.length, 4);
  const states = out.reduce((acc, d) => {
    acc[d.serial] = d.state;
    return acc;
  }, {});
  assert.equal(states['emulator-5554'], 'device');
  assert.equal(states['R3CW70BFGAA'], 'device');
  assert.equal(states['emulator-5556'], 'offline');
  assert.equal(states['emulator-5558'], 'unauthorized');
});

test('parseAllAdbDevices: skips the header line and empty lines', () => {
  assert.deepEqual(parseAllAdbDevices(''), []);
  assert.deepEqual(parseAllAdbDevices('List of devices attached\n'), []);
  assert.deepEqual(parseAllAdbDevices('List of devices attached\n\n\n'), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveTargetDevice
// ─────────────────────────────────────────────────────────────────────────────

test('resolveTargetDevice: 1 candidate, no deviceId → auto-select', () => {
  const r = resolveTargetDevice([{ id: 'BBB-BOOTED' }], undefined);
  assert.equal(r.ok, true);
  assert.equal(r.deviceId, 'BBB-BOOTED');
  assert.equal(r.autoSelected, true);
  assert.equal(r.totalAvailable, 1);
});

test('resolveTargetDevice: 1 candidate + mismatched deviceId → AMBIGUOUS (explicit selection is authoritative)', () => {
  // Even with only one device available, an explicit deviceId must
  // match or we refuse. Silently picking the only device when the
  // caller asked for a different one is the same class of wrong-device
  // behavior GH #173 is trying to prevent — a stale UDID from a saved
  // workflow would silently record the wrong sim.
  const r = resolveTargetDevice([{ id: 'BBB-BOOTED' }], 'something-else');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AMBIGUOUS');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, 'BBB-BOOTED');
});

test('resolveTargetDevice: 1 candidate + matching deviceId → use it (not auto-selected)', () => {
  const r = resolveTargetDevice([{ id: 'BBB-BOOTED' }], 'BBB-BOOTED');
  assert.equal(r.ok, true);
  assert.equal(r.deviceId, 'BBB-BOOTED');
  assert.equal(
    r.autoSelected,
    false,
    'explicit match is not auto-selected even with only one candidate',
  );
});

test('resolveTargetDevice: >1 candidates, deviceId matches one → use it', () => {
  const r = resolveTargetDevice([{ id: 'AAA' }, { id: 'BBB' }, { id: 'CCC' }], 'BBB');
  assert.equal(r.ok, true);
  assert.equal(r.deviceId, 'BBB');
  assert.equal(r.autoSelected, false);
  assert.equal(r.totalAvailable, 3);
});

test('resolveTargetDevice: >1 candidates, no deviceId → AMBIGUOUS with full list (THE GH #173 fix surface)', () => {
  const r = resolveTargetDevice(
    [
      { id: 'BBB-BOOTED', label: 'iPhone 17 Pro' },
      { id: 'CCC-BOOTED', label: 'iPhone 15 Pro' },
    ],
    undefined,
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AMBIGUOUS');
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), ['BBB-BOOTED', 'CCC-BOOTED']);
  // Labels preserved so the error message can name what each id is.
  assert.equal(r.candidates.find((c) => c.id === 'BBB-BOOTED').label, 'iPhone 17 Pro');
});

test('resolveTargetDevice: >1 candidates, deviceId does NOT match → AMBIGUOUS (typo surfaces fast)', () => {
  const r = resolveTargetDevice([{ id: 'AAA' }, { id: 'BBB' }], 'typo-here');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'AMBIGUOUS');
  assert.equal(r.candidates.length, 2);
});
