import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flowUsesClearState,
  resolveIosAppFile,
} from '../../dist/tools/resolve-ios-app-file.js';

test('GH#201 flowUsesClearState detects clearState: true', () => {
  assert.equal(flowUsesClearState('- launchApp:\n    clearState: true\n'), true);
  assert.equal(flowUsesClearState('- launchApp:\n    clearState:   true'), true);
  assert.equal(flowUsesClearState('- tapOn: Login\n'), false);
  assert.equal(flowUsesClearState('clearState: false'), false);
});

test('GH#201 resolveIosAppFile returns the simctl container path when it exists', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: (id) => (id === 'com.example.app' ? '/sim/MyApp.app' : null),
    exists: (p) => p === '/sim/MyApp.app',
    newestDerivedDataApp: () => assert.fail('should not fall back when container resolves'),
  });
  assert.equal(got, '/sim/MyApp.app');
});

test('GH#201 resolveIosAppFile falls back to newest DerivedData .app', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
    exists: (p) => p === '/dd/Build/Products/Debug-iphonesimulator/MyApp.app',
  });
  assert.equal(got, '/dd/Build/Products/Debug-iphonesimulator/MyApp.app');
});

test('GH#201 resolveIosAppFile returns null when nothing is found', () => {
  const got = resolveIosAppFile('com.example.app', {
    getAppContainer: () => null,
    newestDerivedDataApp: () => null,
    exists: () => false,
  });
  assert.equal(got, null);
});
