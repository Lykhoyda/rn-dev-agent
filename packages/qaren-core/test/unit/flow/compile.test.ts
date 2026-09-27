import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { compileFlow, FlowCompileError } from '../../../dist/flow/compile.js';

const fixtures = resolve(import.meta.dirname, '../../fixtures/rn-flow-1');
const walk = resolve(import.meta.dirname, '../../../dist/qa/walk.js');
const PARAMS = { TITLE: 'Ship it', DESC: 'From the plan', PRIORITY: 'high', TAG: 'bug' };

function withFlow(body: string, run: (file: string, dir: string) => void, name = 'a.yaml'): void {
  const dir = mkdtempSync(join(tmpdir(), 'rn-flow-'));
  try {
    const file = join(dir, name);
    writeFileSync(file, `appId: com.example.app\n---\n# id: sample\n# intent: t\n${body}`);
    run(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compile(body: string, platform: 'ios' | 'android' = 'ios', params = {}) {
  let plan;
  withFlow(body, (file) => {
    plan = compileFlow({ file, params, platform });
  });
  return plan!;
}

function refusal(body: string, params = {}): FlowCompileError {
  let error: unknown;
  withFlow(body, (file) => {
    try {
      compileFlow({ file, params, platform: 'ios' });
    } catch (caught) {
      error = caught;
    }
  });
  assert.ok(error instanceof FlowCompileError, `expected a refusal, got ${String(error)}`);
  return error;
}

test('an unsupported command refuses with its name and line', () => {
  const error = refusal('- launchApp:\n    stopApp: false\n- copyTextFrom:\n    id: x\n');
  assert.equal(error.command, 'copyTextFrom');
  assert.equal(error.line, 7);
});

test('commands outside the validator allowlist refuse with their line', () => {
  const denied = refusal('- back\n- runScript: evil.js\n');
  assert.deepEqual([denied.command, denied.line], ['runScript', 6]);
  const unknown = refusal('- repeat:\n    times: 2\n');
  assert.deepEqual([unknown.command, unknown.line], ['repeat', 5]);
  assert.match(refusal('- inputText: "a\\u0007"\n').reason, /Unsafe scalar/);
});

test('malformed and cyclic runFlow refuse instead of crashing', () => {
  assert.match(refusal('- runFlow:\n    file: 12\n').reason, /must be a path/);
  assert.match(refusal('- runFlow:\n    commands: true\n').reason, /must be a list/);
  assert.match(refusal('- runFlow: a.yaml\n').reason, /nesting exceeds 5/);
  assert.match(refusal('- runFlow: ../escape.yaml\n').reason, /must not contain/);
});

test('a regex-shaped text selector refuses; a param value is literal', () => {
  const error = refusal('- tapOn: "Log.n"\n');
  assert.equal(error.command, 'tapOn');
  assert.equal(error.line, 5);
  assert.match(error.reason, /regex/);
  assert.match(refusal('- assertVisible:\n    text: "(Continue|Weiter)"\n').reason, /regex/);
  assert.match(refusal('- tapOn: ${LABEL ?? "Log.n"}\n').reason, /regex/);
  assert.match(refusal('- tapOn:\n    id: ${ID}\n', { ID: '' }).reason, /empty/);
  const plan = compile('- assertVisible: ${TITLE}\n', 'ios', { TITLE: 'Done (1).' });
  assert.deepEqual(plan.steps[0]!.selector, { text: 'Done (1).' });
});

test('a selector mixing id and native text semantics refuses', () => {
  const error = refusal('- tapOn:\n    id: "save"\n    text: "Save"\n');
  assert.equal(error.command, 'tapOn');
  assert.match(error.reason, /both id and text/);
});

test('relative selectors and unknown keys refuse', () => {
  assert.match(refusal('- tapOn:\n    text: "A"\n    below: "B"\n').reason, /below/);
  assert.match(
    refusal('- tapOn:\n    id: "a"\n    retryTapIfNoChange: true\n').reason,
    /retryTapIfNoChange/,
  );
  assert.match(refusal('- launchApp:\n    permissions: {}\n').reason, /permissions/);
});

test('a missing param refuses; unknown expressions refuse', () => {
  assert.match(refusal('- inputText: ${TITLE}\n').reason, /TITLE/);
  assert.match(refusal('- inputText: ${output.x}\n').reason, /expression/);
  assert.equal(compile('- inputText: ${TITLE ?? "fallback"}\n').steps[0]!.text, 'fallback');
});

test('iOS routes only exact-id reads to the React tree; mutations stay native', () => {
  const plan = compile(
    [
      '- tapOn:\n    id: "a"',
      '- inputText: "x"',
      '- assertVisible:\n    id: "a"',
      '- assertNotVisible:\n    id: "a"',
      '- assertVisible:\n    id: "a"\n    index: 1',
      '- assertVisible: "Title"',
      '- swipe:\n    from:\n      id: "a"\n    direction: DOWN',
      '- scrollUntilVisible:\n    element:\n      id: "a"',
      '- hideKeyboard',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain]),
    [
      ['tapOn', 'native'],
      ['inputText', 'native'],
      ['assertVisible', 'react-tree'],
      ['assertNotVisible', 'native'],
      ['assertVisible', 'native'],
      ['assertVisible', 'native'],
      ['swipe', 'native'],
      ['scrollUntilVisible', 'native'],
      ['hideKeyboard', 'native'],
    ],
  );
  assert.equal(plan.steps.at(-1)!.fallbackDomain, 'react-tree');
});

test('absence reads stay native on iOS: a parked sheet keeps its fibers mounted', () => {
  const plan = compile(
    '- extendedWaitUntil:\n    notVisible:\n      id: "a"\n    timeout: 900\n- runFlow:\n    when:\n      notVisible:\n        id: "a"\n    commands:\n      - back\n- runFlow:\n    when:\n      visible:\n        id: "a"\n    commands:\n      - back\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain]),
    [
      ['assertNotVisible', 'native'],
      ['runFlow', 'native'],
      ['runFlow', 'react-tree'],
    ],
  );
});

test('malformed YAML refuses with its line instead of throwing', () => {
  assert.match(refusal('- back\n- tapOn: *missing\n').reason, /^YAML:/);
  const syntax = refusal('- back\n- tapOn: "unterminated\n');
  assert.match(syntax.reason, /^YAML:/);
  assert.ok(syntax.line >= 6, `line ${syntax.line}`);
  assert.match(refusal('back: true\n').reason, /must be a list/);
  assert.match(refusal('- back\n---\n- tapOn: Save\n').reason, /one optional header/);
  let error: unknown;
  const dir = mkdtempSync(join(tmpdir(), 'rn-flow-'));
  try {
    writeFileSync(join(dir, 'a.yaml'), 'appId: *missing\n---\n- back\n');
    compileFlow({ file: join(dir, 'a.yaml'), params: {}, platform: 'ios' });
  } catch (caught) {
    error = caught;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(error instanceof FlowCompileError);
  assert.match(error.reason, /^YAML:/);
});

test('Android keeps every read native; lifecycle and the keyboard tier stay', () => {
  const plan = compile('- launchApp\n- assertVisible:\n    id: "a"\n- hideKeyboard\n', 'android');
  assert.deepEqual(
    plan.steps.map((step) => step.domain),
    ['lifecycle', 'native', 'native'],
  );
  assert.equal(plan.steps[2]!.fallbackDomain, 'react-tree');
});

test('launchApp defaults to stopApp; only an activation is native', () => {
  const plan = compile(
    '- launchApp\n- launchApp:\n    stopApp: false\n- launchApp:\n    stopApp: false\n    clearState: true\n- killApp\n- stopApp\n- clearState\n- openLink: "app://x"\n',
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.domain, step.stopApp, step.clearState]),
    [
      ['launchApp', 'lifecycle', true, false],
      ['launchApp', 'native', false, false],
      ['launchApp', 'lifecycle', false, true],
      ['killApp', 'lifecycle', undefined, undefined],
      ['stopApp', 'lifecycle', undefined, undefined],
      ['clearState', 'lifecycle', undefined, undefined],
      ['openLink', 'lifecycle', undefined, undefined],
    ],
  );
});

test('budgets follow the contract', () => {
  const plan = compile(
    [
      '- tapOn: "A"',
      '- tapOn:\n    text: "A"\n    optional: true',
      '- assertNotVisible: "A"',
      '- extendedWaitUntil:\n    notVisible: "A"\n    timeout: 3000',
      '- scrollUntilVisible:\n    element: "A"',
      '- waitForAnimationToEnd:\n    timeout: 9000',
      '- waitForAnimationToEnd',
      '- swipeUp',
      '- runFlow:\n    when:\n      visible: "A"\n    commands:\n      - back',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    plan.steps.map((step) => [step.op, step.budgetMs, step.optional]),
    [
      ['tapOn', 17_000, false],
      ['tapOn', 7_000, true],
      ['assertNotVisible', 7_000, false],
      ['assertNotVisible', 3_000, false],
      ['scrollUntilVisible', 20_000, false],
      ['waitForAnimationToEnd', 5_000, false],
      ['waitForAnimationToEnd', 5_000, false],
      ['swipe', 10_400, false],
      ['runFlow', 0, false],
    ],
  );
});

test('runFlow file refs compile with their own file and line', () => {
  withFlow(
    '- runFlow:\n    file: sub/dismiss.yaml\n    when:\n      notVisible:\n        id: "home"\n- runFlow: sub/dismiss.yaml\n',
    (file, dir) => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'dismiss.yaml'), '- back\n- hideKeyboard\n');
      const plan = compileFlow({ file, params: {}, platform: 'ios' });
      const [conditional, spliced, last] = plan.steps;
      assert.deepEqual(conditional!.when, { notVisible: { id: 'home' } });
      assert.deepEqual(conditional!.source, { line: 5 });
      assert.deepEqual(
        conditional!.steps.map((step) => [step.id, step.source]),
        [
          ['s2', { file: 'sub/dismiss.yaml', line: 1 }],
          ['s3', { file: 'sub/dismiss.yaml', line: 2 }],
        ],
      );
      assert.deepEqual(
        [spliced, last].map((step) => [step!.id, step!.op, step!.source]),
        [
          ['s4', 'back', { file: 'sub/dismiss.yaml', line: 1 }],
          ['s5', 'hideKeyboard', { file: 'sub/dismiss.yaml', line: 2 }],
        ],
      );
    },
  );
});

