import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevicePickDateHandler, parseISODate } from '../../dist/tools/device-picker.js';

function envelope(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

test('device_pick_date rejects impossible calendar dates', () => {
  assert.equal(parseISODate('2026-02-31'), null);
  assert.equal(parseISODate('2025-02-29'), null);
  assert.deepEqual(parseISODate('2024-02-29T12:00:00Z'), {
    year: 2024,
    month: 2,
    day: 29,
    monthName: 'February',
  });
});

test('device_pick_date emits one flow with one undivided 120s budget', async () => {
  const calls: Array<{ yaml: string; opts: Record<string, any> }> = [];
  const handler = createDevicePickDateHandler(async (yaml, opts) => {
    calls.push({ yaml, opts });
    return {
      passed: true,
      output: '',
      flowFile: '/tmp/deleted.yaml',
    };
  });
  const result = await handler({
    date: '1990-06-15',
    platform: 'ios',
    openerTestId: 'open-date',
    pickerScopeTestId: 'date-wheel',
  });
  assert.equal(envelope(result).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.opts.timeoutMs, 120_000);
  assert.match(calls[0]!.yaml, /id: "open-date"/);
  assert.match(calls[0]!.yaml, /text: "June"/);
  assert.match(calls[0]!.yaml, /text: "15"/);
  assert.match(calls[0]!.yaml, /text: "1990"/);
  assert.equal((calls[0]!.yaml.match(/childOf:/g) ?? []).length, 3);
});

test('deprecated pickerTestId remains an opener alias and never claims to scope taps', async () => {
  let yaml = '';
  const handler = createDevicePickDateHandler(async (flow) => {
    yaml = flow;
    return { passed: false, output: '', flowFile: '/tmp/deleted.yaml' };
  });
  const result = envelope(
    await handler({ date: '2026-06-15', platform: 'ios', pickerTestId: 'legacy-opener' }),
  );
  assert.equal(result.ok, false);
  assert.match(yaml, /id: "legacy-opener"[\s\S]*optional: true/);
  assert.doesNotMatch(result.error, /pickerTestId.*scope/i);
});

test('every incomplete date pick hard-fails with component attribution', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on "June" (0.1s)\n    ✗ Tap on "15" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(await handler({ date: '2026-06-15', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PICK_DATE_INCOMPLETE');
  assert.deepEqual(result.meta.succeeded, ['month']);
  assert.equal(result.meta.failedAt, 'day');
});

test('date timeout is a hard PICK_DATE_TIMEOUT at the observed component', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on "June" (0.1s)',
    flowFile: '/tmp/deleted.yaml',
    error: 'Maestro timed out after 120000ms',
    timedOut: true,
  }));
  const result = envelope(await handler({ date: '2026-06-15', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PICK_DATE_TIMEOUT');
  assert.equal(result.meta.failedAt, 'day');
});

test('component attribution does not confuse day substrings with the year', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on "June" (0.1s)\n    ✓ Tap on "2" (0.1s)\n    ✗ Tap on "2026" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(await handler({ date: '2026-06-02', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, ['month', 'day']);
  assert.equal(result.meta.failedAt, 'year');
  assert.equal(result.meta.failedValue, '2026');
});

test('component attribution consumes repeated selector values in execution order', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on "June" (0.1s)\n    ✓ Tap on "2" (0.1s)\n    ✗ Tap on "2" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(await handler({ date: '0002-06-02', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, ['month', 'day']);
  assert.equal(result.meta.failedAt, 'year');
  assert.equal(result.meta.failedValue, '2');
});

test('component attribution uses the terminal outcome after a transient retry', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output:
      '    ✗ Tap on "June" (0.1s)\n    ✓ Tap on "June" (0.1s)\n    ✓ Tap on "2" (0.1s)\n    ✗ Tap on "2026" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(await handler({ date: '2026-06-02', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, ['month', 'day']);
  assert.equal(result.meta.failedAt, 'year');
  assert.equal(result.meta.failedValue, '2026');
});

test('executor refusal does not fabricate a component failure', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output:
      '    ✓ Tap on "June" (0.1s)\n    ✓ Tap on "2" (0.1s)\n    ✓ Tap on "2026" (0.1s)',
    flowFile: '/tmp/deleted.yaml',
    error: 'plugin-owned automation cleanup is unproven',
    errorCode: 'AUTOMATION_CLEANUP_UNPROVEN',
  }));
  const result = envelope(await handler({ date: '2026-06-02', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(result.meta.failedAt, undefined);
  assert.equal(result.meta.failedValue, undefined);
});

test('uncoded executor error is preserved without component attribution', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '',
    flowFile: '/tmp/deleted.yaml',
    error: 'Maestro runner not found',
  }));
  const result = envelope(await handler({ date: '2026-06-02', platform: 'ios' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PICK_DATE_INCOMPLETE');
  assert.equal(result.error, 'Maestro runner not found');
  assert.equal(result.meta.failedAt, undefined);
  assert.equal(result.meta.failedValue, undefined);
});

test('opener observation is excluded when its identifier equals a component value', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on element with id "June" (0.1s)\n    ✗ Tap on "June" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(
    await handler({ date: '2026-06-02', platform: 'ios', openerTestId: 'June' }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, []);
  assert.equal(result.meta.failedAt, 'month');
  assert.equal(result.meta.failedValue, 'June');
});

test('opener retry outcome is fully excluded from component attribution', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output:
      '    ✗ Tap on element with id "June" (0.1s)\n    ✓ Tap on element with id "June" (0.1s)\n    ✗ Tap on "June" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(
    await handler({ date: '2026-06-02', platform: 'ios', openerTestId: 'June' }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, []);
  assert.equal(result.meta.failedAt, 'month');
});

test('missing opener evidence does not consume matching component evidence', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    output: '    ✓ Tap on "June" (0.1s)\n    ✗ Tap on "2" (20.0s)',
    flowFile: '/tmp/deleted.yaml',
  }));
  const result = envelope(
    await handler({ date: '2026-06-02', platform: 'ios', openerTestId: 'June' }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.meta.succeeded, ['month']);
  assert.equal(result.meta.failedAt, 'day');
  assert.equal(result.meta.failedValue, '2');
});
