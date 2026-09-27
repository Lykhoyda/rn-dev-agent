import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchParent } from '../../../dist/qa/parent-watch.js';

test('the core notices once when the CLI that spawned it is gone', async () => {
  let parent = 4242;
  let gone = 0;
  const stop = watchParent(
    4242,
    () => parent,
    () => {
      gone += 1;
    },
    5,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gone, 0, 'an unchanged parent is not a departure');
  parent = 1;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(gone, 1, 'a reparented core reports the departure exactly once');
  stop();
});

test('a CLI that died during startup is reported as soon as the watch starts', () => {
  let gone = 0;
  watchParent(
    4242,
    () => 1,
    () => {
      gone += 1;
    },
    5,
  );
  assert.equal(gone, 1, 'the startup parent is the baseline, not whoever adopted the core');
});

test('a stopped watch never reports', async () => {
  let parent = 4242;
  let gone = 0;
  const stop = watchParent(
    4242,
    () => parent,
    () => {
      gone += 1;
    },
    5,
  );
  stop();
  parent = 1;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gone, 0);
});
