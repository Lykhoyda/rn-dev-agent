import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertAuthorityProfilesExhaustive,
  authorityProfileFor,
} from '../../../dist/session/tool-profiles.js';

const registered: string[] = JSON.parse(
  readFileSync(new URL('../../fixtures/tool-registry.json', import.meta.url), 'utf8'),
);
if (!registered.includes('rn_session')) registered.push('rn_session');

interface GoldenProfile {
  kind: string;
  axes: string;
  postflightAxes?: string;
  optionalAxes?: string;
  nativeOrigin?: 'optional' | 'required';
  managedOrigin?: boolean;
  managedRunnerPark?: boolean;
  sessionIdentity?: boolean;
  mutation: boolean;
  liveBundleProbe: boolean;
}

// Captured before regrouping; every tool and argument-shaped special case must remain exact.
const GOLDEN: Record<string, GoldenProfile> = {
  cdp_auto_login: { kind: 'authoritative', axes: 'CSIMBDR', mutation: true, liveBundleProbe: true },
  cdp_component_state: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_component_tree: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_connect: { kind: 'transition', axes: 'CS', mutation: true, liveBundleProbe: false },
  cdp_console_log: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_cpu_profile: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_dev_settings: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_diagnostic_renderers: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_disconnect: { kind: 'transition', axes: 'CS', mutation: true, liveBundleProbe: false },
  // GH #750: picker recovery runs while A/B are missing (the stranded state it
  // repairs) and proves A/B via the managed origin lifecycle after dismissal.
  cdp_dismiss_dev_client_picker: {
    kind: 'authoritative',
    axes: 'CSIMD',
    managedOrigin: true,
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_dispatch: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_error_log: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  cdp_evaluate: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_exception_breakpoint: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_heap_usage: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  cdp_interact: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_lock_e2e_test: {
    kind: 'authoritative',
    axes: 'CSIMDR',
    managedOrigin: true,
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_metro_events: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_mmkv: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_native_errors: {
    kind: 'authoritative',
    axes: 'CSID',
    mutation: false,
    liveBundleProbe: false,
  },
  cdp_nav_graph: { kind: 'authoritative', axes: 'CS', mutation: true, liveBundleProbe: false },
  'cdp_nav_graph {"action":"go"}': {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  'cdp_nav_graph {"action":"read"}': {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  'cdp_nav_graph {"action":"scan"}': {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_navigate: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_navigation_state: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_network_body: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_network_log: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_object_inspect: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_open_devtools: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_record_test_annotate: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_record_test_generate: {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_record_test_list: {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_record_test_load: {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_record_test_save: {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_record_test_save_as_action: {
    kind: 'authoritative',
    axes: 'CS',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_record_test_start: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_record_test_stop: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_reload: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  cdp_repair_action: {
    kind: 'authoritative',
    axes: 'CSIMADR',
    nativeOrigin: 'required',
    mutation: true,
    liveBundleProbe: false,
  },
  cdp_restart: { kind: 'authoritative', axes: 'CSIMBD', mutation: true, liveBundleProbe: true },
  'cdp_restart {"hardReset":true,"platform":"android"}': {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  'cdp_restart {"hardReset":true,"platform":"ios"}': {
    kind: 'transition',
    axes: 'CSIMBDR',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_run_action: {
    kind: 'authoritative',
    axes: 'CSIMDR',
    optionalAxes: 'B',
    managedOrigin: true,
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_run_e2e_suite: {
    kind: 'authoritative',
    axes: 'CSIMBDR',
    managedOrigin: true,
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_set_shared_value: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: true,
    liveBundleProbe: true,
  },
  cdp_status: { kind: 'diagnostic', axes: '', mutation: false, liveBundleProbe: false },
  cdp_store_state: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  cdp_targets: { kind: 'diagnostic', axes: '', mutation: false, liveBundleProbe: false },
  cdp_wait_for_network: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  collect_logs: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  cross_platform_verify: {
    kind: 'authoritative',
    axes: 'CSIMADR',
    nativeOrigin: 'required',
    mutation: false,
    liveBundleProbe: false,
  },
  device_accept_system_dialog: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_back: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_batch: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_deeplink: {
    kind: 'authoritative',
    axes: 'CSIMD',
    managedOrigin: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_dismiss_system_dialog: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_fill: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_find: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: false,
    liveBundleProbe: false,
  },
  'device_find {"action":"click"}': {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  'device_find {"action":"get"}': {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: false,
    liveBundleProbe: false,
  },
  device_focus_next: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_list: { kind: 'diagnostic', axes: '', mutation: false, liveBundleProbe: false },
  device_longpress: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  'device_permission {"action":"grant"}': {
    kind: 'authoritative',
    axes: 'CSID',
    mutation: true,
    liveBundleProbe: false,
  },
  'device_permission {"action":"query"}': {
    kind: 'authoritative',
    axes: 'CSID',
    mutation: false,
    liveBundleProbe: false,
  },
  device_pick_date: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_pick_value: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_pinch: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_press: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_record: {
    kind: 'authoritative',
    axes: 'CSID',
    sessionIdentity: true,
    mutation: true,
    liveBundleProbe: false,
  },
  'device_record {"action":"start"}': {
    kind: 'authoritative',
    axes: 'CSID',
    sessionIdentity: true,
    mutation: true,
    liveBundleProbe: false,
  },
  'device_record {"action":"status"}': {
    kind: 'authoritative',
    axes: 'CSD',
    sessionIdentity: true,
    mutation: false,
    liveBundleProbe: false,
  },
  'device_record {"action":"stop"}': {
    kind: 'authoritative',
    axes: 'CSD',
    sessionIdentity: true,
    mutation: true,
    liveBundleProbe: false,
  },
  device_reset_state: {
    kind: 'authoritative',
    axes: 'CSIMDR',
    postflightAxes: 'CSIMDR',
    managedOrigin: true,
    mutation: true,
    liveBundleProbe: false,
  },
  'device_reset_state {"storageKeys":["token"]}': {
    kind: 'authoritative',
    axes: 'CSIMBDR',
    postflightAxes: 'CSIMDR',
    managedOrigin: true,
    mutation: true,
    liveBundleProbe: true,
  },
  device_screenshot: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: false,
    liveBundleProbe: false,
  },
  device_scroll: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_scrollintoview: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  device_snapshot: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: false,
    liveBundleProbe: false,
  },
  device_swipe: {
    kind: 'authoritative',
    axes: 'CSIDR',
    nativeOrigin: 'optional',
    mutation: true,
    liveBundleProbe: false,
  },
  expect_redux: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  expect_route: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  expect_text: { kind: 'authoritative', axes: 'CSIMBD', mutation: false, liveBundleProbe: true },
  expect_visible_by_testid: {
    kind: 'authoritative',
    axes: 'CSIMBD',
    mutation: false,
    liveBundleProbe: true,
  },
  maestro_generate: { kind: 'authoritative', axes: 'CS', mutation: true, liveBundleProbe: false },
  maestro_run: {
    kind: 'authoritative',
    axes: 'CSIMDR',
    postflightAxes: 'CSIMD',
    managedOrigin: true,
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  maestro_test_all: {
    kind: 'authoritative',
    axes: 'CSIMDR',
    postflightAxes: 'CSIMD',
    managedOrigin: true,
    managedRunnerPark: true,
    mutation: true,
    liveBundleProbe: false,
  },
  observe: { kind: 'authoritative', axes: 'CS', mutation: false, liveBundleProbe: false },
  proof_capture: {
    kind: 'authoritative',
    axes: 'CSIMABDRP',
    nativeOrigin: 'required',
    mutation: true,
    liveBundleProbe: true,
  },
  'proof_capture {"action":"discard"}': {
    kind: 'authoritative',
    axes: 'CSDP',
    postflightAxes: 'CSD',
    mutation: true,
    liveBundleProbe: false,
  },
  'proof_capture {"action":"finalize"}': {
    kind: 'authoritative',
    axes: 'CSIMABDRP',
    nativeOrigin: 'required',
    mutation: true,
    liveBundleProbe: true,
  },
  proof_step: {
    kind: 'authoritative',
    axes: 'CSIMABDRP',
    nativeOrigin: 'required',
    mutation: true,
    liveBundleProbe: true,
  },
  rn_session: { kind: 'transition', axes: 'CS', mutation: true, liveBundleProbe: false },
};

function goldenCall(key: string): { tool: string; args: Record<string, unknown> } {
  const space = key.indexOf(' ');
  if (space === -1) return { tool: key, args: {} };
  return { tool: key.slice(0, space), args: JSON.parse(key.slice(space + 1)) };
}

test('every registered MCP tool has one explicit authority profile', () => {
  assert.doesNotThrow(() => assertAuthorityProfilesExhaustive(registered));
  assert.throws(
    () => assertAuthorityProfilesExhaustive([...registered, 'future_unprofiled_tool']),
    /UNPROFILED_AUTHORITY_TOOL/,
  );
});

test('golden: grouped bookkeeping resolves every tool to its exact facet set', () => {
  for (const [key, expected] of Object.entries(GOLDEN)) {
    const { tool, args } = goldenCall(key);
    const profile = authorityProfileFor(tool, args);
    const label = `golden mismatch for ${key}`;
    assert.equal(profile.kind, expected.kind, label);
    assert.equal(profile.axes.join(''), expected.axes, label);
    assert.equal(profile.postflightAxes?.join(''), expected.postflightAxes, label);
    assert.equal(profile.optionalAxes?.join(''), expected.optionalAxes, label);
    assert.equal(profile.nativeOrigin, expected.nativeOrigin, label);
    assert.equal(profile.managedOrigin, expected.managedOrigin, label);
    assert.equal(profile.managedRunnerPark, expected.managedRunnerPark, label);
    assert.equal(profile.sessionIdentity, expected.sessionIdentity, label);
    assert.equal(profile.mutation, expected.mutation, label);
    assert.equal(profile.liveBundleProbe, expected.liveBundleProbe, label);
  }
});

test('the golden table covers the complete registered tool surface', () => {
  const covered = new Set(Object.keys(GOLDEN).map((key) => goldenCall(key).tool));
  for (const tool of registered) {
    assert.ok(covered.has(tool), `${tool} is missing from the golden table`);
  }
});

test('Session resolves C+S; Target adds D+I; Runtime adds M+B with the live A probe; Automation adds R', () => {
  const sessionOnly = authorityProfileFor('observe');
  assert.deepEqual(sessionOnly.groups, ['session']);
  assert.deepEqual(sessionOnly.axes, ['C', 'S']);

  const target = authorityProfileFor('cdp_native_errors');
  assert.deepEqual(target.groups, ['session', 'target']);
  assert.deepEqual(target.axes, ['C', 'S', 'I', 'D']);

  const nativeRuntime = authorityProfileFor('cross_platform_verify');
  assert.deepEqual(nativeRuntime.groups, ['session', 'target', 'runtime', 'automation']);
  assert.deepEqual(nativeRuntime.axes, ['C', 'S', 'I', 'M', 'A', 'D', 'R']);

  const cdpRuntime = authorityProfileFor('cdp_interact');
  assert.deepEqual(cdpRuntime.groups, ['session', 'target', 'runtime']);
  assert.deepEqual(cdpRuntime.axes, ['C', 'S', 'I', 'M', 'B', 'D']);

  const proof = authorityProfileFor('proof_step');
  assert.deepEqual(proof.groups, ['session', 'target', 'runtime', 'automation']);
  assert.deepEqual(proof.axes, ['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R', 'P']);
});

test('every registered non-diagnostic profile declares its ownership groups', () => {
  for (const tool of registered) {
    const profile = authorityProfileFor(tool);
    assert.ok(Array.isArray(profile.groups), `${tool} must declare ownership groups`);
    if (profile.kind !== 'diagnostic') {
      assert.ok(profile.groups!.includes('session'), `${tool} must be Session-owned`);
    }
  }
});

test('raw native runner mutations require exact control authority and admit origin optionally', () => {
  const press = authorityProfileFor('device_press');
  assert.deepEqual(press.groups, ['session', 'target', 'automation']);
  assert.deepEqual(press.axes, ['C', 'S', 'I', 'D', 'R']);
  assert.equal(press.nativeOrigin, 'optional');
  assert.equal(press.liveBundleProbe, false);
  assert.equal(press.axes.includes('M'), false);
  assert.equal(press.axes.includes('A'), false);
  assert.equal(press.axes.includes('B'), false);
  assert.equal(authorityProfileFor('cdp_interact').liveBundleProbe, true);
  assert.ok(authorityProfileFor('cdp_interact').axes.includes('B'));
});

test('native reads separate raw control from strict cross-platform evidence', () => {
  for (const tool of ['device_find', 'device_screenshot', 'device_snapshot']) {
    const profile = authorityProfileFor(tool);
    assert.deepEqual(profile.axes, ['C', 'S', 'I', 'D', 'R']);
    assert.equal(profile.nativeOrigin, 'optional');
  }
  const verdict = authorityProfileFor('cross_platform_verify');
  assert.deepEqual(verdict.axes, ['C', 'S', 'I', 'M', 'A', 'D', 'R']);
  assert.equal(verdict.nativeOrigin, 'required');
});

test('device_find click and lifecycle tools use mutation-aware origin authority', () => {
  const click = authorityProfileFor('device_find', { action: 'click' });
  assert.deepEqual(click.axes, ['C', 'S', 'I', 'D', 'R']);
  assert.equal(click.nativeOrigin, 'optional');
  assert.equal(authorityProfileFor('device_find', { action: 'get' }).mutation, false);
  for (const tool of ['device_reset_state', 'maestro_run', 'maestro_test_all']) {
    const profile = authorityProfileFor(tool);
    assert.equal(profile.axes.includes('A'), false);
    assert.equal(profile.managedOrigin, true);
  }
  for (const tool of ['maestro_run', 'maestro_test_all']) {
    assert.equal(authorityProfileFor(tool).managedRunnerPark, true);
  }
  assert.equal(authorityProfileFor('maestro_run').managedInstallReissue, true);
  assert.equal(authorityProfileFor('maestro_test_all').managedInstallReissue, false);
  const storageReset = authorityProfileFor('device_reset_state', { storageKeys: ['token'] });
  assert.equal(storageReset.axes.includes('B'), true);
  assert.equal(storageReset.postflightAxes?.includes('B'), false);
});

test('OS-scoped device tools stay within Session+Target and never require runner or origin', () => {
  const deeplink = authorityProfileFor('device_deeplink');
  assert.deepEqual(deeplink.axes, ['C', 'S', 'I', 'M', 'D']);
  assert.equal(deeplink.managedOrigin, true);

  const permissionQuery = authorityProfileFor('device_permission', { action: 'query' });
  const permissionGrant = authorityProfileFor('device_permission', { action: 'grant' });
  assert.deepEqual(permissionQuery.groups, ['session', 'target']);
  assert.deepEqual(permissionQuery.axes, ['C', 'S', 'I', 'D']);
  assert.equal(permissionQuery.mutation, false);
  assert.equal(permissionGrant.mutation, true);

  const recordingStatus = authorityProfileFor('device_record', { action: 'status' });
  assert.deepEqual(recordingStatus.axes, ['C', 'S', 'D']);
  assert.equal(recordingStatus.sessionIdentity, true);
  assert.equal(recordingStatus.mutation, false);
  const recordingStop = authorityProfileFor('device_record', { action: 'stop' });
  assert.deepEqual(recordingStop.axes, ['C', 'S', 'D']);
  assert.equal(recordingStop.mutation, true);
  assert.deepEqual(authorityProfileFor('device_record', { action: 'start' }).axes, [
    'C',
    'S',
    'I',
    'D',
  ]);
});

test('proof requires all four groups live while discard keeps its lighter teardown path', () => {
  const discard = authorityProfileFor('proof_capture', { action: 'discard' });

  assert.deepEqual(discard.axes, ['C', 'S', 'D', 'P']);
  assert.deepEqual(discard.postflightAxes, ['C', 'S', 'D']);
  assert.equal(discard.liveBundleProbe, false);
  assert.deepEqual(authorityProfileFor('proof_capture', { action: 'finalize' }).axes, [
    'C',
    'S',
    'I',
    'M',
    'A',
    'B',
    'D',
    'R',
    'P',
  ]);
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

test('Observe is a session-scoped read-only child', () => {
  const profile = authorityProfileFor('observe');

  assert.equal(profile.kind, 'authoritative');
  assert.deepEqual(profile.axes, ['C', 'S']);
  assert.equal(profile.mutation, false);
  assert.equal(profile.liveBundleProbe, false);
});

test('the retired O axis appears in no tool profile', () => {
  for (const tool of registered) {
    const profile = authorityProfileFor(tool);
    for (const axes of [profile.axes, profile.postflightAxes ?? [], profile.optionalAxes ?? []]) {
      assert.equal(axes.includes('O'), false, `${tool} must not carry the retired O axis`);
    }
  }
});

test('GH #750: picker recovery is admitted while A/B are missing and proves them after', () => {
  const profile = authorityProfileFor('cdp_dismiss_dev_client_picker');

  assert.equal(profile.axes.includes('A'), false);
  assert.equal(profile.axes.includes('B'), false);
  assert.equal(profile.managedOrigin, true);
  assert.equal(profile.liveBundleProbe, false);
  assert.equal(profile.mutation, true);
});

test('iOS hard reset transitions through runner authority', () => {
  const profile = authorityProfileFor('cdp_restart', { hardReset: true, platform: 'ios' });

  assert.equal(profile.kind, 'transition');
  assert.equal(profile.axes.includes('R'), true);
});
