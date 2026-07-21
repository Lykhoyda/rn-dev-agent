function uniqueValues(values) {
    return [...new Set(values.filter((value) => Boolean(value)))];
}
function uniqueMatches(output, pattern) {
    return uniqueValues([...output.matchAll(pattern)].map((match) => match[1]));
}
/**
 * Verify the process that actually executed the flow, not the metadata used to
 * request it. maestro-runner 1.0.9 emits the selected device in its report/log
 * and every iOS WDA build/start target in its log stream; those direct receipts
 * are replay authority. A requested UDID alone is never accepted as proof.
 */
export function verifyMaestroDeviceAuthority(input) {
    const requestedDeviceId = input.requestedDeviceId?.trim() || null;
    const reportedIds = uniqueValues([
        ...(input.directReportDeviceIds ?? []),
        ...uniqueMatches(input.output, /\b(?:Found|Using specified) (?:(?:iOS|Android) )?device:\s*([A-Za-z0-9._:-]+)/gi),
    ]);
    const wdaDeviceIds = uniqueMatches(input.output, /\b(?:Building WDA for|Starting WDA on) device\s+([A-Za-z0-9._:-]+)/gi);
    const observedDeviceIds = [...new Set([...reportedIds, ...wdaDeviceIds])];
    const reportedDeviceId = reportedIds.length === 1 ? reportedIds[0] : null;
    if (!requestedDeviceId) {
        return {
            requestedDeviceId,
            reportedDeviceId,
            observedDeviceIds,
            wdaDeviceIds,
            verified: false,
            source: reportedIds.length > 0 ? 'maestro-runner-log' : 'none',
            reason: 'no-exact-device-request',
        };
    }
    // The official Maestro CLI receives --udid too, but its normal output does
    // not provide a stable direct-device receipt. Forward the exact target while
    // declining to manufacture RunRecord authority from argv metadata.
    if (input.runner !== 'maestro-runner') {
        return {
            requestedDeviceId,
            reportedDeviceId,
            observedDeviceIds,
            wdaDeviceIds,
            verified: false,
            source: 'maestro-cli-explicit-udid',
            reason: 'direct-runner-evidence-unavailable',
        };
    }
    const base = {
        requestedDeviceId,
        reportedDeviceId,
        observedDeviceIds,
        wdaDeviceIds,
        source: 'maestro-runner-log',
    };
    if (reportedIds.length === 0) {
        return { ...base, verified: false, reason: 'reported-device-missing' };
    }
    if (reportedIds.length !== 1) {
        return { ...base, verified: false, reason: 'reported-device-ambiguous' };
    }
    if (reportedDeviceId !== requestedDeviceId) {
        return { ...base, verified: false, reason: 'reported-device-mismatch' };
    }
    if (observedDeviceIds.some((id) => id !== requestedDeviceId)) {
        return { ...base, verified: false, reason: 'wda-device-mismatch' };
    }
    if (input.platform === 'ios' &&
        input.requireWdaProvenance === true &&
        wdaDeviceIds.length === 0) {
        return { ...base, verified: false, reason: 'wda-provenance-missing' };
    }
    return {
        ...base,
        verified: true,
        reason: input.platform === 'ios' && wdaDeviceIds.length > 0
            ? 'exact-runner-and-wda-match'
            : 'exact-runner-match',
    };
}
export function shouldRejectMaestroDeviceAuthority(authority) {
    return (authority.requestedDeviceId !== null &&
        authority.source === 'maestro-runner-log' &&
        !authority.verified);
}
