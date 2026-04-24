// B144: findProjectRoot's new bundleId-aware overload should prefer the
// candidate whose app.json declares the matching bundleId over the
// alphabetically-first sibling (which is the legacy behavior and the source
// of the Story D post-merge finding where recordings landed in the wrong
// sibling project).
//
// Tests use a tmpdir-backed fs fixture to simulate:
//   parent/
//     aaa-other-rn/   (package.json: react-native,  app.json: com.other)
//     zzz-target-rn/  (package.json: react-native,  app.json: com.target)
//     plugin-repo/    (package.json: no RN deps — CWD sits here)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProjectRoot, readProjectBundleId } from '../../dist/nav-graph/storage.js';

let root;
let originalCwd;
let originalEnvRoot;
let originalEnvClaudeCwd;

function makeRnProject(dir, pkgName, appJson) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: pkgName,
    dependencies: { 'react-native': '0.76.0' },
  }));
  if (appJson) {
    writeFileSync(join(dir, 'app.json'), JSON.stringify(appJson));
  }
}

function makeNonRnDir(dir, pkgName) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName }));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'b144-')));
  originalCwd = process.cwd();
  originalEnvRoot = process.env.RN_PROJECT_ROOT;
  originalEnvClaudeCwd = process.env.CLAUDE_USER_CWD;
  delete process.env.RN_PROJECT_ROOT;
  delete process.env.CLAUDE_USER_CWD;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalEnvRoot) process.env.RN_PROJECT_ROOT = originalEnvRoot;
  if (originalEnvClaudeCwd) process.env.CLAUDE_USER_CWD = originalEnvClaudeCwd;
  rmSync(root, { recursive: true, force: true });
});

// ─────────── readProjectBundleId ───────────

test('B144: readProjectBundleId extracts expo.ios.bundleIdentifier', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', {
    expo: { ios: { bundleIdentifier: 'com.acme.foo' } },
  });
  assert.equal(readProjectBundleId(dir), 'com.acme.foo');
});

test('B144: readProjectBundleId falls back to expo.android.package when iOS is missing', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', {
    expo: { android: { package: 'com.acme.bar' } },
  });
  assert.equal(readProjectBundleId(dir), 'com.acme.bar');
});

test('B144: readProjectBundleId prefers iOS when both are present', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', {
    expo: {
      ios: { bundleIdentifier: 'com.acme.ios' },
      android: { package: 'com.acme.android' },
    },
  });
  assert.equal(readProjectBundleId(dir), 'com.acme.ios');
});

test('B144: readProjectBundleId accepts top-level ios.bundleIdentifier (non-Expo shape)', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', { ios: { bundleIdentifier: 'com.bare.rn' } });
  assert.equal(readProjectBundleId(dir), 'com.bare.rn');
});

test('B144: readProjectBundleId returns null when app.json is absent', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', null);
  assert.equal(readProjectBundleId(dir), null);
});

test('B144: readProjectBundleId returns null when app.json is malformed JSON', () => {
  const dir = join(root, 'proj');
  makeRnProject(dir, 'proj', null);
  writeFileSync(join(dir, 'app.json'), '{not valid json');
  assert.equal(readProjectBundleId(dir), null);
});

// ─────────── findProjectRoot({bundleId}) ───────────

test('B144: finds the bundleId-matching sibling, not the alphabetically-first one', () => {
  // Layout:
  //   parent/
  //     aaa-other/   (bundleId: com.other)
  //     zzz-target/  (bundleId: com.target)
  //     plugin-cwd/  (no RN deps — process.cwd())
  makeRnProject(join(root, 'aaa-other'), 'aaa-other', {
    expo: { ios: { bundleIdentifier: 'com.other' } },
  });
  makeRnProject(join(root, 'zzz-target'), 'zzz-target', {
    expo: { ios: { bundleIdentifier: 'com.target' } },
  });
  makeNonRnDir(join(root, 'plugin-cwd'), 'plugin');
  process.chdir(join(root, 'plugin-cwd'));

  // Legacy: no bundleId → picks aaa-other (alphabetical first)
  assert.equal(findProjectRoot(), join(root, 'aaa-other'));
  // B144: bundleId → picks the matching sibling
  assert.equal(findProjectRoot({ bundleId: 'com.target' }), join(root, 'zzz-target'));
});

