// D1206 Tier 2 Sprint D / Phase 129 — repair-engine pure helper tests.
// Handler integration test (with disk + agent-device) deferred to live
// smoke when first exercised by /run-action's failure path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  levenshtein,
  similarityScore,
  findBestMatch,
  DEFAULT_REPAIR_THRESHOLD,
  extractAllTestIDs,
  extractIdSelectors,
  replaceIdSelector,
  attemptRepair,
  applyRepair,
} from '../../dist/domain/repair-engine.js';
import { freshRuntimeState } from '../../dist/domain/reusable-action.js';

// ─────────────────────────────────────────────────────────────────────────────
// levenshtein
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 levenshtein: identity', () => {
  assert.equal(levenshtein('hello', 'hello'), 0);
  assert.equal(levenshtein('', ''), 0);
});

test('Phase129 levenshtein: empty strings', () => {
  assert.equal(levenshtein('', 'hello'), 5);
  assert.equal(levenshtein('hello', ''), 5);
});

test('Phase129 levenshtein: one substitution', () => {
  assert.equal(levenshtein('cat', 'cot'), 1);
});

test('Phase129 levenshtein: insert + substitute', () => {
  // kitten → sitting: k→s (sub), e→i (sub), insert g = 3
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('Phase129 levenshtein: realistic testID renames', () => {
  // common: appending a suffix
  assert.equal(levenshtein('fab-create-task', 'fab-create-task-btn'), 4);
  // common: prefix change
  assert.equal(levenshtein('btn-submit', 'submit-btn'), 8);
});

// ─────────────────────────────────────────────────────────────────────────────
// similarityScore
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 similarityScore: identity = 1.0', () => {
  assert.equal(similarityScore('hello', 'hello'), 1);
});

test('Phase129 similarityScore: empty pair = 1.0', () => {
  assert.equal(similarityScore('', ''), 1);
});

test('Phase129 similarityScore: single edit on long string is high', () => {
  const s = similarityScore('fab-create-task', 'fab-create-tasks');
  assert.ok(s > 0.9, `expected >0.9, got ${s}`);
});

