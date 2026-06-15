import { test } from 'node:test'; import assert from 'node:assert/strict';
import * as w from '../../dist/agent-device-wrapper.js';
test('runNative exported; runAgentDevice is a transition alias', () => {
  assert.equal(typeof w.runNative, 'function');
  assert.equal(w.runAgentDevice, w.runNative);
});
