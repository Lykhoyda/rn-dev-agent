export async function autostartObserve(deps) {
    try {
        // GH #672: a blocked contender shares the owner's deterministic Observe port.
        // Autostarting there produces a port conflict and a child the contender has no
        // authority to own — recovery must be the only thing it can do.
        const recoveryOnly = deps.recoveryOnlyReason?.() ?? null;
        if (recoveryOnly) {
            deps.info(`observe UI autostart skipped (${recoveryOnly})`);
            return null;
        }
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
