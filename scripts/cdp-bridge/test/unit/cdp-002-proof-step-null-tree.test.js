// CDP-002: proof_step must NOT report verified:true when the helper's
// getTree() returns a successful envelope with tree:null or empty matches.
// Previous logic treated "no __agent_error" as proof of existence, which
// let LLM proof flows mark missing testIDs as verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProofStepHandler } from '../../dist/tools/proof-step.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

function buildHandler(treeResponse) {
  const client = createMockClient();
  client.evaluate = async (expr) => {
    if (expr.includes('getTree')) return { value: JSON.stringify(treeResponse) };
    return { value: undefined };
  };
  return createProofStepHandler(() => client);
}

function parseResult(toolResult) {
  return JSON.parse(toolResult.content[0].text);
}

test('CDP-002: tree:null with no matches → verified:false', async () => {
  const handler = buildHandler({ tree: null, totalNodes: 123 });
  const r = await handler({ verifyTestID: 'missing-id', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, false, 'tree:null must NOT pass verification');
  assert.match(parsed.data.verifyDetail, /not found/);
  assert.ok(parsed.data.errors?.length > 0);
});

test('CDP-002: empty matches array → verified:false', async () => {
  const handler = buildHandler({ matches: [], totalNodes: 50 });
  const r = await handler({ verifyTestID: 'missing-id', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, false, 'empty matches must NOT pass verification');
});

test('CDP-002: __agent_error envelope → verified:false', async () => {
  const handler = buildHandler({ __agent_error: 'helper unavailable' });
  const r = await handler({ verifyTestID: 'x', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, false);
  assert.match(parsed.data.verifyDetail, /helper unavailable/);
});

test('CDP-002: malformed JSON → verified:false (was true before)', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: 'not-json{{{' });
  const handler = createProofStepHandler(() => client);
  const r = await handler({ verifyTestID: 'x', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, false, 'unparseable response must NOT pass verification');
  assert.match(parsed.data.verifyDetail, /failed to parse/);
});

test('CDP-002: tree present with at least one node → verified:true', async () => {
  const handler = buildHandler({ tree: { component: 'View', testID: 'real-id' }, totalNodes: 100 });
  const r = await handler({ verifyTestID: 'real-id', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, true);
});

test('CDP-002: matches array with at least one item → verified:true', async () => {
  const handler = buildHandler({ matches: [{ component: 'View', testID: 'real' }] });
  const r = await handler({ verifyTestID: 'real', waitMs: 0 });
  const parsed = parseResult(r);
  assert.equal(parsed.data.verified, true);
});
