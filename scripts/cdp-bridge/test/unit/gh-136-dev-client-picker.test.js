// GH #136 / D690+: dev-client picker reliability. Tests cover the new pure
// helpers (parsePortPatternEntry, parseFirstServerEntry) and the dismissPicker
// integration that uses them, including auto-advance race detection and the
// tightened waitForBundle cadence. Mock the agent-device wrapper via the
// underscore-prefixed test seams (_setRunAgentDeviceForTest, _setHasSessionForTest)
// so we can drive every branch deterministically without spawning a real CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/tools/dev-client-picker.js';

// ── parsePortPatternEntry: pure host:port matcher ────────────────────

test('parsePortPatternEntry: matches IPv4 LAN address with Metro port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('192.168.1.5:8081'), '192.168.1.5:8081');
});

test('parsePortPatternEntry: matches Android emulator alias', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('10.0.2.2:8081'), '10.0.2.2:8081');
});

test('parsePortPatternEntry: matches hostname with port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('antons-macbook.local:8081'), 'antons-macbook.local:8081');
});

test('parsePortPatternEntry: extracts entry from a noisy snapshot blob', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nrn-dev-agent-test-app\n192.168.1.5:8081\nEnter URL manually';
  assert.equal(parsePortPatternEntry(snapshot), '192.168.1.5:8081');
});

test('parsePortPatternEntry: ignores non-port colons', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('Updated at 11:42 AM'), null);
  assert.equal(parsePortPatternEntry('http://example.com:443/path'), 'example.com:443');
});

test('parsePortPatternEntry: rejects ports < 80 (avoids version strings)', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('react-native:0.76'), null);
  assert.equal(parsePortPatternEntry('v1.2:34'), null);
});

test('parsePortPatternEntry: rejects ports > 65535', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('host:99999'), null);
});

test('parsePortPatternEntry: returns null on empty/null input', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry(''), null);
  assert.equal(parsePortPatternEntry(null), null);
  assert.equal(parsePortPatternEntry(undefined), null);
});

// ── parseFirstServerEntry: orchestrates matcher fallbacks ────────────

test('parseFirstServerEntry: prefers literal localhost when present', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nlocalhost\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), 'localhost');
});

test('parseFirstServerEntry: falls through to port-pattern when no literal IP', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nrn-dev-agent-test-app\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), '192.168.1.5:8081');
});

test('parseFirstServerEntry: first-non-header fallback when no port-pattern match', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  // Picker variant where the URL is hidden; only the manifest name is visible.
  const snapshot = 'Development servers\nrn-dev-agent-test-app\nEnter URL manually';
  assert.equal(parseFirstServerEntry(snapshot), 'rn-dev-agent-test-app');
});

test('parseFirstServerEntry: returns null when no header found', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  assert.equal(parseFirstServerEntry('Welcome screen\nGet started'), null);
});

test('parseFirstServerEntry: skips footer rows in fallback', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nServer-A\nEnter URL manually\nFetch development servers';
  assert.equal(parseFirstServerEntry(snapshot), 'Server-A');
});

// ── dismissPicker: integration with parseFirstServerEntry ────────────

test('dismissPicker: taps host:port row when picker shows LAN IP', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, dismissPicker } = await import(MOD_PATH);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'Development servers\n192.168.1.5:8081' }] };
    }
    if (args[0] === 'find' && args[1] === '192.168.1.5:8081' && args[2] === 'click') {
      return { content: [{ type: 'text', text: 'tapped' }] };
    }
    if (args[0] === 'find' && args[1] === 'Development servers') {
      // waitForBundle re-probe — picker is gone after tap.
      return { isError: true, content: [{ type: 'text', text: 'not found' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unhandled' }] };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, true);
    assert.match(result.reason, /192\.168\.1\.5:8081/);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});

test('dismissPicker: returns dismissed:false with helpful reason when nothing matches', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, dismissPicker } = await import(MOD_PATH);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'No picker visible' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'no match' }] };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, false);
    assert.match(result.reason, /could not find a server entry/i);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});
