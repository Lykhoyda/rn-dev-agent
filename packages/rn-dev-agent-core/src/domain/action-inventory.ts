import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAction } from './action-store.js';
import {
  readableActionsDirectory,
  resolveReadableActionCorpus,
  sameReadableActionCorpus,
} from '../session/worktree-inheritance.js';

import type { ActionSummary } from '../observability/wire-types.js';

// GH #438: ActionSummary lives in observability/wire-types.ts (shared with
// the observe SPA).
export type { ActionSummary } from '../observability/wire-types.js';

export async function listActions(projectRoot: string): Promise<ActionSummary[]> {
  const corpus = resolveReadableActionCorpus(projectRoot);
  if (corpus.status === 'refused') throw new Error(corpus.reason);
  const readableDir = readableActionsDirectory(corpus);
  if (!readableDir) return [];
  let files: string[];
  try {
    files = readdirSync(readableDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const after = resolveReadableActionCorpus(projectRoot);
  if (!sameReadableActionCorpus(corpus, after)) {
    throw new Error(
      `Refusing replaced learned-action corpus symlink at ${join(projectRoot, '.rn-agent', 'actions')}.`,
    );
  }
  const yamlFiles = files.filter((f) => /\.ya?ml$/.test(f)).sort();
  const results: ActionSummary[] = [];
  for (const id of new Set(yamlFiles.map((file) => file.replace(/\.ya?ml$/, '')))) {
    // Inventory omits yaml/yml twins; resolveActionPath still refuses replay.
    if (yamlFiles.includes(`${id}.yaml`) && yamlFiles.includes(`${id}.yml`)) continue;
    const action = loadAction(projectRoot, id);
    if (!action) continue;
    const { metadata } = action;
    const summary: ActionSummary = {
      id: metadata.id,
      intent: metadata.intent,
      status: metadata.status,
    };
    if (metadata.params !== undefined) summary.params = metadata.params;
    if (metadata.mutates !== undefined) summary.mutates = metadata.mutates;
    if (metadata.appId !== undefined) summary.appId = metadata.appId;
    results.push(summary);
  }
  return results;
}
