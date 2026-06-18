import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowUsesClearState } from '../../dist/tools/resolve-ios-app-file.js';

// Audit (needs-runtime bucket): flowUsesClearState only matched
// `launchApp: { clearState: true }`, missing the standalone `- clearState`
// command (also in the validator allowlist), which uninstalls + needs reinstall.

test('clearState: launchApp object form is detected', () => {
  assert.equal(flowUsesClearState('- launchApp:\n    clearState: true\n'), true);
});

test('clearState: standalone command form is now detected', () => {
  assert.equal(flowUsesClearState('- launchApp\n- clearState\n- tapOn:\n    id: x\n'), true);
});

test('clearState: a flow without it is not flagged', () => {
  assert.equal(flowUsesClearState('- launchApp\n- tapOn:\n    id: x\n'), false);
});

test('clearState: a comment mentioning clearState does not false-trigger the standalone form', () => {
  // The standalone matcher anchors on a list item, so prose/comment mentions
  // (no leading `- `) do not match.
  assert.equal(flowUsesClearState('# we used to clearState here\n- launchApp\n'), false);
});
