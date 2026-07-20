import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateAuthorityReasons } from '../../dist/tools/proof-capture.js';
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