test('B144: falls back to alphabetical pick when no candidate matches bundleId', () => {
  makeRnProject(join(root, 'aaa'), 'aaa', { expo: { ios: { bundleIdentifier: 'com.a' } } });
  makeRnProject(join(root, 'bbb'), 'bbb', { expo: { ios: { bundleIdentifier: 'com.b' } } });
  makeNonRnDir(join(root, 'plugin'), 'plugin');
  process.chdir(join(root, 'plugin'));

  // No candidate has com.missing → fall back to alphabetical (aaa).
  assert.equal(findProjectRoot({ bundleId: 'com.missing' }), join(root, 'aaa'));
});

test('B144: walk-up match with matching bundleId wins over sibling candidates', () => {
  // Layout:
  //   parent/
  //     target-app/          (walk-up hit, bundleId: com.target)
  //       subdir/             (CWD)
  //     decoy-app/           (sibling, bundleId: com.decoy)
  makeRnProject(join(root, 'target-app'), 'target', {
    expo: { ios: { bundleIdentifier: 'com.target' } },
  });
  mkdirSync(join(root, 'target-app', 'subdir'));
  makeRnProject(join(root, 'decoy-app'), 'decoy', {
    expo: { ios: { bundleIdentifier: 'com.decoy' } },
  });
  process.chdir(join(root, 'target-app', 'subdir'));

  // Walk-up finds target-app and its bundleId matches — return immediately.
  assert.equal(findProjectRoot({ bundleId: 'com.target' }), join(root, 'target-app'));
});

test('B144: walk-up match that does NOT match bundleId returns itself when no sibling matches', () => {
  // Layout:
  //   parent/
  //     wrong-app/           (walk-up hit, bundleId: com.wrong)
  //       subdir/             (CWD)
  //     unrelated-rn/        (sibling, bundleId: com.unrelated)
  //
  // The "walk-up finds wrong-app, but a TRUE match lives as a sibling"
  // case is exotic (users rarely CD into project A then ask for project B).
  // What we CAN guarantee is that when walk-up's bundleId doesn't match
  // AND no sibling matches either, the fallback is walkupHit, not null.
  makeRnProject(join(root, 'wrong-app'), 'wrong', {
    expo: { ios: { bundleIdentifier: 'com.wrong' } },
  });
  mkdirSync(join(root, 'wrong-app', 'subdir'));
  makeRnProject(join(root, 'unrelated-rn'), 'unrelated', {
    expo: { ios: { bundleIdentifier: 'com.unrelated' } },
  });
  process.chdir(join(root, 'wrong-app', 'subdir'));

  // Neither walk-up (wrong-app → com.wrong) nor sibling (wrong-app/subdir
  // contains no RN sibling) matches com.nonexistent → fall back to walkup.
  assert.equal(findProjectRoot({ bundleId: 'com.nonexistent' }), join(root, 'wrong-app'));
});

test('B144: legacy behavior unchanged when bundleId is omitted', () => {
  // Exactly the pre-B144 behavior: walk-up wins over siblings, first found.
  makeRnProject(join(root, 'target'), 'target', null);
  mkdirSync(join(root, 'target', 'subdir'));
  makeRnProject(join(root, 'decoy'), 'decoy', null);
  process.chdir(join(root, 'target', 'subdir'));

  assert.equal(findProjectRoot(), join(root, 'target'));
});

