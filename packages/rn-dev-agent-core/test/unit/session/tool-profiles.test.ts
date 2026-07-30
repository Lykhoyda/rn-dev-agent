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

test('native runner mutations prove app origin without requiring a live CDP bundle seat', () => {
  assert.deepEqual(authorityProfileFor('device_press').axes, ['C', 'S', 'I', 'M', 'A', 'D', 'R']);
  assert.equal(authorityProfileFor('device_press').liveBundleProbe, false);
  assert.equal(authorityProfileFor('device_press').axes.includes('B'), false);
  assert.equal(authorityProfileFor('cdp_interact').liveBundleProbe, true);
  assert.ok(authorityProfileFor('cdp_interact').axes.includes('B'));
});

test('native runner reads prove the app origin on the claimed device', () => {
  for (const tool of [
    'cross_platform_verify',
    'device_find',
    'device_screenshot',
    'device_snapshot',
  ]) {
    assert.deepEqual(authorityProfileFor(tool).axes, ['C', 'S', 'I', 'M', 'A', 'D', 'R']);
  }
});

test('device_find click and lifecycle tools use mutation-aware origin authority', () => {
  assert.deepEqual(authorityProfileFor('device_find', { action: 'click' }).axes, [
    'C',
    'S',
    'I',
    'M',
    'A',
    'D',
    'R',
  ]);
  assert.equal(authorityProfileFor('device_find', { action: 'get' }).mutation, false);
  for (const tool of ['device_reset_state', 'maestro_run', 'maestro_test_all']) {
    const profile = authorityProfileFor(tool);
    assert.equal(profile.axes.includes('A'), false);
    assert.equal(profile.managedOrigin, true);
  }
  for (const tool of ['maestro_run', 'maestro_test_all']) {
    assert.equal(authorityProfileFor(tool).managedRunnerPark, true);
  }
  const storageReset = authorityProfileFor('device_reset_state', { storageKeys: ['token'] });
  assert.equal(storageReset.axes.includes('B'), true);
  assert.equal(storageReset.postflightAxes?.includes('B'), false);
});

test('OS-scoped device tools do not require a live app origin or runner', () => {
  const deeplink = authorityProfileFor('device_deeplink');
  assert.deepEqual(deeplink.axes, ['C', 'S', 'I', 'M', 'D']);
  assert.equal(deeplink.managedOrigin, true);

  const permissionQuery = authorityProfileFor('device_permission', { action: 'query' });
  const permissionGrant = authorityProfileFor('device_permission', { action: 'grant' });
  assert.deepEqual(permissionQuery.axes, ['C', 'S', 'I', 'D']);
  assert.equal(permissionQuery.mutation, false);
  assert.equal(permissionGrant.mutation, true);

  const recordingStatus = authorityProfileFor('device_record', { action: 'status' });
  assert.deepEqual(recordingStatus.axes, ['C', 'S', 'I', 'D']);
  assert.equal(recordingStatus.sessionIdentity, true);
  assert.equal(recordingStatus.mutation, false);
  assert.equal(authorityProfileFor('device_record', { action: 'stop' }).mutation, true);
});

test('hybrid execution separates required and optional bundle authority', () => {
  for (const tool of ['cdp_auto_login', 'cdp_run_e2e_suite']) {
    const profile = authorityProfileFor(tool);
    assert.equal(profile.liveBundleProbe, true);
    assert.equal(profile.axes.includes('B'), true);
    assert.equal(profile.axes.includes('R'), true);
  }
  const suite = authorityProfileFor('cdp_run_e2e_suite');
  assert.equal(suite.managedOrigin, true);
  assert.equal(suite.managedRunnerPark, true);
  const action = authorityProfileFor('cdp_run_action');
  assert.equal(action.axes.includes('B'), false);
  assert.equal(action.axes.includes('A'), false);
  assert.equal(action.managedOrigin, true);
  assert.deepEqual(action.optionalAxes, ['B']);
  assert.equal(action.axes.includes('R'), true);
});

test('lock and live navigation paths receive exact mutation authority', () => {
  assert.deepEqual(authorityProfileFor('cdp_lock_e2e_test').axes, ['C', 'S', 'I', 'M', 'D', 'R']);
  assert.equal(authorityProfileFor('cdp_lock_e2e_test').managedOrigin, true);
  assert.equal(authorityProfileFor('cdp_lock_e2e_test').managedRunnerPark, true);
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

test('native crash diagnostics do not require Metro or bundle authority', () => {
  const profile = authorityProfileFor('cdp_native_errors');

  assert.deepEqual(profile.axes, ['C', 'S', 'I', 'D']);
  assert.equal(profile.liveBundleProbe, false);
  assert.equal(profile.mutation, false);
});

test('iOS hard reset transitions through runner authority', () => {
  const profile = authorityProfileFor('cdp_restart', { hardReset: true, platform: 'ios' });

  assert.equal(profile.kind, 'transition');
  assert.equal(profile.axes.includes('R'), true);
});
