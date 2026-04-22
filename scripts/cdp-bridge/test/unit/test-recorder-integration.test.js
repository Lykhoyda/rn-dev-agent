// M6 / Phase 112: integration tests — handler + mock client + envelope.
//
// Pattern mirrors metro-clear-hint-integration.test.js: createMockClient with
// a bespoke `evaluate` stub per test, then run the handler factory and assert
// the parsed envelope. Module-level storedEvents is reset between tests via
// _resetState to avoid cross-test contamination.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk, expectFail, parseEnvelope } from '../helpers/result-helpers.js';
import {
  createRecordTestStartHandler,
  createRecordTestStopHandler,
  createRecordTestGenerateHandler,
  createRecordTestAnnotateHandler,
  createRecordTestSaveHandler,
  createRecordTestLoadHandler,
  createRecordTestListHandler,
  _resetState,
  _setStoredEvents,
  _getStoredEvents,
} from '../../dist/tools/test-recorder.js';

function makeClient(evaluateStub) {
  const client = createMockClient({});
  client.evaluate = evaluateStub;
  return client;
}

test('M6 start: fails DEV_MODE_REQUIRED when __DEV__ is false', async () => {
  _resetState();
  const client = makeClient(async (expr) => {
    if (expr.includes('__DEV__')) return { value: false };
    return { value: 'unexpected' };
  });
  const handler = createRecordTestStartHandler(() => client);
  const env = parseEnvelope(await handler({}));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'DEV_MODE_REQUIRED');
  assert.match(env.error, /__DEV__=true/);
});

test('M6 start: succeeds with activeRoute parsed from JSON envelope', async () => {
  _resetState();
  const client = makeClient(async (expr) => {
    if (expr.includes('__DEV__')) return { value: true };
    if (expr.includes('Object.freeze')) {
      return { value: JSON.stringify({ ok: true, alreadyRunning: false, activeRoute: 'Home' }) };
    }
    // Freshness probe
    return { value: 16 };
  });
  const handler = createRecordTestStartHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.started, true);
  assert.equal(data.activeRoute, 'Home');
  assert.equal(data.alreadyRunning, false);
});

test('M6 start: surfaces alreadyRunning when interceptor reports it', async () => {
  _resetState();
  const client = makeClient(async (expr) => {
    if (expr.includes('__DEV__')) return { value: true };
    if (expr.includes('Object.freeze')) {
      return { value: JSON.stringify({ ok: true, alreadyRunning: true, activeRoute: 'Settings' }) };
    }
    return { value: 16 };
  });
  const handler = createRecordTestStartHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.alreadyRunning, true);
  assert.equal(data.activeRoute, 'Settings');
});

test('M6 stop: deduplicates + populates typeCounts + truncated flag', async () => {
  _resetState();
  const fakeEvents = [
    { type: 'tap', testID: 'btn', t: 1000 },
    { type: 'tap', testID: 'btn', t: 1050 }, // dedup window
    { type: 'type', testID: 'email', value: 'a',     t: 1100 },
    { type: 'type', testID: 'email', value: 'a@b',   t: 1110 },
    { type: 'type', testID: 'email', value: 'a@b.c', t: 1120 },
    { type: 'navigate', from: 'Login', to: 'Home',   t: 1200 },
  ];
  const client = makeClient(async (expr) => {
    if (expr.includes('__METRO_MCP_REC_CLEANUP__')) {
      return { value: JSON.stringify({ ok: true, events: fakeEvents, truncated: true }) };
    }
    return { value: 16 };
  });
  const handler = createRecordTestStopHandler(() => client);
  const data = expectOk(await handler({}));
  assert.equal(data.stopped, true);
  assert.equal(data.truncated, true);
  // After dedup: 1 tap (collapsed), 1 type (latest only), 1 navigate
  assert.equal(data.eventCount, 3);
  assert.deepEqual(data.typeCounts, { tap: 1, type: 1, navigate: 1 });
});

test('M6 generate: NO_EVENTS error when buffer is empty', async () => {
  _resetState();
  const handler = createRecordTestGenerateHandler();
  const env = parseEnvelope(await handler({ format: 'maestro' }));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'NO_EVENTS');
});

test('M6 generate: appium returns NOT_IMPLEMENTED', async () => {
  _setStoredEvents([{ type: 'tap', testID: 'x', t: 1 }]);
  const handler = createRecordTestGenerateHandler();
  const env = parseEnvelope(await handler({ format: 'appium' }));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'NOT_IMPLEMENTED');
  _resetState();
});

