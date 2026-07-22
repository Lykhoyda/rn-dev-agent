import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  candidateAuthorityReasons,
  proofCandidateEntrypointEnvironmentMatches,
  resolveProofCandidateEntrypoint,
} from '../../dist/tools/proof-capture.js';
import { proofCandidateRuntimeSchema } from '../../dist/domain/proof-receipt.js';

const sha = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const runtime = proofCandidateRuntimeSchema.parse({
  repo: 'Lykhoyda/rn-dev-agent',
  sha,
  coreBundleSha256: digest,
  runnerManifestSha256: 'c'.repeat(64),
  mcp: { pid: 42, argv: ['node', '/candidate/packages/codex-plugin/dist/index.js'], cwd: '/app' },
});

test('GH-588 Slice P: matching dual candidate authority is accepted', () => {
  assert.deepEqual(candidateAuthorityReasons(runtime, structuredClone(runtime), sha, true), []);
});

test('GH-588 Slice P: PR SHA, missing cross-repo block, and tampered bundle are rejected', () => {
  assert.deepEqual(candidateAuthorityReasons(runtime, runtime, 'd'.repeat(40), true), [
    'CANDIDATE_SHA_MISMATCH',
  ]);
  assert.deepEqual(candidateAuthorityReasons(null, null, sha, true), [
    'CANDIDATE_RUNTIME_REQUIRED',
  ]);
  assert.deepEqual(
    candidateAuthorityReasons(runtime, { ...runtime, coreBundleSha256: 'e'.repeat(64) }, sha, true),
    ['CANDIDATE_RUNTIME_MISMATCH'],
  );
});

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

test('GH-588 V8: absolute Codex supervisor argv binds the candidate packaged core', async (t) => {
  const aliasParent = await mkdtemp(join(tmpdir(), 'proof-candidate-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const candidateAlias = join(aliasParent, 'candidate');
  await symlink(REPO_ROOT, candidateAlias);
  const supervisor = join(REPO_ROOT, 'packages/codex-plugin/bin/cdp-supervisor.js');

  const resolved = resolveProofCandidateEntrypoint(candidateAlias, ['node', supervisor]);

  assert.deepEqual(resolved, {
    host: 'codex-plugin',
    coreBundle: join(REPO_ROOT, 'packages/codex-plugin/rn-dev-agent-core/dist/index.js'),
    coreSupervisor: join(REPO_ROOT, 'packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js'),
    authorityArg: supervisor,
    kind: 'codex-launcher',
  });
  assert.equal(proofCandidateEntrypointEnvironmentMatches(resolved!, {}), true);
  assert.equal(
    proofCandidateEntrypointEnvironmentMatches(resolved!, {
      RN_BRIDGE_WORKER_PATH: '/tmp/foreign/dist/index.js',
    }),
    false,
    'a candidate launcher cannot authorize a foreign worker override',
  );
  assert.equal(
    proofCandidateEntrypointEnvironmentMatches(resolved!, {
      RN_DEV_AGENT_CORE_SUPERVISOR: join(
        REPO_ROOT,
        'packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js',
      ),
      RN_BRIDGE_WORKER_PATH: join(
        REPO_ROOT,
        'packages/codex-plugin/rn-dev-agent-core/dist/index.js',
      ),
    }),
    true,
  );
});

test('GH-588 V8: foreign and merely similar supervisor argv remain rejected', () => {
  assert.equal(
    resolveProofCandidateEntrypoint(REPO_ROOT, [
      'node',
      '/tmp/another-candidate/packages/codex-plugin/bin/cdp-supervisor.js',
    ]),
    null,
  );
  assert.equal(
    resolveProofCandidateEntrypoint(REPO_ROOT, [
      'node',
      join(REPO_ROOT, 'packages/codex-plugin/bin/not-cdp-supervisor.js'),
    ]),
    null,
  );
});
