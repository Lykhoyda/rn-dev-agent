import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdbInputTextArgv, splitChunkAroundPercentS, findInputForPressable } from '../../dist/tools/device-interact.js';

// ── buildAdbInputTextArgv ──────────────────────────────────────────────

test('buildAdbInputTextArgv wraps chunk in single-quoted shell literal', () => {
  assert.deepEqual(buildAdbInputTextArgv('hello'), ['shell', 'input', 'text', "'hello'"]);
});

test('buildAdbInputTextArgv replaces spaces with %s inside the quoted literal', () => {
  assert.deepEqual(
    buildAdbInputTextArgv('hello world'),
    ['shell', 'input', 'text', "'hello%sworld'"],
  );
  assert.deepEqual(
    buildAdbInputTextArgv('a b c d'),
    ['shell', 'input', 'text', "'a%sb%sc%sd'"],
  );
});

test("buildAdbInputTextArgv escapes embedded single quotes via POSIX '\\'' dance", () => {
  assert.deepEqual(
    buildAdbInputTextArgv("it's"),
    ['shell', 'input', 'text', "'it'\\''s'"],
  );
  assert.deepEqual(
    buildAdbInputTextArgv("a'b'c"),
    ['shell', 'input', 'text', "'a'\\''b'\\''c'"],
  );
});

test('buildAdbInputTextArgv keeps shell metacharacters inside quotes (no escape needed)', () => {
  assert.deepEqual(
    buildAdbInputTextArgv('a$b`c\\d'),
    ['shell', 'input', 'text', "'a$b`c\\d'"],
  );
  assert.deepEqual(
    buildAdbInputTextArgv('a|b&c;d'),
    ['shell', 'input', 'text', "'a|b&c;d'"],
  );
  assert.deepEqual(
    buildAdbInputTextArgv('a<b>c*d?e[f]'),
    ['shell', 'input', 'text', "'a<b>c*d?e[f]'"],
  );
});

test('buildAdbInputTextArgv handles empty string', () => {
  assert.deepEqual(buildAdbInputTextArgv(''), ['shell', 'input', 'text', "''"]);
});

test('buildAdbInputTextArgv returns a fresh argv array on each call', () => {
  const a = buildAdbInputTextArgv('x');
  const b = buildAdbInputTextArgv('x');
  assert.notEqual(a, b);
  a.push('mutated');
  assert.equal(b.length, 4);
});

// ── splitChunkAroundPercentS (B97) ─────────────────────────────────────

test('splitChunkAroundPercentS returns chunk as-is when no %s present', () => {
  assert.deepEqual(splitChunkAroundPercentS('hello'), ['hello']);
  assert.deepEqual(splitChunkAroundPercentS('a%b'), ['a%b']);
  assert.deepEqual(splitChunkAroundPercentS('a%Sb'), ['a%Sb']);
  assert.deepEqual(splitChunkAroundPercentS(''), ['']);
});

test('splitChunkAroundPercentS splits single %s into [before, "%", "s"+after]', () => {
  assert.deepEqual(splitChunkAroundPercentS('a%sb'), ['a', '%', 'sb']);
});

test('splitChunkAroundPercentS handles %s at start', () => {
  assert.deepEqual(splitChunkAroundPercentS('%sb'), ['%', 'sb']);
});

test('splitChunkAroundPercentS handles %s at end', () => {
  assert.deepEqual(splitChunkAroundPercentS('a%s'), ['a', '%', 's']);
});

test('splitChunkAroundPercentS handles bare %s', () => {
  assert.deepEqual(splitChunkAroundPercentS('%s'), ['%', 's']);
});

test('splitChunkAroundPercentS handles two consecutive %s', () => {
  assert.deepEqual(splitChunkAroundPercentS('a%s%sb'), ['a', '%', 's', '%', 'sb']);
});

test('splitChunkAroundPercentS handles three %s in mixed text', () => {
  assert.deepEqual(
    splitChunkAroundPercentS('x%sy%sz%sw'),
    ['x', '%', 'sy', '%', 'sz', '%', 'sw'],
  );
});

test('splitChunkAroundPercentS preserves spaces (not yet encoded)', () => {
  assert.deepEqual(splitChunkAroundPercentS('a %s b'), ['a ', '%', 's b']);
});

