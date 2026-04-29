// CDP-005: proof_step previously returned ok:true even when a screenshot
// was requested but failed (or no device session was open). The boolean
// was: (errors && !verified && verifyText) || verifyTestID — which let
// missing screenshots through unless verification was also requested
// AND failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProofStepHandler } from '../../dist/tools/proof-step.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

function parseEnvelope(result) {
  return JSON.parse(result.content[0].text);
}

// Note: in this codebase warnResult() returns ok:true with meta.warning set
// (it is not a fail envelope). The CDP-005 fix is "trigger warn metadata
// when an error was accumulated, even without verification args" — these
// tests assert the warning surfaces.

test('CDP-005: errors accumulated (e.g. navigation error) → warn metadata is set', async () => {
  const client = createMockClient();
  // Simulate navigation evaluate error — proof_step pushes "Navigation failed"
  // to errors[] but previously did NOT set warning metadata for that case.
  client.evaluate = async (expr) => {
    if (expr.includes('navigateTo')) return { error: 'evaluate failed' };
    if (expr.includes('getTree')) return { value: JSON.stringify({ tree: { component: 'View' } }) };
    return { value: undefined };
  };
  const handler = createProofStepHandler(() => client);
  const r = await handler({ screen: 'X', verifyTestID: 'something', waitMs: 0 });
  const env = parseEnvelope(r);
  assert.ok(typeof env.meta?.warning === 'string' && env.meta.warning.length > 0,
    'navigation error must set meta.warning, not be silent');
  assert.ok(env.data.errors?.some((e) => /Navigation/i.test(e)));
});

test('CDP-005: verification requested + verified=false alone triggers warning', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: JSON.stringify({ tree: null }) });
  const handler = createProofStepHandler(() => client);
  const r = await handler({ verifyTestID: 'missing', waitMs: 0 });
  const env = parseEnvelope(r);
  assert.ok(typeof env.meta?.warning === 'string' && env.meta.warning.length > 0);
  assert.equal(env.data.verified, false);
});

test('CDP-005: clean verification stays verified=true (warn may still fire from screenshot if no session — that\'s the expected CDP-005 behaviour)', async () => {
  const client = createMockClient();
  client.evaluate = async () => ({ value: JSON.stringify({ tree: { component: 'View', testID: 'real' } }) });
  const handler = createProofStepHandler(() => client);
  const r = await handler({ verifyTestID: 'real', waitMs: 0 });
  const env = parseEnvelope(r);
  // Verification succeeded — that's the regression-preserving check.
  assert.equal(env.data.verified, true);
  // If a warning fired, it must NOT be about the verification (which passed).
  if (env.meta?.warning) {
    assert.doesNotMatch(env.meta.warning, /testID.*not found/);
  }
});
