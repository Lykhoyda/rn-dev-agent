import { okResult, withConnection } from "../utils.js";
import { drainNetworkHookBuffer } from "../cdp/net-hook-drain.js";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const CANDIDATES_CAP = 10;
/**
 * Normalize a user-supplied ISO-ish timestamp to the UTC Z-form that
 * NetworkEntry.timestamp uses. Returns the input unchanged when not
 * parseable, matching cdp_network_log's leniency (network-log.ts:31-35).
 */
export function normalizeSince(since) {
    const parsed = new Date(since);
    return Number.isNaN(parsed.getTime()) ? since : parsed.toISOString();
}
/**
 * Build the URL-pattern + method + since match predicate. Does NOT
 * include the completion gate — pair with isComplete to find fully-arrived
 * responses, or use alone to also surface in-flight candidates.
 *
 * `since` must already be normalized via normalizeSince so lex-comparison
 * against entry timestamps is correct.
 */
export function buildMatchPredicate(urlPattern, method, since) {
    const wantedMethods = method === undefined
        ? null
        : (Array.isArray(method) ? method : [method]).map((m) => m.toUpperCase());
    return (entry) => {
        if (!entry.url.includes(urlPattern))
            return false;
        if (since !== undefined && entry.timestamp < since)
            return false;
        if (wantedMethods !== null && !wantedMethods.includes(entry.method.toUpperCase()))
            return false;
        return true;
    };
}
/**
 * Completion gate: the response (or terminal failure with status=0) has
 * arrived. Separate from the match predicate so callers can differentiate
 * "fully arrived" from "matched but still in-flight" in the timeout
 * diagnostic payload.
 */
export function isComplete(entry) {
    return entry.status !== undefined;
}
export function createWaitForNetworkHandler(getClient) {
    // requireHelpers: false — this tool reads the in-process network buffer
    // (mutated by event-handlers.ts on Network.* CDP events). In hook mode it
    // additionally drains the in-app __RN_AGENT_NET_BUF__ via evaluate
    // (fail-open, throttled); the freshness probe is still unnecessary work.
    return withConnection(getClient, async (args, client) => {
        const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const pollIntervalMs = args.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
        const since = args.since !== undefined ? normalizeSince(args.since) : undefined;
        const scope = args.device ?? client.activeDeviceKey;
        const predicate = buildMatchPredicate(args.url_pattern, args.method, since);
        // Capture deadline before the phase-1 drain so a slow evaluate round-trip
        // cannot silently eat into the caller's wait budget.
        const deadline = Date.now() + timeoutMs;
        // Phase 1: retroactive scan — catches mutations already in the buffer
        // (the common case when no `since` is set, or when `since` predates
        // buffer entries that arrived during the MCP transport window).
        // Drain targets the active device; `scope` only filters the read — intentionally decoupled.
        await drainNetworkHookBuffer(client);
        const existing = client.networkBufferManager.filter(scope, predicate);
        const found = existing.find(isComplete);
        if (found) {
            return okResult({
                matched: true,
                mutation: found,
                network_log_since: existing,
                device: scope,
            });
        }
        // Phase 2: poll the buffer until a completed match arrives or deadline.
        // Buffer entries are mutated in-place by Network.responseReceived
        // (event-handlers.ts:43), so polling the buffer is functionally
        // equivalent to subscribing to the event stream.
        // DRAIN_MIN_INTERVAL_MS: evaluate round-trips are not free; 500ms caps
        // drain overhead at ~2/s while phase-1 catches pre-existing entries.
        const DRAIN_MIN_INTERVAL_MS = 500;
        let lastDrainAt = Date.now();
        while (Date.now() < deadline) {
            // Bail early if the connection died mid-wait — otherwise we'd poll a
            // frozen buffer for the full timeout duration. Match the convention
            // from withConnection's reconnect loops (utils.ts:83, 96, 161, 167).
            if (!client.isConnected) {
                const partials = client.networkBufferManager.filter(scope, predicate);
                return okResult({
                    matched: false,
                    timeout_ms: timeoutMs,
                    candidates_seen: partials.slice(-CANDIDATES_CAP),
                    device: scope,
                    disconnected: true,
                });
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
            if (Date.now() - lastDrainAt >= DRAIN_MIN_INTERVAL_MS) {
                lastDrainAt = Date.now();
                await drainNetworkHookBuffer(client);
            }
            const matches = client.networkBufferManager.filter(scope, predicate);
            const hit = matches.find(isComplete);
            if (hit) {
                return okResult({
                    matched: true,
                    mutation: hit,
                    network_log_since: matches,
                    device: scope,
                });
            }
        }
        // Timeout: surface up to CANDIDATES_CAP matched entries (completed or
        // in-flight) so the agent can self-correct (e.g., wrong url_pattern →
        // see what DID fire) without another tool roundtrip.
        const finalMatches = client.networkBufferManager.filter(scope, predicate);
        return okResult({
            matched: false,
            timeout_ms: timeoutMs,
            candidates_seen: finalMatches.slice(-CANDIDATES_CAP),
            device: scope,
        });
    }, { requireHelpers: false });
}
