import { assertReadableActionLoadContextStable, loadActionFromContext, openReadableActionLoadContext, } from './action-store.js';
function emitInventoryWarning(warning) {
    process.emitWarning(warning.message, {
        type: 'ActionInventoryWarning',
        code: warning.code,
    });
}
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
        const file = yamlFiles.includes(`${id}.yaml`) ? `${id}.yaml` : `${id}.yml`;
        let action;
        let failure;
        try {
            action = load(context, id);
            if (!action)
                failure = new Error('missing or invalid action metadata');
        }
        catch (error) {
            failure = error;
            action = null;
        }
        if (!action) {
            assertReadableActionLoadContextStable(context);
            const message = `Skipped corrupt action inventory entry ${file}: ${failure instanceof Error ? failure.message : String(failure)}`;
            (dependencies.onWarning ?? emitInventoryWarning)({
                code: 'ACTION_INVENTORY_ENTRY_SKIPPED',
                file,
                message,
            });
            continue;
        }
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
    assertReadableActionLoadContextStable(context);
    return results;
}
