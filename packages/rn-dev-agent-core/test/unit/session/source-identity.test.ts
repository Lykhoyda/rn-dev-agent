import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  resolveSourceIdentity,
  strictProofSourceIdentity,
} from '../../../dist/session/source-identity.js';
import { previewMetroIntegration } from '../../../dist/session/package-integration.js';

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
      if (args.includes('--stage') || args.includes('--ignored')) return '';
      if (args[0] === 'ls-files') return 'untracked.txt\0';
      throw new Error('unexpected git command');
    },
  });

  assert.equal(receipt.kind, 'git-strict-proof');
  assert.match(receipt.dirtyDigest, /^[a-f0-9]{64}$/);
});

test('strict proof length-frames untracked paths and bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-framing-'));
  roots.push(root);
  writeFileSync(join(root, 'a'), Buffer.from('X\0b\0file\0Y'));
  writeFileSync(join(root, 'b'), 'Y');
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const gitFor = (entries: string) => (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'diff') return '';
    if (args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return entries;
    throw new Error('unexpected git command');
  };

  const folded = strictProofSourceIdentity(identity, { git: gitFor('a\0') });
  writeFileSync(join(root, 'a'), 'X');
  const split = strictProofSourceIdentity(identity, { git: gitFor('a\0b\0') });

  assert.notEqual(folded.dirtyDigest, split.dirtyDigest);
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
        if (args.includes('--stage') || args.includes('--ignored')) return '';
        if (args[0] === 'ls-files') return 'root-untracked.txt\0';
        throw new Error('unexpected git command');
      },
    },
  );

  assert.equal(receipt.head, 'current-head');
  assert.ok(calls.every((call) => call.startsWith(`${root}:`)));
  assert.ok(calls.some((call) => call.includes('diff --binary --no-ext-diff current-head --')));
});

test('strict proof rejects an untracked symlink that escapes the content root', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-symlink-'));
  roots.push(root);
  const external = mkdtempSync(join(tmpdir(), 'rn-source-proof-external-'));
  roots.push(external);
  const externalFile = join(external, 'secret.txt');
  writeFileSync(externalFile, 'first');
  symlinkSync(externalFile, join(root, 'untracked-link'));
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'diff') return '';
    if (args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return 'untracked-link\0';
    throw new Error('unexpected git command');
  };

  assert.throws(() => strictProofSourceIdentity(identity, { git }), /STRICT_PROOF_PATH_ESCAPE/);
});

test('strict proof includes ignored runtime inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-ignored-'));
  roots.push(root);
  const ignoredFile = join(root, 'ios', '.xcode.env.local');
  mkdirSync(join(root, 'ios'), { recursive: true });
  writeFileSync(ignoredFile, 'NODE_BINARY=first');
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const ignoredQueries: (readonly string[])[] = [];
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'diff') return '';
    if (args.includes('--stage')) return '';
    if (args.includes('--directory')) return '';
    if (args.includes('--ignored')) {
      ignoredQueries.push(args);
      return 'ios/.xcode.env.local\0';
    }
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  const first = strictProofSourceIdentity(identity, { git });
  writeFileSync(ignoredFile, 'NODE_BINARY=second');
  const second = strictProofSourceIdentity(identity, { git });

  assert.notEqual(first.dirtyDigest, second.dirtyDigest);
  assert.ok(ignoredQueries.every((args) => args.includes(':(top,glob)**')));
  assert.ok(ignoredQueries.every((args) => args.includes(':(top,exclude,glob)**/node_modules/**')));
  assert.ok(ignoredQueries.every((args) => !args.some((arg) => arg.includes('.xcode.env'))));
});

test('strict proof authenticates ignored dependency bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-dependencies-'));
  roots.push(root);
  const dependency = join(root, 'node_modules', 'fixture', 'index.js');
  mkdirSync(join(root, 'node_modules', 'fixture'), { recursive: true });
  writeFileSync(dependency, 'module.exports = "first";');
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return 'node_modules/\0';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  const first = strictProofSourceIdentity(identity, { git });
  writeFileSync(dependency, 'module.exports = "second";');
  const second = strictProofSourceIdentity(identity, { git });

  assert.notEqual(first.dirtyDigest, second.dirtyDigest);
});

test('strict proof authenticates dependency symlink targets outside the content root', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-dependency-link-'));
  roots.push(root);
  const external = mkdtempSync(join(tmpdir(), 'rn-source-proof-dependency-target-'));
  roots.push(external);
  const dependency = join(external, 'index.js');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(dependency, 'module.exports = "first";');
  symlinkSync(external, join(root, 'node_modules', 'fixture'));
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return 'node_modules/\0';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  const first = strictProofSourceIdentity(identity, { git });
  writeFileSync(dependency, 'module.exports = "second";');
  const second = strictProofSourceIdentity(identity, { git });

  assert.notEqual(first.dirtyDigest, second.dirtyDigest);
});

test('strict proof rejects Plug’n’Play loaders under a nested app root', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-pnp-'));
  roots.push(root);
  const appRoot = join(root, 'apps', 'mobile');
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, '.pnp.js'), 'module.exports = {};');
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return '';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  assert.throws(
    () => strictProofSourceIdentity(identity, { git }),
    /STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT/,
  );
});

