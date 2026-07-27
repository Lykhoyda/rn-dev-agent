import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  resolveSourceIdentity,
  strictProofSourceIdentity,
} from '../../../dist/session/source-identity.js';
import { canonicalAuthorityJson } from '../../../dist/session/authority-json.js';
import { previewMetroIntegration } from '../../../dist/session/package-integration.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('authority JSON ignores mutable serializers and toJSON hooks', () => {
  const stringify = JSON.stringify;
  try {
    JSON.stringify = () => '{"forged":true}';
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => ({ forged: true }),
    });
    assert.equal(canonicalAuthorityJson({ safe: true }), '{"safe":true}');
  } finally {
    delete (Object.prototype as { toJSON?: unknown }).toJSON;
    JSON.stringify = stringify;
  }
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

test('strict proof rejects unenforced reporter silence and validates enforced runtime inputs', () => {
  const rootInput = mkdtempSync(join(tmpdir(), 'rn-source-proof-metro-policy-'));
  roots.push(rootInput);
  const root = realpathSync(rootInput);
  const externalInput = mkdtempSync(join(tmpdir(), 'rn-source-proof-metro-external-'));
  roots.push(externalInput);
  const external = realpathSync(externalInput);
  const runtimeFile = join(external, 'transformer.js');
  const runtimeEvidencePath = join(external, 'metro-runtime-evidence.jsonl');
  const runtimeEvidenceSocket = join(external, 'metro-runtime-evidence.sock');
  const integration = join(root, '.rn-agent', 'integration');
  mkdirSync(integration, { recursive: true });
  writeFileSync(runtimeFile, 'module.exports = "first";');
  writeFileSync(join(root, 'metro.config.js'), previewMetroIntegration('module.exports = {};\n'));
  const capability = 'policy-capability';
  const runtimeManifest = {
    version: 1,
    executable: process.execPath,
    nodeExecutable: process.execPath,
    port: 8341,
    args: ['metro', '--port', '8341'],
    nodeOptions: '',
    environmentDigest: 'ab'.repeat(32),
    contentRoot: root,
    appRoot: root,
    servingRoot: root,
    buildGeneration: 1,
    packageInputs: [],
    metroConfigInputs: [join(root, 'metro.config.js')],
    dependencyRoots: [],
    runtimeInputs: [],
  };
  const enforcementReceipt = {
    version: 1,
    kind: 'darwin-seatbelt-v1',
    profileSha256: '12'.repeat(32),
    sandboxExecutableSha256: '34'.repeat(32),
    sandboxExecutableCdHash: '56'.repeat(20),
    processCreationDenied: true,
    unmanifestedReadDenied: true,
    unmanifestedWriteDenied: true,
    symlinkEscapeDenied: true,
    unallocatedListenerDenied: true,
    allocatedListenerAllowed: true,
    networkOutboundDenied: true,
  };
  const policyPayload = (runtimeEnforcement: 'os-enforced-v1' | 'unsupported') => ({
    version: 1,
    runtimeEvidenceAuthority: 'broker-v2',
    sessionId: 'session',
    metroInstanceId: 'metro',
    contentRoot: root,
    appRoot: root,
    runtimeEnforcement,
    runtimeEnforcementReceipt: runtimeEnforcement === 'os-enforced-v1' ? enforcementReceipt : null,
    runtimeManifest,
    runtimeInputs: [],
    violations: [],
  });
  const publishPolicy = (runtimeEnforcement: 'os-enforced-v1' | 'unsupported') => {
    const payload = policyPayload(runtimeEnforcement);
    writeFileSync(
      join(integration, 'metro-runtime-policy.json'),
      `${JSON.stringify({
        ...payload,
        signature: createHmac('sha256', capability)
          .update(canonicalAuthorityJson(payload))
          .digest('hex'),
      })}\n`,
    );
  };
  publishPolicy('os-enforced-v1');
  const runtimeLoadPayload = {
    version: 1,
    runtimeEvidenceAuthority: 'broker-v2',
    sessionId: 'session',
    metroInstanceId: 'metro',
    kind: 'input',
    value: runtimeFile,
    digest: createHash('sha256').update('module.exports = "first";').digest('hex'),
  };
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
    evidencePath: runtimeEvidencePath,
    evidenceSocket: runtimeEvidenceSocket,
    evidenceAuthority: 'broker-v2' as const,
  };
  const signRuntimeLoads = (entries: Record<string, unknown>[]) => {
    let previousSignature: string | null = null;
    return entries
      .map((entry, index) => {
        const chained = {
          ...entry,
          sequence: index + 1,
          previousSignature,
        };
        previousSignature = createHmac('sha256', capability)
          .update(canonicalAuthorityJson(chained))
          .digest('hex');
        return canonicalAuthorityJson({ ...chained, signature: previousSignature });
      })
      .join('\n');
  };
  let authoritativeHead = { sequence: 0, journalSignature: null as string | null };
  const publishRuntimeLoads = (entries: Record<string, unknown>[]) => {
    const journal = signRuntimeLoads(entries);
    const last = JSON.parse(journal.split('\n').at(-1)!) as {
      sequence: number;
      signature: string;
    };
    authoritativeHead = {
      sequence: last.sequence,
      journalSignature: last.signature,
    };
    writeFileSync(runtimeEvidencePath, `${journal}\n`);
  };
  const readMetroEvidenceHead = (_socket: string, challenge: string) => {
    const headPayload = {
      version: 1,
      runtimeEvidenceAuthority: 'broker-v2',
      sessionId: 'session',
      metroInstanceId: 'metro',
      challenge,
      ...authoritativeHead,
    };
    return canonicalAuthorityJson({
      ...headPayload,
      signature: createHmac('sha256', capability)
        .update(canonicalAuthorityJson(headPayload))
        .digest('hex'),
    });
  };
  const dependencies = {
    git,
    metroRuntimePolicy,
    readMetroEvidenceHead,
    verifyMetroRuntimeEnforcement: () => true,
  };
  publishPolicy('unsupported');
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /closed-world runtime enforcement is unavailable/,
  );
  publishPolicy('os-enforced-v1');
  assert.throws(
    () =>
      strictProofSourceIdentity(identity, {
        ...dependencies,
        verifyMetroRuntimeEnforcement: () => false,
      }),
    /runtime enforcement attestation is invalid/,
  );
  publishRuntimeLoads([runtimeLoadPayload]);
  const first = strictProofSourceIdentity(identity, dependencies);
  const semanticsValue = JSON.stringify({
    mode: 'node',
    entrypoint: runtimeFile,
    execArgv: ['--conditions=development'],
  });
  const semanticsPayload = {
    version: 1,
    runtimeEvidenceAuthority: 'broker-v2',
    sessionId: 'session',
    metroInstanceId: 'metro',
    kind: 'semantics',
    value: semanticsValue,
    digest: null,
  };
  const semanticsDigest = createHash('sha256').update(semanticsValue).digest('hex');
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload]);
  const semanticIdentity = strictProofSourceIdentity(identity, dependencies);
  assert.notEqual(first.dirtyDigest, semanticIdentity.dirtyDigest);
  const secondSemanticsPayload = {
    ...semanticsPayload,
    value: JSON.stringify({ mode: 'worker-message', invocationDigest: 'cd'.repeat(32) }),
  };
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload, secondSemanticsPayload]);
  const orderedSemanticIdentity = strictProofSourceIdentity(identity, dependencies);
  publishRuntimeLoads([runtimeLoadPayload, secondSemanticsPayload, semanticsPayload]);
  assert.notEqual(
    orderedSemanticIdentity.dirtyDigest,
    strictProofSourceIdentity(identity, dependencies).dirtyDigest,
  );
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload, semanticsPayload]);
  assert.notEqual(
    semanticIdentity.dirtyDigest,
    strictProofSourceIdentity(identity, dependencies).dirtyDigest,
  );
  const launchPayload = {
    version: 1,
    runtimeEvidenceAuthority: 'broker-v2',
    sessionId: 'session',
    metroInstanceId: 'metro',
    kind: 'launch',
    value: `${'ab'.repeat(16)}:process:123:${semanticsDigest}`,
    digest: null,
  };
  const attestationPayload = { ...launchPayload, kind: 'attestation' };
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload, launchPayload, attestationPayload]);
  assert.doesNotThrow(() => strictProofSourceIdentity(identity, dependencies));
  const pendingPayload = {
    version: 1,
    runtimeEvidenceAuthority: 'broker-v2',
    sessionId: 'session',
    metroInstanceId: 'metro',
    kind: 'pending',
    value: 'cd'.repeat(16),
    digest: null,
  };
  const completionPayload = { ...pendingPayload, kind: 'completion' };
  publishRuntimeLoads([
    runtimeLoadPayload,
    semanticsPayload,
    launchPayload,
    attestationPayload,
    pendingPayload,
  ]);
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /IPC completion is pending/,
  );
  publishRuntimeLoads([
    runtimeLoadPayload,
    semanticsPayload,
    launchPayload,
    attestationPayload,
    pendingPayload,
    completionPayload,
  ]);
  assert.doesNotThrow(() => strictProofSourceIdentity(identity, dependencies));
  publishRuntimeLoads([runtimeLoadPayload, launchPayload, attestationPayload]);
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /descendant execution semantics are missing/,
  );
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload, launchPayload, attestationPayload]);
  writeFileSync(runtimeEvidencePath, `${signRuntimeLoads([runtimeLoadPayload])}\n`);
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /runtime evidence head is invalid/,
  );
  writeFileSync(runtimeEvidencePath, '');
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /runtime load evidence is empty/,
  );
  publishRuntimeLoads([runtimeLoadPayload, semanticsPayload, launchPayload]);
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /descendant execution was not attested/,
  );
  publishRuntimeLoads(
    Array.from({ length: 50_001 }, () => ({
      ...semanticsPayload,
      value: 'x',
    })),
  );
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /runtime load evidence is unbounded/,
  );
  publishRuntimeLoads([runtimeLoadPayload]);
  writeFileSync(runtimeFile, 'module.exports = "second";');
  assert.match(first.dirtyDigest, /^[a-f0-9]{64}$/);
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /runtime input bytes changed after execution/,
  );
  writeFileSync(
    runtimeEvidencePath,
    `${JSON.stringify({
      ...runtimeLoadPayload,
      sequence: 1,
      previousSignature: null,
      signature: '00'.repeat(32),
    })}\n`,
  );
  assert.throws(
    () => strictProofSourceIdentity(identity, dependencies),
    /STRICT_PROOF_UNVERIFIED_METRO_POLICY/,
  );
});

test('strict proof rejects Metro-reported runtime evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'rn-source-proof-reported-metro-'));
  roots.push(root);
  writeFileSync(join(root, 'metro.config.js'), previewMetroIntegration('module.exports = {};\n'));
  const identity = {
    kind: 'git' as const,
    contentRoot: root,
    appRoot: root,
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    head: 'abc123',
  };

  assert.throws(
    () =>
      strictProofSourceIdentity(identity, {
        metroRuntimePolicy: {
          sessionId: 'session',
          metroInstanceId: 'metro',
          capability: 'capability',
          evidencePath: join(root, 'reported.jsonl'),
          evidenceSocket: join(root, 'reported.sock'),
          evidenceAuthority: 'reported-v1',
        },
      }),
    /reported Metro evidence cannot grant strict authority/,
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