test('M6 generate: maestro round-trip produces expected YAML', async () => {
  _setStoredEvents([
    { type: 'tap',      testID: 'login-btn', t: 1 },
    { type: 'type',     testID: 'email',     value: 'a@b.c', t: 2 },
    { type: 'submit',   testID: 'email',     t: 3 },
    { type: 'navigate', from: 'Login', to: 'Home', t: 4 },
    { type: 'tap',      testID: 'home-greeting', t: 5 },
  ]);
  const handler = createRecordTestGenerateHandler();
  const data = expectOk(await handler({ format: 'maestro', testName: 'Login flow', bundleId: 'com.x.app' }));
  assert.equal(data.format, 'maestro');
  assert.equal(data.eventCount, 5);
  assert.match(data.text, /appId: com\.x\.app/);
  assert.match(data.text, /# Login flow/);
  assert.match(data.text, /- launchApp/);
  assert.match(data.text, /- tapOn:\s+id: "login-btn"/);
  assert.match(data.text, /- inputText: "a@b\.c"/);
  assert.match(data.text, /- pressKey: Enter/);
  assert.match(data.text, /- assertVisible:\s+id: "home-greeting"/);
  _resetState();
});

test('M6 generate: detox round-trip produces expected JS', async () => {
  _setStoredEvents([
    { type: 'tap',  testID: 'login-btn', t: 1 },
    { type: 'type', testID: 'email',     value: 'a@b.c', t: 2 },
  ]);
  const handler = createRecordTestGenerateHandler();
  const data = expectOk(await handler({ format: 'detox' }));
  assert.equal(data.format, 'detox');
  assert.match(data.text, /describe\("Recorded flow"/);
  assert.match(data.text, /await element\(by\.id\("login-btn"\)\)\.tap\(\)/);
  assert.match(data.text, /await element\(by\.id\("email"\)\)\.typeText\("a@b\.c"\)/);
  _resetState();
});

test('M6 annotate: fails NOT_RECORDING when recording is inactive', async () => {
  _resetState();
  const client = makeClient(async (expr) => {
    if (expr.includes('__DEV__')) return { value: true };
    if (expr.includes('annotation')) {
      return { value: JSON.stringify({ ok: false, error: 'Recording is not active' }) };
    }
    return { value: 16 };
  });
  const handler = createRecordTestAnnotateHandler(() => client);
  const env = parseEnvelope(await handler({ note: 'reached checkout' }));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'NOT_RECORDING');
});

test('M6 annotate: succeeds during active recording', async () => {
  _resetState();
  const client = makeClient(async (expr) => {
    if (expr.includes('__DEV__')) return { value: true };
    if (expr.includes('annotation')) {
      return { value: JSON.stringify({ ok: true }) };
    }
    return { value: 16 };
  });
  const handler = createRecordTestAnnotateHandler(() => client);
  const data = expectOk(await handler({ note: 'reached checkout' }));
  assert.equal(data.annotated, true);
});

test('M6 save: NO_EVENTS when nothing recorded', async () => {
  _resetState();
  const handler = createRecordTestSaveHandler();
  const env = parseEnvelope(await handler({ filename: 'foo' }));
  assert.equal(env.ok, false);
  assert.equal(env.code, 'NO_EVENTS');
});

test('M6 save → load round-trip restores events', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'm6-save-'));
  process.env.RN_PROJECT_ROOT = tmp;
  // findProjectRoot() requires an isRnProject signal — fake one cheaply.
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'fake', dependencies: { 'react-native': '*' } }));
  try {
    _setStoredEvents([
      { type: 'tap',  testID: 'btn',   t: 1 },
      { type: 'type', testID: 'email', value: 'a@b.c', t: 2 },
    ]);
    const saveData = expectOk(await createRecordTestSaveHandler()({ filename: 'login.json' }));
    assert.equal(saveData.saved, true);
    assert.equal(saveData.eventCount, 2);
    assert.match(saveData.path, /\.rn-agent\/recordings\/login\.json$/);

    _resetState();
    const loadData = expectOk(await createRecordTestLoadHandler()({ filename: 'login' }));
    assert.equal(loadData.loaded, true);
    assert.equal(loadData.eventCount, 2);
    assert.deepEqual(loadData.typeCounts, { tap: 1, type: 1 });
    const stored = _getStoredEvents();
    assert.equal(stored.length, 2);
    assert.equal(stored[0].testID, 'btn');
  } finally {
    delete process.env.RN_PROJECT_ROOT;
    await rm(tmp, { recursive: true, force: true });
    _resetState();
  }
});

test('M6 list: returns sorted recording names without .json suffix', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'm6-list-'));
  process.env.RN_PROJECT_ROOT = tmp;
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'fake', dependencies: { 'react-native': '*' } }));
  await mkdir(join(tmp, '.rn-agent', 'recordings'), { recursive: true });
  await writeFile(join(tmp, '.rn-agent', 'recordings', 'zebra.json'), '[]');
  await writeFile(join(tmp, '.rn-agent', 'recordings', 'alpha.json'), '[]');
  await writeFile(join(tmp, '.rn-agent', 'recordings', 'ignore.txt'), 'noise');
  try {
    const data = expectOk(await createRecordTestListHandler()({}));
    assert.deepEqual(data.files, ['alpha', 'zebra']);
  } finally {
    delete process.env.RN_PROJECT_ROOT;
    await rm(tmp, { recursive: true, force: true });
  }
});

test('M6 load: LOAD_FAILED when file missing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'm6-loadfail-'));
  process.env.RN_PROJECT_ROOT = tmp;
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'fake', dependencies: { 'react-native': '*' } }));
  try {
    const env = parseEnvelope(await createRecordTestLoadHandler()({ filename: 'nope' }));
    assert.equal(env.ok, false);
    assert.equal(env.code, 'LOAD_FAILED');
  } finally {
    delete process.env.RN_PROJECT_ROOT;
    await rm(tmp, { recursive: true, force: true });
  }
});
