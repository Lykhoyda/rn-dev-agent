import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDevicePickDateHandler,
  createDevicePickValueHandler,
  parseISODate,
} from '../../dist/tools/device-picker.js';

function body(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

test('date picker validates real calendar dates', () => {
  assert.deepEqual(parseISODate('2024-02-29'), {
    year: 2024,
    month: 2,
    day: 29,
    monthName: 'February',
  });
  assert.equal(parseISODate('2023-02-29'), null);
  assert.equal(parseISODate('2025-13-01'), null);
});

test('date picker uses one flow, opener compatibility, scope, and one timeout budget', async () => {
  const calls: Array<{ yaml: string; options: Record<string, unknown> }> = [];
  const handler = createDevicePickDateHandler(async (yaml, options) => {
    calls.push({ yaml, options });
    return { passed: true, output: '', flowFile: '/tmp/flow.yaml' };
  });
  const result = body(
    await handler({
      date: '2025-08-03',
      pickerTestId: 'legacy-opener',
      pickerScopeTestId: 'date-scope',
      platform: 'ios',
      timeoutMs: 120_000,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.timeoutMs, 120_000);
  assert.match(calls[0]!.yaml, /id: "legacy-opener"/);
  assert.equal(calls[0]!.yaml.match(/childOf:/g)?.length, 3);
});

for (const failure of [
  {
    name: 'timeout with formatted component output',
    result: {
      passed: false,
      timedOut: true,
      output: 'PASSED tap on "August"\nFAILED tap on "3"',
      flowFile: '/tmp/flow.yaml',
    },
  },
  {
    name: 'selector failure with canonical IDs and retries',
    result: {
      passed: false,
      output:
        'PASSED tapOn: id="date-opener"\nFAILED tap on "August"\nPASSED tap on "August"\nFAILED tap on "3"',
      flowFile: '/tmp/flow.yaml',
    },
  },
  {
    name: 'executor error with human step text',
    result: {
      passed: false,
      error: 'runner failed after tap on "August"',
      output: 'PASSED tap on "August"',
      flowFile: '/tmp/flow.yaml',
    },
  },
]) {
  test(`picker failure omits attribution for ${failure.name}`, async () => {
    const handler = createDevicePickDateHandler(async () => failure.result);
    const result = body(
      await handler({ date: '2025-08-03', openerTestId: 'date-opener', platform: 'ios' }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.meta.failedAt, undefined);
    assert.equal(result.meta.failedValue, undefined);
    assert.equal(result.meta.succeeded, undefined);
    assert.equal(result.meta.completedOperations, undefined);
    assert.equal(typeof result.meta.output, 'string');
    assert.ok(result.meta.output.length <= 500);
  });
}

test('cleanup refusal preserves its typed code without picker attribution', async () => {
  const handler = createDevicePickDateHandler(async () => ({
    passed: false,
    error: 'AUTOMATION_CLEANUP_UNPROVEN: cleanup unknown',
    errorCode: 'AUTOMATION_CLEANUP_UNPROVEN',
    output: 'PASSED tap on "August"',
    flowFile: '/tmp/flow.yaml',
    cleanupRefusal: {
      processGroup: 'owned-process-group',
      manualCommand: 'kill -TERM -4242',
    },
  }));
  const result = body(await handler({ date: '2025-08-03', platform: 'ios' }));
  assert.equal(result.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(result.meta.failedAt, undefined);
  assert.equal(result.meta.succeeded, undefined);
  assert.equal(result.meta.cleanupRefusal.manualCommand, 'kill -TERM -4242');
});

test('value picker preserves the authoritative cleanup refusal envelope', async () => {
  const handler = createDevicePickValueHandler(async () => ({
    passed: false,
    error: 'AUTOMATION_CLEANUP_UNPROVEN: cleanup unknown',
    errorCode: 'AUTOMATION_CLEANUP_UNPROVEN',
    output: '',
    flowFile: '/tmp/flow.yaml',
    timedOut: true,
    cleanupEscalated: true,
    cleanupRefusal: {
      processGroup: 'owned-process-group',
      manualCommand: 'kill -TERM -4242',
    },
  }));
  const result = body(await handler({ value: 'August', platform: 'ios' }));
  assert.equal(result.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(result.meta.picked, false);
  assert.equal(result.meta.value, 'August');
  assert.equal(result.meta.cleanupRefusal.manualCommand, 'kill -TERM -4242');
});
