import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan, slugify } from '../../../dist/qa/plan.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { join as joinScreen } from '../../../dist/qa/screen.js';
import { runPlan, walkBlock, type BlockStore } from '../../../dist/qa/walker.js';
import type { Ledger, WalkResult } from '../../../dist/qa/ledger.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { AppProcessGoneError } from '../../../dist/qa/capture.js';
import { captureInputPrivacy, isPrivateInput } from '../../../dist/qa/privacy.js';

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
  welcomeId?: string;
}

// A fresh install of the onboarding → home → tasks app; presses move it forward by testID.
function app(options: AppOptions = {}) {
  const doneId = options.doneId ?? 'onboarding-done';
  let state = 0;
  const screens: Element[][] = [
    [element('@skip', 'Skip', { testID: 'onboarding-skip' })],
    [element('@done', 'Done', { testID: doneId })],
    [
      element('@welcome', 'Welcome', { kind: 'text', testID: options.welcomeId ?? 'home-title' }),
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
  const saved = readFileSync(actionFile(dir), 'utf8');
  assert.match(saved, /- tapOn: \{ id: "onboarding-done" \}/);
  assert.match(
    saved,
    /# 3\. Wait for "Welcome" to appear\n- extendedWaitUntil: \{ visible: \{ id: "home-title" \}, timeout: 15000 \}/,
  );
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

for (const extension of ['yaml', 'yml']) {
  test(`a stored .${extension} id missing at line k re-walks and patches only that line`, async () => {
    const dir = root();
    await run(literalLabel, dir);
    const savedPath = join(dir, '.qaren', 'actions', `${SLUG}.${extension}`);
    if (extension === 'yml') renameSync(actionFile(dir), savedPath);
    const before = readFileSync(savedPath, 'utf8');
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
    const after = readFileSync(savedPath, 'utf8');
    const other = extension === 'yml' ? 'yaml' : 'yml';
    assert.equal(existsSync(join(dir, '.qaren', 'actions', `${SLUG}.${other}`)), false);
    const a = before.split('\n');
    const b = after.split('\n');
    assert.equal(a.length, b.length);
    const differing = a.flatMap((line, i) => (line === b[i] ? [] : [[line, b[i]]]));
    assert.deepEqual(differing, [
      ['- tapOn: { id: "onboarding-done" }', '- tapOn: { id: "onboarding-finish" }'],
    ]);
    for (const line of a.filter((l) => l.startsWith('# ✓'))) assert.ok(b.includes(line));
  });
}

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

test('overflow title discovery passes but preserves the short-title action', async () => {
  const dir = root();
  const longTitle = 'a'.repeat(65);
  const shortTitle = slugify(longTitle);
  const withTitle = (title: string) =>
    literal.replace('### Onboarding to the tasks tab', `### ${title}`);
  const first = await run(withTitle(shortTitle), dir);
  assert.equal(first.result.verdict, 'PASS');
  assert.deepEqual(first.result.blocksWritten, [shortTitle]);
  const path = join(dir, '.qaren/actions', `${shortTitle}.yaml`);
  const before = readFileSync(path, 'utf8');
  const { result } = await run(withTitle(longTitle), dir);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.path, 'walk');
  assert.equal(result.blocks[0].source, 'discovered');
  assert.equal(result.blocks[0].saved, false);
  assert.match(result.blocks[0].unsavable ?? '', /BLOCK_SLUG_COLLISION/);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(readFileSync(path, 'utf8'), before);
  const replayed = await run(withTitle(shortTitle), dir);
  assert.equal(replayed.result.path, 'replay');
  assert.equal(readFileSync(path, 'utf8'), before);
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
    let shots = 0;
    mkdirSync(join(dir, 'screenshots'));
    fake.deps.screenshot = async (name) => {
      shots += 1;
      writeFileSync(join(dir, name), 'other-app-private-pixels');
      return name;
    };
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
    assert.equal(result.publicationInterrupted, expected !== 'PASS', label);
    if (expected === 'PASS') continue;
    assert.equal(result.failure?.step, blocks(literal)[0].items[0].line, label);
    assert.match(result.failure?.seen ?? '', /APP_PROCESS_CHANGED: the app restarted or crashed/);
    assert.deepEqual(fake.actions, ['press @skip'], label);
    assert.equal(shots, 0);
    assert.equal(result.failure?.screenshot, undefined);
    assert.ok(result.steps.every((row) => row.screenshot === undefined));
    assert.deepEqual(result.blocksWritten, []);
    assert.equal(existsSync(actionFile(dir)), false);
  }
});

test('the iOS process guard refuses a runner that does not report the app process', async () => {
  const dir = root();
  const fake = app();
  const path = join(dir, 'unknown-process.png');
  let shots = 0;
  fake.deps.screenshot = async () => {
    shots += 1;
    writeFileSync(path, 'other-app-private-pixels');
    return 'unknown-process.png';
  };
  fake.deps.appProcess = {};
  const result = await runPlan(blocks(literal), fake.deps, [], store(dir));
  assert.equal(result.verdict, 'REFUSED');
  assert.equal((result as { code?: string }).code, 'APP_PROCESS_UNKNOWN');
  assert.equal(fake.actions.length, 0);
  assert.equal(shots, 0);
  assert.equal(existsSync(path), false);
});

test('without the guard (Android) captures need no process identifier', async () => {
  const fake = app();
  const result = ledger(
    await runPlan(blocks(literal), fake.deps, [], { ...store(root()), platform: 'android' }),
  );
  assert.equal(result.verdict, 'PASS');
});

test('a capture that finds the app process gone fails APP_PROCESS_CHANGED and writes nothing', async () => {
  const dir = root();
  const fake = app();
  const path = join(dir, 'lost-process.png');
  let shots = 0;
  fake.deps.screenshot = async () => {
    shots += 1;
    writeFileSync(path, 'other-app-private-pixels');
    return 'lost-process.png';
  };
  let captures = 0;
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async (options) => {
    if (captures++ === 1) throw new AppProcessGoneError();
    return { ...(await capture(options)), appProcessIdentifier: 41 };
  };
  fake.deps.appProcess = {};
  const result = ledger(await runPlan(blocks(literal), fake.deps, [], store(dir)));
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /APP_PROCESS_CHANGED/);
  assert.equal(result.publicationInterrupted, true);
  assert.equal(existsSync(actionFile(dir)), false);
  assert.equal(shots, 0);
  assert.equal(existsSync(path), false);
  assert.equal(result.failure?.screenshot, undefined);
});

