import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { sidecarPathFor } from '../../../dist/domain/sidecar-io.js';
import { e2eRunsDirFor } from '../../../dist/domain/e2e-run.js';
import { ensureSharedKnowledgeRoot } from '../../../dist/session/shared-knowledge-root.js';

const priorRuntimeRoot = process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;

afterEach(() => {
  if (priorRuntimeRoot === undefined) delete process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT;
  else process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = priorRuntimeRoot;
});

test('mutable action and E2E state share the fenced session runtime root', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-runtime-paths-'));
  try {
    const project = join(root, 'app');
    const runtime = join(root, 'session-runtime');
    mkdirSync(join(project, '.rn-agent', 'actions'), { recursive: true });
    process.env.RN_DEV_AGENT_SESSION_RUNTIME_ROOT = runtime;

    assert.equal(
      sidecarPathFor(join(project, '.rn-agent', 'actions', 'login.yaml')),
      join(runtime, 'state', 'login.state.json'),
    );
    assert.equal(e2eRunsDirFor(project), join(runtime, 'state', 'e2e-runs'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('external shared-knowledge symlink is materialized without corpus loss', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-knowledge-migration-'));
  try {
    const project = join(root, 'app');
    const corpus = join(root, 'shared-corpus');
    mkdirSync(join(project), { recursive: true });
    mkdirSync(join(corpus, 'actions'), { recursive: true });
    writeFileSync(join(corpus, 'actions', 'login.yaml'), 'appId: dev.example\n');
    symlinkSync(corpus, join(project, '.rn-agent'));

    const result = ensureSharedKnowledgeRoot(project);

    assert.equal(result.migrated, true);
    assert.equal(
      readFileSync(join(project, '.rn-agent', 'actions', 'login.yaml'), 'utf8'),
      'appId: dev.example\n',
    );
    writeFileSync(join(project, '.rn-agent', 'actions', 'local.yaml'), 'appId: local\n');
    assert.throws(() => readFileSync(join(corpus, 'actions', 'local.yaml'), 'utf8'));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('nested links refuse materialization before changing the project link', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-knowledge-migration-'));
  try {
    const project = join(root, 'app');
    const corpus = join(root, 'shared-corpus');
    mkdirSync(project, { recursive: true });
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(root, 'foreign'), 'foreign');
    symlinkSync(join(root, 'foreign'), join(corpus, 'nested-link'));
    symlinkSync(corpus, join(project, '.rn-agent'));

    assert.throws(() => ensureSharedKnowledgeRoot(project), /SHARED_KNOWLEDGE_ROOT_UNSAFE/);
    assert.equal(readFileSync(join(project, '.rn-agent', 'nested-link'), 'utf8'), 'foreign');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
