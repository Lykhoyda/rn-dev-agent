import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { runPlan, type BlockStore } from '../../../dist/qa/walker.js';
import type { Ledger, WalkResult } from '../../../dist/qa/ledger.js';
import { element, scriptedJudge, walker } from './judgment-fixtures.ts';

const literal = readFileSync(new URL('../../fixtures/plans/literal.md', import.meta.url), 'utf8');
const literalLabel = literal.replace('2. Tap "onboarding-done"', '2. Tap "Done"');
const SLUG = 'onboarding-to-the-tasks-tab';

function blocks(markdown: string): Block[] {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks;
}

interface AppOptions {
  doneId?: string;
  taskTitle?: string;
}

// A fresh install of the onboarding → home → tasks app; presses move it forward by testID.
function app(options: AppOptions = {}) {
  const doneId = options.doneId ?? 'onboarding-done';
  let state = 0;
  const screens: Element[][] = [
    [element('@skip', 'Skip', { testID: 'onboarding-skip' })],
    [element('@done', 'Done', { testID: doneId })],
    [
      element('@welcome', 'Welcome', { kind: 'text', testID: 'home-title' }),
      element('@tasks', 'Tasks', { testID: 'tab-tasks' }),
    ],
    [element('@header', options.taskTitle ?? 'Tasks (3)', { kind: 'text', testID: 'task-header' })],
  ];
  const next: Record<string, number> = { '@skip': 1, '@done': 2, '@tasks': 3 };
  const current = (): Screen => {
    const elements = screens[state];
    return {
      front: 'app',
      elements,
      visibleText: elements.map((e) => e.label ?? ''),
      coverage: { native: 'complete', react: 'complete' },
    };
  };
  const judge = scriptedJudge(() => assert.fail('a literal plan must never ask Jev'));
  const fake = walker([], judge);
  fake.deps.captureScreen = async () => current();
  fake.deps.press = async (ref) => {
    fake.actions.push(`press ${ref}`);
    if (next[ref] === state + 1) state = next[ref];
    return { ok: true, proven: false };
  };
  return { ...fake, judge };
}

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-replay-'));
  mkdirSync(join(dir, '.qaren'));
  return dir;
}

const store = (appRoot: string): BlockStore => ({
  appRoot,
  platform: 'ios',
  appId: 'com.example.app',
});
const actionFile = (appRoot: string) => join(appRoot, '.qaren', 'actions', `${SLUG}.yaml`);

async function run(markdown: string, appRoot: string, options?: AppOptions) {
  const fake = app(options);
  const result = (await runPlan(blocks(markdown), fake.deps, [], store(appRoot))) as Ledger;
  return { result, fake };
}

function ledger(result: WalkResult): Ledger {
  assert.notEqual(result.verdict, 'REFUSED', JSON.stringify(result));
  return result as Ledger;
}

test('first run walks, passes and writes the block', async () => {
  const dir = root();
  const { result } = await run(literal, dir);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.path, 'walk');
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'pass', source: 'discovered' }]);
  assert.deepEqual(result.blocksWritten, [SLUG]);
  assert.match(readFileSync(actionFile(dir), 'utf8'), /- tapOn: \{ id: "onboarding-done" \}/);
});

test('second run replays the stored block without Jev and leaves the file unchanged', async () => {
  const dir = root();
  await run(literal, dir);
  const before = readFileSync(actionFile(dir), 'utf8');
  const { result, fake } = await run(literal, dir);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.path, 'replay');
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'pass', source: 'replayed' }]);
  assert.equal(result.jev.calls, 0);
  assert.equal(fake.judge.calls.length, 0);
  assert.deepEqual(result.blocksWritten, []);
  assert.ok(result.steps.every((row) => row.resolvedBy === 'exact'));
  assert.equal(readFileSync(actionFile(dir), 'utf8'), before);
});

test('an edited plan line changes planHash, so the block is walked and rewritten', async () => {
  const dir = root();
  await run(literal, dir);
  const edited = literal.replace('4. Tap "tab-tasks"', '4. Tap "Tasks"');
  const { result } = await run(edited, dir);
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.path, 'walk');
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'pass', source: 'discovered' }]);
  assert.deepEqual(result.blocksWritten, [SLUG]);
  assert.match(
    readFileSync(actionFile(dir), 'utf8'),
    /# 4\. Tap "Tasks"\n- tapOn: \{ id: "tab-tasks" \}/,
  );
});

test('a stored id missing at line k re-walks from k and patches only that line', async () => {
  const dir = root();
  await run(literalLabel, dir);
  const before = readFileSync(actionFile(dir), 'utf8');
  const doneLine = blocks(literalLabel)[0].items[1].line;
  const { result, fake } = await run(literalLabel, dir, { doneId: 'onboarding-finish' });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.path, `replay→walk@${doneLine}`);
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'pass', source: 'patched' }]);
  assert.deepEqual(result.blocksWritten, [SLUG]);
  assert.equal(result.jev.calls, 0);
  assert.equal(fake.judge.calls.length, 0);
  const miss = result.steps.find((row) => row.line === doneLine && row.outcome !== 'pass');
  assert.equal(miss?.outcome, 'retry');
  assert.match(miss?.reason ?? '', /REPLAY_SELECTOR/);
  assert.ok(!result.steps.some((row) => row.outcome === 'fail'));
  const after = readFileSync(actionFile(dir), 'utf8');
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length);
  const differing = a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]]));
  assert.deepEqual(differing, [
    ['- tapOn: { id: "onboarding-done" }', '- tapOn: { id: "onboarding-finish" }'],
  ]);
  for (const line of a.filter((l) => l.startsWith('# ✓'))) assert.ok(b.includes(line));
});

