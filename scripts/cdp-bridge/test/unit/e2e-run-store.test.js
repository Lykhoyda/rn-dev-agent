import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeRunRecord,
  loadIndex,
  loadRunRecord,
  lastGreenRunId,
} from '../../dist/domain/e2e-run.js';

function rec(runId, verdict) {
  const failed = verdict === 'green' ? 0 : 1;
  return {
    runId,
    startedAt: '2026-06-18T00:00:00Z',
    finishedAt: '2026-06-18T00:01:00Z',
    durationMs: 60000,
    gitSha: 'x',
    gitDirty: false,
    platform: 'ios',
    deviceId: 'udid',
    metroReloaded: true,
    totals: { total: 1, passed: 1 - failed, failed, skipped: 0 },
    verdict,
    results: [],
    previousGreenRunId: null,
  };
}

test('writeRunRecord persists record + index; lastGreenRunId finds newest green', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-store-'));
  try {
    writeRunRecord(root, rec('run-1', 'green'));
    writeRunRecord(root, rec('run-2', 'red'));
    writeRunRecord(root, rec('run-3', 'green'));
    const idx = loadIndex(root);
    assert.equal(idx.length, 3);
    assert.equal(idx[0].runId, 'run-3');
    assert.equal(loadRunRecord(root, 'run-2').verdict, 'red');
    assert.equal(lastGreenRunId(root), 'run-3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
