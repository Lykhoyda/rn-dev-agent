import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAction } from './action-store.js';
import { readableActionsDirectory, resolveReadableActionCorpus, sameReadableActionCorpus, } from '../session/worktree-inheritance.js';
export async function listActions(projectRoot) {
    const corpus = resolveReadableActionCorpus(projectRoot);
    if (corpus.status === 'refused')
        throw new Error(corpus.reason);
    const readableDir = readableActionsDirectory(corpus);
    if (!readableDir)
        return [];
    let files;
    try {
        files = readdirSync(readableDir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
    const after = resolveReadableActionCorpus(projectRoot);
    if (!sameReadableActionCorpus(corpus, after)) {
        throw new Error(`Refusing replaced learned-action corpus symlink at ${join(projectRoot, '.rn-agent', 'actions')}.`);
    }
    const yamlFiles = files.filter((f) => /\.ya?ml$/.test(f)).sort();
    const results = [];
    for (const id of new Set(yamlFiles.map((file) => file.replace(/\.ya?ml$/, '')))) {
        // Inventory omits yaml/yml twins; resolveActionPath still refuses replay.
        if (yamlFiles.includes(`${id}.yaml`) && yamlFiles.includes(`${id}.yml`))
            continue;
        const action = loadAction(projectRoot, id);
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
