// M11 / Phase 90 Tier 3: Metro --clear / --reset-cache hint.
//
// When the MCP's buffers return empty while the session has been active
// for more than METRO_CLEAR_HINT_THRESHOLD_MS, suggest restarting Metro
// with a cache clear. The common failure mode this targets is a stale
// bundle cache — app logs/requests happen but never reach the MCP because
// a mismatched bundle is running. Source: metro-mcp troubleshooting
// "Empty Results or Stale Data" (top-3 issue).
export const METRO_CLEAR_HINT_THRESHOLD_MS = 60_000;
export const METRO_CLEAR_HINT_TEXT = 'If results stay empty, try restarting Metro with `npx expo start --clear` ' +
    'or `npx react-native start --reset-cache`. The MCP will reconnect automatically.';
/**
 * Decide whether to include the Metro --clear hint in a tool result.
 *
 * Semantics: the idle-clock reference is the MORE RECENT of `connectedAt`
 * and `lastEventAt`. Any activity (connecting OR receiving an event)
 * resets the clock. Both must be older than the threshold for the hint
 * to fire.
 */
export function shouldShowMetroClearHint(deps, resultIsEmpty) {
    if (!resultIsEmpty)
        return false;
    if (deps.connectedAt == null)
        return false;
    const ref = Math.max(deps.connectedAt, deps.lastEventAt ?? deps.connectedAt);
    return deps.now() - ref >= METRO_CLEAR_HINT_THRESHOLD_MS;
}
