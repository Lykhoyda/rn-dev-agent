import { DISCOVERY_TIMEOUT_MS, discoverAllMetroPorts, fetchTargets, filterValidTargets, inferPlatformFromDeviceName, resolveDefaultPorts, targetMatchesBundleId, } from '../cdp/discovery.js';
import { SessionAuthorityError } from './registry.js';
import { filterTargetsForExactDevice, } from './target-device-authority.js';
function targetServedByPort(target, port) {
    try {
        const { hostname, port: targetPort } = new URL(target.webSocketDebuggerUrl);
        return (hostname === '127.0.0.1' || hostname === 'localhost') && Number(targetPort) === port;
    }
    catch {
        return false;
    }
}
/**
 * GH #630: affirmative dev-client fallback evidence. Returns the sibling Metro
 * that advertises a live Hermes target for the session's app proven (via
 * deviceName↔UDID/serial resolution) to run on the session's exact device — or
 * null when no such proof exists. Null is "unprovable", never "safe". Scan
 * breadth is resolveDefaultPorts() unless overridden, so an exotic sibling port
 * degrades to unprovable, not to a false verdict.
 */
export async function findForeignMetroOrigin(query, dependencies) {
    let siblingPorts;
    try {
        siblingPorts = (await dependencies.listSiblingMetroPorts(query.expectedMetroPort)).filter((port) => port !== query.expectedMetroPort);
    }
    catch {
        return null;
    }
    if (siblingPorts.length === 0)
        return null;
    const candidates = [];
    await Promise.all(siblingPorts.map(async (port) => {
        try {
            // Platform screen uses only the pure deviceName heuristic: null means
            // unknown (kept), never a defaulted guess, and no subprocess probes.
            const targets = filterValidTargets(await dependencies.fetchPortTargets(port)).filter((target) => targetMatchesBundleId(target, query.appId) &&
                targetServedByPort(target, port) &&
                (inferPlatformFromDeviceName(target.deviceName) ?? query.platform) === query.platform);
            for (const target of targets)
                candidates.push({ deviceName: target.deviceName, port });
        }
        catch {
            // An uninspectable sibling yields no evidence either way.
        }
    }));
    if (candidates.length === 0)
        return null;
    let matches;
    try {
        matches = await dependencies.filterForExactDevice({
            platform: query.platform,
            deviceId: query.deviceId,
            targets: candidates,
        });
    }
    catch {
        return null;
    }
    const match = matches.find((candidate) => candidate.deviceName?.trim());
    return match?.deviceName ? { port: match.port, targetDeviceName: match.deviceName.trim() } : null;
}
export const FOREIGN_METRO_SCAN_DEADLINE_MS = 8_000;
export const FOREIGN_METRO_SCAN_UNPROVABLE_TTL_MS = 10_000;
export const FOREIGN_METRO_SCAN_EVIDENCE_TTL_MS = 2_000;
const FOREIGN_METRO_SCAN_CACHE_CAPACITY = 32;
function scanCacheKey(query) {
    return JSON.stringify([query.platform, query.deviceId, query.appId, query.expectedMetroPort]);
}
/** Collapses a repeated device_* loop onto one scan; failures are never cached. */
export function memoizeForeignMetroOriginScanner(scan, options = {}) {
    const now = options.now ?? (() => Date.now());
    const unprovableTtlMs = options.unprovableTtlMs ?? FOREIGN_METRO_SCAN_UNPROVABLE_TTL_MS;
    const evidenceTtlMs = options.evidenceTtlMs ?? FOREIGN_METRO_SCAN_EVIDENCE_TTL_MS;
    const capacity = options.capacity ?? FOREIGN_METRO_SCAN_CACHE_CAPACITY;
    const settled = new Map();
    const inFlight = new Map();
    let epoch = 0;
    const memoized = Object.assign((query) => {
        const key = scanCacheKey(query);
        const cached = settled.get(key);
        if (cached) {
            if (cached.expiresAt > now())
                return Promise.resolve(cached.value);
            settled.delete(key);
        }
        const pending = inFlight.get(key);
        if (pending)
            return pending;
        const startedEpoch = epoch;
        const started = scan(query)
            .then((value) => {
            if (startedEpoch !== epoch)
                return value;
            settled.set(key, {
                value,
                expiresAt: now() + (value ? evidenceTtlMs : unprovableTtlMs),
            });
            if (settled.size > capacity) {
                const oldest = settled.keys().next();
                if (!oldest.done)
                    settled.delete(oldest.value);
            }
            return value;
        })
            .finally(() => {
            inFlight.delete(key);
        });
        inFlight.set(key, started);
        return started;
    }, {
        invalidate(query) {
            epoch += 1;
            if (query)
                settled.delete(scanCacheKey(query));
            else
                settled.clear();
        },
    });
    return memoized;
}
export function createForeignMetroOriginScanner(authority, overrides = {}) {
    const dependencies = {
        listSiblingMetroPorts: overrides.listSiblingMetroPorts ??
            ((expectedMetroPort) => discoverAllMetroPorts([...new Set(resolveDefaultPorts())].filter((port) => port !== expectedMetroPort), DISCOVERY_TIMEOUT_MS)),
        fetchPortTargets: overrides.fetchPortTargets ?? ((port) => fetchTargets(port, DISCOVERY_TIMEOUT_MS)),
        filterForExactDevice: overrides.filterForExactDevice ?? ((input) => filterTargetsForExactDevice(input, authority)),
    };
    // A deadline overrun means "unprovable", never a verdict — same as any other
    // evidence-gathering failure inside the scan.
    return memoizeForeignMetroOriginScanner((query) => {
        let timer;
        const deadline = new Promise((resolveDeadline) => {
            timer = setTimeout(() => resolveDeadline(null), FOREIGN_METRO_SCAN_DEADLINE_MS);
            timer.unref?.();
        });
        return Promise.race([findForeignMetroOrigin(query, dependencies), deadline]).finally(() => {
            if (timer !== undefined)
                clearTimeout(timer);
        });
    });
}
const PROVEN_METRO_ORIGIN_META_KEY = 'metroOriginPinning';
export function provenMetroOriginMismatch(expectedMetroPort, context, evidence) {
    const error = new SessionAuthorityError('METRO_ORIGIN_MISMATCH', `the bound ${context.platform} device ${context.deviceId} is running ${context.appId} served by Metro :${evidence.port}, not this session's Metro :${expectedMetroPort}`, undefined, {
        expected: `Metro :${expectedMetroPort}`,
        observed: `Metro :${evidence.port} (target on ${evidence.targetDeviceName})`,
        nextAction: 'Re-point the dev client to this session\'s Metro with rn_session action "pin_dev_client", then retry.',
    });
    error.attachMeta({
        [PROVEN_METRO_ORIGIN_META_KEY]: 'proven-foreign-metro',
        foreignMetroPort: evidence.port,
    });
    return error;
}
export function recordedMetroOriginConflict(expectedMetroPort, boundMetroPort) {
    const error = new SessionAuthorityError('METRO_ORIGIN_MISMATCH', `the device binding recorded Metro :${expectedMetroPort} as its expected origin, but the session's Metro authority is bound to :${boundMetroPort}`, undefined, {
        expected: `Metro :${expectedMetroPort}`,
        observed: `Metro :${boundMetroPort}`,
        nextAction: 'Re-bind the device with rn_session action "bind_device" so its expected Metro origin matches the bound Metro.',
    });
    error.attachMeta({ [PROVEN_METRO_ORIGIN_META_KEY]: 'recorded-origin-conflict' });
    return error;
}
/** True only for a PROVEN origin mismatch — the fail-closed subset the gate must never swallow. */
export function isProvenMetroOriginMismatch(error) {
    return (error instanceof SessionAuthorityError &&
        error.code === 'METRO_ORIGIN_MISMATCH' &&
        error.getSupplementalMeta()[PROVEN_METRO_ORIGIN_META_KEY] !== undefined);
}
