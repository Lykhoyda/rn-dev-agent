// Live-sim speedup (GH #321, quick win #3): getTree({ interactiveOnly: true })
// returns a compact "what can I act on here?" digest — only actionable nodes
// (Pressable/Button/TextInput/Switch/Link + their text) with a minimal shape —
// instead of the full fiber tree with props + hookStates. This is the perception
// PAYLOAD (token) lever, complementary to #2's round-trip lever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

function createSandbox(fiberRoot) {
  const sandbox = {
    globalThis: {},
    Array, Object, JSON, Map, WeakSet, Error, Date, parseInt, parseFloat,
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    String, Number, Boolean, RegExp, Symbol, Set, Promise, setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: fiberRoot }]),
  };
  vm.createContext(sandbox);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  return sandbox;
}

const txt = (s) => ({ tag: 6, memoizedProps: s, child: null, sibling: null });
const el = (name, props, child = null, sibling = null) => ({
  type: { name }, memoizedProps: props || {}, child, sibling,
});

// A screen: a Pressable button, a TextInput, a Switch, and a non-interactive
// View wrapping plain text that must NOT appear as an actionable entry.
function buildScreen() {
  const button = el('Pressable', { onPress: () => {}, testID: 'submit-btn' }, txt('Submit'));
  const input = el('TextInput', { testID: 'email-input', placeholder: 'Email' });
  const toggle = el('Switch', { testID: 'notifications-switch', value: true });
  const staticView = el('View', {}, txt('Just a label, not actionable'));
  button.sibling = input; input.sibling = toggle; toggle.sibling = staticView;
  return el('View', {}, button);
}

test('interactiveOnly returns ONLY actionable nodes (excludes plain View/Text)', () => {
  const sandbox = createSandbox(buildScreen());
  const result = JSON.parse(sandbox.__RN_AGENT.getTree({ interactiveOnly: true }));
  assert.ok(Array.isArray(result.interactive), 'result.interactive must be an array');
  const ids = result.interactive.map((n) => n.testID).sort();
  assert.deepEqual(ids, ['email-input', 'notifications-switch', 'submit-btn']);
});

test('interactiveOnly infers a role and captures the element text', () => {
  const sandbox = createSandbox(buildScreen());
  const result = JSON.parse(sandbox.__RN_AGENT.getTree({ interactiveOnly: true }));
  const byId = Object.fromEntries(result.interactive.map((n) => [n.testID, n]));
  assert.equal(byId['submit-btn'].role, 'button');
  assert.equal(byId['submit-btn'].text, 'Submit');
  assert.equal(byId['email-input'].role, 'textinput');
  assert.equal(byId['notifications-switch'].role, 'switch');
});

test('interactiveOnly drops props/hookStates — entries are compact', () => {
  const sandbox = createSandbox(buildScreen());
  const result = JSON.parse(sandbox.__RN_AGENT.getTree({ interactiveOnly: true }));
  for (const n of result.interactive) {
    assert.equal(n.props, undefined, 'salient entries must not carry props');
    assert.equal(n.hookStates, undefined, 'salient entries must not carry hookStates');
    assert.equal(n.children, undefined, 'salient entries are flat, not nested');
  }
});

test('interactiveOnly digest is dramatically smaller than the full tree', () => {
  const sandbox = createSandbox(buildScreen());
  const salient = sandbox.__RN_AGENT.getTree({ interactiveOnly: true });
  const full = sandbox.__RN_AGENT.getTree({});
  assert.ok(salient.length < full.length, 'salient digest should be smaller than the full tree');
});

test('interactiveOnly recognizes accessibilityRole=button without an onPress prop', () => {
  const root = el('View', {}, el('View', { accessibilityRole: 'button', testID: 'a11y-btn' }, txt('Tap me')));
  const sandbox = createSandbox(root);
  const result = JSON.parse(sandbox.__RN_AGENT.getTree({ interactiveOnly: true }));
  const ids = result.interactive.map((n) => n.testID);
  assert.ok(ids.includes('a11y-btn'), 'an explicit accessibilityRole=button is actionable');
});
