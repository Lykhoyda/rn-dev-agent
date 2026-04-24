// B144 Codex #2 (conf ≥80): split-resolver semantics for save vs load/list.
//
// The `makeRecordingRootResolver` factory returns different bundleId
// preference orderings based on the operation mode:
//   - mode='save'       captured > live  (recording identity is bound to
//                                         capture time, not dispatch time)
//   - mode='load-list'  live > captured  (browsing the current app's
//                                         recording dir)
//
// These tests verify the resolver's preference ordering via direct
// invocation. Fs-level fixtures live in find-project-root-bundle-id.test.js;
// this file focuses on the resolver contract itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _makeRecordingRootResolverForTest,
  _setRecordingBundleId,
  _resetState,
} from '../../dist/tools/test-recorder.js';

let root;
const origCwd = process.cwd();

function makeRnProject(dir, name, extraAppJson = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, dependencies: { 'react-native': '0.76.0' } }),
  );
  writeFileSync(join(dir, 'app.json'), JSON.stringify(extraAppJson));
}

function makeNonRnDir(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dependencies: {} }));
}

function fakeClient(bundleId) {
  return {
    connectedTarget: bundleId ? { description: bundleId } : null,
  };
}

test.beforeEach(() => {
  // realpathSync resolves /var → /private/var on macOS so join(root, ...)
  // matches what process.cwd() + filesystem calls return canonically.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'b144-codex2-')));
  _resetState();
});

test.afterEach(() => {
  process.chdir(origCwd);
  _resetState();
  delete process.env.RN_PROJECT_ROOT;
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

// ─────────── save mode ───────────

test("B144 Codex #2: save mode prefers captured recordingBundleId over live client", () => {
  makeRnProject(join(root, 'captured-app'), 'captured-app', {
    expo: { ios: { bundleIdentifier: 'com.captured' } },
  });
  makeRnProject(join(root, 'live-app'), 'live-app', {
    expo: { ios: { bundleIdentifier: 'com.live' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  _setRecordingBundleId('com.captured');
  const resolver = _makeRecordingRootResolverForTest(() => fakeClient('com.live'), 'save');

  // save should land in the captured app's project, not the currently-
  // connected one — the recording's identity belongs to when it was made.
  assert.equal(resolver(), join(root, 'captured-app'));
});

test("B144 Codex #2: save mode falls back to live when no captured bundleId", () => {
  makeRnProject(join(root, 'live-app'), 'live-app', {
    expo: { ios: { bundleIdentifier: 'com.live' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  // No start was called → recordingBundleId is null → live client wins.
  const resolver = _makeRecordingRootResolverForTest(() => fakeClient('com.live'), 'save');
  assert.equal(resolver(), join(root, 'live-app'));
});

// ─────────── load-list mode ───────────

test("B144 Codex #2: load-list mode prefers LIVE client over captured recordingBundleId", () => {
  // This is the Codex-flagged scenario: user recorded app A, then reconnected
  // to app B and called load/list. They want B's recordings, not A's.
  makeRnProject(join(root, 'captured-app'), 'captured-app', {
    expo: { ios: { bundleIdentifier: 'com.captured' } },
  });
  makeRnProject(join(root, 'live-app'), 'live-app', {
    expo: { ios: { bundleIdentifier: 'com.live' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  _setRecordingBundleId('com.captured');
  const resolver = _makeRecordingRootResolverForTest(() => fakeClient('com.live'), 'load-list');

  // load/list want the CURRENTLY-connected app's recording dir.
  assert.equal(resolver(), join(root, 'live-app'));
});

test("B144 Codex #2: load-list mode falls back to captured when no live client is connected", () => {
  makeRnProject(join(root, 'captured-app'), 'captured-app', {
    expo: { ios: { bundleIdentifier: 'com.captured' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  _setRecordingBundleId('com.captured');
  // Client is null → no live bundleId → captured is the safety net.
  const resolver = _makeRecordingRootResolverForTest(() => fakeClient(null), 'load-list');
  assert.equal(resolver(), join(root, 'captured-app'));
});

test("B144 Codex #2: load-list mode falls back to legacy findProjectRoot when no bundleId at all", () => {
  // No env, no captured, no live — fully legacy alphabetical.
  makeRnProject(join(root, 'aaa-default'), 'aaa-default', {
    expo: { ios: { bundleIdentifier: 'com.aaa' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  const resolver = _makeRecordingRootResolverForTest(undefined, 'load-list');
  assert.equal(resolver(), join(root, 'aaa-default'));
});

test("B144 Codex #2: default mode is 'save' (back-compat when caller omits mode)", () => {
  makeRnProject(join(root, 'captured-app'), 'captured-app', {
    expo: { ios: { bundleIdentifier: 'com.captured' } },
  });
  makeRnProject(join(root, 'live-app'), 'live-app', {
    expo: { ios: { bundleIdentifier: 'com.live' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  _setRecordingBundleId('com.captured');
  // Omit mode — should behave like 'save' (captured wins).
  const resolver = _makeRecordingRootResolverForTest(() => fakeClient('com.live'));
  assert.equal(resolver(), join(root, 'captured-app'));
});