test('strict proof checks the terminal ancestor for external node_modules', () => {
  const identity = {
    kind: 'git' as const,
    contentRoot: '/repo/worktree',
    appRoot: '/repo/worktree',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return '';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  assert.throws(
    () =>
      strictProofSourceIdentity(identity, {
        git,
        exists: (path) => path === '/node_modules',
      }),
    /STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT/,
  );
});

test('strict proof bounds dependency traversal depth', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-dependency-depth-'));
  roots.push(root);
  let directory = join(root, 'node_modules');
  mkdirSync(directory);
  for (let depth = 0; depth < 130; depth += 1) {
    directory = join(directory, 'd');
    mkdirSync(directory);
  }
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return 'node_modules/\0';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  assert.throws(
    () => strictProofSourceIdentity(identity, { git }),
    /STRICT_PROOF_DEPENDENCY_LIMIT/,
  );
});

test('strict proof requires one exact terminal Metro integration block', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-metro-suffix-'));
  roots.push(root);
  const integrated = previewMetroIntegration('module.exports = {};\n');
  writeFileSync(
    join(root, 'metro.config.js'),
    integrated.replace(
      '// rn-dev-agent session integration: end',
      'module.exports.watchFolders = [];\n// rn-dev-agent session integration: end',
    ),
  );
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };

  assert.throws(() => strictProofSourceIdentity(identity), /STRICT_PROOF_UNVERIFIED_METRO_CONFIG/);
});

test('strict proof authenticates signed external Metro runtime inputs', () => {
  const rootInput = mkdtempSync(join(tmpdir(), 'rn-source-proof-metro-policy-'));
  roots.push(rootInput);
  const root = realpathSync(rootInput);
  const externalInput = mkdtempSync(join(tmpdir(), 'rn-source-proof-metro-external-'));
  roots.push(externalInput);
  const external = realpathSync(externalInput);
  const runtimeFile = join(external, 'transformer.js');
  const integration = join(root, '.rn-agent', 'integration');
  mkdirSync(integration, { recursive: true });
  writeFileSync(runtimeFile, 'module.exports = "first";');
  writeFileSync(join(root, 'metro.config.js'), previewMetroIntegration('module.exports = {};\n'));
  const capability = 'policy-capability';
  const payload = {
    version: 1,
    sessionId: 'session',
    metroInstanceId: 'metro',
    contentRoot: root,
    appRoot: root,
    runtimeInputs: [],
    violations: [],
  };
  writeFileSync(
    join(integration, 'metro-runtime-policy.json'),
    `${JSON.stringify({
      ...payload,
      signature: createHmac('sha256', capability).update(JSON.stringify(payload)).digest('hex'),
    })}\n`,
  );
  const runtimeLoadPayload = {
    version: 1,
    sessionId: 'session',
    metroInstanceId: 'metro',
    kind: 'input',
    value: runtimeFile,
  };
  writeFileSync(
    join(integration, 'metro-runtime-loads.jsonl'),
    `${JSON.stringify({
      ...runtimeLoadPayload,
      signature: createHmac('sha256', capability)
        .update(JSON.stringify(runtimeLoadPayload))
        .digest('hex'),
    })}\n`,
  );
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args.includes('--directory')) return '';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };
  const metroRuntimePolicy = {
    sessionId: 'session',
    metroInstanceId: 'metro',
    capability,
  };

  const first = strictProofSourceIdentity(identity, { git, metroRuntimePolicy });
  writeFileSync(runtimeFile, 'module.exports = "second";');
  const second = strictProofSourceIdentity(identity, { git, metroRuntimePolicy });

  assert.notEqual(first.dirtyDigest, second.dirtyDigest);
  writeFileSync(
    join(integration, 'metro-runtime-loads.jsonl'),
    `${JSON.stringify({ ...runtimeLoadPayload, signature: '00'.repeat(32) })}\n`,
  );
  assert.throws(
    () => strictProofSourceIdentity(identity, { git, metroRuntimePolicy }),
    /STRICT_PROOF_UNVERIFIED_METRO_POLICY/,
  );
});

test('strict proof rejects oversized untracked runtime inputs before buffering them', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-limit-'));
  roots.push(root);
  writeFileSync(join(root, 'oversized.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (_root: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'diff' || args.includes('--stage') || args.includes('--ignored')) return '';
    if (args[0] === 'ls-files') return 'oversized.bin\0';
    throw new Error('unexpected git command');
  };

  assert.throws(
    () => strictProofSourceIdentity(identity, { git }),
    /STRICT_PROOF_RUNTIME_INPUT_LIMIT/,
  );
});

test('strict proof rejects dirty submodules whose content is not represented by the parent diff', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-submodule-'));
  roots.push(root);
  const submodule = join(root, 'vendor', 'runtime');
  mkdirSync(submodule, { recursive: true });
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };
  const git = (commandRoot: string, args: readonly string[]) => {
    if (commandRoot === submodule && args[0] === 'status') return ' M runtime.js';
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'diff') return 'Subproject commit abc123-dirty';
    if (args.includes('--stage')) {
      return '160000 abc123abc123abc123abc123abc123abc123abcd 0\tvendor/runtime\0';
    }
    if (args[0] === 'ls-files') return '';
    throw new Error('unexpected git command');
  };

  assert.throws(() => strictProofSourceIdentity(identity, { git }), /STRICT_PROOF_DIRTY_SUBMODULE/);
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

test('declared-root fallback accepts only a definitive non-Git probe result', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-declared-errors-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  const fallback = {
    canonicalize: (path: string) => path,
    declaredRoot: root,
    declaredManifests: ['package.json'],
  };

  assert.equal(
    resolveSourceIdentity(root, {
      ...fallback,
      git: () => {
        throw new Error('fatal: not a git repository');
      },
    }).kind,
    'declared-root',
  );
  assert.throws(
    () =>
      resolveSourceIdentity(root, {
        ...fallback,
        git: () => {
          throw new Error('git probe timed out');
        },
      }),
    /git probe timed out/,
  );
});
