import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';
export const DISCOVERY_TIMEOUT_MS = 1500;
export const USER_METRO_PORT = process.env.RN_METRO_PORT ? parseInt(process.env.RN_METRO_PORT, 10) : null;
export const DEFAULT_PORTS = [
    ...(USER_METRO_PORT && !isNaN(USER_METRO_PORT) ? [USER_METRO_PORT] : []),
    8081, 8082, 19000, 19006,
];
export async function discoverMetroPort(ports, timeout) {
    for (const p of ports) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
            const text = await resp.text();
            if (text.includes('packager-status:running')) {
                return p;
            }
        }
        catch {
            // Port not available, continue scanning
        }
        finally {
            clearTimeout(timer);
        }
    }
    return null;
}
export async function fetchTargets(port, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
        return (await resp.json());
    }
    catch (err) {
        throw new Error(`Failed to list CDP targets on port ${port}: ${err instanceof Error ? err.message : err}`);
    }
    finally {
        clearTimeout(timer);
    }
}
export function filterValidTargets(targets) {
    return targets
        .filter(t => !!t.webSocketDebuggerUrl && !t.title?.includes('Experimental') &&
        (t.vm === 'Hermes' || t.title?.includes('React Native') || t.description?.includes('React Native')))
        .map(t => ({
        ...t,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
            ?.replace(/\[::1\]/g, '127.0.0.1')
            ?.replace(/\[::\]/g, '127.0.0.1'),
    }));
}
export function inferPlatforms(targets) {
    let androidPackages = null;
    try {
        const out = execFileSync('adb', ['shell', 'pm', 'list', 'packages'], {
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        androidPackages = new Set(out.split('\n')
            .map(line => line.replace('package:', '').trim())
            .filter(Boolean));
    }
    catch {
        // adb not available or no device — all targets treated as iOS
    }
    for (const t of targets) {
        if (androidPackages?.has(t.description ?? '')) {
            t.platform = 'android';
        }
        else {
            t.platform = 'ios';
        }
    }
}
export function selectTarget(validTargets, filtersOrPlatform) {
    // Legacy single-string signature kept for back-compat; new callers pass an object.
    const filters = typeof filtersOrPlatform === 'string'
        ? { platform: filtersOrPlatform }
        : (filtersOrPlatform ?? {});
    let filteredTargets = validTargets;
    const warnings = [];
    // B111 (D635): targetId is an exact-id filter — highest precedence.
    if (filters.targetId) {
        const idMatched = validTargets.filter(t => t.id === filters.targetId);
        if (idMatched.length > 0) {
            filteredTargets = idMatched;
        }
        else {
            warnings.push(`targetId "${filters.targetId}" matched no targets; ignoring filter. Available ids: ${validTargets.map(t => t.id).join(', ')}`);
        }
    }
    // B111 (D635): bundleId matches target.description exactly.
    if (filters.bundleId && filteredTargets.length > 1) {
        const bundleMatched = filteredTargets.filter(t => t.description === filters.bundleId);
        if (bundleMatched.length > 0) {
            filteredTargets = bundleMatched;
        }
        else {
            warnings.push(`bundleId "${filters.bundleId}" matched no targets (available descriptions: ${filteredTargets.map(t => t.description ?? '?').join(', ')}); falling through.`);
        }
    }
    if (filters.platform && filteredTargets.length > 1) {
        const pf = filters.platform.toLowerCase();
        let platformMatched = filteredTargets.filter(t => t.platform === pf);
        if (platformMatched.length === 0) {
            platformMatched = filteredTargets.filter(t => {
                const haystack = `${t.title ?? ''} ${t.description ?? ''} ${t.vm ?? ''}`.toLowerCase();
                return haystack.includes(pf);
            });
        }
        if (platformMatched.length > 0) {
            filteredTargets = platformMatched;
        }
        else {
            warnings.push(`Platform filter "${filters.platform}" matched no targets (available: ${filteredTargets.map(t => `${t.description || t.id} [${t.platform ?? '?'}]`).join(', ')}). Connecting to best available target.`);
        }
    }
    // B111 (D635): smarter auto-selection — when a preferred bundleId exists (e.g. from
    // project-config.ts), prefer targets whose description matches it. This is a soft
    // filter: only applied when it narrows without eliminating all candidates.
    if (filters.preferredBundleId && filteredTargets.length > 1) {
        const preferred = filteredTargets.filter(t => t.description === filters.preferredBundleId);
        if (preferred.length > 0 && preferred.length < filteredTargets.length) {
            filteredTargets = preferred;
        }
    }
    const sorted = [...filteredTargets].sort((a, b) => {
        const aPage = parseInt(a.id?.split('-')[1] ?? '0', 10);
        const bPage = parseInt(b.id?.split('-')[1] ?? '0', 10);
        return bPage - aPage;
    });
    return { targets: sorted, warning: warnings.length > 0 ? warnings.join(' | ') : undefined };
}
export async function discover(currentPort, platformFilterOrFilters) {
    const filters = typeof platformFilterOrFilters === 'string'
        ? { platform: platformFilterOrFilters }
        : (platformFilterOrFilters ?? {});
    const ports = [...new Set([currentPort, ...DEFAULT_PORTS])];
    const hints = [];
    if (filters.platform)
        hints.push(`platform=${filters.platform}`);
    if (filters.targetId)
        hints.push(`targetId=${filters.targetId}`);
    if (filters.bundleId)
        hints.push(`bundleId=${filters.bundleId}`);
    if (filters.preferredBundleId)
        hints.push(`preferredBundleId=${filters.preferredBundleId}`);
    logger.debug('CDP', `Discovering Metro on ports: ${ports.join(', ')}${hints.length ? ` (${hints.join(', ')})` : ''}`);
    const metroPort = await discoverMetroPort(ports, DISCOVERY_TIMEOUT_MS);
    if (!metroPort) {
        throw new Error('Metro not found on ports ' + ports.join(', ') +
            '. Is the dev server running? Try: npx expo start or npx react-native start');
    }
    logger.info('CDP', `Metro found on port ${metroPort}`);
    const raw = await fetchTargets(metroPort, DISCOVERY_TIMEOUT_MS * 2);
    const validTargets = filterValidTargets(raw).filter(t => {
        try {
            const { hostname } = new URL(t.webSocketDebuggerUrl);
            return hostname === '127.0.0.1' || hostname === 'localhost';
        }
        catch {
            return false;
        }
    });
    if (validTargets.length === 0) {
        throw new Error('No Hermes debug target found. Is the app running? Is Hermes enabled?');
    }
    inferPlatforms(validTargets);
    const { targets: sorted, warning } = selectTarget(validTargets, filters);
    logger.debug('CDP', `Found ${sorted.length} valid target(s): ${sorted.map(t => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`);
    return { port: metroPort, targets: sorted, warning };
}
export async function discoverForList(currentPort, portHint) {
    const ports = [...new Set([portHint ?? currentPort, ...DEFAULT_PORTS])];
    const metroPort = await discoverMetroPort(ports, DISCOVERY_TIMEOUT_MS);
    if (!metroPort) {
        throw new Error('Metro not found on ports ' + ports.join(', '));
    }
    const raw = await fetchTargets(metroPort, DISCOVERY_TIMEOUT_MS * 2);
    const targets = filterValidTargets(raw);
    inferPlatforms(targets);
    return { port: metroPort, targets };
}
