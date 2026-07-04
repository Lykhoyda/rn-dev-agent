import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithRetryIfNoChange, tapRetryPolicy } from '../../dist/agent-device-wrapper.js';
import { updateRefMapFromFlat, clearRefMap } from '../../dist/fast-runner-ref-map.js';
import {
  _resetNoChangeStreakForTest,
  recordNoUiChange,
} from '../../dist/lifecycle/no-change-tracker.js';
import { okResult, failResult } from '../../dist/utils.js';

const seedRefMap = () =>
  updateRefMapFromFlat([
    { ref: '@e0', type: 'Button', label: 'Go', rect: { x: 0, y: 0, width: 100, height: 40 } },
  ]);
const parse = (r) => JSON.parse(r.content[0].text);
const ctx = { platform: 'ios', verb: 'tap' };
const policy = { eligible: true, targetKey: 'tap@50,20' };
const depsWith = (outcomes) => {
  let i = 0;
  const seenHashes = [];
  return {
    enabled: () => true,
    capabilities: () => [],
    probes: () => ({
      snapshotHash: async () => 'H',
      sleep: async () => {},
      now: () => 0,
    }),
    wait: async (opts) => {
      assert.equal(opts.initialSnapshotHash !== undefined, true);
      seenHashes.push(opts.initialSnapshotHash);
      return outcomes[Math.min(i++, outcomes.length - 1)];
    },
    seenHashes,
  };
};
const changed = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: true };
const unchanged = { settled: true, method: 'snapshot-eq', ms: 10, hierarchyChanged: false };
// Fail-open fixture: NO hierarchyChanged key (probe failure / settle timeout).
const probeFailed = { settled: false, method: 'timeout', ms: 10 };

beforeEach(() => {
  clearRefMap();
  _resetNoChangeStreakForTest();
  seedRefMap();
});

test('changed hierarchy → no retry, no flags', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      dispatches++;
      return okResult({ tapped: true });
    },
    ctx,
    policy,
    depsWith([changed]),
  );
  assert.equal(dispatches, 0);
  const env = parse(result);
  assert.equal(env.meta.tapRetried, undefined);
  assert.equal(env.meta.noUiChange, undefined);
});

test('unchanged → exactly one retry; changed after retry → tapRetried only', async () => {
  let dispatches = 0;
  const deps = depsWith([unchanged, changed]);
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      dispatches++;
      return okResult({ tapped: true });
    },
    ctx,
    policy,
    deps,
  );
  assert.equal(dispatches, 1);
  const env = parse(result);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, undefined);
  // The retry's settle compares against the SAME pre-first-tap baseline —
  // guards against re-reading getLastSnapshotHash() between attempts.
  assert.equal(deps.seenHashes.length, 2);
  assert.equal(deps.seenHashes[0], deps.seenHashes[1]);
});

test('probe failure on first settle (hierarchyChanged undefined) → fail-open, no retry, no flags', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      dispatches++;
      return okResult({ tapped: true });
    },
    ctx,
    policy,
    depsWith([probeFailed]),
  );
  assert.equal(dispatches, 0);
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, undefined);
  assert.equal(env.meta.noUiChange, undefined);
});

test('unchanged then probe failure on retry settle → tapRetried only, streak untouched', async () => {
  // Pre-seed one streak entry so BOTH wrongful mutations are detectable:
  // a wrongful flagNoUiChange would make the next distinct count 3, a
  // wrongful recordUiChange would clear the streak and make it 1.
  assert.equal(recordNoUiChange('pre-existing'), 1);
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      dispatches++;
      return okResult({ tapped: true });
    },
    ctx,
    policy,
    depsWith([unchanged, probeFailed]),
  );
  assert.equal(dispatches, 1);
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, undefined);
  assert.equal(env.meta.hint, undefined);
  assert.equal(recordNoUiChange('probe-check'), 2); // pre-existing + probe-check only
});

test('unchanged twice → tapRetried + noUiChange, exactly 2 attempts total, still success', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => {
      dispatches++;
      return okResult({ tapped: true });
    },
    ctx,
    policy,
    depsWith([unchanged, unchanged]),
  );
  assert.equal(dispatches, 1); // + the first dispatch made by the caller = 2 total
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, true);
  assert.equal(env.meta.hint, undefined); // one distinct target only
});

test('wedged hint after noUiChange on 3 distinct targets', async () => {
  for (const key of ['tap@1,1', 'tap@2,2']) {
    await settleWithRetryIfNoChange(
      okResult({}),
      async () => okResult({}),
      ctx,
      { eligible: true, targetKey: key },
      depsWith([unchanged, unchanged]),
    );
  }
  const result = await settleWithRetryIfNoChange(
    okResult({}),
    async () => okResult({}),
    ctx,
    { eligible: true, targetKey: 'tap@3,3' },
    depsWith([unchanged, unchanged]),
  );
  const env = parse(result);
  assert.match(env.meta.hint, /wedged/);
});

test('retap dispatch error → first success kept, flagged noUiChange (advisory contract)', async () => {
  const result = await settleWithRetryIfNoChange(
    okResult({ tapped: true }),
    async () => failResult('runner died', 'RN_FAST_RUNNER_DOWN'),
    ctx,
    policy,
    depsWith([unchanged]),
  );
  const env = parse(result);
  assert.equal(env.ok, true);
  assert.equal(env.meta.tapRetried, true);
  assert.equal(env.meta.noUiChange, true);
});

test('ineligible policy → single settle, no initial hash requirement, no retry', async () => {
  let dispatches = 0;
  const result = await settleWithRetryIfNoChange(
    okResult({}),
    async () => {
      dispatches++;
      return okResult({});
    },
    ctx,
    { eligible: false, targetKey: '' },
    {
      enabled: () => true,
      capabilities: () => [],
      probes: () => ({ snapshotHash: async () => 'H', sleep: async () => {}, now: () => 0 }),
      wait: async (opts) => {
        assert.equal(opts.initialSnapshotHash, undefined);
        return unchanged;
      },
    },
  );
  assert.equal(dispatches, 0);
  assert.equal(parse(result).meta.noUiChange, undefined);
});

test('tapRetryPolicy gates on command, flags, coords, env, and opt-out', () => {
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).eligible, true);
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).targetKey, 'tap@50,20');
  assert.equal(tapRetryPolicy(['longpress', '50', '20'], 'longPress', 50, 20, {}).eligible, true);
  assert.equal(tapRetryPolicy(['fill', '@e0', 'hi'], 'type', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0', '--double-tap'], 'tap', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0', '--count', '3'], 'tap', 50, 20, {}).eligible, false);
  assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', undefined, undefined, {}).eligible, false);
  assert.equal(
    tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, { retryIfNoChange: false }).eligible,
    false,
  );
  process.env.RN_SELF_HEAL = '0';
  try {
    assert.equal(tapRetryPolicy(['press', '@e0'], 'tap', 50, 20, {}).eligible, false);
  } finally {
    delete process.env.RN_SELF_HEAL;
  }
});
