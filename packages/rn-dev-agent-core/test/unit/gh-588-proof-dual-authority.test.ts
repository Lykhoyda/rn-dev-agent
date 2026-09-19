import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  candidateAuthorityReasons,
  proofCandidateCheckoutMatchesHead,
  proofCandidateEntrypointEnvironmentMatches,
  readProofCandidateHeadArtifacts,
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

test('GH-588 V8: candidate artifacts must be tracked clean HEAD bytes', async (t) => {
  const candidateRoot = await mkdtemp(join(tmpdir(), 'proof-candidate-clean-'));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  const artifact = join(candidateRoot, 'artifact.js');
  await writeFile(artifact, 'candidate bytes\n');
  execFileSync('git', ['-C', candidateRoot, 'init']);
  execFileSync('git', ['-C', candidateRoot, 'add', 'artifact.js']);
  execFileSync('git', [
    '-C',
    candidateRoot,
    '-c',
    'user.name=Proof Test',
    '-c',
    'user.email=proof@example.invalid',
    'commit',
    '-m',
    'candidate',
  ]);

  assert.equal(proofCandidateCheckoutMatchesHead(candidateRoot, [artifact]), true);
  const aliasParent = await mkdtemp(join(tmpdir(), 'proof-candidate-clean-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const candidateAlias = join(aliasParent, 'candidate');
  await symlink(candidateRoot, candidateAlias);
  assert.equal(proofCandidateCheckoutMatchesHead(candidateAlias, [artifact]), true);
  const verifiedBytes = readProofCandidateHeadArtifacts(candidateAlias, [artifact]);
  assert.equal(verifiedBytes?.[0]?.toString('utf8'), 'candidate bytes\n');
  await writeFile(artifact, 'dirty candidate bytes\n');
  assert.equal(proofCandidateCheckoutMatchesHead(candidateRoot, [artifact]), false);
  assert.equal(verifiedBytes?.[0]?.toString('utf8'), 'candidate bytes\n');
});

test('GH-588 V8: absolute Codex supervisor argv binds the candidate packaged core', async (t) => {
  // Fixture layout, not the real tree: the shipped Codex launcher now lives in
  // packages/claude-plugin/bin and is deliberately NOT an accepted authority
  // path (see the real-tree assertions below); the legacy codex-plugin layout
  // only proves the launcher -> packaged-core binding contract.
  const candidateRoot = await mkdtemp(join(tmpdir(), 'proof-candidate-legacy-'));
  t.after(() => rm(candidateRoot, { recursive: true, force: true }));
  const legacyHost = join(candidateRoot, 'packages/codex-plugin');
  await mkdir(join(legacyHost, 'bin'), { recursive: true });
  await mkdir(join(legacyHost, 'rn-dev-agent-core/dist'), { recursive: true });
  const supervisor = join(legacyHost, 'bin/cdp-supervisor.js');
  await writeFile(supervisor, 'export {};\n');
  await writeFile(join(legacyHost, 'rn-dev-agent-core/dist/index.js'), 'export {};\n');
  await writeFile(join(legacyHost, 'rn-dev-agent-core/dist/supervisor.js'), 'export {};\n');
  const realCandidate = realpathSync(candidateRoot);
  const aliasParent = await mkdtemp(join(tmpdir(), 'proof-candidate-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const candidateAlias = join(aliasParent, 'candidate');
  await symlink(candidateRoot, candidateAlias);

  const resolved = resolveProofCandidateEntrypoint(candidateAlias, ['node', supervisor]);

  assert.deepEqual(resolved, {
    host: 'codex-plugin',
    coreBundle: join(realCandidate, 'packages/codex-plugin/rn-dev-agent-core/dist/index.js'),
    coreSupervisor: join(
      realCandidate,
      'packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js',
    ),
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
        realCandidate,
        'packages/codex-plugin/rn-dev-agent-core/dist/supervisor.js',
      ),
      RN_BRIDGE_WORKER_PATH: join(
        realCandidate,
        'packages/codex-plugin/rn-dev-agent-core/dist/index.js',
      ),
    }),
    true,
  );
});

test('GH-588/GH-892: the shipped tree accepts only the committed packages/claude-plugin worker', () => {
  const worker = join(REPO_ROOT, 'packages/claude-plugin/rn-dev-agent-core/dist/index.js');
  assert.equal(resolveProofCandidateEntrypoint(REPO_ROOT, ['node', worker])?.kind, 'core-index');
  assert.equal(
    resolveProofCandidateEntrypoint(REPO_ROOT, [
      'node',
      join(REPO_ROOT, 'packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js'),
    ])?.kind,
    'core-supervisor',
  );
  // The Codex launcher that both hosts now ship from packages/claude-plugin/bin
  // is not a candidate authority path; it execs the accepted worker above.
  assert.equal(
    resolveProofCandidateEntrypoint(REPO_ROOT, [
      'node',
      join(REPO_ROOT, 'packages/claude-plugin/bin/cdp-supervisor.js'),
    ]),
    null,
  );
  // The authoring launcher has no packaged core beside it any more.
  assert.equal(
    resolveProofCandidateEntrypoint(REPO_ROOT, [
      'node',
      join(REPO_ROOT, 'packages/codex-plugin/bin/cdp-supervisor.js'),
    ]),
    null,
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
