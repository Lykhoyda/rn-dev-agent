import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findElement, discoverTestIDs } from '../dist/tools/cross-platform-verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── findElement ────────────────────────────────────────────────────────

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

// ── discoverTestIDs ────────────────────────────────────────────────────

test('discoverTestIDs extracts testIDs from .tsx fixture', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'scan-test');
  const ids = discoverTestIDs(fixtureDir);
  assert.ok(ids.includes('example-screen'), 'should find testID="example-screen"');
  assert.ok(ids.includes('title-text'), 'should find testID="title-text"');
  assert.ok(ids.includes('submit-btn'), "should find testID='submit-btn'");
  assert.ok(ids.includes('dynamic-view'), 'should find testID={"dynamic-view"}');
  assert.equal(ids.length, 4);
});

test('discoverTestIDs returns sorted results', () => {
  const fixtureDir = join(__dirname, 'fixtures', 'scan-test');
  const ids = discoverTestIDs(fixtureDir);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted);
});

test('discoverTestIDs returns empty array for nonexistent dir', () => {
  const ids = discoverTestIDs('/nonexistent/path/that/does/not/exist');
  assert.deepEqual(ids, []);
});

test('discoverTestIDs skips node_modules and dotfiles', () => {
  const ids = discoverTestIDs(join(__dirname, '..'));
  assert.ok(!ids.some(id => id.includes('node_modules')));
});
