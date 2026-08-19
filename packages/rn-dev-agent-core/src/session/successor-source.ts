import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  deleteStateFile,
  readJsonStateFile,
  writeJsonStateFileAtomic,
} from '../util/secure-state-file.js';
import { sessionRuntimeDirectory, type AuthorityStateLayout } from './state-root.js';
import type { SourceIdentity } from './source-identity.js';

// GH #776: a fenced bind_source declares the worktree the successor session must
// bind; the supervisor consumes the declaration exactly once at mint time.
export interface SuccessorSourceDeclaration {
  version: 1;
  projectRoot: string;
  sourceKey: string;
  sessionId: string;
  declaredAtMs: number;
}

const DECLARATION_FILE = 'successor-source.json';

export function successorSourceDeclarationPath(runtimeRoot: string): string {
  return join(runtimeRoot, DECLARATION_FILE);
}

export function writeSuccessorSourceDeclaration(
  runtimeRoot: string,
  declaration: SuccessorSourceDeclaration,
): void {
  writeJsonStateFileAtomic(successorSourceDeclarationPath(runtimeRoot), declaration);
}

export function clearSuccessorSourceDeclaration(runtimeRoot: string): void {
  deleteStateFile(successorSourceDeclarationPath(runtimeRoot));
}

export function consumeSuccessorSourceDeclaration(
  layout: AuthorityStateLayout,
  sessionId: string,
): SuccessorSourceDeclaration | null {
  const path = successorSourceDeclarationPath(sessionRuntimeDirectory(layout, sessionId));
  const value = readJsonStateFile<Partial<SuccessorSourceDeclaration>>(path);
  deleteStateFile(path);
  if (
    !value ||
    value.version !== 1 ||
    typeof value.projectRoot !== 'string' ||
    value.projectRoot.length === 0 ||
    typeof value.sourceKey !== 'string' ||
    value.sourceKey.length === 0 ||
    !Number.isFinite(value.declaredAtMs) ||
    value.sessionId !== sessionId
  ) {
    return null;
  }
  return value as SuccessorSourceDeclaration;
}

export interface TerminalSessionSource {
  layout: AuthorityStateLayout;
  session: { sessionId: string };
  source: SourceIdentity;
}

/**
 * GH #776: successor mint precedence — a validated bind_source declaration wins,
 * otherwise the terminal session's own source is inherited (sticky), and only a
 * first mint falls back to the supervisor's boot working directory.
 */
