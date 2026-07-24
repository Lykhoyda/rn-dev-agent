import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  resolveSourceIdentity,
  strictProofSourceIdentity,
} from '../../../dist/session/source-identity.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('normal Git authority is coarse and does not compute a dirty-content digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-git-'));
  roots.push(root);
  const app = join(root, 'apps', 'mobile');
  mkdirSync(app, { recursive: true });
  const calls = [];
  const identity = resolveSourceIdentity(app, {
    git: (_root, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return root;
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return join(root, '.git');
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
      throw new Error('unexpected git command');
    },
    canonicalize: (path) => path,
  });

  assert.equal(identity.kind, 'git');
  assert.equal(identity.head, 'abc123');
  assert.equal('dirtyDigest' in identity, false);
  assert.equal(
    calls.some((call) => call.startsWith('diff')),
    false,
  );
  assert.equal(
    calls.some((call) => call.startsWith('status')),
    false,
  );
});

test('strict proof computes dirty identity only for Git sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-'));
  roots.push(root);
  writeFileSync(join(root, 'untracked.txt'), 'candidate');
  const normal = {
    kind: 'git',
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const receipt = strictProofSourceIdentity(normal, {
    git: (_root, args) => {
      if (args[0] === 'rev-parse') return 'abc123';
      if (args[0] === 'diff') return 'diff-content';
      if (args[0] === 'ls-files') return 'untracked.txt\0';
      throw new Error('unexpected git command');
    },
  });

  assert.equal(receipt.kind, 'git-strict-proof');
  assert.match(receipt.dirtyDigest, /^[a-f0-9]{64}$/);
});

test('strict proof uses one current repository HEAD and content-root-relative untracked paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-nested-'));
  roots.push(root);
  const appRoot = join(root, 'apps', 'mobile');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(root, 'root-untracked.txt'), 'root candidate');
  const calls: string[] = [];

  const receipt = strictProofSourceIdentity(
    {
      kind: 'git',
      contentRoot: root,
      appRoot,
      sourceKey: 'source',
      worktreeKey: 'worktree',
      appRootKey: 'app',
      head: 'session-start-head',
    },
    {
      git: (commandRoot, args) => {
        calls.push(`${commandRoot}:${args.join(' ')}`);
        if (args[0] === 'rev-parse') return 'current-head';
        if (args[0] === 'diff') return 'diff-content';
        if (args[0] === 'ls-files') return 'root-untracked.txt\0';
        throw new Error('unexpected git command');
      },
    },
  );

  assert.equal(receipt.head, 'current-head');
  assert.ok(calls.every((call) => call.startsWith(`${root}:`)));
  assert.ok(calls.some((call) => call.includes('diff --binary --no-ext-diff current-head --')));
});

test('non-Git authority requires declared manifests and remains ineligible for strict proof', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-declared-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  const git = () => {
    throw new Error('not a Git repository');
  };

  assert.throws(
    () => resolveSourceIdentity(root, { git, canonicalize: (path) => path }),
    /NON_GIT_MANIFEST_REQUIRED/,
  );
  const identity = resolveSourceIdentity(root, {
    git,
    canonicalize: (path) => path,
    declaredRoot: root,
    declaredManifests: ['package.json'],
  });
  assert.equal(identity.kind, 'declared-root');
  assert.match(identity.manifestDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => strictProofSourceIdentity(identity), /STRICT_PROOF_GIT_REQUIRED/);
});
