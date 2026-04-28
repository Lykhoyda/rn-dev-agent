import { okResult, withConnection } from '../utils.js';
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
    // requireHelpers: false — this tool only reads the in-process network
    // buffer (mutated by event-handlers.ts on Network.* CDP events). It never
    // evaluates JS in Hermes, so the freshness probe is unnecessary work.
    return withConnection(getClient, async (args, client) => {
        const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const pollIntervalMs = args.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
        const since = args.since !== undefined ? normalizeSince(args.since) : undefined;
        const scope = args.device ?? client.activeDeviceKey;
        const predicate = buildMatchPredicate(args.url_pattern, args.method, since);
        // Phase 1: retroactive scan — catches mutations already in the buffer
        // (the common case when no `since` is set, or when `since` predates
        // buffer entries that arrived during the MCP transport window).
        const existing = client.networkBufferManager.filter(scope, predicate);
        const found = existing.find(isComplete);
        if (found) {
            return okResult({ matched: true, mutation: found, network_log_since: existing, device: scope });
        }
        // Phase 2: poll the buffer until a completed match arrives or deadline.
        // Buffer entries are mutated in-place by Network.responseReceived
        // (event-handlers.ts:43), so polling the buffer is functionally
        // equivalent to subscribing to the event stream.
        const deadline = Date.now() + timeoutMs;
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
            const matches = client.networkBufferManager.filter(scope, predicate);
            const hit = matches.find(isComplete);
            if (hit) {
                return okResult({ matched: true, mutation: hit, network_log_since: matches, device: scope });
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
