import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProofStepHandler } from '../../dist/tools/proof-step.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

function envelope(result: Awaited<ReturnType<ReturnType<typeof createProofStepHandler>>>) {
  return JSON.parse(result.content[0]!.text) as {
    data: { screenshotPath: string; errors?: string[] };
    meta?: { warning?: string };
  };
}

test('proof_step rejects a screenshot written outside its declared proof path', async () => {
  const client = createMockClient();
  const requestedPath = '/tmp/proof/declared.png';
  const handler = createProofStepHandler(() => client, {
    hasSession: () => true,
    captureScreenshot: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, data: { path: '/tmp/runner-internal.png' } }),
        },
      ],
    }),
  });

  const result = envelope(await handler({ screenshotPath: requestedPath, waitMs: 0 }));

  assert.equal(result.data.screenshotPath, '/tmp/runner-internal.png');
  assert.match(result.meta?.warning ?? '', /declared screenshot path/);
  assert.ok(result.data.errors?.some((error) => error.includes(requestedPath)));
});

test('proof_step accepts the declared path from a screenshot result envelope', async () => {
  const client = createMockClient();
  const requestedPath = '/tmp/proof/declared.png';
  const handler = createProofStepHandler(() => client, {
    hasSession: () => true,
    captureScreenshot: async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, data: { path: requestedPath } }),
        },
      ],
    }),
  });

  const result = envelope(await handler({ screenshotPath: requestedPath, waitMs: 0 }));

  assert.equal(result.data.screenshotPath, requestedPath);
  assert.equal(result.meta?.warning, undefined);
  assert.equal(result.data.errors, undefined);
});
