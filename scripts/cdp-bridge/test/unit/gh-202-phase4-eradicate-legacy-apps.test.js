import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_BUNDLE_IDS,
  selectInstalledLegacyApps,
  eradicateLegacyRunnerApps,
} from '../../dist/runners/ensure-single-runner.js';
import { parseSimctlListapps } from '../../dist/cdp/discovery.js';

// Realistic `xcrun simctl listapps <udid>` excerpt (NeXTSTEP plist; top-level
// bundle-id keys at exactly 4-space indent — same shape parseSimctlListapps
// was field-verified against in B116/D639).
const LISTAPPS_WITH_LEGACY = [
  '{',
  '    "com.callstack.agentdevice.runner" =     {',
  '        ApplicationType = User;',
  '        Bundle = "file:///...";',
  '    };',
  '    "com.callstack.agentdevice.runner.uitests.xctrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '    "com.rndevagent.testapp" =     {',
  '        ApplicationType = User;',
  '        GroupContainers =         {',
  '        "group.com.callstack.agentdevice.runner" =             {',
  '        };',
  '    };',
  '    "dev.lykhoyda.rndevagent.fastrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '}',
].join('\n');

const LISTAPPS_CLEAN = [
  '{',
  '    "com.rndevagent.testapp" =     {',
  '        ApplicationType = User;',
  '    };',
  '    "dev.lykhoyda.rndevagent.fastrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '}',
].join('\n');

test('GH#202-P4 LEGACY_BUNDLE_IDS: exactly the two callstack runner bundles', () => {
  assert.deepEqual([...LEGACY_BUNDLE_IDS], [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 selectInstalledLegacyApps: finds installed legacy bundles, ignores nested keys and our own apps', () => {
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps(LISTAPPS_WITH_LEGACY)), [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 selectInstalledLegacyApps: empty on a clean simulator and on garbage input', () => {
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps(LISTAPPS_CLEAN)), []);
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps('')), []);
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps('not a plist at all')), []);
});

function appDeps(over = {}) {
  return {
    listApps: () => LISTAPPS_WITH_LEGACY,
    uninstallApp: () => {},
    ...over,
  };
}

// No separate `terminate` step (review-2 finding #4): `simctl uninstall`
// terminates a running app itself, and Phase 1's process-kill (scopedKill)
// has already run by the time eradication is reached.
test('GH#202-P4 eradicate: uninstalls every installed legacy bundle', async () => {
  const calls = [];
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    uninstallApp: (udid, id) => calls.push(`unin:${udid}:${id}`),
  }));
  assert.deepEqual(r.removedApps, [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls, [
    'unin:UDID-A:com.callstack.agentdevice.runner',
    'unin:UDID-A:com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 eradicate: clean simulator is a warning-free no-op', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({ listApps: () => LISTAPPS_CLEAN }));
  assert.deepEqual(r.removedApps, []);
  assert.deepEqual(r.warnings, []);
});

test('GH#202-P4 eradicate: uninstall failure -> warning with the manual command, other bundle still removed', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    uninstallApp: (udid, id) => {
      if (id === 'com.callstack.agentdevice.runner') throw new Error('Device busy');
    },
  }));
  assert.deepEqual(r.removedApps, ['com.callstack.agentdevice.runner.uitests.xctrunner']);
  assert.ok(r.warnings.some((w) => w.includes('xcrun simctl uninstall UDID-A com.callstack.agentdevice.runner')));
});

test('GH#202-P4 eradicate: listapps failure -> warning, no throw', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    listApps: () => { throw new Error('Invalid device state'); },
  }));
  assert.deepEqual(r.removedApps, []);
  assert.ok(r.warnings.some((w) => /listapps failed/.test(w)));
});

// Plan-review amendment (Gemini, 2026-06-10): a booted simulator ALWAYS has
// built-in system apps, so zero parsed bundle ids proves a parse/format
// failure (e.g. a future Xcode reformats listapps output away from the
// 4-space-indent plist parseSimctlListapps expects) — NOT a clean device.
// Surfacing it as a warning keeps the breakage visible instead of reading
// as "no legacy apps installed".
test('GH#202-P4 eradicate: zero parsed apps from a successful listapps -> parse-failure warning', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    listApps: () => 'totally reformatted output the parser cannot read',
  }));
  assert.deepEqual(r.removedApps, []);
  assert.ok(r.warnings.some((w) => /0 apps/.test(w)));
});
