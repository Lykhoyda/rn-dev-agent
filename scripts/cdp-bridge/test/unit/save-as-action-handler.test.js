// Issue #103 — handler integration tests for cdp_record_test_save_as_action.
//
// Covers the I/O orchestration that pure-helper unit tests can't reach:
// real filesystem fixtures, the M7 metadata round-trip, the
// pre-existing-file refusal path, and the #101 atomicity guarantee
// (sidecar-first ordering + future-mtime buffer).

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSaveAsActionHandler } from '../../dist/tools/save-as-action.js';
import {
  _setStoredEvents,
  _setRecordingStartRoute,
  _resetState,
} from '../../dist/tools/test-recorder.js';
import { atomicWriter } from '../../dist/domain/atomic-writer.js';
import { yamlEditedSinceLastSeen } from '../../dist/domain/sidecar-io.js';
import { loadAction } from '../../dist/domain/action-store.js';
import { parseM7Header } from '../../dist/domain/reusable-action.js';
import { createTmpProject } from '../helpers/tmp-project.js';

const SAMPLE_EVENTS = [
  { type: 'tap', testID: 'fab-create-task', label: null, route: 'home', t: 0 },
  { type: 'type', testID: 'input-title', label: null, value: 'My task', route: 'wizard', t: 100 },
  { type: 'tap', testID: 'btn-save', label: null, route: 'wizard', t: 200 },
];

let project;
let mockTracker;

beforeEach(() => {
  project = createTmpProject();
  _resetState();
  mockTracker = { restore: () => {} };
});

