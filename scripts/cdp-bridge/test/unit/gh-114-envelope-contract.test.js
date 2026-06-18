// GH #114 — agent-device envelope CONTRACT tests.
//
// Why: handler-side parsers (findRefByTestID, snapshotEnvelopeFailed,
// the various `env.data?.nodes` consumers in device-interact/device-session/
// repair-action) read envelopes emitted by THREE distinct producer tiers:
//
//   1. In-tree iOS runner (rn-fast-runner-client.runIOS)
//   2. In-tree Android runner (rn-android-runner-client.runAndroid)
//   3. Legacy upstream agent-device dispatch tiers (daemon socket / CLI
//      subprocess / agent-device's internal fast-runner sub-tier)
//
// Each producer emits subtly different envelope shapes. Without contract
// pinning, a future tightening of a handler parser (e.g. require `data.code`
// on failure) can pass synthetic handler tests yet break real producer
// output in prod — exactly the gap codex flagged on PR #109 (issue #114).
//
// These tests are PRODUCER-CONSUMER pairings: pin the canonical envelope
// each producer emits for a class of event, then run every consumer parser
// against it. If either side drifts, the test fails before users do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRefByTestID, snapshotEnvelopeFailed } from '../../dist/tools/device-batch.js';

// ─────────────────────────────────────────────────────────────────────────────
// Producer fixtures — canonical envelopes each dispatch tier emits.
// Sourced from real runner output captured during the iOS-MVP (PR #164) and
// Android-MVP (PR #165) integrations. Update these when the producer shapes
// change AND verify all consumer parsers below still handle them.
// ─────────────────────────────────────────────────────────────────────────────

// In-tree iOS runner: mapRunnerNodesToFlat in rn-fast-runner-client.ts emits
// `{ref: '@e<n>', type, rect, label?, identifier?, enabled?, hittable?}`.
// `parentIndex`/`depth` are NOT in the post-mapping shape — they exist on the
// raw runner JSON but are dropped before MCP consumers see them.
const IN_TREE_IOS_SNAPSHOT_OK = {
  ok: true,
  data: {
    nodes: [
      {
        ref: '@e0',
        type: 'Application',
        rect: { x: 0, y: 0, width: 393, height: 852 },
        label: 'TaskApp',
        identifier: '',
        enabled: true,
        hittable: false,
      },
      {
        ref: '@e7',
        type: 'Button',
        rect: { x: 320, y: 720, width: 56, height: 56 },
        label: 'Create task',
        identifier: 'fab-create-task',
        enabled: true,
        hittable: true,
      },
      {
        ref: '@e8',
        type: 'StaticText',
        rect: { x: 16, y: 60, width: 200, height: 24 },
        label: 'Tasks',
        identifier: 'header-title',
        enabled: true,
        hittable: false,
      },
    ],
  },
};

// In-tree Android runner: identical flat-node shape (same field set, same
// types) emitted by mapRunnerNodesToFlat in rn-android-runner-client.ts.
// The parity test below pins this — a divergence would break platform-agnostic
// handlers.
const IN_TREE_ANDROID_SNAPSHOT_OK = {
  ok: true,
  data: {
    nodes: [
      {
        ref: '@e0',
        type: 'FrameLayout',
        rect: { x: 0, y: 0, width: 1080, height: 2400 },
        label: '',
        identifier: '',
        enabled: true,
        hittable: false,
      },
      {
        ref: '@e12',
        type: 'Button',
        rect: { x: 800, y: 2000, width: 168, height: 168 },
        label: 'Create task',
        identifier: 'fab-create-task',
        enabled: true,
        hittable: true,
      },
    ],
  },
};

// Legacy upstream agent-device daemon (socket) tier: flat-nodes shape with
// less metadata than the in-tree runners. Consumer parsers only care about
// `ref` + `identifier`, so the same handler contract holds.
const LEGACY_DAEMON_SNAPSHOT_OK = {
  ok: true,
  data: {
    nodes: [{ ref: 'el-0', identifier: 'fab-create-task', label: 'Create task' }],
  },
};

// Legacy upstream agent-device CLI tier: same flat-nodes shape as the daemon.
// Pinned separately so a future divergence (e.g. CLI starts including a `type`
// field, daemon doesn't) would surface this contract test as the canary.
const LEGACY_CLI_SNAPSHOT_OK = {
  ok: true,
  data: {
    nodes: [{ ref: 'el-0', identifier: 'fab-create-task', label: 'Create task' }],
  },
};

