export function validateRouteSequenceAgainstGraph(graph, expected) {
    if (!expected || expected.length === 0)
        return { ok: true };
    const known = new Set(graph?.all_screens ?? []);
    // Empty/unknown graph → can't make a confident judgement; don't false-positive.
    if (known.size === 0)
        return { ok: true };
    const missing = expected.filter((s) => !known.has(s));
    if (missing.length > 0) {
        return {
            ok: false,
            reason: `action expects screen(s) the nav graph no longer has: ${missing.join(", ")}`,
            missing,
        };
    }
    return { ok: true };
}
export function classifyRouteDriftAfterFailure(input) {
    const { expectedSequence, liveRoute } = input;
    if (!expectedSequence || expectedSequence.length === 0)
        return { isDrift: false, liveRoute };
    if (!liveRoute)
        return { isDrift: false, liveRoute };
    if (!expectedSequence.includes(liveRoute)) {
        return {
            isDrift: true,
            liveRoute,
            reason: `live route "${liveRoute}" is not in the action's expected sequence [${expectedSequence.join(" → ")}] — an unexpected screen appeared (structural drift, not a stale selector)`,
        };
    }
    return { isDrift: false, liveRoute };
}
