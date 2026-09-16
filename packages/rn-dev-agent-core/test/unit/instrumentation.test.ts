import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceRecorder } from '../../dist/experience/evidence.js';
import { AUTHORITY_REFUSAL_CODES } from '../../dist/experience/authority-refusal.js';
import {
  addToolObserver,
  instrumentTool,
  type ToolObserverInput,
} from '../../dist/observability/instrumentation.js';

test('instrumentation fans out the same event to every observer', async (t) => {
  const seenA: ToolObserverInput[] = [];
  const seenB: ToolObserverInput[] = [];
  const detachA = addToolObserver((event) => seenA.push(event));
  const detachB = addToolObserver((event) => seenB.push(event));
  t.after(detachA);
  t.after(detachB);

  await instrumentTool('proof_step', async () => ({ ok: true }))({ step: 'open-profile' });

  assert.equal(seenA.length, 1);
  assert.equal(seenB.length, 1);
  assert.strictEqual(seenA[0], seenB[0]);
});

test('a throwing observer cannot block another observer or change the tool result', async (t) => {
  const seen: string[] = [];
  const detachThrowing = addToolObserver(() => {
    throw new Error('observer failed');
  });
  const detachSeen = addToolObserver((event) => seen.push(event.tool));
  t.after(detachThrowing);
  t.after(detachSeen);
  const expected = { ok: true, value: 'unchanged' };

  const result = await instrumentTool('proof_step', async () => expected)({});

  assert.strictEqual(result, expected);
  assert.deepEqual(seen, ['proof_step']);
});

test('detaching an observer removes only its own subscription', async (t) => {
  const seenA: string[] = [];
  const seenB: string[] = [];
  const detachA = addToolObserver((event) => seenA.push(event.tool));
  const detachB = addToolObserver((event) => seenB.push(event.tool));
  t.after(detachA);
  t.after(detachB);

  await instrumentTool('proof_step', async () => ({ ok: true }))({});
  detachA();
  await instrumentTool('device_screenshot', async () => ({ ok: true }))({});

  assert.deepEqual(seenA, ['proof_step']);
  assert.deepEqual(seenB, ['proof_step', 'device_screenshot']);
});

test('authority outcomes remain identical with deferred and blocked experience persistence', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'authority-instrumentation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocked = join(directory, 'blocked');
  writeFileSync(blocked, 'not a directory');
  const queued: Array<() => void> = [];
  const recorder = new ExperienceRecorder({
    directory: blocked,
    coreVersion: '1.0.0',
    schedule: (work) => queued.push(work),
  });
  t.after(addToolObserver((event) => recorder.observe(event)));
  t.after(
    addToolObserver(() => {
      throw new Error('observer unavailable');
    }),
  );
  for (const code of AUTHORITY_REFUSAL_CODES) {
    const envelope = { ok: false, code, error: `${code}: refused`, meta: { axis: 'M' } };
    for (const expected of [
      envelope,
      { isError: true, content: [{ text: JSON.stringify(envelope) }] },
    ]) {
      assert.strictEqual(await instrumentTool('rn_session', async () => expected)({}), expected);
    }
    const thrown = new Error(`${code}: refused`);
    await assert.rejects(
      instrumentTool('rn_session', async () => {
        throw thrown;
      })({}),
      (error) => error === thrown,
    );
  }
  assert.equal(queued.length, AUTHORITY_REFUSAL_CODES.length * 3);
  for (const work of queued) assert.doesNotThrow(work);
});