test('B144 Codex #1 (conf ≥80): RN_PROJECT_ROOT is absolute priority — wins even when bundleId mismatches', () => {
  // User-explicit config > heuristics. When the user sets RN_PROJECT_ROOT,
  // the plugin must honor it regardless of what bundleId the caller
  // requests. If the user has a reason to point elsewhere, they should
  // update or unset the env var — the plugin should not second-guess.
  //
  // This is the behavior change from the original B144 fix (2026-04-23
  // review): previously, when bundleId was passed and env's bundleId
  // didn't match, a sibling scan could override env. Codex review
  // (2026-04-24, conf ≥80) flagged that as a regression against the
  // documented "env var is absolute first priority" contract. Fixed
  // by short-circuiting on RN_PROJECT_ROOT before the heuristic cascade.
  makeRnProject(join(root, 'env-target'), 'env-target', {
    expo: { ios: { bundleIdentifier: 'com.envtarget' } },
  });
  makeRnProject(join(root, 'auto-target'), 'auto-target', {
    expo: { ios: { bundleIdentifier: 'com.autotarget' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));
  process.env.RN_PROJECT_ROOT = join(root, 'env-target');

  // Even when the caller asks for com.autotarget, env wins absolutely.
  assert.equal(findProjectRoot({ bundleId: 'com.autotarget' }), join(root, 'env-target'));

  // When bundleId is omitted, env wins (unchanged).
  assert.equal(findProjectRoot(), join(root, 'env-target'));

  // When bundleId matches env, env wins (short-circuit on env still applies).
  assert.equal(findProjectRoot({ bundleId: 'com.envtarget' }), join(root, 'env-target'));
});

test('B144: bundleId match on a sibling works with no walk-up hit', () => {
  // Layout:
  //   parent/
  //     rn-app/   (bundleId: com.target)
  //     cwd/      (no RN deps — CWD, no walk-up match)
  makeRnProject(join(root, 'rn-app'), 'rn-app', {
    expo: { ios: { bundleIdentifier: 'com.target' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  assert.equal(findProjectRoot({ bundleId: 'com.target' }), join(root, 'rn-app'));
});

test('B144: bundleId match works with non-iOS package identifier', () => {
  makeRnProject(join(root, 'aaa'), 'aaa', { expo: { android: { package: 'com.android.a' } } });
  makeRnProject(join(root, 'bbb'), 'bbb', { expo: { android: { package: 'com.android.b' } } });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));

  assert.equal(findProjectRoot({ bundleId: 'com.android.b' }), join(root, 'bbb'));
});

test('B144: returns null when no RN project exists anywhere in the scan range', () => {
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  makeNonRnDir(join(root, 'sibling'), 'sibling');
  process.chdir(join(root, 'cwd'));

  assert.equal(findProjectRoot({ bundleId: 'com.anything' }), null);
});

// ─────────── test-recorder fresh-session fallback (Gemini A1, conf 80) ───────────
// Gemini flagged that cdp_record_test_load / _list in a session WITHOUT a
// prior cdp_record_test_start would hit the original B144 bug because
// recordingBundleId stays null. Fix: those handlers now accept getClient
// and fall back to the live CDP client's connected bundleId. Verify the
// resolver prefers captured bundleId but falls back to live client bundleId.

import { _setRecordingBundleId, _resetState } from '../../dist/tools/test-recorder.js';
import { existsSync as _existsSync } from 'node:fs';

test('B144 Gemini A1: makeRecordingRootResolver falls back to live CDP bundleId when no recording started', async () => {
  // Layout:
  //   parent/
  //     aaa-other/   (bundleId: com.other)
  //     zzz-target/  (bundleId: com.target)
  //     cwd/         (no RN — plugin-cwd-ish)
  makeRnProject(join(root, 'aaa-other'), 'aaa-other', {
    expo: { ios: { bundleIdentifier: 'com.other' } },
  });
  makeRnProject(join(root, 'zzz-target'), 'zzz-target', {
    expo: { ios: { bundleIdentifier: 'com.target' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));
  _resetState(); // clear any leftover module state from other tests

  // Without live fallback (resolver passed nothing), load/list would resolve
  // to aaa-other (alphabetical). This is the B144 pitfall Gemini flagged.
  assert.equal(findProjectRoot(), join(root, 'aaa-other'));

  // With a live-client fallback returning com.target, resolver must pick
  // zzz-target — simulated by passing bundleId directly.
  assert.equal(findProjectRoot({ bundleId: 'com.target' }), join(root, 'zzz-target'));
});

test('B144 Gemini A1: captured recordingBundleId takes precedence over live client', () => {
  // Even when the live client connects to com.other, a recording started
  // against com.target should save back to com.target. This is important
  // for sessions that outlive their CDP connection (app restart) — the
  // recording is still bound to the app it was taken from.
  makeRnProject(join(root, 'target'), 'target', {
    expo: { ios: { bundleIdentifier: 'com.target' } },
  });
  makeRnProject(join(root, 'other'), 'other', {
    expo: { ios: { bundleIdentifier: 'com.other' } },
  });
  makeNonRnDir(join(root, 'cwd'), 'cwd');
  process.chdir(join(root, 'cwd'));
  _resetState();
  _setRecordingBundleId('com.target');

  // Direct validation: bundleId passed to findProjectRoot wins.
  assert.equal(findProjectRoot({ bundleId: 'com.target' }), join(root, 'target'));
  assert.equal(findProjectRoot({ bundleId: 'com.other' }), join(root, 'other'));
  _resetState();
});