test('the enginePin header never gates compilation', () => {
  const plan = compile('# enginePin: maestro-runner@0.0.1\n- back\n');
  assert.equal(plan.steps[0]!.op, 'back');
});

test('the 13 Test App actions match their golden plans on both platforms', () => {
  const actions = readdirSync(join(fixtures, 'actions')).filter((name) => name.endsWith('.yaml'));
  assert.equal(actions.length, 13);
  for (const name of actions) {
    for (const platform of ['ios', 'android'] as const) {
      const plan = compileFlow({ file: join(fixtures, 'actions', name), params: PARAMS, platform });
      const golden = join(fixtures, 'plans', `${name.replace(/\.yaml$/, '')}.${platform}.json`);
      const actual = `${JSON.stringify(plan, null, 2)}\n`;
      if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, actual);
      assert.equal(actual, readFileSync(golden, 'utf8'), golden);
    }
  }
});

test('walk.js --compile prints the plan or the refusal', () => {
  withFlow('- back\n- tapOn:\n    point: "50%,50%"\n', (file) => {
    const refused = spawnSync(
      process.execPath,
      [walk, '--compile', file, '--params', '{}', '--platform', 'ios'],
      { encoding: 'utf8' },
    );
    assert.equal(refused.status, 4, refused.stderr);
    const out = JSON.parse(refused.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'FLOW_UNSUPPORTED');
    assert.equal(out.refused[0].line, 6);
    assert.equal(out.refused[0].command, 'tapOn');
  });
  const file = join(fixtures, 'actions', 'wizard-create-task.yaml');
  const ok = spawnSync(
    process.execPath,
    [walk, '--compile', file, '--params', JSON.stringify(PARAMS), '--platform', 'android'],
    { encoding: 'utf8' },
  );
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.plan.schema, 'rn-flow/1');
  assert.equal(out.plan.actionId, 'wizard-create-task');
  const usage = spawnSync(process.execPath, [walk, '--compile', file, '--platform', 'web'], {
    encoding: 'utf8',
  });
  assert.equal(usage.status, 4);
});
