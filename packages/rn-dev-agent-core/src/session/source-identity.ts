import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface GitSourceIdentity {
  kind: 'git';
  contentRoot: string;
  appRoot: string;
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  head: string;
}

export interface DeclaredSourceIdentity {
  kind: 'declared-root';
  contentRoot: string;
  appRoot: string;
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  manifestDigest: string;
  declaredManifests: string[];
}

export type SourceIdentity = GitSourceIdentity | DeclaredSourceIdentity;

interface SourceIdentityDependencies {
  git?: (root: string, args: readonly string[]) => string;
  canonicalize?: (path: string) => string;
  declaredRoot?: string;
  declaredManifests?: readonly string[];
}

function digest(parts: readonly (string | Buffer)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function defaultGit(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  }).trim();
}

function assertContained(root: string, candidate: string, code: string): void {
  const child = relative(root, candidate);
  if (
    child === '..' ||
    child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(child)
  ) {
    throw new Error(`${code}: path is outside the declared content root`);
  }
}

function resolveDeclaredIdentity(
  appRoot: string,
  dependencies: SourceIdentityDependencies,
  canonicalize: (path: string) => string,
): DeclaredSourceIdentity {
  if (!dependencies.declaredRoot || !dependencies.declaredManifests?.length) {
    throw new Error(
      'NON_GIT_MANIFEST_REQUIRED: non-Git authority needs an explicit root and manifest list',
    );
  }
  const contentRoot = canonicalize(resolve(dependencies.declaredRoot));
  assertContained(contentRoot, appRoot, 'NON_GIT_ROOT_MISMATCH');
  const manifestParts: (string | Buffer)[] = [];
  for (const entry of [...dependencies.declaredManifests].sort()) {
    const manifest = canonicalize(resolve(contentRoot, entry));
    assertContained(contentRoot, manifest, 'NON_GIT_MANIFEST_OUTSIDE_ROOT');
    manifestParts.push(relative(contentRoot, manifest), readFileSync(manifest));
  }
  const manifestDigest = digest(manifestParts);
  const appRelative = relative(contentRoot, appRoot) || '.';
  return {
    kind: 'declared-root',
    contentRoot,
    appRoot,
    sourceKey: digest(['declared-source', contentRoot, manifestDigest]),
    worktreeKey: digest(['declared-root', contentRoot]),
    appRootKey: digest(['declared-app', appRelative]),
    manifestDigest,
    declaredManifests: [...dependencies.declaredManifests],
  };
}

export function resolveSourceIdentity(
  inputRoot: string,
  dependencies: SourceIdentityDependencies = {},
): SourceIdentity {
  const canonicalize = dependencies.canonicalize ?? realpathSync;
  const appRoot = canonicalize(resolve(inputRoot));
  const git = dependencies.git ?? defaultGit;

  try {
    const contentRoot = canonicalize(git(appRoot, ['rev-parse', '--show-toplevel']));
    assertContained(contentRoot, appRoot, 'APP_ROOT_OUTSIDE_WORKTREE');
    const commonRaw = git(appRoot, ['rev-parse', '--git-common-dir']);
    const commonDirectory = canonicalize(
      isAbsolute(commonRaw) ? commonRaw : join(contentRoot, commonRaw),
    );
    const head = git(appRoot, ['rev-parse', 'HEAD']);
    const appRelative = relative(contentRoot, appRoot) || '.';
    return {
      kind: 'git',
      contentRoot,
      appRoot,
      sourceKey: digest(['git-source', commonDirectory]),
      worktreeKey: digest(['git-worktree', contentRoot]),
      appRootKey: digest(['git-app', appRelative]),
      head,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith('APP_ROOT_OUTSIDE_WORKTREE') ||
        error.message.startsWith('NON_GIT_'))
    ) {
      throw error;
    }
    return resolveDeclaredIdentity(appRoot, dependencies, canonicalize);
  }
}

export function strictProofSourceIdentity(
  identity: SourceIdentity,
  dependencies: Pick<SourceIdentityDependencies, 'git'> = {},
): {
  kind: 'git-strict-proof';
  sourceKey: string;
  worktreeKey: string;
  appRootKey: string;
  head: string;
  dirtyDigest: string;
} {
  if (identity.kind !== 'git') {
    throw new Error('STRICT_PROOF_GIT_REQUIRED: accepted strict proof requires a Git worktree');
  }
  const git = dependencies.git ?? defaultGit;
  const head = git(identity.contentRoot, ['rev-parse', 'HEAD']);
  const diff = git(identity.contentRoot, ['diff', '--binary', '--no-ext-diff', head, '--']);
  const untracked = git(identity.contentRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort();
  const dirtyParts: (string | Buffer)[] = ['git-dirty-v1', diff];
  for (const entry of untracked) {
    const file = resolve(identity.contentRoot, entry);
    assertContained(identity.contentRoot, file, 'STRICT_PROOF_PATH_ESCAPE');
    dirtyParts.push(entry, readFileSync(file));
  }
  return {
    kind: 'git-strict-proof',
    sourceKey: identity.sourceKey,
    worktreeKey: identity.worktreeKey,
    appRootKey: identity.appRootKey,
    head,
    dirtyDigest: digest(dirtyParts),
  };
}
