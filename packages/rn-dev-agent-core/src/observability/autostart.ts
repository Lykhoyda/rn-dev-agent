/**
 * Spec 2026-07-02: autostart the observe web UI at MCP worker boot — but only
 * inside a detected RN project, only when enabled (env > config > default on),
 * and NEVER fatally: an autostart failure is a warning, not a boot error.
 * Dependency-injected so the gating logic is unit-testable without sockets.
 */
export interface AutostartDeps {
  findRoot: () => string | null;
  resolveEnabled: () => { enabled: boolean; source: 'env' | 'config' | 'default' };
  /** GH #672: reason this session may not open operational children (blocked contender), or null. */
  recoveryOnlyReason?: () => string | null;
  start: () => Promise<{ url: string; port: number }>;
  warn: (msg: string) => void;
  info: (msg: string) => void;
}

export async function autostartObserve(deps: AutostartDeps): Promise<{ url: string } | null> {
  try {
    // GH #672: a blocked contender shares the owner's deterministic Observe port.
    // Autostarting there produces a port conflict and a child the contender has no
    // authority to own — recovery must be the only thing it can do.
    const recoveryOnly = deps.recoveryOnlyReason?.() ?? null;
    if (recoveryOnly) {
      deps.info(`observe UI autostart skipped (${recoveryOnly})`);
      return null;
    }
    if (!deps.findRoot()) return null;
    const res = deps.resolveEnabled();
    if (!res.enabled) {
      deps.info(`observe UI autostart disabled (${res.source})`);
      return null;
    }
    const { url } = await deps.start();
    deps.info(`observe UI autostarted: ${url}`);
    return { url };
  } catch (e) {
    deps.warn(`observe UI autostart failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