afterEach(() => {
  mockTracker.restore();
  mock.reset();
  _resetState();
  project.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

test('save-as-action: happy path emits YAML + sidecar with M7 metadata', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  _setRecordingStartRoute('home');

  const handler = createSaveAsActionHandler();
  const result = await handler({
    id: 'create-task-flow',
    intent: 'create a new task via the wizard',
    tags: ['wizard', 'tasks'],
    mutates: true,
    bundleId: 'com.test.app',
    projectRoot: project.root,
  });

  assert.equal(result.isError, undefined, `expected ok result, got ${result.content[0].text}`);
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.created, true);
  assert.equal(envelope.data.overwritten, false);
  assert.equal(envelope.data.actionId, 'create-task-flow');
  assert.equal(envelope.data.eventCount, 3);

  // Files exist on disk.
  assert.ok(project.yamlExists('create-task-flow'), 'YAML should exist');
  assert.ok(project.sidecarExists('create-task-flow'), 'sidecar should exist');

  // M7 header round-trips. (appId lives in the Maestro top section
  // before `---`, not in the M7 comment block, so check it separately.)
  const yaml = project.readYaml('create-task-flow');
  assert.match(yaml, /^appId:\s+com\.test\.app/m, 'top-level appId should be present');
  const parsed = parseM7Header(yaml);
  assert.ok(parsed, 'M7 header should parse');
  assert.equal(parsed.id, 'create-task-flow');
  assert.equal(parsed.intent, 'create a new task via the wizard');
  assert.deepEqual(parsed.tags, ['wizard', 'tasks']);
  assert.equal(parsed.mutates, true);
  assert.equal(parsed.status, 'experimental');

  // Sidecar shape is valid.
  const sidecar = project.readSidecar('create-task-flow');
  assert.equal(sidecar.schemaVersion, 1);
  assert.equal(sidecar.revision, 1);
  assert.ok(sidecar.lastSeenMtimeMs > 0, 'lastSeenMtimeMs should be seeded');
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation paths
// ─────────────────────────────────────────────────────────────────────────────

test('save-as-action: missing id returns BAD_FILENAME', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  const handler = createSaveAsActionHandler();
  const result = await handler({
    intent: 'no id supplied',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
  assert.match(env.error, /requires id/);
});

test('save-as-action: missing intent returns BAD_FILENAME', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  const handler = createSaveAsActionHandler();
  const result = await handler({
    id: 'no-intent',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
  assert.match(env.error, /requires intent/);
});

test('save-as-action: id regex rejects path-traversal vectors', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  const handler = createSaveAsActionHandler();
  const malicious = ['../escape', 'with/slash', 'with.dot', 'UPPER', 'with_under', '-leading-hyphen'];
  for (const id of malicious) {
    const result = await handler({
      id,
      intent: 'attempt traversal',
      projectRoot: project.root,
    });
    assert.equal(result.isError, true, `id "${id}" should be rejected`);
    const env = JSON.parse(result.content[0].text);
    assert.equal(env.code, 'BAD_FILENAME');
    assert.match(env.error, /must be lower-case kebab-case/);
  }
});

test('save-as-action: empty buffer returns NO_EVENTS', async () => {
  _setStoredEvents([]); // explicit empty
  const handler = createSaveAsActionHandler();
  const result = await handler({
    id: 'no-events',
    intent: 'try with empty buffer',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'NO_EVENTS');
});

test('save-as-action: null buffer (recorder never started) returns NO_EVENTS', async () => {
  // _resetState() in beforeEach leaves storedEvents = null
  const handler = createSaveAsActionHandler();
  const result = await handler({
    id: 'no-events',
    intent: 'try with null buffer',
    projectRoot: project.root,
  });
  assert.equal(result.isError, true);
  const env = JSON.parse(result.content[0].text);
  assert.equal(env.code, 'NO_EVENTS');
});

// ─────────────────────────────────────────────────────────────────────────────
// Overwrite semantics
// ─────────────────────────────────────────────────────────────────────────────

test('save-as-action: duplicate id without overwrite refuses', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  _setRecordingStartRoute('home');
  const handler = createSaveAsActionHandler();

  const args = {
    id: 'duplicate-id',
    intent: 'first call wins',
    bundleId: 'com.test.app',
    projectRoot: project.root,
  };
  const first = await handler(args);
  assert.equal(first.isError, undefined, 'first call should succeed');

  const second = await handler(args);
  assert.equal(second.isError, true, 'second call without overwrite should fail');
  const env = JSON.parse(second.content[0].text);
  assert.equal(env.code, 'BAD_FILENAME');
  assert.match(env.error, /already exists/);
});

test('save-as-action: duplicate id with overwrite=true succeeds and reports overwritten:true', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  _setRecordingStartRoute('home');
  const handler = createSaveAsActionHandler();

  await handler({
    id: 'overwrite-me',
    intent: 'first version',
    bundleId: 'com.test.app',
    projectRoot: project.root,
  });

  const second = await handler({
    id: 'overwrite-me',
    intent: 'second version',
    bundleId: 'com.test.app',
    projectRoot: project.root,
    overwrite: true,
  });
  assert.equal(second.isError, undefined, 'overwrite=true should succeed');
  const env = JSON.parse(second.content[0].text);
  assert.equal(env.ok, true);
  assert.equal(env.data.created, false);
  assert.equal(env.data.overwritten, true);

  // Verify the YAML now reflects the second intent.
  const yaml = project.readYaml('overwrite-me');
  assert.match(yaml, /intent:\s+second version/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Atomicity (#101 regression test) — sidecar-first ordering must keep
// `actionWasEditedExternally` returning false even when the second
// (YAML) write fails after the (sidecar) first one succeeded.
// ─────────────────────────────────────────────────────────────────────────────

test('save-as-action: when YAML write fails after sidecar succeeds, no false-positive external-edit alarm', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  _setRecordingStartRoute('home');

  // Stub the writer to fail when writing the YAML's .tmp file. The
  // sidecar write happens first (sidecar-first ordering) and should
  // succeed; the YAML write then fails. Per #101's required invariant,
  // the persisted sidecar should hold a `lastSeenMtimeMs` ≥ the (still
  // pre-existing or absent) YAML mtime, so a follow-up edit-detection
  // call returns false.
  const realWriteFile = atomicWriter._writeFile.bind(atomicWriter);
  const stub = mock.method(atomicWriter, '_writeFile', (path, content) => {
    if (path.endsWith('.yaml.tmp')) {
      throw new Error('SIMULATED_DISK_FULL: yaml write failed');
    }
    return realWriteFile(path, content);
  });

  const handler = createSaveAsActionHandler();

  // Handler will throw because pairWrite throws — that's OK, the test
  // is about post-failure state, not graceful error handling here
  // (the issue's explicit goal is "verify recovery", not "verify the
  // failure is wrapped in failResult").
  await assert.rejects(
    handler({
      id: 'partial-fail',
      intent: 'verify atomicity',
      bundleId: 'com.test.app',
      projectRoot: project.root,
    }),
    /SIMULATED_DISK_FULL/,
  );

  // YAML must NOT exist on disk — the .tmp write failed before rename.
  assert.equal(project.yamlExists('partial-fail'), false, 'YAML should not be present after partial failure');

  // Sidecar exists (step 1+2 succeeded). Its lastSeenMtimeMs is the
  // projected future mtime (≥ Date.now()) — so a subsequent
  // yamlEditedSinceLastSeen() call against any future YAML creation
  // would see lastSeenMtimeMs ahead, suppressing a false alarm.
  assert.equal(project.sidecarExists('partial-fail'), true, 'sidecar should exist with projected mtime');
  const sidecar = project.readSidecar('partial-fail');
  assert.ok(
    sidecar.lastSeenMtimeMs >= Date.now() - 1_000,
    `expected projected lastSeenMtimeMs near now or future, got ${sidecar.lastSeenMtimeMs}`,
  );

  // Restore writer, reset mocks, simulate recovery: a subsequent call
  // with the same id should succeed cleanly (action correctly considered
  // absent and creatable).
  stub.mock.restore();

  const handler2 = createSaveAsActionHandler();
  const recovery = await handler2({
    id: 'partial-fail',
    intent: 'verify atomicity',
    bundleId: 'com.test.app',
    projectRoot: project.root,
  });
  assert.equal(recovery.isError, undefined, 'recovery call should succeed');
  const recEnv = JSON.parse(recovery.content[0].text);
  assert.equal(recEnv.data.created, true, 'recovery should report created:true (YAML was absent)');
  assert.ok(project.yamlExists('partial-fail'));

  // The fresh action loaded back must NOT be considered externally edited.
  const action = loadAction(project.root, 'partial-fail');
  assert.ok(action, 'recovered action should load');
  assert.equal(
    yamlEditedSinceLastSeen(action.filePath, action.state),
    false,
    'no false-positive external-edit alarm after partial failure + recovery',
  );
});

test('save-as-action: when sidecar write fails first, nothing is persisted and a retry can succeed', async () => {
  _setStoredEvents(SAMPLE_EVENTS);
  _setRecordingStartRoute('home');

  // Fail on the very first write — the sidecar.tmp.
  let failedOnce = false;
  const realWriteFile = atomicWriter._writeFile.bind(atomicWriter);
  const stub = mock.method(atomicWriter, '_writeFile', (path, content) => {
    if (!failedOnce && path.endsWith('.state.json.tmp')) {
      failedOnce = true;
      throw new Error('SIMULATED_DISK_FULL: sidecar write failed');
    }
    return realWriteFile(path, content);
  });

  const handler = createSaveAsActionHandler();
  await assert.rejects(
    handler({
      id: 'sidecar-fail',
      intent: 'verify atomicity',
      bundleId: 'com.test.app',
      projectRoot: project.root,
    }),
    /SIMULATED_DISK_FULL/,
  );

  // Neither file should exist — the operation aborted before either rename.
  assert.equal(project.yamlExists('sidecar-fail'), false);
  assert.equal(project.sidecarExists('sidecar-fail'), false);

  // Retry succeeds (the stub has already let `failedOnce` flip, so subsequent
  // calls fall through to the real writer).
  stub.mock.restore();
  const recovery = await handler({
    id: 'sidecar-fail',
    intent: 'verify atomicity',
    bundleId: 'com.test.app',
    projectRoot: project.root,
  });
  assert.equal(recovery.isError, undefined, 'retry should succeed cleanly');
});
