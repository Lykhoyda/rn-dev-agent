import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAction } from './action-store.js';

export interface ActionSummary {
  id: string;
  intent: string;
  status: string;
  params?: string[];
  mutates?: boolean;
  appId?: string;
}

export async function listActions(projectRoot: string): Promise<ActionSummary[]> {
  const actionsDir = join(projectRoot, '.rn-agent', 'actions');
  let files: string[];
  try {
    files = readdirSync(actionsDir);
  } catch {
    return [];
  }
  const yamlFiles = files.filter((f) => f.endsWith('.yaml')).sort();
  const results: ActionSummary[] = [];
  for (const file of yamlFiles) {
    const id = file.slice(0, -5);
    let action;
    try {
      action = loadAction(projectRoot, id);
    } catch {
      continue;
    }
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
