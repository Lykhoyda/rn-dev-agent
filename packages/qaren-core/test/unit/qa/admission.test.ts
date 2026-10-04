import { interruptible } from '../../../dist/domain/cancellation.js';
import { createStop } from '../../../dist/qa/stop.js';
import { TargetReadinessTimeoutError } from '../../../dist/cdp/discovery.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOAD_ENVELOPE, admit, type AdmissionSteps } from '../../../dist/qa/admission.js';

const PROVEN = {
  ok: true,
  scriptURL: 'http://127.0.0.1:8081/index.bundle',
  appModules: 3,
} as const;

function harness(overrides: Partial<AdmissionSteps> = {}) {
  const calls: string[] = [];
  const stop = createStop();
  const step =
    <T>(name: string, result: () => T) =>
    async (): Promise<T> => {
      calls.push(name);
      return result();
    };
  const steps: AdmissionSteps = {
    metroPort: 8081,
    readinessMs: 30_000,
    remainingMs: () => 90_000,
    attach: step('attach', () => undefined),
    foreignDriver: step('foreignDriver', () => undefined),
    open: step('open', () => undefined),
    prove: step('prove', () => PROVEN),
    close: async () => {
      calls.push('close');
    },
    load: () => 1,
    ...overrides,
  };
  return { calls, stop, steps };
}

test('admission runs connect, driver probe, session open and bundle proof in order', async () => {
  const { calls, stop, steps } = harness();
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.deepEqual(calls, ['attach', 'foreignDriver', 'open', 'prove']);
});

test('a stop raised before each setup effect runs neither that effect nor any later one', async () => {
  const order = ['attach', 'foreignDriver', 'open', 'prove'];
  for (const [index, effect] of order.entries()) {
    const { calls, stop, steps } = harness();
    const raise = order[index - 1];
    if (raise) {
      const original = steps[raise as 'attach'];
      steps[raise as 'attach'] = async () => {
        await original();
        stop.begin();
      };
    } else stop.begin();
    await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'RUN_CANCELLED');
      return true;
    });
    assert.ok(!calls.includes(effect), `${effect} ran after the stop: ${calls}`);
    assert.deepEqual(calls.slice(-1), ['close'], `${effect}: the session is closed`);
  }
});

test('a stop during the attach wait ends the wait instead of running to its timeout', async () => {
  const stop = createStop();
  const calls: string[] = [];
  const steps: AdmissionSteps = {
    ...harness().steps,
    attach: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stop.begin();
      throw new Error("the readiness wait was cancelled");
    },
    open: async () => void calls.push('open'),
    close: async () => void calls.push('close'),
  };
  const started = Date.now();
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(calls, ['close']);
});

test('an attach timeout under host load is retried once and refused as environment with the load', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 42.25,
    attach: async () => {
      attempts++;
      throw new TargetReadinessTimeoutError('Timed out waiting for CDP targets on port 8081 after 30000ms');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /Metro 8081/);
    assert.match(error.message, /1-minute load 42\.3 is above the envelope 10/);
    assert.match(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 2);
  assert.ok(!calls.includes('open'));
  assert.equal(LOAD_ENVELOPE, 10);
});

test('within the load envelope an attach failure is refused at once, with the load recorded', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 3,
    attach: async () => {
      attempts++;
      throw new Error('no target');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'CDP_NOT_CONNECTED');
    assert.match(error.message, /1-minute load 3\.0 is within the envelope 10/);
    assert.doesNotMatch(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('a retried attach that connects under load continues the admission', async () => {
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 50,
    attach: async () => {
      if (++attempts === 1) throw new TargetReadinessTimeoutError('no target yet');
    },
  });
  assert.deepEqual(await admit(steps, stop), PROVEN);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['foreignDriver', 'open', 'prove']);
});

test('a failed bundle proof closes the session and refuses with its own code', async () => {
  const { calls, stop, steps } = harness({
    prove: async () => ({ ok: false, code: 'METRO_ORIGIN_MISMATCH', message: 'foreign bundle' }),
  });
  await assert.rejects(admit(steps, stop), { code: 'METRO_ORIGIN_MISMATCH' });
  assert.deepEqual(calls.slice(-1), ['close']);
});

test('a foreign automation driver refuses before the session opens', async () => {
  const { calls, stop, steps } = harness({ foreignDriver: async () => 'Maestro holds the device' });
  await assert.rejects(admit(steps, stop), { code: 'BUSY_FOREIGN_FLOW' });
  assert.ok(!calls.includes('open'));
});


test('cancellation during bundle proof refuses the proven result', async () => {
  const { calls, steps, stop } = harness();
  steps.prove = async () => {
    stop.begin();
    return PROVEN;
  };
  await assert.rejects(admit(steps, stop), { code: 'RUN_CANCELLED' });
  assert.equal(calls.at(-1), 'close');
});


test('a loaded timeout with only 15 seconds left refuses without a second 30-second wait', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 42,
    remainingMs: () => 15_000,
    attach: async () => {
      attempts++;
      throw new TargetReadinessTimeoutError('readiness timeout');
    },
  });
  await assert.rejects(admit(steps, stop), /environment refusal without enough budget/);
  assert.equal(attempts, 1);
});

test('a deterministic rejection under load is never retried or called environmental', async () => {
  let attempts = 0;
  const { stop, steps } = harness({
    load: () => 42,
    attach: async () => {
      attempts++;
      throw new Error('PLATFORM_TARGET_NOT_FOUND: wrong app');
    },
  });
  await assert.rejects(admit(steps, stop), (error: Error) => {
    assert.doesNotMatch(error.message, /environment refusal/);
    return true;
  });
  assert.equal(attempts, 1);
});


test('abort during each awaited admission primitive rejects before any later effect', async () => {
  const order = ['attach', 'foreignDriver', 'open', 'prove'] as const;
  for (const effect of order) {
    const { calls, stop, steps } = harness();
    const original = steps[effect];
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    steps[effect as 'attach'] = (async () => {
      ready();
      await interruptible(() => blocked);
      return original();
    }) as typeof steps.attach;
    const admitted = admit(steps, stop);
    const refused = assert.rejects(admitted, /RUN_CANCELLED/);
    await started;
    stop.begin();
    await refused;
    assert.deepEqual(calls, [...order.slice(0, order.indexOf(effect)), 'close']);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [...order.slice(0, order.indexOf(effect)), 'close']);
  }
});

test('loaded handshake timeout retries once and remains an environment refusal', async () => {
  const { CDPHandshakeTimeoutError } = await import('../../../dist/cdp/connect.js');
  let attempts = 0;
  const { calls, stop, steps } = harness({
    load: () => 42,
    attach: async () => { attempts++; throw new CDPHandshakeTimeoutError('handshake timed out'); },
  });
  await assert.rejects(admit(steps, stop), /host 1-minute load 42.0.*environment refusal after one retry/);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, ['close']);
});