test('a process change on an error screen still records its concealed inputs before reporting', async () => {
  const fake = app();
  let captures = 0;
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async (options) => {
    const screen = await capture(options);
    if (captures++ === 0) return { ...screen, appProcessIdentifier: 41 };
    const secret = element('@pin', 'PIN', { kind: 'input', secure: true, value: 'hunter2' });
    return {
      ...screen,
      elements: [...screen.elements, secret],
      visibleText: [...screen.visibleText, 'hunter2'],
      appProcessIdentifier: 77,
      renderError: true,
    };
  };
  fake.deps.appProcess = {};
  const result = ledger(await runPlan(blocks(literal), fake.deps, [], store(root())));
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /APP_PROCESS_CHANGED/);
  assert.equal(result.publicationInterrupted, true);
  assert.doesNotMatch(JSON.stringify(result), /hunter2/);
});

function form(secure: boolean) {
  let saved = false;
  const judge = scriptedJudge(() => assert.fail('a literal plan must never ask Jev'));
  const fake = walker([], judge);
  fake.deps.captureScreen = async () => {
    const elements = saved
      ? [element('@done', 'Saved', { kind: 'text' })]
      : [
          element('@pin', 'PIN', { kind: 'input', testID: 'pin-input', secure }),
          element('@save', 'Save', { testID: 'save' }),
        ];
    return {
      front: 'app',
      elements,
      visibleText: elements.map((e) => e.label ?? ''),
      coverage: { native: 'complete', react: 'complete' },
    };
  };
  fake.deps.press = async (ref) => {
    fake.actions.push(`press ${ref}`);
    if (ref === '@save') saved = true;
    return { ok: true, proven: false };
  };
  return fake;
}

const formPlan =
  '## QA\n\n### Save a PIN\n\n1. Type "4711" into "pin-input"\n2. Tap "Save"\n✓ "Saved"\n';

