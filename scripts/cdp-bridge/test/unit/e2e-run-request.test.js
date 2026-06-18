import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  writeRequest,
  updateRequest,
  loadRequest,
  listRequests,
  recoverInterruptedRequests,
} from '../../dist/domain/e2e-run-request.js';

const NOW = () => new Date('2026-06-18T00:00:00Z');
function req(runId, status, pid) {
  return {
    runId,
    status,
    pid,
    createdAt: '2026-06-18T00:00:00Z',
    updatedAt: '2026-06-18T00:00:00Z',
  };
}

test('write → update → load reflects status + progress transitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-req-'));
  try {
    writeRequest(root, req('run-1', 'requested', process.pid));
    updateRequest(root, 'run-1', { status: 'running', progress: { total: 3, completed: 1 } });
    const loaded = loadRequest(root, 'run-1');
    assert.equal(loaded.status, 'running');
    assert.equal(loaded.progress.completed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover marks running-with-dead-pid interrupted; leaves live + terminal alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-req-'));
  try {
    writeRequest(root, req('dead', 'running', 99999));
    writeRequest(root, req('live', 'running', process.pid));
    writeRequest(root, req('done', 'done', 99999));
    const affected = recoverInterruptedRequests(root, (pid) => pid === process.pid, NOW);
    assert.deepEqual(affected, ['dead']);
    assert.equal(loadRequest(root, 'dead').status, 'interrupted');
    assert.equal(loadRequest(root, 'live').status, 'running');
    assert.equal(loadRequest(root, 'done').status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listRequests and recoverInterruptedRequests tolerate invalid/corrupt filenames', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-req-'));
  try {
    writeRequest(root, req('valid-run', 'running', 99999));
    // Drop a file whose stem contains a space — assertValidActionId will throw on it
    const reqsDir = join(root, '.rn-agent', 'state', 'e2e-runs', 'requests');
    writeFileSync(join(reqsDir, 'bad id.json'), '{}', 'utf8');
    // Must not throw; must return only the valid entry
    const results = listRequests(root);
    assert.equal(results.length, 1);
    assert.equal(results[0].runId, 'valid-run');
    // recoverInterruptedRequests must also not throw
    assert.doesNotThrow(() => recoverInterruptedRequests(root, () => false, NOW));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
