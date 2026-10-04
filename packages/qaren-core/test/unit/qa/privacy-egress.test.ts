import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlan } from '../../../dist/qa/plan.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { capturePrivateScreen, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';
import { element, scriptedJudge, walker } from './judgment-fixtures.ts';

const TYPED = 'hunter-canary-77';
const SHORT = '47';
const OTP = '4815';
const SECURE = 's3cure-pin-9';
const PREFILLED = '654321';
const GROUPED = '1234567890';
const ECHOED = 'echo-canary-x';
const LONG = [TYPED, SECURE, PREFILLED, ECHOED, '1234 5678 90'];

const PLAN = `## QA

### Check the account
✓ "${PREFILLED}"

### Open the code screen
1. Tap "qa-start"
✓ "Step 1 of 2"

### Enter the code
1. Fill "qa-password" with "${TYPED}"
2. Tap "qa-otp-verify"
✓ the welcome banner is visible
`;

const text = (ref: string, label: string, extra: Partial<Element> = {}) =>
  element(ref, label, { kind: 'text', ...extra });

function view(elements: Element[]): Screen {
  return {
    front: 'app',
    elements,
    visibleText: elements.filter((e) => e.kind === 'text').map((e) => e.label ?? ''),
    coverage: { native: 'complete', react: 'complete' },
  };
}

// The producer's private facts for the code screen: boxes, a secure pin, a prefilled
// account, a grouped card number, a short value and a label-echoed field.
function codeScreen(after: boolean): Screen {
  const pin = element('@pin', 'PIN', { kind: 'input', testID: 'qa-pin', secure: true });
  const account = element('@account', 'Account', {
    kind: 'input',
    testID: 'qa-account',
    value: PREFILLED,
  });
  const echo = element('@echo', ECHOED, { kind: 'input', testID: 'qa-echo' });
  const card = element('@cardInput', 'Card', { kind: 'input', testID: 'qa-card', value: GROUPED });
  const age = element('@age', 'Age', { kind: 'input', testID: 'qa-age', value: SHORT });
  const password = element('@password', 'Password', {
    kind: 'input',
    testID: 'qa-password',
    secure: true,
  });
  const s = view([
    text('@heading', after ? 'Almost done' : 'Enter the code'),
    text('@step', 'Step 1 of 2'),
    ...OTP.split('').map((digit, i) => text(`@box${i}`, digit)),
    text('@card', '1234 5678 90'),
    text('@shown', `Account ${PREFILLED}`),
    text('@echoText', ECHOED),
    text('@ageText', SHORT),
    pin,
    account,
    card,
    echo,
    age,
    password,
    element('@verify', 'Verify', { testID: 'qa-otp-verify' }),
  ]);
  capturePrivateScreen(s, [
    { values: [OTP], secure: true, elements: [], associationUnique: true },
    { values: [SECURE], secure: true, testID: 'qa-pin', elements: [pin], associationUnique: true },
    { values: [PREFILLED], secure: false, elements: [account], associationUnique: true },
    { values: [GROUPED], secure: false, elements: [card], associationUnique: true },
    { values: [SHORT], secure: false, elements: [age], associationUnique: true },
    {
      values: [ECHOED],
      secure: false,
      elements: [echo],
      associationUnique: true,
      labelMayBeValue: true,
    },
  ]);
  return s;
}

const home = (): Screen =>
  view([
    text('@account', `Your account ${PREFILLED}`),
    text('@accountValue', PREFILLED),
    element('@start', 'Start', { testID: 'qa-start' }),
  ]);

const strings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : [];

const TOKEN = /[\p{L}\p{M}\p{N}_.@-]+/gu;

function assertAbsent(sink: string, value: unknown): void {
  const all = strings(value);
  for (const canary of LONG)
    for (const s of all) assert.ok(!s.includes(canary), `${sink} carries ${canary}: ${s}`);
  for (const s of all) {
    const tokens = s.match(TOKEN) ?? [];
    assert.ok(!tokens.includes(SHORT), `${sink} carries the short value: ${s}`);
    assert.ok(!tokens.includes(GROUPED), `${sink} carries the ungrouped value: ${s}`);
    assert.ok(!/4\W{1,4}8\W{1,4}1\W{1,4}5/.test(s), `${sink} carries the code boxes: ${s}`);
  }
}

async function walk() {
  const blocks = parsePlan(PLAN).blocks;
  assert.ok(blocks);
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.01 }])),
  );
  let state = 0;
  const f = walker([], judge);
  const streamed: LedgerRow[] = [];
  f.deps.row = (row) => streamed.push(structuredClone(row));
  f.deps.captureScreen = async () => (state === 0 ? home() : codeScreen(state === 2));
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    state = ref === '@start' ? 1 : ref === '@verify' ? 2 : state;
    return { ok: true, proven: true };
  };
  const appRoot = mkdtempSync(join(tmpdir(), 'qaren-egress-'));
  const ledger = await runPlan(blocks, f.deps, [], {
    appRoot,
    platform: 'ios',
    appId: 'com.example',
  });
  const dir = join(appRoot, '.qaren', 'actions');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return {
    ledger,
    streamed,
    judge,
    files,
    yaml: files.map((file) => readFileSync(join(dir, file), 'utf8')),
  };
}

