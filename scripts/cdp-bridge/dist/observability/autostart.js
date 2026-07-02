export async function autostartObserve(deps) {
    try {
        if (!deps.findRoot())
            return null;
        const res = deps.resolveEnabled();
        if (!res.enabled) {
            deps.info(`observe UI autostart disabled (${res.source})`);
            return null;
        }
        const { url } = await deps.start();
        deps.info(`observe UI autostarted: ${url}`);
        return { url };
    }
    catch (e) {
        deps.warn(`observe UI autostart failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
