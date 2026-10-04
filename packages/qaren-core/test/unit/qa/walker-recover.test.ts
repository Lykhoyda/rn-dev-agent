import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { NativeCaptureError } from '../../../dist/qa/capture.js';
import { loginBlock, runPlan, walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';

function screen(
  labels: string[],
  front: Screen['front'] = 'app',
  testIDs: Record<string, string> = {},
): Screen {
  return {
    elements: labels.map((label, i) => ({
      ref: `@e${i}`,
      kind: 'button',
      label,
      ...(testIDs[label] ? { testID: testIDs[label] } : {}),
      hittable: true,
      disabled: false,
      secure: false,
      offscreen: false,
      semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
      where: 'middle',
      side: 'center',
    })),
    visibleText: labels,
    front,
    coverage: { native: 'complete', react: 'complete' },
  };
}

function fake(
  screens: (Screen | Error)[],
  extra: Partial<WalkerDeps> = {},
  redBox = false,
): { deps: WalkerDeps; rows: LedgerRow[]; calls: string[] } {
  const rows: LedgerRow[] = [];
  const calls: string[] = [];
  let clock = 0;
  const queue = [...screens];
  const ok: ActResult = { ok: true, proven: false };
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return redBox ? { ...next, renderError: true } : next;
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return ok;
    },
    async fill(ref, text) {
      calls.push(`fill ${ref} ${text}`);
      return { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
      return ok;
    },
    async back() {
      calls.push('back');
      return ok;
    },
    async dialog(action) {
      calls.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      calls.push('hideDevMenu');
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: (row) => {
      rows.push(row);
    },
    ...extra,
  };
  return { deps, rows, calls };
}

function block(markdown: string): Block {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

test('an unchanged screen with a dialog in front recovers once and the retry passes', async () => {
  const covered = screen(['Settings'], 'dialog');
  const f = fake([
    covered,
    covered,
    covered,
    covered,
    covered,
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.equal(ledger.escapes, 0);
  assert.equal(ledger.llmTurns, 0);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith('capture')),
    ['press @e0', 'press @e0', 'dialog accept', 'press @e0'],
  );
  const recovered = ledger.steps.find((r) => r.reason?.includes('recovered: dialog'));
  assert.equal(recovered?.outcome, 'retry');
  assert.equal(ledger.steps.at(-1)?.outcome, 'pass');
});

test('a second failure of the same item fails without a second recovery', async () => {
  const f = fake([screen(['Settings'], 'dialog')]);
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.recoveries, 1);
  assert.equal(f.calls.filter((c) => c === 'dialog accept').length, 1);
  assert.match(ledger.failure?.seen ?? '', /did not change after recovery/);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 3);
});

