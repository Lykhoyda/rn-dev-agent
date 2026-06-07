import { test } from 'node:test';
import assert from 'node:assert/strict';

import { metroOrigin } from '../../dist/ws-origin.js';

/**
 * B177 (D1240): RN 0.85 / @react-native/dev-middleware 401s WebSocket
 * handshakes whose Origin hostname is not loopback. metroOrigin synthesizes a
 * loopback Origin matching the dev-server port so the header-less `ws` client
 * is accepted by the inspector proxy.
 */

test('metroOrigin: derives a loopback origin carrying the ws URL port', () => {
  assert.equal(
    metroOrigin('ws://localhost:8081/inspector/debug?device=abc&page=2'),
    'http://localhost:8081',
  );
});

test('metroOrigin: forces the localhost hostname even when the ws URL is a LAN IP', () => {
  assert.equal(
    metroOrigin('ws://192.168.18.51:8082/inspector/debug?device=abc&page=1'),
    'http://localhost:8082',
  );
});

test('metroOrigin: falls back to :8081 when the ws URL has no explicit port', () => {
  assert.equal(metroOrigin('ws://localhost/inspector/debug'), 'http://localhost:8081');
});

test('metroOrigin: falls back to a safe default on an unparseable input', () => {
  assert.equal(metroOrigin('not a url'), 'http://localhost:8081');
});