test('a fill into a secure input leaves its block unsaved with a value-free reason', async () => {
  const dir = root();
  const result = ledger(await runPlan(blocks(formPlan), form(true).deps, [], store(dir)));
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  const fillLine = blocks(formPlan)[0].items[0].line;
  assert.deepEqual(result.blocks, [
    {
      key: 'save-a-pin',
      outcome: 'pass',
      source: 'discovered',
      saved: false,
      unsavable: `line ${fillLine}: fills a private input`,
    },
  ]);
  assert.deepEqual(result.blocksWritten, []);
  assert.equal(existsSync(join(dir, '.qaren', 'actions', 'save-a-pin.yaml')), false);
});

test('an ordinary fill keeps its plan literal in the saved block', async () => {
  const dir = root();
  const result = ledger(await runPlan(blocks(formPlan), form(false).deps, [], store(dir)));
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.deepEqual(result.blocksWritten, ['save-a-pin']);
  assert.match(
    readFileSync(join(dir, '.qaren', 'actions', 'save-a-pin.yaml'), 'utf8'),
    /- tapOn: \{ id: "pin-input" \}\n- inputText: "4711"\n/,
  );
});

for (const representation of ['title', 'comment', 'assertion'] as const) {
  for (const source of ['discovered', 'patched'] as const) {
    test(`private fill history withholds later ${representation} content during ${source} save`, async () => {
      const dir = root();
      const echo = representation === 'assertion' ? '4711' : 'Saved';
      const plan = blocks(
        `## QA\n\n### Enter PIN\n1. Type "4711" into "pin-input"\n\n### Confirm\n1. Tap "Finish"\n✓ "${echo}"\n`,
      );
      const later = plan[1];
      const check = later.items[1];
      assert.equal(check.kind, 'check');
      if (representation === 'title') later.title = 'Confirm 4711';
      if (representation === 'comment') check.raw = '✓ "Saved" (4711)';
      const fake = (finishId: string, secure = true) =>
        walker(
          [
            screen([
              element('@pin', 'PIN', { kind: 'input', testID: 'pin-input', secure }),
              element('@finish', 'Finish', { testID: finishId }),
              element('@saved', 'Saved', { kind: 'text' }),
              element('@echo', '4711', { kind: 'text' }),
            ]),
          ],
          scriptedJudge(() => assert.fail('literal resolution must not ask Jev')),
        );
      const path = join(dir, '.qaren', 'actions', `${later.slug}.yaml`);
      let before: string | undefined;
      if (source === 'patched') {
        const initial = ledger(await runPlan(plan, fake('finish-old', false).deps, [], store(dir)));
        assert.equal(initial.verdict, 'PASS');
        assert.deepEqual(initial.blocksWritten, ['enter-pin', later.slug]);
        before = readFileSync(path, 'utf8');
      }
      const result = ledger(await runPlan(plan, fake('finish-new').deps, [], store(dir)));
      assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
      assert.equal(result.blocks[0].saved, false);
      assert.deepEqual(result.blocks[1], {
        key: later.slug,
        outcome: 'pass',
        source,
        saved: false,
        unsavable: 'contains a protected plan-typed value',
      });
      assert.deepEqual(result.blocksWritten, []);
      if (source === 'patched') {
        assert.equal(result.blocks[0].source, 'replayed');
        assert.equal(result.path, `replay→walk@${later.items[0].line}`);
        assert.equal(readFileSync(path, 'utf8'), before);
      } else {
        assert.equal(existsSync(path), false);
      }
    });
  }
}

test('the private-input predicate covers secure fields and inputs the privacy model cannot read safely', () => {
  const plain = element('@a', 'Name', { kind: 'input' });
  assert.equal(isPrivateInput(plain), false);
  assert.equal(isPrivateInput(element('@b', 'PIN', { kind: 'input', secure: true })), true);
  const unknown = element('@c', 'Code', { kind: 'input' });
  captureInputPrivacy(unknown, {
    values: [],
    nativeLabelMayBeValue: false,
    checkSubject: 'unknown',
  });
  assert.equal(isPrivateInput(unknown), true);
  const labelValue = element('@d', 'ada@example.com', { kind: 'input' });
  captureInputPrivacy(labelValue, {
    values: [],
    nativeLabelMayBeValue: true,
    checkSubject: 'supported',
  });
  assert.equal(isPrivateInput(labelValue), true);
});

