import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAction } from './action-store.js';
export async function listActions(projectRoot) {
    const actionsDir = join(projectRoot, '.rn-agent', 'actions');
    let files;
    try {
        files = readdirSync(actionsDir);
    }
    catch {
        return [];
    }
    const yamlFiles = files.filter((f) => f.endsWith('.yaml')).sort();
    const results = [];
    for (const file of yamlFiles) {
        const id = file.slice(0, -5);
        let action;
        try {
            action = loadAction(projectRoot, id);
        }
        catch {
            continue;
        }
        if (!action)
            continue;
        const { metadata } = action;
        const summary = {
            id: metadata.id,
            intent: metadata.intent,
            status: metadata.status,
        };
        if (metadata.params !== undefined)
            summary.params = metadata.params;
        if (metadata.mutates !== undefined)
            summary.mutates = metadata.mutates;
        if (metadata.appId !== undefined)
            summary.appId = metadata.appId;
        results.push(summary);
    }
    return results;
}
