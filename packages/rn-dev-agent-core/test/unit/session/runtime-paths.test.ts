import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { sidecarPathFor } from '../../../dist/domain/sidecar-io.js';
import { e2eRunsDirFor } from '../../../dist/domain/e2e-run.js';

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