test('splitChunkAroundPercentS + buildAdbInputTextArgv produce correct argv sequence', () => {
  const segments = splitChunkAroundPercentS('hello %s world');
  const argvs = segments.map(s => buildAdbInputTextArgv(s));
  assert.deepEqual(argvs, [
    ['shell', 'input', 'text', "'hello%s'"],
    ['shell', 'input', 'text', "'%'"],
    ['shell', 'input', 'text', "'s%sworld'"],
  ]);
});

// ── B122: findInputForPressable (Pressable→TextInput resolution) ──────

const PRESSABLE_NODES = [
  { ref: 'e10', identifier: 'email-pressable', type: 'Other' },
  { ref: 'e11', identifier: 'email', type: 'TextField' },
  { ref: 'e12', identifier: 'email-label', type: 'StaticText' },
  { ref: 'e20', identifier: 'password-pressable', type: 'Other' },
  { ref: 'e21', identifier: 'password', type: 'SecureTextField' },
  { ref: 'e30', identifier: 'plain-input', type: 'TextField' },
];

test('findInputForPressable resolves -pressable ref to inner TextField', () => {
  assert.equal(findInputForPressable(PRESSABLE_NODES, '@e10'), '@e11');
  assert.equal(findInputForPressable(PRESSABLE_NODES, 'e10'), '@e11');
});

test('findInputForPressable resolves -pressable ref to inner SecureTextField', () => {
  assert.equal(findInputForPressable(PRESSABLE_NODES, '@e20'), '@e21');
});

test('findInputForPressable supports Android EditText', () => {
  const nodes = [
    { ref: 'a1', identifier: 'username-pressable', type: 'View' },
    { ref: 'a2', identifier: 'username', type: 'EditText' },
  ];
  assert.equal(findInputForPressable(nodes, '@a1'), '@a2');
});

test('findInputForPressable supports TextView', () => {
  const nodes = [
    { ref: 'b1', identifier: 'notes-pressable', type: 'Other' },
    { ref: 'b2', identifier: 'notes', type: 'TextView' },
  ];
  assert.equal(findInputForPressable(nodes, '@b1'), '@b2');
});

test('findInputForPressable returns null when ref does not end in -pressable', () => {
  // Plain input — no wrapping Pressable to resolve.
  assert.equal(findInputForPressable(PRESSABLE_NODES, '@e30'), null);
});

test('findInputForPressable returns null when no inner TextInput sibling exists', () => {
  const nodes = [
    { ref: 'c1', identifier: 'orphan-pressable', type: 'Other' },
    // No matching identifier='orphan' anywhere
  ];
  assert.equal(findInputForPressable(nodes, '@c1'), null);
});

test('findInputForPressable returns null when sibling has matching id but wrong type', () => {
  // Label, not a TextField — should not resolve to it.
  const nodes = [
    { ref: 'd1', identifier: 'addr-pressable', type: 'Other' },
    { ref: 'd2', identifier: 'addr', type: 'StaticText' },
  ];
  assert.equal(findInputForPressable(nodes, '@d1'), null);
});

test('findInputForPressable returns null for null/empty input', () => {
  assert.equal(findInputForPressable(null, '@e10'), null);
  assert.equal(findInputForPressable([], '@e10'), null);
});

test('findInputForPressable returns null when ref does not exist in nodes', () => {
  assert.equal(findInputForPressable(PRESSABLE_NODES, '@nonexistent'), null);
});

test('findInputForPressable handles -pressable suffix on identifier with hyphens in base', () => {
  const nodes = [
    { ref: 'e1', identifier: 'shipping-address-pressable', type: 'Other' },
    { ref: 'e2', identifier: 'shipping-address', type: 'TextField' },
  ];
  assert.equal(findInputForPressable(nodes, '@e1'), '@e2');
});

test('findInputForPressable rejects bare -pressable identifier (no base)', () => {
  // Edge case: identifier === '-pressable' would have empty baseId.
  const nodes = [
    { ref: 'e1', identifier: '-pressable', type: 'Other' },
    { ref: 'e2', identifier: '', type: 'TextField' },
  ];
  assert.equal(findInputForPressable(nodes, '@e1'), null);
});
