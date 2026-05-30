const FRESHNESS_PROBE_MS = 2000;
const STALE_RETRY_DELAY_MS = 500;
const STALE_RETRY_PROBE_MS = 3000;
// GH #186: cross-tool "the CDP target may be stale" signal. A device-session
// runner-leak recovery can re-foreground/relaunch the app out from under CDP,
// after which the next cdp_* call would hit a ~47s STALE_TARGET timeout in the
// handler. The recovery sets this flag; withConnection consumes it before the
// next handler and proactively re-pins via recoverFromStaleTarget, turning that
// 47s catch-path recovery into a fast pre-handler one. Process-scoped boolean —
// a single MCP serves one device at a time, so no per-client keying is needed.
let cdpStale = false;
export function markCdpStale() { cdpStale = true; }
/** Read-and-clear: returns whether the stale flag was set, resetting it. */
export function consumeCdpStale() {
    const was = cdpStale;
    cdpStale = false;
    return was;
}
export async function probeFreshness(client, timeoutMs = FRESHNESS_PROBE_MS) {
    if (!client.isConnected) {
        return { fresh: false, version: null, probed: false };
    }
    let probeTimer;
    try {
        const result = await Promise.race([
            client.evaluate('typeof globalThis.__RN_AGENT === "object" && globalThis.__RN_AGENT.__v'),
            new Promise((resolve) => {
                probeTimer = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs);
            }),
        ]);
        if (probeTimer)
            clearTimeout(probeTimer);
        if (result.error || typeof result.value !== 'number') {
            return { fresh: false, version: null, probed: true };
        }
        return { fresh: true, version: result.value, probed: true };
    }
    catch {
        if (probeTimer)
            clearTimeout(probeTimer);
        return { fresh: false, version: null, probed: true };
    }
}
export async function recoverFromStaleTarget(client) {
    if (!client.isConnected) {
        return { recovered: false, reason: 'probe-failed', error: 'Client not connected' };
    }
    let probe = await probeDev(client, FRESHNESS_PROBE_MS);
    let isStale = !probe.ok;
    // D526: retry once to avoid false positives from GC pauses / transient blocks
    if (isStale && probe.timedOut) {
        await sleep(STALE_RETRY_DELAY_MS);
        probe = await probeDev(client, STALE_RETRY_PROBE_MS);
        isStale = !probe.ok;
    }
    if (!isStale) {
        return { recovered: false, reason: 'not-stale' };
    }
    try {
        await client.softReconnect();
        return { recovered: true, reason: 'reconnected' };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { recovered: false, reason: 'reconnect-failed', error: msg };
    }
}
async function probeDev(client, timeoutMs) {
    let timer;
    try {
        const result = await Promise.race([
            client.evaluate('typeof __DEV__ !== "undefined" && __DEV__ === true'),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve({ error: 'probe timeout' }), timeoutMs);
            }),
        ]);
        if (timer)
            clearTimeout(timer);
        return {
            ok: result.error === undefined && result.value === true,
            timedOut: result.error === 'probe timeout',
        };
    }
    catch {
        if (timer)
            clearTimeout(timer);
        return { ok: false, timedOut: false };
    }
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
