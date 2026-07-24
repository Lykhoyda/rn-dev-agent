import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertAuthorityProfilesExhaustive,
  authorityProfileFor,
} from '../../../dist/session/tool-profiles.js';

const registered = JSON.parse(
  readFileSync(new URL('../../fixtures/tool-registry.json', import.meta.url), 'utf8'),
);
if (!registered.includes('rn_session')) registered.push('rn_session');

test('every registered MCP tool has one explicit authority profile', () => {
  assert.doesNotThrow(() => assertAuthorityProfilesExhaustive(registered));
  assert.throws(
    () => assertAuthorityProfilesExhaustive([...registered, 'future_unprofiled_tool']),
    /UNPROFILED_AUTHORITY_TOOL/,
  );
});

test('native runner operations do not require a live CDP bundle seat', () => {
  assert.deepEqual(authorityProfileFor('device_press').axes, ['C', 'S', 'I', 'M', 'D', 'R']);
  assert.equal(authorityProfileFor('device_press').liveBundleProbe, false);
  assert.equal(authorityProfileFor('cdp_interact').liveBundleProbe, true);
  assert.ok(authorityProfileFor('cdp_interact').axes.includes('B'));
});

test('hybrid execution separates required and optional bundle authority', () => {
  for (const tool of ['cdp_auto_login', 'cdp_run_e2e_suite']) {
    const profile = authorityProfileFor(tool);
    assert.equal(profile.liveBundleProbe, true);
    assert.equal(profile.axes.includes('B'), true);
    assert.equal(profile.axes.includes('R'), true);
  }
  const action = authorityProfileFor('cdp_run_action');
  assert.equal(action.axes.includes('B'), false);
  assert.deepEqual(action.optionalAxes, ['B']);
  assert.equal(action.axes.includes('R'), true);
});

test('lock and live navigation paths receive exact mutation authority', () => {
  assert.deepEqual(authorityProfileFor('cdp_lock_e2e_test').axes, ['C', 'S', 'I', 'M', 'D', 'R']);
  assert.deepEqual(authorityProfileFor('cdp_nav_graph', { action: 'read' }).axes, ['C', 'S']);
  assert.deepEqual(authorityProfileFor('cdp_nav_graph', { action: 'navigate' }).axes, ['C', 'S']);
  for (const action of ['scan', 'go']) {
    const profile = authorityProfileFor('cdp_nav_graph', { action });
    assert.equal(profile.axes.includes('B'), true);
    assert.equal(profile.axes.includes('D'), true);
    assert.equal(profile.liveBundleProbe, true);
  }
  assert.equal(authorityProfileFor('cdp_record_test_annotate').axes.includes('B'), true);
});

test('diagnostics are explicitly non-verdict and arbitrary evaluate is mutating', () => {
  assert.equal(authorityProfileFor('cdp_status').kind, 'diagnostic');
  assert.equal(authorityProfileFor('device_list').kind, 'diagnostic');
  assert.equal(authorityProfileFor('cdp_evaluate').kind, 'authoritative');
  assert.equal(authorityProfileFor('cdp_evaluate').mutation, true);
});