test('every canary is absent at every core egress boundary', async () => {
  const { ledger, streamed, judge, files, yaml } = await walk();
  assert.equal(ledger.verdict, 'FAIL');
  assert.ok(judge.requests.length > 0, 'the phrase check reached the model');
  assertAbsent('streamed rows', streamed);
  assertAbsent('ledger', ledger);
  assertAbsent('model requests', judge.requests);
  assertAbsent('block files', [files, yaml]);
});

test('streamed rows carry only value-free fields', async () => {
  const { streamed } = await walk();
  assert.ok(streamed.length > 0);
  for (const row of streamed) {
    assert.equal(row.text, '', JSON.stringify(row));
    assert.equal(row.reason, undefined, JSON.stringify(row));
    assert.equal(row.selector, undefined, JSON.stringify(row));
    assert.equal(row.block, '', JSON.stringify(row));
  }
});

test('the projected ledger stays readable and ordinary blocks are saved', async () => {
  const { ledger, files, yaml } = await walk();
  const texts = ledger.steps.map((row) => row.text);
  assert.ok(texts.includes('✓ "Step 1 of 2"'), JSON.stringify(texts));
  assert.ok(texts.includes('1. Tap "qa-start"'), JSON.stringify(texts));
  assert.match(ledger.failure?.seen ?? '', /Step 1 of 2/);
  assert.match(ledger.failure?.seen ?? '', /Almost done/);
  assert.match(ledger.failure?.seen ?? '', /\bthe\b/);
  assert.ok(
    files.some((file) => file.startsWith('open-the-code-screen')),
    JSON.stringify(files),
  );
  assert.ok(yaml.some((y) => y.includes('qa-start') && y.includes('Step 1 of 2')));
  assert.equal(
    ledger.blocks.find((block) => block.key === 'check-the-account')?.saved,
    false,
    JSON.stringify(ledger.blocks),
  );
});

test('a future short fill protects an earlier failure screen before typing', async () => {
  const blocks = parsePlan(
    '## QA\n\n### Fail early\n✓ "Missing"\n\n### Fill later\n1. Fill "qa-input" with "47"\n',
  ).blocks;
  assert.ok(blocks);
  const f = walker(
    [view([text('@shown', '47')])],
    scriptedJudge(() => ({})),
  );
  const ledger = await runPlan(blocks, f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.failure?.seen?.includes('47'), false);
  assert.match(
    ledger.failure?.seen ?? '',
    /Missing.*historical context, previously on screen: •••/,
  );
  assert.equal(f.actions.length, 0);
});

test('a future fill withholds an earlier passing block even if it never types', async () => {
  const blocks = parsePlan(
    `## QA\n\n### Confirm\n✓ "${TYPED}"\n\n### Fill later\n1. Fill "missing-input" with "${TYPED}"\n`,
  ).blocks;
  assert.ok(blocks);
  const f = walker(
    [view([text('@shown', TYPED)])],
    scriptedJudge(() => ({})),
  );
  const appRoot = mkdtempSync(join(tmpdir(), 'qaren-preclassified-'));
  const ledger = await runPlan(blocks, f.deps, [], {
    appRoot,
    platform: 'ios',
    appId: 'com.example',
  });
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.blocks[0].saved, false);
  assert.equal(JSON.stringify(ledger).includes(TYPED), false);
  assert.deepEqual(ledger.blocksWritten, []);
});

for (const code of ['4815', '4415']) {
  test(`failure diagnostics project original boxes ${code} before masking an adjacent input`, async () => {
    const input = element('@name', 'Name', { kind: 'input', value: 'Ada' });
    const observed = view([
      text('@heading', 'Enter code'),
      ...[...code].map((digit, i) => text(`@box${i}`, digit)),
      input,
      text('@step', 'Step 1 of 2'),
    ]);
    observed.visibleText = [
      'Enter code',
      ...[...code].filter((digit, i) => i === 0 || digit !== code[i - 1]),
      'Name: Ada',
      'Step 1 of 2',
    ];
    capturePrivateScreen(observed, [
      { values: [code], secure: true, elements: [], associationUnique: true },
    ]);
    const blocks = parsePlan(
      '## QA\n\n### Fail early\n✓ "Missing"\n\n### Fill later\n1. Fill "qa-name" with "Ada"\n',
    ).blocks;
    assert.ok(blocks);
    const f = walker(
      [observed],
      scriptedJudge(() => ({})),
    );
    const ledger = await runPlan(blocks, f.deps);
    const seen = ledger.failure?.seen ?? '';
    assert.match(seen, /Enter code \| ••• \| ••• \| ••• \| ••• \| Name: ••• \| Step 1 of 2/);
    assert.equal(seen.includes('Ada'), false);
    for (const digit of new Set(code))
      assert.equal(
        (seen.match(/\b\d+\b/g) ?? []).filter(
          (value) => value === digit && !['1', '2'].includes(value),
        ).length,
        0,
      );
    assert.equal(input.value, 'Ada');
    assert.deepEqual(
      observed.elements.slice(1, 5).map((item) => item.label),
      [...code],
    );
    const privacy = new ObservedPrivacy();
    privacy.observe(observed);
    privacy.observe(view([text('@done', 'Done')]));
    assert.equal(privacy.redact([...code].join(' | ')), '••• | ••• | ••• | •••');
    assert.equal(privacy.redact('4 | 8'), '4 | 8');
  });
}
