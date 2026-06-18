import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCsrfToken, isPostAllowed } from '../../dist/observability/e2e-csrf.js';

const T = 'tok_abc123';
const post = (over = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': T, ...over.headers }, ...over });

test('makeCsrfToken returns a long unguessable hex token, unique per call', () => {
  const a = makeCsrfToken(); const b = makeCsrfToken();
  assert.match(a, /^[0-9a-f]{32,}$/); assert.notEqual(a, b);
});
test('valid POST with matching csrf + json passes', () => {
  assert.deepEqual(isPostAllowed(post(), T), { ok: true });
});
test('GET is refused (405) — never triggers a run', () => {
  assert.equal(isPostAllowed({ method: 'GET', headers: {} }, T).status, 405);
});
test('missing/wrong csrf is refused (403)', () => {
  assert.equal(isPostAllowed(post({ headers: { 'x-csrf-token': 'nope' } }), T).status, 403);
  assert.equal(isPostAllowed({ method: 'POST', headers: { 'content-type': 'application/json' } }, T).status, 403);
});
test('non-json content-type is refused (415)', () => {
  assert.equal(isPostAllowed(post({ headers: { 'content-type': 'text/plain' } }), T).status, 415);
});