test('a target missing behind a dialog recovers once', async () => {
  const f = fake([
    screen(['Allow'], 'dialog'),
    screen(['Allow'], 'dialog'),
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.equal(outcome.recoveries, 1);
  assert.deepEqual(
    outcome.rows.map((r) => r.outcome),
    ['retry', 'pass'],
  );
  assert.match(outcome.rows[0].reason ?? '', /TARGET_NOT_FOUND.*recovered: dialog/);
});

test('the dev menu in front is hidden, then the step retries', async () => {
  const f = fake([
    screen(['Reload'], 'dev-menu'),
    screen(['Reload'], 'dev-menu'),
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(f.calls.includes('hideDevMenu'));
});

test('a red box fails at the step with its text and no recovery row', async () => {
  const f = fake([screen(['Render Error', 'boom'])], {}, true);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.step, 1);
  assert.match(
    outcome.failure?.seen ?? '',
    /React Native error screen; historical context, previously on screen: Render Error \| boom/,
  );
  assert.equal(outcome.recoveries, undefined);
  assert.deepEqual(
    outcome.rows.map((r) => r.outcome),
    ['fail'],
  );
  assert.ok(!f.calls.some((c) => c.startsWith('dialog') || c === 'hideDevMenu'));
});

test('the dev-client picker fails at the step without recovering', async () => {
  const f = fake([screen(['Development servers'], 'picker')]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.refusal, undefined);
  assert.match(outcome.failure?.seen ?? '', /dev-client picker or first-run screen is in front/);
});

test('a capture error or a Jev error never recovers', async () => {
  const capture = fake([new NativeCaptureError()]);
  const failedCapture = await walkBlock(block('1. Tap "Settings"\n'), capture.deps);
  assert.equal(failedCapture.refusal?.code, 'NATIVE_CAPTURE_UNAVAILABLE');
  assert.ok(!capture.calls.includes('hideDevMenu'));

  const incomplete = fake([
    { ...screen(['Settings']), coverage: { native: 'incomplete', react: 'complete' } },
  ]);
  const unusable = await walkBlock(block('1. Tap "Settings"\n'), incomplete.deps);
  assert.match(unusable.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.ok(!incomplete.calls.includes('hideDevMenu'));

  const jev = fake([screen(['Settings'], 'dialog')]);
  const phrase = await walkBlock(block('1. Tap the settings button\n'), jev.deps);
  assert.match(phrase.failure?.seen ?? '', /JEV_UNAVAILABLE/);
  assert.ok(!jev.calls.includes('hideDevMenu'));
});

test('a login wall replays the login block, then the step retries and passes', async () => {
  const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
  const f = fake(
    [wall, wall, wall, screen(['Settings']), screen(['Settings']), screen(['Profile'])],
    {
      login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
    },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.deepEqual(
    ledger.steps.map((r) => [r.block, r.outcome]),
    [
      ['login', 'pass'],
      ['plan', 'retry'],
      ['plan', 'pass'],
    ],
  );
  assert.match(ledger.steps[1].reason ?? '', /recovered: login/);
});

test('no recovery runs inside the login replay', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const f = fake([wall], {
    login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(outcome.failure?.seen ?? '', /the login block did not pass/);
  assert.deepEqual(
    outcome.rows.map((r) => [r.block, r.outcome]),
    [
      ['login', 'fail'],
      ['plan', 'fail'],
    ],
  );
});

test('a configured but unreadable login block fails at the step', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const f = fake([wall], { login: { marker: { id: 'login-screen' } } });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.match(outcome.failure?.seen ?? '', /the login block did not pass/);
});

test('login fills are masked and withhold the video', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const input: Screen = {
    ...screen([]),
    elements: [
      {
        ref: '@e1',
        kind: 'input',
        testID: 'password',
        placeholder: 'Password',
        hittable: true,
        disabled: false,
        secure: false,
        offscreen: false,
        semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
      },
    ],
  };
  const f = fake(
    [wall, wall, input, screen(['Settings']), screen(['Settings']), screen(['Profile'])],
    {
      login: {
        marker: { id: 'login-screen' },
        block: block('### Login\n1. Type "hunter2-secret" into "password"\n'),
      },
    },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.videoPublication, 'withheld-fill');
  assert.ok(!JSON.stringify(ledger).includes('hunter2-secret'));
});

test('a stored login block becomes exact-target items', () => {
  const login = loginBlock('login', {
    header: { appId: 'app', plan: 'login', planHash: 'h', platform: 'ios' },
    steps: [
      { raw: '1. Tap the sign in button', kind: 'press', selector: { id: 'sign-in' } },
      { raw: '2. Type "a" into email', kind: 'fill', selector: { text: 'Email' }, text: 'a' },
      { raw: '✓ "Welcome"', kind: 'check', text: 'Welcome' },
      { raw: '✓ The home screen is shown', kind: 'check' },
      { raw: '3. Accept the dialog', kind: 'dialog', action: 'accept' },
    ],
  });
  assert.deepEqual(
    login.items.map((item) => ({ ...item, raw: undefined })),
    [
      {
        kind: 'press',
        target: { quoted: 'sign-in', phrase: 'sign-in', exact: 'id' },
        line: 1,
        source: 'grammar',
        raw: undefined,
      },
      {
        kind: 'fill',
        target: { quoted: 'Email', phrase: 'Email', exact: 'text' },
        text: 'a',
        line: 2,
        source: 'grammar',
        raw: undefined,
      },
      { kind: 'check', text: 'Welcome', literal: true, line: 3, source: 'grammar', raw: undefined },
      {
        kind: 'check',
        text: 'The home screen is shown',
        literal: false,
        line: 4,
        source: 'grammar',
        raw: undefined,
      },
      { kind: 'dialog', action: 'accept', line: 5, source: 'grammar', raw: undefined },
    ],
  );
});

test('a selector miss after a replay recovery is terminal, not a second re-walk', async () => {
  const covered = screen(['Settings'], 'dialog', { Settings: 'settings' });
  const f = fake([covered, covered, covered, covered, covered, screen(['Other'])]);
  const replayed = block('1. Tap "settings"\n');
  const exact: Block = {
    ...replayed,
    items: replayed.items.map((item) =>
      item.kind === 'press'
        ? { ...item, target: { quoted: 'settings', phrase: 'settings', exact: 'id' } }
        : item,
    ),
  };
  const outcome = await walkBlock(exact, f.deps, 0, [], undefined, undefined, { mode: 'replay' });
  assert.equal(outcome.recoveries, 1);
  assert.equal(outcome.miss, undefined);
  assert.match(outcome.failure?.seen ?? '', /REPLAY_SELECTOR/);
});

test('a stale login selector fails the login plainly and reports the screen after it', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const after = screen(['Password required']);
  const f = fake([wall, wall, after, after], {
    login: {
      marker: { id: 'login-screen' },
      block: loginBlock('login', {
        header: { appId: 'app', plan: 'login', planHash: 'h', platform: 'ios' },
        steps: [{ raw: '1. Tap the sign in button', kind: 'press', selector: { id: 'sign-in' } }],
      }),
    },
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.deepEqual(
    outcome.rows.map((r) => [r.block, r.outcome]),
    [
      ['login', 'fail'],
      ['plan', 'fail'],
    ],
  );
  assert.ok(!outcome.rows[0].reason?.includes('re-walking'));
  assert.match(outcome.failure?.seen ?? '', /login block did not pass.*Password required/);
});

for (const plan of ['1. Tap "Settings"\n', '✓ "Render Error"\n', '✓ The home screen is shown\n']) {
  test(`render error terminates before accepting ${plan.trim()}`, async () => {
    const overlay = {
      ...screen(['Render Error', 'boom']),
      renderError: true,
      coverage: { native: 'incomplete', react: 'unknown' } as const,
    };
    const f = fake([overlay]);
    const outcome = await walkBlock(block(plan), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(outcome.refusal, undefined);
    assert.match(outcome.failure?.seen ?? '', /boom/);
    assert.equal(outcome.recoveries, undefined);
    assert.ok(!f.calls.some((c) => c.startsWith('press') || c === 'hideDevMenu'));
  });
}

test('a press opening a render error fails instead of accepting screen change', async () => {
  const f = fake([
    screen(['Settings']),
    { ...screen(['Render Error', 'boom']), renderError: true },
  ]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(outcome.failure?.seen ?? '', /boom/);
  assert.equal(outcome.recoveries, undefined);
});

test('a render error inside login replay terminates login and the parent step', async () => {
  const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
  const overlay = { ...screen(['Render Error', 'login boom']), renderError: true };
  const f = fake([wall, wall, wall, overlay], {
    login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(outcome.rows.some((r) => r.block === 'login' && r.outcome === 'fail'));
  assert.match(outcome.failure?.seen ?? '', /login boom/);
  assert.equal(outcome.recoveries, undefined);
});

test('a dev-menu no-op never counts as hidden or recovered', async () => {
  const f = fake([screen(['Reload'], 'dev-menu')], {
    hideDevMenu: async () => ({ ok: true, proven: false, executed: false }),
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(outcome.failure?.seen ?? '', /dev menu in front could not be hidden/);
  assert.equal(outcome.recoveries, undefined);
  assert.ok(outcome.rows.every((row) => row.outcome !== 'retry'));
});

for (const [plan, method] of [
  ['1. Tap "Settings"\n', 'press'],
  ['1. Go back\n', 'back'],
  ['1. Scroll down\n', 'scroll'],
  ['1. Accept the dialog\n', 'dialog'],
  ['1. Dismiss the dialog\n', 'dialog'],
  ['1. Type "hello" into "Settings"\n', 'fill'],
] as const) {
  test(`recovery permits only one additional dispatch: ${plan.trim()}`, async () => {
    const covered = screen(['Settings'], 'dev-menu');
    if (method === 'fill') {
      covered.elements[0].kind = 'input';
      covered.elements[0].semantic = {
        press: 'unsupported',
        fill: 'supported',
        visibility: 'visible',
      };
    }
    let dispatches = 0;
    const f = fake([covered], {
      [method]: async () => {
        dispatches++;
        return { ok: false, proven: false, mutation: 'none' };
      },
    });
    const outcome = await walkBlock(block(plan), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(outcome.recoveries, 1);
    assert.equal(dispatches, 3);
    assert.match(outcome.failure?.seen ?? '', /did not change after recovery/);
  });
}
