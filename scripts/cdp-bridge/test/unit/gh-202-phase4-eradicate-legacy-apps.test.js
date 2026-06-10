import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_BUNDLE_IDS,
  selectInstalledLegacyApps,
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
