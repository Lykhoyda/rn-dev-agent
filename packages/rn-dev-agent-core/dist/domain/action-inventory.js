import { loadActionFromContext, openReadableActionLoadContext, } from './action-store.js';
export async function listActions(projectRoot, dependencies = {}) {
    const context = openReadableActionLoadContext(projectRoot);
    if (!context)
        return [];
    const load = dependencies.loadAction ?? loadActionFromContext;
    const yamlFiles = context.files.filter((f) => /\.ya?ml$/.test(f)).sort();
    const results = [];
    for (const id of new Set(yamlFiles.map((file) => file.replace(/\.ya?ml$/, '')))) {
        // Inventory omits yaml/yml twins; resolveActionPath still refuses replay.
        if (yamlFiles.includes(`${id}.yaml`) && yamlFiles.includes(`${id}.yml`))
            continue;
        const action = load(context, id);
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