// Legacy upstream-agent-device internal fast-runner sub-tier — nested tree
// shape, NOT flat-nodes. findRefByTestID's second branch handles this; if
// that branch is ever removed without warning, this test fails.
const LEGACY_FAST_RUNNER_SNAPSHOT_OK_NESTED = {
  ok: true,
  data: {
    tree: {
      ref: 'app-0',
      identifier: '',
      label: 'Application',
      children: [
        {
          ref: 'btn-7',
          identifier: 'fab-create-task',
          label: 'Create task',
          children: [],
        },
      ],
    },
  },
};

// In-tree runner failure shape AFTER the client converts raw runner errors
// through failResult(message, code). The raw HTTP response from the
// underlying XCTest/UIAutomator has `error: {message, code}`, but MCP
// consumers (findRefByTestID etc.) never see that — they get the post-
// failResult shape `{ok:false, error: string, code: string}` instead.
const IN_TREE_RUNNER_FAILURE_APP_NOT_RUNNING = {
  ok: false,
  error: 'app not running',
  code: 'APP_NOT_RUNNING',
};

const LEGACY_DAEMON_FAILURE_NO_DEVICE = {
  ok: false,
  error: 'No iOS simulator booted',
};

const LEGACY_CLI_FAILURE_WITH_CODE = {
  ok: false,
  error: 'agent-device CLI exited with code 1',
  code: 'CLI_SPAWN_FAILED',
};

// iOS-specific: XCUIElement.typeText quiescence-timeout shim. The text
// landed in the field but XCTest's main-thread waitForIdle timed out
// after the side effect succeeded. Runner returns ok:true with a meta
// marker (exact shape: rn-fast-runner-client.ts emits
// `okResult({typed, text}, {meta: {sideEffectSucceeded, runnerTimeoutShim}})`).
// snapshotEnvelopeFailed must NOT report this as failed — it would route
// a successful fill to SNAPSHOT_FAILED otherwise.
const IOS_TYPETEXT_RUNNER_TIMEOUT_SHIM = {
  ok: true,
  data: { typed: true, text: 'hello' },
  meta: { sideEffectSucceeded: true, runnerTimeoutShim: true },
};

// Snapshot succeeded but nothing matched the testID — empty nodes array.
// This is "element not present", NOT "snapshot infrastructure failed".
const IN_TREE_SNAPSHOT_OK_EMPTY = {
  ok: true,
  data: { nodes: [] },
};

// ─────────────────────────────────────────────────────────────────────────────
// findRefByTestID — must extract ref by identifier from all producer shapes
// ─────────────────────────────────────────────────────────────────────────────

const SUCCESS_ENVELOPES_WITH_TARGET = [
  { name: 'in-tree iOS (flat nodes)', env: IN_TREE_IOS_SNAPSHOT_OK, expectedRef: '@e7' },
  { name: 'in-tree Android (flat nodes)', env: IN_TREE_ANDROID_SNAPSHOT_OK, expectedRef: '@e12' },
  { name: 'legacy daemon (flat nodes)', env: LEGACY_DAEMON_SNAPSHOT_OK, expectedRef: 'el-0' },
  { name: 'legacy CLI (flat nodes)', env: LEGACY_CLI_SNAPSHOT_OK, expectedRef: 'el-0' },
  {
    name: 'legacy fast-runner (nested)',
    env: LEGACY_FAST_RUNNER_SNAPSHOT_OK_NESTED,
    expectedRef: 'btn-7',
  },
];

for (const { name, env, expectedRef } of SUCCESS_ENVELOPES_WITH_TARGET) {
  test(`findRefByTestID: ${name} — resolves testID 'fab-create-task' to ${expectedRef}`, () => {
    const ref = findRefByTestID(JSON.stringify(env), 'fab-create-task');
    assert.equal(ref, expectedRef);
  });
}

test('findRefByTestID: in-tree snapshot with empty nodes — returns null (testID not present)', () => {
  const ref = findRefByTestID(JSON.stringify(IN_TREE_SNAPSHOT_OK_EMPTY), 'fab-create-task');
  assert.equal(ref, null);
});

