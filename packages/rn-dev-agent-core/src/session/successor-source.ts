import { join } from 'node:path';
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
