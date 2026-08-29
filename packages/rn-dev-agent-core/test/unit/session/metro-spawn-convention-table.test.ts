import assert from 'node:assert/strict';
import test from 'node:test';

import { pinnedNativeSpawnConventions } from '../../../dist/session/package-integration.js';

function hostSpawnConvention(): 'object' | 'positional' {
  const binding = (process as unknown as { binding(name: string): unknown }).binding(
    'process_wrap',
  ) as { constants?: unknown } | null;
  return binding && binding.constants ? 'positional' : 'object';
}

test('pinned native spawn convention table brackets every published convention boundary', () => {
  assert.deepEqual(pinnedNativeSpawnConventions('22.4.0'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('22.5.0'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('22.23.2'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('24.18.0'), ['object']);
  assert.deepEqual(pinnedNativeSpawnConventions('24.19.0'), ['positional']);
  assert.deepEqual(pinnedNativeSpawnConventions('24.20.0'), ['positional']);
  assert.deepEqual(pinnedNativeSpawnConventions('26.0.0'), ['object', 'positional']);
  assert.deepEqual(pinnedNativeSpawnConventions('26.7.0'), ['object', 'positional']);
  assert.deepEqual(pinnedNativeSpawnConventions('23.0.0'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('25.5.0'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('27.0.0'), []);
  assert.deepEqual(pinnedNativeSpawnConventions('not-a-version'), []);
});

test('the pinned table is a drift probe, not an admission gate for this host', () => {
  const observed = hostSpawnConvention();
  const pinned = pinnedNativeSpawnConventions(process.versions.node);
  assert.ok(
    observed === 'object' || observed === 'positional',
    `Node ${process.versions.node} observes an unknown spawn convention ${observed}`,
  );
  // An unpinned major is expected and supported: admission authenticates argument
  // content, so the table only has to stay truthful about the majors it does pin.
  if (pinned.length > 0) {
    assert.ok(
      pinned.includes(observed),
      `Node ${process.versions.node} is pinned as ${JSON.stringify(pinned)} but observes ${observed}`,
    );
  }
});