export function resolveSuccessorMintSource(input: {
  terminal: TerminalSessionSource | null;
  bootSource: SourceIdentity;
  resolveIdentity: (root: string) => SourceIdentity;
  diagnostic?: (message: string) => void;
}): SourceIdentity {
  const diagnostic = input.diagnostic ?? (() => {});
  const terminal = input.terminal;
  if (!terminal) return input.bootSource;
  const declaration = consumeSuccessorSourceDeclaration(
    terminal.layout,
    terminal.session.sessionId,
  );
  if (declaration) {
    try {
      const declared = input.resolveIdentity(declaration.projectRoot);
      if (
        declared.sourceKey === declaration.sourceKey &&
        declared.sourceKey === terminal.source.sourceKey
      ) {
        return declared;
      }
      diagnostic(
        'declared successor root belongs to a different repository than the released session; ignoring the declaration',
      );
    } catch (error) {
      diagnostic(
        `declared successor root could not be resolved: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
  return terminal.source;
}

// GH #776: handlers default projectRoot to process.cwd(), so the worker must
// run in the bound source root — after a bind_source recycle that is the
// declared worktree, not the supervisor's boot cwd. The root is re-resolved at
// spawn time and compared by repository identity (not mere path existence), so
// a missing root or a foreign tree recreated at the same path fails closed
// instead of silently redirecting the worker.
// A probe failure only proves the root is gone when the filesystem says so or
// the tree is not a repository at all; a git budget blown under load must not
// poison the session, so it degrades to the already-bound root instead of the
// unrelated boot checkout.
function isProvenUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'ELOOP') return true;
  return (
    error.message.startsWith('APP_ROOT_OUTSIDE_WORKTREE') || error.message.startsWith('NON_GIT_')
  );
}

export function resolveWorkerSpawnCwd(input: {
  authoritySource: SourceIdentity | undefined;
  fallbackCwd: string;
  resolveIdentity: (root: string) => SourceIdentity;
  attempts?: number;
  diagnostic?: (message: string) => void;
}): string {
  const source = input.authoritySource;
  if (!source) return input.fallbackCwd;
  const attempts = Math.max(1, input.attempts ?? 2);
  let observed: SourceIdentity | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts && observed === null; attempt += 1) {
    try {
      observed = input.resolveIdentity(source.appRoot);
    } catch (error) {
      lastError = error;
      if (isProvenUnavailable(error)) {
        throw new Error(
          `SOURCE_ROOT_UNAVAILABLE: bound source root ${source.appRoot} is unavailable (${
            error instanceof Error ? error.message : 'unresolvable'
          }); refusing to run the worker in ${input.fallbackCwd}`,
        );
      }
    }
  }
  if (observed === null) {
    input.diagnostic?.(
      `bound source root ${source.appRoot} could not be re-proven (${
        lastError instanceof Error ? lastError.message : 'unresolvable'
      }); running the worker in the bound root without a fresh identity probe`,
    );
    return source.appRoot;
  }
  // worktreeKey/appRootKey pin the exact checkout (a symlink to a sibling
  // worktree of the same repository must refuse); the git sourceKey pins the
  // repository. Declared kinds skip the manifest-derived sourceKey so manifest
  // content drift does not refuse the root.
  const matches =
    observed.kind === source.kind &&
    observed.worktreeKey === source.worktreeKey &&
    observed.appRootKey === source.appRootKey &&
    (source.kind !== 'git' || observed.sourceKey === source.sourceKey);
  if (!matches) {
    throw new Error(
      `SOURCE_WORKTREE_MISMATCH: bound source root ${source.appRoot} no longer matches the session's repository identity (it now resolves to ${observed.appRoot}); refusing to run the worker there or in ${input.fallbackCwd}`,
    );
  }
  return observed.appRoot;
}

function canonicalOrRaw(path: string, canonicalize: (value: string) => string): string {
  try {
    return canonicalize(resolve(path));
  } catch {
    return resolve(path);
  }
}

// GH #776: pinning only the worker's process cwd is not enough — findProjectRoot()
// prefers RN_PROJECT_ROOT and CLAUDE_USER_CWD over the cwd, so a recycle into a
// linked worktree would still resolve the harness startup tree for every
// cwd-default handler. The inherited roots are rewritten to the bound root when
// the spawn diverges from the supervisor's boot cwd — containment under the bound
// root is not enough, since a nested worktree or monorepo app under it resolves to
// itself. A first boot (no divergence) only gets an accurate PWD.
export function resolveWorkerSpawnRootEnvironment(input: {
  workerCwd: string;
  bootCwd: string;
  inherited: { RN_PROJECT_ROOT?: string };
  canonicalize?: (path: string) => string;
}): { set: Record<string, string>; unset: string[] } {
  const canonicalize = input.canonicalize ?? realpathSync;
  const worker = canonicalOrRaw(input.workerCwd, canonicalize);
  const set: Record<string, string> = { PWD: worker };
  const unset: string[] = [];
  if (canonicalOrRaw(input.bootCwd, canonicalize) === worker) return { set, unset };
  set.CLAUDE_USER_CWD = worker;
  const projectRoot = input.inherited.RN_PROJECT_ROOT;
  if (projectRoot && canonicalOrRaw(projectRoot, canonicalize) !== worker) {
    unset.push('RN_PROJECT_ROOT');
  }
  return { set, unset };
}
