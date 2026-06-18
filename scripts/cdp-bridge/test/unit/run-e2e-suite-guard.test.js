import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunE2eSuiteHandler } from '../../dist/tools/run-e2e-suite.js';
import { writeRequest, loadRequest } from '../../dist/domain/e2e-run-request.js';

function parse(r) { return JSON.parse(r.content[0].text); }
const NOW_ISO = '2026-06-18T00:00:00.000Z';
const baseDeps = (over = {}) => ({
  discover: () => [],
  getGitInfo: () => ({ sha: 's', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date(NOW_ISO),
  makeRunId: () => 'run-guard-1',
  runReload: async () => false,
  preflightCheck: async () => ({ ok: true }),
  isPidAlive: () => true,
  ...over,
});

test('pre-flight failure → SETUP_ERROR; request marked failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const handler = createRunE2eSuiteHandler(baseDeps({ preflightCheck: async () => ({ ok: false, code: 'SETUP_ERROR', detail: 'Metro down' }) }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.code, 'SETUP_ERROR');
    assert.equal(loadRequest(root, 'run-guard-1').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('single-slot guard refuses a fresh live run in progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    writeRequest(root, { runId: 'run-existing', status: 'running', pid: process.pid, createdAt: NOW_ISO, updatedAt: NOW_ISO });
    const handler = createRunE2eSuiteHandler(baseDeps({ isPidAlive: (pid) => pid === process.pid }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.code, 'E2E_RUN_ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('STALE running request (old updatedAt) does NOT wedge the guard', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    writeRequest(root, { runId: 'run-stale', status: 'running', pid: process.pid, createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z' });
    const handler = createRunE2eSuiteHandler(baseDeps({ isPidAlive: () => true }));
    const res = parse(await handler({ projectRoot: root }));
    assert.equal(res.ok, true); // stale holder ignored, run proceeds
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('happy path → ends in done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  try {
    const res = parse(await createRunE2eSuiteHandler(baseDeps())({ projectRoot: root }));
    assert.equal(res.ok, true);
    assert.equal(loadRequest(root, 'run-guard-1').status, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
