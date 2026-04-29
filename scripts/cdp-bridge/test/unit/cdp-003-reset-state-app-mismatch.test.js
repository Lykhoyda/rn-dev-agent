// CDP-003: device_reset_state must refuse to mutate MMKV when the connected
// CDP target does not belong to args.appId. Otherwise multi-app / monorepo
// sessions can clear auth/session keys from a sibling app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpTargetMatchesApp } from '../../dist/tools/device-reset-state.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';

test('CDP-003: target description containing appId → matches', () => {
  const client = createMockClient({
    _connectedTarget: {
      id: 'p1', title: 'React Native (Hermes)', vm: 'Hermes',
      description: 'com.requested.app', platform: 'ios',
      webSocketDebuggerUrl: 'ws://x',
    },
  });
  assert.equal(cdpTargetMatchesApp(client, 'com.requested.app'), true);
});

test('CDP-003: target description with different appId → does NOT match', () => {
  const client = createMockClient({
    _connectedTarget: {
      id: 'p1', title: 'React Native (Hermes)', vm: 'Hermes',
      description: 'com.actual.app', platform: 'ios',
      webSocketDebuggerUrl: 'ws://x',
    },
  });
  assert.equal(cdpTargetMatchesApp(client, 'com.requested.app'), false,
    'must reject when target description does not contain requested appId');
});

test('CDP-003: case-insensitive match', () => {
  const client = createMockClient({
    _connectedTarget: {
      id: 'p1', title: 'COM.MIXED.CASE', vm: 'Hermes',
      description: '', platform: 'ios',
      webSocketDebuggerUrl: 'ws://x',
    },
  });
  assert.equal(cdpTargetMatchesApp(client, 'com.mixed.case'), true);
});

test('CDP-003: not connected → does not match (conservative default)', () => {
  const client = createMockClient({ _isConnected: false });
  assert.equal(cdpTargetMatchesApp(client, 'com.anything'), false);
});

test('CDP-003: null target → does not match', () => {
  const client = createMockClient({ _connectedTarget: null });
  assert.equal(cdpTargetMatchesApp(client, 'com.anything'), false);
});

test('CDP-003: empty description AND empty title → does not match', () => {
  const client = createMockClient({
    _connectedTarget: {
      id: 'p1', title: '', vm: 'Hermes', description: '', platform: 'ios',
      webSocketDebuggerUrl: 'ws://x',
    },
  });
  assert.equal(cdpTargetMatchesApp(client, 'com.anything'), false,
    'empty haystack must default to false rather than vacuously matching');
});
