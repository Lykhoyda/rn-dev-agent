import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFlowParked } from '../../dist/tools/maestro-run.js';

test('GH#202 runFlowParked: parks L2 before the flow and marks CDP stale after (success)', async () => {
  const calls = [];
  const out = await runFlowParked(
    async () => { calls.push('flow'); return 'RESULT'; },
    { stopFastRunner: () => calls.push('stop'), markCdpStale: () => calls.push('stale') },
  );
  assert.equal(out, 'RESULT');
  assert.deepEqual(calls, ['stop', 'flow', 'stale']);
});

test('GH#202 runFlowParked: still marks CDP stale when the flow throws', async () => {
  const calls = [];
  await assert.rejects(
    runFlowParked(
      async () => { calls.push('flow'); throw new Error('boom'); },
      { stopFastRunner: () => calls.push('stop'), markCdpStale: () => calls.push('stale') },
    ),
    /boom/,
  );
  assert.deepEqual(calls, ['stop', 'flow', 'stale']);
});
