// GH #581: exact fill-target binding — direct refs/testIDs, unique
// `${base}-pressable` wrapper mapping, duplicate rejection, and
// generation-safe positional rebinding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindExactFillTarget, isRecognizedInputType } from '../../dist/tools/device-interact.js';

const NODES = [
  {
    ref: '@e10',
    identifier: 'email-pressable',
    type: 'Other',
    rect: { x: 0, y: 0, width: 10, height: 10 },
  },
  {
    ref: '@e11',
    identifier: 'email',
    type: 'TextField',
    rect: { x: 0, y: 10, width: 10, height: 10 },
  },
  {
    ref: '@e12',
    identifier: 'email-label',
    type: 'StaticText',
    rect: { x: 0, y: 20, width: 10, height: 10 },
  },
  {
    ref: '@e20',
    identifier: 'password-pressable',
    type: 'Other',
    rect: { x: 0, y: 30, width: 10, height: 10 },
  },
  {
    ref: '@e21',
    identifier: 'password',
    type: 'SecureTextField',
    rect: { x: 0, y: 40, width: 10, height: 10 },
  },
  {
    ref: '@e30',
    identifier: 'plain-input',
    type: 'TextField',
    rect: { x: 0, y: 50, width: 10, height: 10 },
  },
  {
    ref: '@e40',
    identifier: 'notes',
    type: 'android.widget.EditText',
    secure: false,
    rect: { x: 0, y: 60, width: 10, height: 10 },
  },
];

test('gh-581 bind: wrapper maps to its unique inner input, focus stays on the wrapper', () => {
  const out = bindExactFillTarget(NODES as never, '@e10');
  assert.ok(out.ok, (out as { detail?: string }).detail);
  assert.deepEqual((out as { binding: unknown }).binding, {
    inputRef: '@e11',
    inputTestId: 'email',
    focusRef: '@e10',
    wrapper: true,
    secure: false,
  });
});

test('gh-581 bind: secure inner input is flagged', () => {
  const out = bindExactFillTarget(NODES as never, '@e20');
  assert.ok(out.ok);
  assert.equal((out as { binding: { secure: boolean } }).binding.secure, true);
});

test('gh-581 bind: direct input ref and bare testID both bind', () => {
  const byRef = bindExactFillTarget(NODES as never, '@e30');
  assert.ok(byRef.ok);
  assert.equal((byRef as { binding: { wrapper: boolean } }).binding.wrapper, false);
  const byTestId = bindExactFillTarget(NODES as never, 'plain-input');
  assert.ok(byTestId.ok);
  assert.equal((byTestId as { binding: { inputRef: string } }).binding.inputRef, '@e30');
});

test('gh-581 bind: Android fully-qualified EditText is recognized; bare EditText is not', () => {
  const out = bindExactFillTarget(NODES as never, 'notes');
  assert.ok(out.ok);
  assert.ok(isRecognizedInputType('android.widget.EditText'));
  assert.ok(isRecognizedInputType('android.widget.AutoCompleteTextView'));
  assert.ok(isRecognizedInputType('SearchField'));
  assert.ok(!isRecognizedInputType('EditText'));
  assert.ok(!isRecognizedInputType('Other'));
});

test('gh-581 bind: duplicate wrapper mapping is rejected', () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e50',
      identifier: 'email',
      type: 'TextField',
      rect: { x: 0, y: 70, width: 10, height: 10 },
    },
  ];
  const out = bindExactFillTarget(nodes as never, '@e10');
  assert.ok(!out.ok);
  assert.match((out as { detail: string }).detail, /ambiguous/);
});

test('gh-581 bind: duplicate direct testID is rejected', () => {
  const nodes = [
    ...NODES,
    {
      ref: '@e50',
      identifier: 'plain-input',
      type: 'TextField',
      rect: { x: 0, y: 70, width: 10, height: 10 },
    },
  ];
  const out = bindExactFillTarget(nodes as never, 'plain-input');
  assert.ok(!out.ok);
  assert.match((out as { detail: string }).detail, /duplicate identifiers/);
});