test('a failed walk writes nothing', async () => {
  const dir = root();
  const broken = literal.replace('4. Tap "tab-tasks"', '4. Tap "tab-settings"');
  const { result } = await run(broken, dir);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'fail', source: 'discovered' }]);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(existsSync(actionFile(dir)), false);
});

test('a ✓ that fails during replay is a FAIL: no re-walk and no write', async () => {
  const dir = root();
  await run(literal, dir);
  const before = readFileSync(actionFile(dir), 'utf8');
  const { result, fake } = await run(literal, dir, { taskTitle: 'Inbox (3)' });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.path, 'replay');
  assert.deepEqual(result.blocks, [{ key: SLUG, outcome: 'fail', source: 'replayed' }]);
  assert.equal(fake.actions.filter((a) => a === 'press @skip').length, 1);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(readFileSync(actionFile(dir), 'utf8'), before);
});

test('a symlinked corpus or a slug collision leaves the block unsaved and the run unaffected', async () => {
  const linked = root();
  symlinkSync(mkdtempSync(join(tmpdir(), 'qaren-elsewhere-')), join(linked, '.qaren', 'actions'));
  const viaLink = ledger(await runPlan(blocks(literal), app().deps, [], store(linked)));
  assert.equal(viaLink.verdict, 'PASS');
  assert.equal(viaLink.blocks[0].saved, false);
  assert.match(viaLink.blocks[0].unsavable ?? '', /symlink/);
  assert.deepEqual(viaLink.blocksWritten, []);

  const taken = root();
  mkdirSync(join(taken, '.qaren', 'actions'));
  writeFileSync(
    actionFile(taken),
    '# id: onboarding-to-the-tasks-tab\n# intent: recorded\n- launchApp\n',
  );
  const collided = ledger(await runPlan(blocks(literal), app().deps, [], store(taken)));
  assert.equal(collided.verdict, 'PASS');
  assert.equal(collided.blocks[0].saved, false);
  assert.match(collided.blocks[0].unsavable ?? '', /BLOCK_SLUG_COLLISION/);
  assert.match(readFileSync(actionFile(taken), 'utf8'), /recorded/);
});

test('a block saved for another platform is walked, not replayed', async () => {
  const dir = root();
  await run(literal, dir);
  const fake = app();
  const result = ledger(
    await runPlan(blocks(literal), fake.deps, [], { ...store(dir), platform: 'android' }),
  );
  assert.equal(result.path, 'walk');
  assert.equal(result.blocks[0].source, 'discovered');
  assert.match(readFileSync(actionFile(dir), 'utf8'), /# platform: android/);
});

test('without a store the walk keeps its previous behaviour', async () => {
  const fake = app();
  const result = ledger(await runPlan(blocks(literal), fake.deps));
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.path, 'walk');
  assert.equal(result.blocksWritten, undefined);
});

test('a hand-reformatted block is not replayed: it is walked and rewritten canonically', async () => {
  const dir = root();
  await run(literal, dir);
  const canonical = readFileSync(actionFile(dir), 'utf8');
  writeFileSync(
    actionFile(dir),
    canonical.replace('{ id: "onboarding-skip" }', "{ id: 'onboarding-skip' }"),
  );
  const { result } = await run(literal, dir);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.path, 'walk');
  assert.equal(result.blocks[0].source, 'discovered');
  assert.equal(readFileSync(actionFile(dir), 'utf8'), canonical);
});

test('the iOS process guard: a changed or missing identifier fails the step; nothing is written', async () => {
  for (const [label, ids, expected] of [
    ['unchanged', [41, 41], 'PASS'],
    ['changed', [41, 77], 'FAIL'],
    ['missing', [41, undefined], 'FAIL'],
  ] as const) {
    const dir = root();
    const fake = app();
    let captures = 0;
    const capture = fake.deps.captureScreen;
    fake.deps.captureScreen = async (options) => {
      const screen = await capture(options);
      const id = captures++ === 0 ? ids[0] : ids[1];
      return id === undefined ? screen : { ...screen, appProcessIdentifier: id };
    };
    fake.deps.appProcess = {};
    const result = ledger(await runPlan(blocks(literal), fake.deps, [], store(dir)));
    assert.equal(result.verdict, expected, label);
    if (expected === 'PASS') continue;
    assert.equal(result.failure?.step, blocks(literal)[0].items[0].line, label);
    assert.match(result.failure?.seen ?? '', /APP_PROCESS_CHANGED: the app restarted or crashed/);
    assert.deepEqual(fake.actions, ['press @skip'], label);
    assert.deepEqual(result.blocksWritten, []);
    assert.equal(existsSync(actionFile(dir)), false);
  }
});

test('the iOS process guard refuses a runner that does not report the app process', async () => {
  const fake = app();
  fake.deps.appProcess = {};
  const result = await runPlan(blocks(literal), fake.deps, [], store(root()));
  assert.equal(result.verdict, 'REFUSED');
  assert.equal((result as { code?: string }).code, 'APP_PROCESS_UNKNOWN');
  assert.equal(fake.actions.length, 0);
});

test('without the guard (Android) captures need no process identifier', async () => {
  const fake = app();
  const result = ledger(
    await runPlan(blocks(literal), fake.deps, [], { ...store(root()), platform: 'android' }),
  );
  assert.equal(result.verdict, 'PASS');
});