test('Phase129 similarityScore: total mismatch is low', () => {
  const s = similarityScore('foo', 'bar');
  assert.ok(s < 0.5, `expected <0.5, got ${s}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// findBestMatch
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 findBestMatch: returns null when no candidate clears threshold', () => {
  const out = findBestMatch('fab-create-task', ['totally-different', 'menu-item-1'], 0.6);
  assert.equal(out, null);
});

test('Phase129 findBestMatch: picks the highest-scoring candidate', () => {
  const out = findBestMatch('fab-create-task', ['fab-create-task-btn', 'fab-create-tasks', 'create-task-fab'], 0.6);
  assert.ok(out);
  // fab-create-tasks (single insert) scores highest
  assert.equal(out.match, 'fab-create-tasks');
  assert.ok(out.score >= 0.9);
});

test('Phase129 findBestMatch: ties broken by candidate order (first match wins)', () => {
  // Two equally-distant candidates → first one in the list wins.
  const out = findBestMatch('cat', ['bat', 'rat'], 0.5);
  assert.ok(out);
  assert.equal(out.match, 'bat');
});

test('Phase129 findBestMatch: empty candidates returns null', () => {
  assert.equal(findBestMatch('foo', [], 0.6), null);
});

test('Phase129 findBestMatch: respects custom threshold', () => {
  // 'fab-x' vs 'fab-y' = 1 edit / 5 chars = 0.8 similarity
  const candidate = ['fab-y'];
  // Threshold 0.5: passes
  assert.ok(findBestMatch('fab-x', candidate, 0.5));
  // Threshold 0.9: fails
  assert.equal(findBestMatch('fab-x', candidate, 0.9), null);
});

test('Phase129 DEFAULT_REPAIR_THRESHOLD is 0.6', () => {
  assert.equal(DEFAULT_REPAIR_THRESHOLD, 0.6);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractAllTestIDs
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 extractAllTestIDs: daemon nodes shape', () => {
  const env = JSON.stringify({
    ok: true,
    data: {
      nodes: [
        { ref: 'e1', identifier: 'foo' },
        { ref: 'e2', identifier: 'bar' },
        { ref: 'e3' }, // no identifier
      ],
    },
  });
  const out = extractAllTestIDs(env);
  assert.deepEqual(out.sort(), ['bar', 'foo']);
});

test('Phase129 extractAllTestIDs: fast-runner tree shape (recursive)', () => {
  const env = JSON.stringify({
    ok: true,
    data: {
      tree: {
        ref: 'e1',
        identifier: 'app',
        children: [
          { ref: 'e2', identifier: 'screen', children: [
            { ref: 'e3', identifier: 'fab' },
            { ref: 'e4', identifier: 'list' },
          ]},
        ],
      },
    },
  });
  const out = extractAllTestIDs(env);
  assert.deepEqual(out.sort(), ['app', 'fab', 'list', 'screen']);
});

test('Phase129 extractAllTestIDs: ok=false returns []', () => {
  assert.deepEqual(extractAllTestIDs(JSON.stringify({ ok: false })), []);
});

test('Phase129 extractAllTestIDs: malformed returns []', () => {
  assert.deepEqual(extractAllTestIDs('not-json'), []);
});

test('Phase129 extractAllTestIDs: dedupe across tree nodes', () => {
  const env = JSON.stringify({
    ok: true,
    data: {
      tree: {
        identifier: 'foo', ref: 'e1',
        children: [{ identifier: 'foo', ref: 'e2' }],
      },
    },
  });
  assert.deepEqual(extractAllTestIDs(env), ['foo']);
});

// ─────────────────────────────────────────────────────────────────────────────
// extractIdSelectors
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_BODY = `- launchApp
- tapOn:
    id: "tab-tasks"
- waitForAnimationToEnd
- tapOn:
    id: "fab-create-task"
- tapOn:
    id: 'wizard-title-input'
- inputText: \${TITLE}
- tapOn:
    id: "wizard-next-btn"`;

test('Phase129 extractIdSelectors: returns all id: selectors in order', () => {
  const out = extractIdSelectors(SAMPLE_BODY);
  assert.deepEqual(out, ['tab-tasks', 'fab-create-task', 'wizard-title-input', 'wizard-next-btn']);
});

test('Phase129 extractIdSelectors: empty body returns []', () => {
  assert.deepEqual(extractIdSelectors(''), []);
});

test('Phase129 extractIdSelectors: body without id: returns []', () => {
  assert.deepEqual(extractIdSelectors('- launchApp\n- waitForAnimationToEnd'), []);
});

// Issue #102 A2 — strip trailing inline comments on bare-form selectors.
test('Issue #102 A2: extractIdSelectors strips trailing inline comments on bare-form selectors', () => {
  const out = extractIdSelectors([
    '- tapOn:',
    '    id: foo-bar  # this is a comment',
  ].join('\n'));
  assert.deepEqual(out, ['foo-bar']);
});

test('Issue #102 A2: quoted forms remain unaffected by the comment-strip', () => {
  const out = extractIdSelectors([
    '- tapOn:',
    '    id: "with-quotes"',
  ].join('\n'));
  assert.deepEqual(out, ['with-quotes']);
});

// ─────────────────────────────────────────────────────────────────────────────
// replaceIdSelector
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 replaceIdSelector: surgical replacement preserves quoting', () => {
  const { body: out, replacements } = replaceIdSelector(SAMPLE_BODY, 'fab-create-task', 'fab-create-task-btn');
  assert.equal(replacements, 1);
  assert.match(out, /id: "fab-create-task-btn"/);
  // Other selectors untouched
  assert.match(out, /id: "tab-tasks"/);
  assert.match(out, /id: 'wizard-title-input'/);
});

test('Phase129 replaceIdSelector: preserves single-quote style', () => {
  const { body: out } = replaceIdSelector(SAMPLE_BODY, 'wizard-title-input', 'wizard-title-input-2');
  assert.match(out, /id: 'wizard-title-input-2'/);
});

test('Phase129 replaceIdSelector: returns 0 replacements when not present', () => {
  const { body: out, replacements } = replaceIdSelector(SAMPLE_BODY, 'never-present', 'replacement');
  assert.equal(replacements, 0);
  assert.equal(out, SAMPLE_BODY);
});

test('Phase129 replaceIdSelector: replaces all occurrences (multi-tap on same testID)', () => {
  const body = `- tapOn:\n    id: "btn"\n- tapOn:\n    id: "btn"`;
  const { body: out, replacements } = replaceIdSelector(body, 'btn', 'newbtn');
  assert.equal(replacements, 2);
  const matches = out.match(/id: "newbtn"/g);
  assert.equal(matches.length, 2);
});

test('Phase129 replaceIdSelector: only matches `id:` lines, not embedded `id` in inputText', () => {
  // Important: the body might have `inputText: "id: foo"` literal that
  // shouldn't be touched.
  const body = `- tapOn:\n    id: "real-btn"\n- inputText: "id: real-btn"`;
  const { body: out, replacements } = replaceIdSelector(body, 'real-btn', 'new-btn');
  assert.equal(replacements, 1);  // ONLY the actual id: line
  assert.match(out, /id: "new-btn"/);
  assert.match(out, /inputText: "id: real-btn"/);  // embedded literal preserved
});

test('Phase129 replaceIdSelector: handles regex special chars in oldId', () => {
  const body = `- tapOn:\n    id: "btn.with.dots"`;
  const { body: out, replacements } = replaceIdSelector(body, 'btn.with.dots', 'btn-without-dots');
  assert.equal(replacements, 1);
  assert.match(out, /id: "btn-without-dots"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// attemptRepair (orchestrator)
// ─────────────────────────────────────────────────────────────────────────────

const FROZEN_DATE = '2026-05-03T12:00:00.000Z';
const fixedNow = () => new Date(FROZEN_DATE);

function makeAction() {
  return {
    metadata: { id: 'wizard-create-task', intent: 'Create a task', status: 'active' },
    body: SAMPLE_BODY,
    filePath: '/fake/path.yaml',
    state: freshRuntimeState(fixedNow, 0),
  };
}

test('Phase129 attemptRepair: patched when failed selector present + good candidate', () => {
  const result = attemptRepair(
    makeAction(),
    'fab-create-task',
    ['tab-tasks', 'fab-create-task-btn', 'wizard-title-input'],
  );
  assert.equal(result.kind, 'patched');
  if (result.kind === 'patched') {
    assert.equal(result.oldSelector, 'fab-create-task');
    assert.equal(result.newSelector, 'fab-create-task-btn');
    assert.equal(result.replacements, 1);
    assert.match(result.newBody, /id: "fab-create-task-btn"/);
  }
});

test('Phase129 attemptRepair: no-stale-selector when failed selector absent from body', () => {
  const result = attemptRepair(
    makeAction(),
    'never-was-in-this-flow',
    ['some', 'candidates'],
  );
  assert.equal(result.kind, 'no-stale-selector');
});

test('Phase129 attemptRepair: no-match when candidates too distant', () => {
  const result = attemptRepair(
    makeAction(),
    'fab-create-task',
    ['totally-unrelated-thing', 'menu-1', 'submit-btn'],
  );
  assert.equal(result.kind, 'no-match');
  if (result.kind === 'no-match') {
    assert.equal(result.failedSelector, 'fab-create-task');
    assert.ok(result.bestScore !== null);
  }
});

test('Phase129 attemptRepair: no-match with bestScore=null when candidates is empty', () => {
  const result = attemptRepair(makeAction(), 'fab-create-task', []);
  assert.equal(result.kind, 'no-match');
  if (result.kind === 'no-match') assert.equal(result.bestScore, null);
});

test('Phase129 attemptRepair: filters the failed selector itself out of candidates', () => {
  // If the live snapshot still contains the failed selector as a candidate,
  // we should NOT pick it as the "fix" (that would be a no-op patch).
  const result = attemptRepair(
    makeAction(),
    'fab-create-task',
    ['fab-create-task', 'fab-create-task-btn'],
  );
  assert.equal(result.kind, 'patched');
  if (result.kind === 'patched') assert.equal(result.newSelector, 'fab-create-task-btn');
});

test('Phase129 attemptRepair: respects custom threshold', () => {
  // 'btn' vs 'b' = 2 edits / 3 chars = 0.33 similarity
  // threshold 0.6 → no match; threshold 0.3 → match
  const action = {
    metadata: { id: 'x', intent: 'y', status: 'active' },
    body: '- tapOn:\n    id: "btn"',
    filePath: '/fake.yaml',
    state: freshRuntimeState(fixedNow, 0),
  };
  assert.equal(attemptRepair(action, 'btn', ['b'], 0.6).kind, 'no-match');
  assert.equal(attemptRepair(action, 'btn', ['b'], 0.3).kind, 'patched');
});

// ─────────────────────────────────────────────────────────────────────────────
// applyRepair
// ─────────────────────────────────────────────────────────────────────────────

test('Phase129 applyRepair: bumps revision + appends RepairRecord', () => {
  const action = makeAction();
  const result = attemptRepair(
    action,
    'fab-create-task',
    ['fab-create-task-btn'],
  );
  assert.equal(result.kind, 'patched');
  if (result.kind !== 'patched') return;
  const repaired = applyRepair(action, result, fixedNow, 'agent: snapshot showed renamed FAB');
  assert.equal(repaired.state.revision, 2);
  assert.equal(repaired.state.repairHistory.length, 1);
  const rec = repaired.state.repairHistory[0];
  assert.equal(rec.failureCode, 'SELECTOR_NOT_FOUND');
  assert.deepEqual(rec.diff.selector, { from: 'fab-create-task', to: 'fab-create-task-btn' });
  assert.equal(rec.agentReasoning, 'agent: snapshot showed renamed FAB');
  assert.equal(rec.timestamp, FROZEN_DATE);
});

test('Phase129 applyRepair: demotes status active → experimental', () => {
  const action = makeAction(); // status: active
  const result = attemptRepair(action, 'fab-create-task', ['fab-create-task-btn']);
  if (result.kind !== 'patched') throw new Error('expected patched');
  const repaired = applyRepair(action, result, fixedNow);
  assert.equal(repaired.metadata.status, 'experimental');
});

test('Phase129 applyRepair: experimental status stays experimental', () => {
  const action = { ...makeAction(), metadata: { id: 'x', intent: 'y', status: 'experimental' } };
  const result = attemptRepair(action, 'fab-create-task', ['fab-create-task-btn']);
  if (result.kind !== 'patched') throw new Error('expected patched');
  const repaired = applyRepair(action, result, fixedNow);
  assert.equal(repaired.metadata.status, 'experimental');
});

test('Phase129 applyRepair: writes the patched body, not the original', () => {
  const action = makeAction();
  const result = attemptRepair(action, 'fab-create-task', ['fab-create-task-btn']);
  if (result.kind !== 'patched') throw new Error('expected patched');
  const repaired = applyRepair(action, result, fixedNow);
  assert.match(repaired.body, /id: "fab-create-task-btn"/);
  assert.doesNotMatch(repaired.body, /id: "fab-create-task"$/m);
});