test('findRefByTestID: in-tree snapshot with present nodes but no match — returns null', () => {
  const ref = findRefByTestID(JSON.stringify(IN_TREE_IOS_SNAPSHOT_OK), 'nonexistent-testid');
  assert.equal(ref, null);
});

const FAILURE_ENVELOPES = [
  { name: 'in-tree runner failure (object error)', env: IN_TREE_RUNNER_FAILURE_APP_NOT_RUNNING },
  { name: 'legacy daemon failure (string error)', env: LEGACY_DAEMON_FAILURE_NO_DEVICE },
  { name: 'legacy CLI failure (error + code)', env: LEGACY_CLI_FAILURE_WITH_CODE },
];

for (const { name, env } of FAILURE_ENVELOPES) {
  test(`findRefByTestID: ${name} — returns null (refuses to scan failed snapshot)`, () => {
    const ref = findRefByTestID(JSON.stringify(env), 'fab-create-task');
    assert.equal(ref, null);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// snapshotEnvelopeFailed — classifies infrastructure failure vs element-absent
// ─────────────────────────────────────────────────────────────────────────────

for (const { name, env } of SUCCESS_ENVELOPES_WITH_TARGET) {
  test(`snapshotEnvelopeFailed: ${name} — returns false (snapshot succeeded)`, () => {
    assert.equal(snapshotEnvelopeFailed(JSON.stringify(env)), false);
  });
}

test('snapshotEnvelopeFailed: empty-nodes success is NOT a failure (element not present is different)', () => {
  // Critical contract: handlers depend on this distinction to route
  // SNAPSHOT_FAILED vs TESTID_NOT_FOUND correctly (Phase 128 #5/#6).
  assert.equal(snapshotEnvelopeFailed(JSON.stringify(IN_TREE_SNAPSHOT_OK_EMPTY)), false);
});

test('snapshotEnvelopeFailed: iOS typeText runner-timeout shim is NOT a failure', () => {
  // The shim shape carries ok:true + meta.runnerTimeoutShim. Treating
  // it as failure would route every successful iOS fill to
  // SNAPSHOT_FAILED — would visibly break the iOS device_fill smoke test.
  assert.equal(snapshotEnvelopeFailed(JSON.stringify(IOS_TYPETEXT_RUNNER_TIMEOUT_SHIM)), false);
});

for (const { name, env } of FAILURE_ENVELOPES) {
  test(`snapshotEnvelopeFailed: ${name} — returns true`, () => {
    assert.equal(snapshotEnvelopeFailed(JSON.stringify(env)), true);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases — what the parsers do under malformed / null input
// ─────────────────────────────────────────────────────────────────────────────

test('snapshotEnvelopeFailed: null/undefined input → true (treat missing as failed)', () => {
  assert.equal(snapshotEnvelopeFailed(null), true);
  assert.equal(snapshotEnvelopeFailed(undefined), true);
});

test('snapshotEnvelopeFailed: empty string → true', () => {
  assert.equal(snapshotEnvelopeFailed(''), true);
});

test('snapshotEnvelopeFailed: malformed JSON → true (the parser cannot vouch for the snapshot)', () => {
  assert.equal(snapshotEnvelopeFailed('not-json'), true);
  assert.equal(snapshotEnvelopeFailed('{ truncated'), true);
});

test('findRefByTestID: malformed JSON → null (no ref to extract)', () => {
  assert.equal(findRefByTestID('not-json', 'any-testid'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-producer parity — same logical event, structurally compatible output
// ─────────────────────────────────────────────────────────────────────────────

test('parity: in-tree iOS and in-tree Android emit structurally identical flat-nodes shape', () => {
  // Both runners should expose the same `{ok, data: {nodes: [{ref, identifier, label}]}}`
  // shape so handlers can be platform-agnostic. A divergence here
  // (e.g. Android renaming `identifier` to `accessibilityId`) would
  // silently break the iOS-tested handlers on Android.
  const iosKeys = Object.keys(IN_TREE_IOS_SNAPSHOT_OK.data.nodes[0]).sort();
  const androidKeys = Object.keys(IN_TREE_ANDROID_SNAPSHOT_OK.data.nodes[0]).sort();
  assert.deepEqual(iosKeys, androidKeys, 'iOS and Android flat-node keys must match');
});