for (const targetLine of ['3. Wait for "Welcome" to appear', '3. Scroll down until "Welcome"']) {
  test(`${targetLine} re-walks target ID drift without repeating prior actions`, async () => {
    const dir = root();
    const plan = literal.replace('3. Wait for "Welcome" to appear', targetLine);
    await run(plan, dir);
    const line = blocks(plan)[0].items[2].line;
    const { result, fake } = await run(plan, dir, { welcomeId: 'welcome-title' });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
    assert.equal(result.path, `replay→walk@${line}`);
    assert.deepEqual(fake.actions, ['press @skip', 'press @done', 'press @tasks']);
    assert.equal(result.steps.find((row) => row.line === line)?.outcome, 'retry');
    assert.match(readFileSync(actionFile(dir), 'utf8'), /id: "welcome-title"/);
  });
}

for (const kind of ['wait', 'scroll', 'press', 'fill'] as const) {
  for (const exact of ['id', 'text'] as const) {
    test(`replay ${kind} rejects duplicate stored ${exact} before dispatch`, async () => {
      const raw =
        kind === 'wait'
          ? '1. Wait for "Go"'
          : kind === 'scroll'
            ? '1. Scroll down until "Go"'
            : kind === 'fill'
              ? '1. Fill "Go" with "Ada"'
              : '1. Tap "Go"';
      const block = blocks(raw)[0];
      const item = block.items[0];
      const target = { quoted: 'Go', phrase: 'Go', exact };
      block.items[0] = kind === 'scroll' ? { ...item, until: target } : { ...item, target };
      const fake = walker(
        [
          screen([
            element('@a', 'Go', { testID: 'Go', kind: kind === 'fill' ? 'input' : 'button' }),
            element('@b', 'Go', { testID: 'Go', kind: kind === 'fill' ? 'input' : 'button' }),
          ]),
        ],
        scriptedJudge(() => assert.fail('exact replay cannot ask Jev')),
      );
      const result = await walkBlock(block, fake.deps, 0, [], undefined, undefined, {
        mode: 'replay',
      });
      assert.equal(result.miss, item.line);
      assert.deepEqual(fake.actions, []);
    });
  }
}

test('an offscreen replay target lost after scrolling stays terminal', async () => {
  const block = blocks('1. Tap "Go"')[0];
  const item = block.items[0];
  assert.equal(item.kind, 'press');
  block.items[0] = { ...item, target: { quoted: 'go', phrase: 'go', exact: 'id' } };
  const fake = walker(
    [
      screen([element('@go', 'Go', { testID: 'go', offscreen: true })]),
      screen([element('@other', 'Other')]),
    ],
    scriptedJudge(() => assert.fail('exact replay cannot ask Jev')),
  );
  const scroll = fake.deps.scroll;
  fake.deps.scroll = async (direction, context) => {
    context.authorize();
    return scroll(direction, context);
  };
  const result = await walkBlock(block, fake.deps, 0, [], undefined, undefined, { mode: 'replay' });
  assert.equal(result.miss, undefined);
  assert.ok(result.failure);
  assert.deepEqual(fake.actions, ['scroll down']);
});

for (const occurrences of [1, 2]) {
  test(`stored text visibility handles ${occurrences} painted contributions`, async () => {
    const block = blocks('1. Wait for "Welcome"')[0];
    const item = block.items[0];
    block.items[0] = { ...item, target: { quoted: 'Welcome', phrase: 'Welcome', exact: 'text' } };
    const fake = walker(
      [screen([], Array(occurrences).fill('Welcome'))],
      scriptedJudge(() => assert.fail('exact visibility cannot ask Jev')),
    );
    const result = await walkBlock(block, fake.deps, 0, [], undefined, undefined, {
      mode: 'replay',
    });
    assert.equal(result.miss, occurrences === 2 ? item.line : undefined);
    assert.equal(!!result.failure, occurrences === 2);
    assert.deepEqual(fake.actions, []);
  });
}

