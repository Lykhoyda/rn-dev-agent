import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arbiterWrap,
  DeviceSessionArbiter,
  promoteCurrentOperationToManagedFlow,
} from '../../dist/lifecycle/device-arbiter.js';
import { maestroRefusalResult } from '../../dist/maestro-invoke.js';
import { authorityProfileFor } from '../../dist/session/tool-profiles.js';

function body(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0]!.text) as Record<string, any>;
}

test('inline-capable tools receive lazy parking authority without static flow classification', () => {
  for (const tool of [
    'device_fill',
    'device_pick_value',
    'device_pick_date',
    'device_accept_system_dialog',
    'device_dismiss_system_dialog',
  ]) {
    assert.equal(authorityProfileFor(tool).managedRunnerPark, true);
  }
});

test('foreign automation refusal reuses the public sanitizer', async () => {
  const arbiter = new DeviceSessionArbiter(() => 20_000);
  const raw =
    '81263 /Users/alice/Library/Developer/CoreSimulator/Devices/7A6033C8-9291-4B0B-80B9-46024EEDF7D7/WebDriverAgentRunner-Runner';
  const wrapped = arbiterWrap(
    'device_press',
    async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    arbiter,
    {
      gate: {
        check: async () => ({
          active: true,
          warning: { code: 'IOS_XCUITEST_COMPETITOR', message: 'foreign', processLines: [raw] },
          scanMs: 3,
        }),
      },
      getUdid: () => '7A6033C8-9291-4B0B-80B9-46024EEDF7D7',
    },
  );
  const result = body(await wrapped({}));
  assert.equal(result.code, 'BUSY_FOREIGN_FLOW');
  assert.doesNotMatch(JSON.stringify(result), /Users\/alice|7A6033C8/);
  assert.match(result.meta.foreignRunner.processLines[0], /device-/);
});

test('inline Maestro dynamically promotes only when fallback dispatches', async () => {
  let now = 20_000;
  const arbiter = new DeviceSessionArbiter(() => now);
  const noForeign = {
    gate: { check: async () => ({ active: false, warning: null, scanMs: 0 }) },
    getUdid: () => null,
  };
  const ordinary = arbiterWrap(
    'device_fill',
    async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
    arbiter,
    noForeign,
  );
  await ordinary({});
  now += 20_000;
  assert.ok(arbiter.msSinceFlowReleased > 10_000, 'ordinary interaction starts no flow grace');

  let contenderResult: any;
  const promoted = arbiterWrap(
    'device_pick_date',
    async () => {
      assert.equal(promoteCurrentOperationToManagedFlow().ok, true);
      const contender = arbiterWrap(
        'device_press',
        async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
        arbiter,
        noForeign,
      );
      contenderResult = await contender({});
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
    arbiter,
    noForeign,
  );
  await promoted({});
  assert.equal(body(contenderResult).code, 'BUSY_FLOW_ACTIVE');
  assert.equal(arbiter.msSinceFlowReleased, 0);
});

test('authoritative Maestro refusals preserve code and cleanup evidence', () => {
  const refusal = maestroRefusalResult(
    {
      passed: false,
      output: '',
      flowFile: '/tmp/flow.yaml',
      error: 'cleanup is unproven',
      errorCode: 'AUTOMATION_CLEANUP_UNPROVEN',
      timedOut: true,
      exitCode: null,
      signal: 'SIGKILL',
      cleanupEscalated: true,
      cleanupRefusal: {
        processGroup: 'owned-process-group',
        manualCommand: 'kill -TERM -4242',
      },
    },
    'fallback',
    { operation: 'fill-or-dialog' },
  );
  assert.ok(refusal);
  const result = body(refusal);
  assert.equal(result.code, 'AUTOMATION_CLEANUP_UNPROVEN');
  assert.equal(result.meta.operation, 'fill-or-dialog');
  assert.equal(result.meta.timedOut, true);
  assert.equal(result.meta.signal, 'SIGKILL');
  assert.equal(result.meta.cleanupEscalated, true);
  assert.equal(result.meta.cleanupRefusal.manualCommand, 'kill -TERM -4242');
});
