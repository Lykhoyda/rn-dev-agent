import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findElement } from '../dist/tools/cross-platform-verify.js';

const NODES = [
  { ref: '@1', label: 'Submit Button', identifier: 'submit-btn', type: 'Button' },
  { ref: '@2', label: 'Username Input', identifier: 'username-input', type: 'TextField' },
  { ref: '@3', label: 'Welcome to the app', identifier: undefined, type: 'StaticText' },
  { ref: '@4', label: undefined, identifier: 'hidden-view', type: 'View' },
];

test('findElement by testID (exact match, case-insensitive)', () => {
  assert.equal(findElement(NODES, 'submit-btn', 'testID'), true);
  assert.equal(findElement(NODES, 'Submit-Btn', 'testID'), true);
  assert.equal(findElement(NODES, 'submit', 'testID'), false);
  assert.equal(findElement(NODES, 'nonexistent', 'testID'), false);
});

test('findElement by label (substring match, case-insensitive)', () => {
  assert.equal(findElement(NODES, 'Submit', 'label'), true);
  assert.equal(findElement(NODES, 'welcome', 'label'), true);
  assert.equal(findElement(NODES, 'Username', 'label'), true);
  assert.equal(findElement(NODES, 'nonexistent', 'label'), false);
});

test('findElement by label does not match nodes without label', () => {
  assert.equal(findElement(NODES, 'hidden-view', 'label'), false);
});

test('findElement with matchBy=any tries both testID and label', () => {
  assert.equal(findElement(NODES, 'submit-btn', 'any'), true);
  assert.equal(findElement(NODES, 'Submit', 'any'), true);
  assert.equal(findElement(NODES, 'Welcome', 'any'), true);
  assert.equal(findElement(NODES, 'hidden-view', 'any'), true);
  assert.equal(findElement(NODES, 'nonexistent', 'any'), false);
});

test('findElement on empty nodes returns false', () => {
  assert.equal(findElement([], 'anything', 'any'), false);
  assert.equal(findElement([], 'anything', 'testID'), false);
  assert.equal(findElement([], 'anything', 'label'), false);
});