for (const verb of [
  'Tap "Target"',
  'Fill "Target" with "Ada"',
  'Scroll down until "Target"',
  'Scroll up until "Target"',
]) {
  for (const phase of ['before', 'after', 'success']) {
    test(`${verb} tracks successful authorization at ${phase}`, async () => {
      const block = blocks(`1. ${verb}`)[0];
      const item = block.items[0];
      const target = { quoted: 'old-id', phrase: 'old-id', exact: 'id' as const };
      block.items[0] = item.kind === 'scroll' ? { ...item, until: target } : { ...item, target };
      let now = 0;
      let drift = false;
      let dispatched = 0;
      const fake = walker(
        [],
        scriptedJudge(() => assert.fail('exact replay must not ask Jev')),
      );
      fake.deps.now = () => now;
      fake.deps.captureScreen = async () =>
        screen([
          element('@target', 'Target', {
            kind: item.kind === 'fill' ? 'input' : 'button',
            testID: drift ? 'new-id' : 'old-id',
            offscreen: item.kind === 'scroll' && dispatched === 0,
          }),
        ]);
      const send = async (context: Parameters<typeof fake.deps.back>[0]) => {
        if (phase !== 'before') {
          context.authorize();
          dispatched += 1;
        }
        if (phase !== 'success') {
          drift = true;
          now = context.deadline;
          context.check();
        }
        return { ok: true, proven: true };
      };
      fake.deps.press = (_ref, context) => send(context);
      fake.deps.fill = (_ref, _text, context) => send(context);
      fake.deps.scroll = (_direction, context) => send(context);
      const result = await walkBlock(block, fake.deps, 0, [], undefined, undefined, {
        mode: 'replay',
      });
      assert.equal(dispatched, phase === 'before' ? 0 : 1);
      assert.equal(result.miss, phase === 'before' ? item.line : undefined);
      assert.equal(!!result.failure, phase !== 'success');
      if (phase === 'after') assert.match(result.failure!.seen, /ACTION_OUTCOME_UNCERTAIN/);
    });
  }
}

test('private-input replay PASS reports withholding without changing the saved action', async () => {
  const dir = root();
  const ordinary = ledger(await runPlan(blocks(formPlan), form(false).deps, [], store(dir)));
  assert.equal(ordinary.verdict, 'PASS');
  const path = join(dir, '.qaren/actions/save-a-pin.yaml');
  const before = readFileSync(path, 'utf8');
  const replay = ledger(await runPlan(blocks(formPlan), form(true).deps, [], store(dir)));
  assert.equal(replay.verdict, 'PASS');
  assert.equal(replay.path, 'replay');
  assert.deepEqual(replay.blocks, [
    {
      key: 'save-a-pin',
      outcome: 'pass',
      source: 'replayed',
      saved: false,
      unsavable: `line ${blocks(formPlan)[0].items[0].line}: fills a private input`,
    },
  ]);
  assert.deepEqual(replay.blocksWritten, []);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.doesNotMatch(JSON.stringify(replay), /4711/);
});

test('stored fill refresh before authorization re-walks without repeating earlier actions', async () => {
  const dir = root();
  const plan = formPlan.replace(
    '1. Type "4711" into "pin-input"',
    '1. Back\n2. Type "4711" into "PIN"',
  );
  await runPlan(blocks(plan), form(false).deps, [], store(dir));
  const fake = form(false);
  const capture = fake.deps.captureScreen;
  let drift = false;
  let now = 0;
  fake.deps.now = () => now;
  fake.deps.captureScreen = async () => {
    const observed = await capture();
    return {
      ...observed,
      elements: observed.elements.map((e) =>
        drift && e.testID === 'pin-input' ? { ...e, testID: 'new-pin' } : e,
      ),
    };
  };
  fake.deps.fill = async (ref, text, context) => {
    if (!drift) {
      drift = true;
      now = context.deadline;
      context.authorize();
    }
    context.authorize();
    fake.actions.push(`fill ${ref} ${text}`);
    return { ok: true, proven: true };
  };
  const replay = ledger(await runPlan(blocks(plan), fake.deps, [], store(dir)));
  assert.equal(replay.verdict, 'PASS', replay.failure?.seen);
  assert.equal(replay.path, `replay→walk@${blocks(plan)[0].items[1].line}`);
  assert.deepEqual(fake.actions, ['back', 'fill @pin 4711', 'press @save']);
});

