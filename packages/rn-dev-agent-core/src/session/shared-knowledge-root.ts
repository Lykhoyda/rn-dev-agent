import {
  cpSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface SharedKnowledgeMigration {
  migrated: boolean;
  priorTarget?: string;
}

function assertTreeHasNoLinks(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(
        'SHARED_KNOWLEDGE_ROOT_UNSAFE: nested symlinks cannot be materialized safely',
      );
    }
    if (entry.isDirectory()) assertTreeHasNoLinks(path);
  }
}

export function ensureSharedKnowledgeRoot(appRoot: string): SharedKnowledgeMigration {
  const knowledgeRoot = join(resolve(appRoot), '.rn-agent');
  let link;
  try {
    link = lstatSync(knowledgeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { migrated: false };
    throw error;
  }
  if (!link.isSymbolicLink()) {
    if (!link.isDirectory()) {
      throw new Error('SHARED_KNOWLEDGE_ROOT_UNSAFE: .rn-agent must be a real directory');
    }
    return { migrated: false };
  }

  const priorTarget = resolve(appRoot, readlinkSync(knowledgeRoot));
  if (!statSync(priorTarget).isDirectory()) {
    throw new Error('SHARED_KNOWLEDGE_ROOT_UNSAFE: .rn-agent symlink target is not a directory');
  }
  assertTreeHasNoLinks(priorTarget);
  const materialized = `${knowledgeRoot}.materialized.${process.pid}`;
  const backup = `${knowledgeRoot}.symlink.${process.pid}`;
  rmSync(materialized, { force: true, recursive: true });
  cpSync(priorTarget, materialized, { recursive: true, dereference: false });
  renameSync(knowledgeRoot, backup);
  try {
    renameSync(materialized, knowledgeRoot);
    rmSync(backup, { force: true });
  } catch (error) {
    try {
      renameSync(backup, knowledgeRoot);
    } catch {
      throw new Error(
        'SHARED_KNOWLEDGE_ROOT_UNSAFE: materialization failed and symlink restoration failed',
        { cause: error },
      );
    }
    throw error;
  }
  return { migrated: true, priorTarget };
}
