import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeLockedTest, parseLockedTest, e2ePathFor } from '../../dist/domain/e2e-test.js';

const META = {
  id: 'add-to-cart',
  intent: 'Add a product to the cart',
  sourceActionId: 'add-to-cart',
  lockedAt: '2026-06-18T10:00:00.000Z',
  lockedGitSha: 'abc1234',
  sourceContentHash: 'deadbeef',
  status: 'locked',
  params: undefined,
  appId: 'com.example.shop',
  // a realistic flow: appId top section, separator, M7 comments, AND a '#' comment in the body
  flow: 'appId: com.example.shop\n---\n# id: add-to-cart\n- launchApp\n# tap the add button\n- tapOn: "Add"\n',
};

test('serialize → parse round-trips lock fields and preserves the full executable flow', () => {
  const text = serializeLockedTest(META);
  const parsed = parseLockedTest(text, '/x/.rn-agent/e2e/add-to-cart.yaml');
  assert.equal(parsed.id, 'add-to-cart');
  assert.equal(parsed.sourceActionId, 'add-to-cart');
  assert.equal(parsed.lockedGitSha, 'abc1234');
  assert.equal(parsed.sourceContentHash, 'deadbeef');
  assert.equal(parsed.appId, 'com.example.shop');
  assert.equal(parsed.filePath, '/x/.rn-agent/e2e/add-to-cart.yaml');
  // BLOCKER-1: flow must still contain the executable appId header + separator
  assert.match(parsed.flow, /^appId: com\.example\.shop$/m);
  assert.match(parsed.flow, /^---$/m);
  // BLOCKER-4: a '#' comment INSIDE the body must not corrupt the split
  assert.match(parsed.flow, /# tap the add button/);
  assert.match(parsed.flow, /tapOn: "Add"/);
});

test('parseLockedTest returns null when the lock header is missing', () => {
  assert.equal(parseLockedTest('appId: com.x\n---\n- launchApp\n', '/x/y.yaml'), null);
});

test('e2ePathFor rejects path traversal', () => {
  assert.throws(() => e2ePathFor('/proj', '../escape'));
});