test('a text wait echoed by containers replays without re-walk', async () => {
  const rect = (y: number, height = 20) => ({ x: 16, y, width: 200, height });
  const home = joinScreen(
    [
      { ref: '@window', index: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      ...[1, 2, 3, 4].map((index) => ({
        ref: `@container${index}`,
        index,
        parentIndex: index - 1,
        type: 'Other',
        label: 'Welcome',
        rect: rect(100, 400),
      })),
      {
        ref: '@welcome',
        index: 5,
        parentIndex: 4,
        type: 'StaticText',
        label: 'Welcome',
        rect: rect(120),
      },
      {
        ref: '@tasks',
        index: 6,
        parentIndex: 0,
        type: 'Button',
        label: 'Tasks',
        identifier: 'tab-tasks',
        hittable: true,
        enabled: true,
        rect: rect(800),
      },
    ],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
  const echoed = () => {
    const fake = app({ welcomeId: '' });
    const capture = fake.deps.captureScreen;
    fake.deps.captureScreen = async (...args) => {
      const shown = await capture(...args);
      return shown.elements.some((e) => e.ref === '@welcome')
        ? { ...shown, elements: home.elements, visibleText: home.visibleText }
        : shown;
    };
    return fake;
  };
  const dir = root();
  const first = ledger(await runPlan(blocks(literal), echoed().deps, [], store(dir)));
  assert.equal(first.verdict, 'PASS', JSON.stringify(first.failure));
  const before = readFileSync(actionFile(dir), 'utf8');
  assert.match(before, /- extendedWaitUntil: \{ visible: \{ text: "Welcome" \}, timeout: 15000 \}/);
  const fake = echoed();
  const second = ledger(await runPlan(blocks(literal), fake.deps, [], store(dir)));
  assert.equal(second.verdict, 'PASS', JSON.stringify(second.failure));
  assert.equal(second.path, 'replay');
  assert.deepEqual(second.blocks, [{ key: SLUG, outcome: 'pass', source: 'replayed' }]);
  assert.equal(second.jev.calls, 0);
  assert.equal(fake.judge.calls.length, 0);
  assert.equal(readFileSync(actionFile(dir), 'utf8'), before);
});

test('a wait on a uniquely labelled control sharing its testID replays by text without re-walk', async () => {
  const rect = (y: number) => ({ x: 16, y, width: 200, height: 20 });
  const home = joinScreen(
    [
      { ref: '@window', index: 0, type: 'Window', rect: { x: 0, y: 0, width: 390, height: 844 } },
      ...[
        { ref: '@welcome', label: 'Welcome', identifier: 'qa-replay-siblings', y: 100 },
        { ref: '@sibling', label: 'Sibling', identifier: 'qa-replay-siblings', y: 200 },
        { ref: '@tasks', label: 'Tasks', identifier: 'tab-tasks', y: 800 },
      ].map(({ y, ...button }, i) => ({
        ...button,
        index: i + 1,
        parentIndex: 0,
        type: 'Button',
        hittable: true,
        enabled: true,
        rect: rect(y),
      })),
    ],
    [],
    'app',
    { native: 'complete', react: 'complete' },
  );
  const siblings = () => {
    const fake = app();
    const capture = fake.deps.captureScreen;
    fake.deps.captureScreen = async (...args) => {
      const shown = await capture(...args);
      return shown.elements.some((e) => e.ref === '@welcome')
        ? {
            ...shown,
            elements: home.elements,
            visibleText: home.visibleText,
            paintedText: home.paintedText,
          }
        : shown;
    };
    return fake;
  };
  const dir = root();
  const first = ledger(await runPlan(blocks(literal), siblings().deps, [], store(dir)));
  assert.equal(first.verdict, 'PASS', JSON.stringify(first.failure));
  const before = readFileSync(actionFile(dir), 'utf8');
  assert.match(before, /- extendedWaitUntil: \{ visible: \{ text: "Welcome" \}, timeout: 15000 \}/);
  const fake = siblings();
  const second = ledger(await runPlan(blocks(literal), fake.deps, [], store(dir)));
  assert.equal(second.verdict, 'PASS', JSON.stringify(second.failure));
  assert.equal(second.path, 'replay');
  assert.deepEqual(second.blocks, [{ key: SLUG, outcome: 'pass', source: 'replayed' }]);
  assert.equal(second.jev.calls, 0);
  assert.equal(fake.judge.calls.length, 0);
  assert.equal(readFileSync(actionFile(dir), 'utf8'), before);
});

test('a post-admission picker remains flagged after the app returns', async () => {
  const fake = app();
  let captures = 0;
  const capture = fake.deps.captureScreen;
  fake.deps.captureScreen = async (options) => ({
    ...(await capture(options)),
    front: captures++ === 0 ? 'picker' : 'app',
  });
  const result = await runPlan(blocks(literal), fake.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.publicationInterrupted, true);
  assert.ok(captures > 1);
});