test('gh-581 bind: wrapper with no inner input is rejected (no first-match fallback)', () => {
  const nodes = [
    {
      ref: '@e1',
      identifier: 'orphan-pressable',
      type: 'Other',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
  ];
  const out = bindExactFillTarget(nodes as never, '@e1');
  assert.ok(!out.ok);
  assert.match((out as { detail: string }).detail, /no recognized input/);
});

test('gh-581 bind: wrapper whose sibling matches by id but not type is rejected', () => {
  const nodes = [
    {
      ref: '@d1',
      identifier: 'addr-pressable',
      type: 'Other',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      ref: '@d2',
      identifier: 'addr',
      type: 'StaticText',
      rect: { x: 0, y: 10, width: 10, height: 10 },
    },
  ];
  const out = bindExactFillTarget(nodes as never, '@d1');
  assert.ok(!out.ok);
});

test('gh-581 bind: non-input, non-wrapper elements are rejected', () => {
  const out = bindExactFillTarget(NODES as never, '@e12');
  assert.ok(!out.ok);
  assert.match((out as { detail: string }).detail, /not a recognized text input/);
});

test('gh-581 bind: a positional ref absent from the snapshot is rejected', () => {
  const out = bindExactFillTarget(NODES as never, '@e99');
  assert.ok(!out.ok);
});

test('gh-581 bind: a bare eN-shaped string binds as a positional ref', () => {
  const out = bindExactFillTarget(NODES as never, 'e30');
  assert.ok(out.ok);
  assert.equal((out as { binding: { inputRef: string } }).binding.inputRef, '@e30');
});

test('gh-581 bind: an unchanged positional slot still requires unique identity', () => {
  const duplicated = [
    ...NODES,
    {
      ref: '@e31',
      identifier: 'plain-input',
      type: 'TextField',
      rect: { x: 0, y: 80, width: 10, height: 10 },
    },
  ];
  const signature = {
    type: 'TextField',
    identifier: 'plain-input',
    flatIndex: 5,
    nodeCount: NODES.length,
  };
  const out = bindExactFillTarget(duplicated as never, '@e30', signature as never);
  assert.ok(!out.ok);
  assert.match((out as { detail: string }).detail, /matches multiple elements/);
});

test('gh-581 bind: positional ref with a shifted identity rebinds by signature or rejects', () => {
  // The signature says @e11 was the email TextField; in the refreshed snapshot
  // e11 now denotes a different element, and the email field moved to e13.
  const shifted = [
    {
      ref: '@e11',
      identifier: 'phone',
      type: 'TextField',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      ref: '@e13',
      identifier: 'email',
      type: 'TextField',
      rect: { x: 0, y: 10, width: 10, height: 10 },
    },
  ];
  const signature = { type: 'TextField', identifier: 'email', flatIndex: 1, nodeCount: 7 };
  const rebound = bindExactFillTarget(shifted as never, '@e11', signature as never);
  assert.ok(rebound.ok, (rebound as { detail?: string }).detail);
  assert.equal((rebound as { binding: { inputRef: string } }).binding.inputRef, '@e13');

  const duplicated = [
    ...shifted,
    {
      ref: '@e14',
      identifier: 'email',
      type: 'TextField',
      rect: { x: 0, y: 20, width: 10, height: 10 },
    },
  ];
  const ambiguous = bindExactFillTarget(duplicated as never, '@e11', signature as never);
  assert.ok(!ambiguous.ok, 'ambiguous identity rebinding must reject');

  const gone = bindExactFillTarget([shifted[0]] as never, '@e11', signature as never);
  assert.ok(!gone.ok, 'absent identity must reject, never serve the recycled position');

  // Same node count as the signature: the shared refreshRef flat-index
  // tie-breaker must NOT license mutation — duplicates stay ambiguous.
  const sameCount = [
    {
      ref: '@e11',
      identifier: 'phone',
      type: 'TextField',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    },
    {
      ref: '@e12',
      identifier: 'email',
      type: 'TextField',
      rect: { x: 0, y: 10, width: 10, height: 10 },
    },
    {
      ref: '@e13',
      identifier: 'email',
      type: 'TextField',
      rect: { x: 0, y: 20, width: 10, height: 10 },
    },
  ];
  const sameCountSig = { type: 'TextField', identifier: 'email', flatIndex: 1, nodeCount: 3 };
  const tieBroken = bindExactFillTarget(sameCount as never, '@e11', sameCountSig as never);
  assert.ok(!tieBroken.ok, 'flat-index tie-breaking must never bind a fill target');
});
