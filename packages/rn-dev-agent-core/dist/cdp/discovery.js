import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';
import { cwdForPort, pathMatchesRoot, resolveBridgeProjectRoot } from './metro-cwd.js';
/**
 * GH #208 (RC2): thrown by `discover()` when Metro IS reachable but advertises
 * zero Hermes debug targets — the app has detached (Expo dev launcher,
 * backgrounded, or crashed). Distinct from the "Metro not found" case so
 * callers (cdp_status) can trigger the bounded auto-relaunch recovery
 * (recover-detached.ts) instead of misreporting Metro as down. Carries the
 * resolved Metro port for the recovery + diagnostics.
 */
export class AppDetachedError extends Error {
    port;
    /**
     * GH #303: all Metro ports found running at throw time. `.port` is preserved
     * for back-compat/diagnostics only — recover-detached.ts relaunches by the
     * active session's deviceId/appId and never reads it.
     */
    runningPorts;
    constructor(port, runningPorts = [port]) {
        super(`Metro is up on port ${port}` +
            (runningPorts.length > 1 ? ` (also running: ${runningPorts.join(', ')})` : '') +
            ` but advertises 0 Hermes debug targets — the app isn't attached ` +
            `(it may be on the Expo dev launcher, backgrounded, or crashed). Relaunch the app, ` +
            `or call cdp_status to auto-relaunch and reconnect.`);
        this.name = 'AppDetachedError';
        this.port = port;
        this.runningPorts = runningPorts;
    }
}
export const DISCOVERY_TIMEOUT_MS = 1500;
/**
 * GH #577: default discovery ports, resolved lazily at call time. When
 * RN_CDP_DISCOVERY_PORTS is set it REPLACES the built-in defaults (including
 * the RN_METRO_PORT entry) — an empty value yields no defaults, so discovery
 * probes only the caller-supplied current/hint port. This lets integration
 * tests own their entire discovery surface; production behavior is unchanged
 * when the variable is unset.
 */
export function resolveDefaultPorts() {
    const override = process.env.RN_CDP_DISCOVERY_PORTS;
    if (override !== undefined) {
        return (override
            .split(',')
            // Whole-value parse — parseInt would accept "9123abc"/"8081.5" as
            // 9123/8081 and silently probe an unintended Metro after a typo.
            .map((entry) => (entry.trim() === '' ? NaN : Number(entry.trim())))
            .filter((port) => Number.isInteger(port) && port > 0));
    }
    const userPort = process.env.RN_METRO_PORT ? parseInt(process.env.RN_METRO_PORT, 10) : NaN;
    return [
        ...(Number.isInteger(userPort) && userPort > 0 ? [userPort] : []),
        8081,
        8082,
        19000,
        19006,
    ];
}
/**
 * GH #303: probe ALL candidate ports in parallel and return every one that is a
 * running Metro. The caller then prefers a port with an attached Hermes target
 * so a detached sibling-worktree Metro can't shadow a healthy one. (Replaces the
 * old first-match `discoverMetroPort`.) Closed localhost ports refuse fast (no
 * per-port timeout cost); only ports that accept but stall hit the timeout.
 */
export async function discoverAllMetroPorts(ports, timeout) {
    const checks = await Promise.all(ports.map(async (p) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
            const text = await resp.text();
            return text.includes('packager-status:running') ? p : null;
        }
        catch {
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }));
    return checks.filter((p) => p !== null);
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
        .filter((t) => !!t.webSocketDebuggerUrl &&
        !t.title?.includes('Experimental') &&
        (t.vm === 'Hermes' ||
            t.title?.includes('React Native') ||
            t.description?.includes('React Native')))
        .map((t) => ({
        ...t,
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
            ?.replace(/\[::1\]/g, '127.0.0.1')
            ?.replace(/\[::\]/g, '127.0.0.1'),
    }));
}
/**
 * B116 (D639): extract top-level bundle IDs from `xcrun simctl listapps booted`.
 * Also used (GH#202 Phase 4) against `simctl listapps <udid>` — same plist shape;
 * live-gated against a real device in Phase 4.
 * Output is NeXTSTEP plist; top-level keys are quoted bundle IDs at exactly
 * 4-space indentation, e.g. `    "com.foo.bar" = {`. We match that pattern
 * explicitly so we don't pick up nested keys like GroupContainers entries.
 */
export function parseSimctlListapps(stdout) {
    const ids = new Set();
    const TOP_LEVEL = /^    "([A-Za-z0-9._-]+)"\s*=\s*\{/;
    for (const line of stdout.split('\n')) {
        const m = line.match(TOP_LEVEL);
        if (m)
            ids.add(m[1]);
    }
    return ids;
}
function readAndroidPackages() {
    try {
        const out = execFileSync('adb', ['shell', 'pm', 'list', 'packages'], {
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return new Set(out
            .split('\n')
            .map((line) => line.replace('package:', '').trim())
            .filter(Boolean));
    }
    catch {
        return null;
    }
}
function readIOSPackages() {
    try {
        const out = execFileSync('xcrun', ['simctl', 'listapps', 'booted'], {
            timeout: 5000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return parseSimctlListapps(out);
    }
    catch {
        return null;
    }
}
/**
 * B116 (D639): look up each target's description against BOTH iOS simctl and
 * Android adb installed-package sets. If present in only one, tag that
 * platform. If present in both (same bundleId installed on both devices),
 * we can't disambiguate from bundleId alone — leave the target ambiguous
 * (callers must pass `targetId` or `bundleId` + `platform`).
 * If present in neither (or lookup failed), fall back to iOS (matches prior
 * behavior — iOS-first bias).
 *
 * Readers are injectable for unit testing without spawning subprocesses.
 */
/**
 * B131 (D660): infer platform from Metro's `deviceName` field when present.
 * Metro 0.76+ includes this in /json/list (e.g. `"iPhone 17 Pro"` or
 * `"sdk_gphone16k_arm64 - 17 - API 37"`). Deterministic and survives the
 * ambiguous-bundle case where the same appId is installed on both platforms
 * (which defeats the B116 package-list inference). Returns null if the name
 * doesn't match either platform convention; caller falls back to package-list
 * inference.
 */
export function inferPlatformFromDeviceName(deviceName) {
    if (!deviceName)
        return null;
    const name = deviceName.toLowerCase();
    // Check iOS FIRST. Multi-review follow-up (L2): a user-renamed device like
    // "My Android-tester iPad" should be classified as iOS because it contains
    // `\bipad\b`. iOS patterns are narrower than Android patterns, so iOS-first
    // check yields fewer false positives. Android-only signals (sdk_gphone,
    // emulator, Pixel, Galaxy, OnePlus, API N) are unlikely to appear in iOS
    // device names the other direction.
    const iosPatterns = /\biphone\b|\bipad\b|\bipod\b|\bios\b/i;
    if (iosPatterns.test(name))
        return 'ios';
    // Android patterns: emulator names (`sdk_gphone`, `emulator`), physical
    // device families (`Pixel`, `Galaxy`, `OnePlus`), the literal `android`, or
    // the `API N` suffix Metro appends on emulators.
    const androidPatterns = /sdk_gphone|emulator|\bpixel\b|\bgalaxy\b|\boneplus\b|\bandroid\b|\bapi\s+\d+\b/i;
    if (androidPatterns.test(name))
        return 'android';
    return null;
}
export function inferPlatforms(targets, readers = {}) {
    const androidPackages = (readers.readAndroid ?? readAndroidPackages)();
    const iosPackages = (readers.readIOS ?? readIOSPackages)();
    for (const t of targets) {
        // B131 (D660): deviceName is the most reliable signal when present.
        // It's deterministic (doesn't depend on adb/simctl running) and correct
        // even when the same bundleId is installed on both iOS and Android
        // (the exact case B116 marks `ambiguousPlatform`).
        const fromDeviceName = inferPlatformFromDeviceName(t.deviceName);
        if (fromDeviceName) {
            t.platform = fromDeviceName;
            continue;
        }
        const desc = t.description ?? '';
        const inAndroid = androidPackages?.has(desc) ?? false;
        const inIOS = iosPackages?.has(desc) ?? false;
        if (inAndroid && !inIOS) {
            t.platform = 'android';
        }
        else if (inIOS && !inAndroid) {
            t.platform = 'ios';
        }
        else if (inAndroid && inIOS) {
            // Ambiguous — same bundleId installed on both. Default to iOS but mark
            // for downstream so callers can notice and pass targetId/bundleId filter.
            t.platform = 'ios';
            t.ambiguousPlatform = true;
        }
        else {
            // No information (adb/simctl both failed, or target bundle unknown) —
            // default to iOS to preserve prior behavior for iOS-only setups.
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
    if (filters.deviceKind) {
        const deviceMatched = filteredTargets.filter((target) => {
            if (!target.deviceName)
                return false;
            const emulator = /sdk_gphone|emulator|\bapi\s+\d+\b/i.test(target.deviceName);
            return filters.deviceKind === (emulator ? 'emulator' : 'physical');
        });
        if (deviceMatched.length === 0) {
            return {
                targets: [],
                warning: `No ${filters.deviceKind} CDP target matched the active Android session. ` +
                    `Available devices: ${filteredTargets.map((target) => target.deviceName ?? '<identity unavailable>').join(', ')}`,
            };
        }
        filteredTargets = deviceMatched;
    }
    // B111 (D643): explicit targetId hard-fails on no match — silent fallthrough
    // would silently connect the caller to a different target than requested.
    if (filters.targetId) {
        const idMatched = validTargets.filter((t) => t.id === filters.targetId);
        if (idMatched.length === 0) {
            return {
                targets: [],
                warning: `targetId "${filters.targetId}" not found. Available ids: ${validTargets.map((t) => t.id).join(', ')}`,
            };
        }
        filteredTargets = idMatched;
    }
    // B111 (D643): explicit bundleId hard-fails on no match (case-insensitive).
    // Runs even with 1 target — single non-matching target is still wrong.
    if (filters.bundleId) {
        const bundleLower = filters.bundleId.toLowerCase();
        const bundleMatched = filteredTargets.filter((t) => (t.description ?? '').toLowerCase() === bundleLower);
        if (bundleMatched.length === 0) {
            return {
                targets: [],
                warning: `bundleId "${filters.bundleId}" not found. Available descriptions: ${filteredTargets.map((t) => t.description ?? '?').join(', ')}`,
            };
        }
        filteredTargets = bundleMatched;
    }
    if (filters.platform && filteredTargets.length > 1) {
        const pf = filters.platform.toLowerCase();
        let platformMatched = filteredTargets.filter((t) => t.platform === pf);
        if (platformMatched.length === 0) {
            platformMatched = filteredTargets.filter((t) => {
                const haystack = `${t.title ?? ''} ${t.description ?? ''} ${t.vm ?? ''}`.toLowerCase();
                return haystack.includes(pf);
            });
        }
        if (platformMatched.length > 0) {
            filteredTargets = platformMatched;
        }
        else {
            warnings.push(`Platform filter "${filters.platform}" matched no targets (available: ${filteredTargets.map((t) => `${t.description || t.id} [${t.platform ?? '?'}]`).join(', ')}). Connecting to best available target.`);
        }
    }
    // B111 (D643): preferredBundleId is a SOFT filter — auto-selection hint
    // (case-insensitive). Only applied when it narrows without eliminating
    // all candidates. Auto-populated from project-config.ts in connect.ts.
    const prefLower = filters.preferredBundleId?.toLowerCase();
    if (prefLower && filteredTargets.length > 1) {
        const preferred = filteredTargets.filter((t) => (t.description ?? '').toLowerCase() === prefLower);
        if (preferred.length > 0 && preferred.length < filteredTargets.length) {
            logger.info('CDP', `Auto-selected target by preferredBundleId "${filters.preferredBundleId}" (${preferred.length} of ${filteredTargets.length})`);
            filteredTargets = preferred;
        }
    }
    // B111 (D643): deterministic sort. Primary: page-id desc (newer first).
    // Tie-break 1: preferredBundleId-matched targets win.
    // Tie-break 2: lexicographic by full id (eliminates JS sort stability dependency).
    const sorted = [...filteredTargets].sort((a, b) => {
        const aPage = parseInt(a.id?.split('-')[1] ?? '0', 10);
        const bPage = parseInt(b.id?.split('-')[1] ?? '0', 10);
        if (aPage !== bPage)
            return bPage - aPage;
        if (prefLower) {
            const aPref = (a.description ?? '').toLowerCase() === prefLower ? 1 : 0;
            const bPref = (b.description ?? '').toLowerCase() === prefLower ? 1 : 0;
            if (aPref !== bPref)
                return bPref - aPref;
        }
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return { targets: sorted, warning: warnings.length > 0 ? warnings.join(' | ') : undefined };
}
/**
 * GH #303: pick the right Metro port among those running. Correctness first
 * (only `attached` ports — those with a live Hermes target — are candidates),
 * then worktree disambiguation. Pure + injectable (`cwdForPort`) for testing.
 *
 * Precedence when >1 port is attached:
 *   1. projectRoot cwd-match — the Metro whose serving dir is (or contains / is
 *      contained by) this bridge's project root. Most specific worktree signal.
 *   2. preferredBundleId — exactly one attached port serves the preferred bundle.
 *   3. sticky currentPort if attached, else lowest attached port + a warning.
 */
export function selectMetroPort(attached, runningPorts, ctx) {
    if (attached.length === 0) {
        throw new AppDetachedError(runningPorts[0] ?? ctx.currentPort, runningPorts);
    }
    if (attached.length === 1) {
        return { port: attached[0].port };
    }
    // 1. projectRoot cwd-match (realpath-normalized, containment-aware).
    if (ctx.projectRoot) {
        const matches = attached.filter((a) => pathMatchesRoot(ctx.cwdForPort(a.port), ctx.projectRoot));
        if (matches.length === 1)
            return { port: matches[0].port };
    }
    // 2. preferredBundleId port-level tie-break (exactly one attached port serves it).
    if (ctx.preferredBundleId) {
        const pref = ctx.preferredBundleId.toLowerCase();
        const prefPorts = attached.filter((a) => a.targets.some((t) => (t.description ?? '').toLowerCase() === pref));
        if (prefPorts.length === 1)
            return { port: prefPorts[0].port };
    }
    // 3. sticky currentPort if attached, else lowest attached port + disambiguation warning.
    const attachedPortNums = attached.map((a) => a.port).sort((x, y) => x - y);
    const chosen = attachedPortNums.includes(ctx.currentPort) ? ctx.currentPort : attachedPortNums[0];
    const list = attached
        .map((a) => {
        const cwd = ctx.cwdForPort(a.port);
        return `:${a.port}${cwd ? ` (${cwd})` : ''}`;
    })
        .join(', ');
    return {
        port: chosen,
        warning: `Multiple live Metros with an attached app: ${list}. Picked :${chosen}. Pass metroPort explicitly to choose a different worktree.`,
    };
}
export async function discover(currentPort, platformFilterOrFilters) {
    const filters = typeof platformFilterOrFilters === 'string'
        ? { platform: platformFilterOrFilters }
        : (platformFilterOrFilters ?? {});
    const ports = [...new Set([currentPort, ...resolveDefaultPorts()])];
    const hints = [];
    if (filters.platform)
        hints.push(`platform=${filters.platform}`);
    if (filters.deviceKind)
        hints.push(`deviceKind=${filters.deviceKind}`);
    if (filters.targetId)
        hints.push(`targetId=${filters.targetId}`);
    if (filters.bundleId)
        hints.push(`bundleId=${filters.bundleId}`);
    if (filters.preferredBundleId)
        hints.push(`preferredBundleId=${filters.preferredBundleId}`);
    logger.debug('CDP', `Discovering Metro on ports: ${ports.join(', ')}${hints.length ? ` (${hints.join(', ')})` : ''}`);
    // GH #303: probe ALL candidate ports, then prefer one with an attached Hermes
    // target so a detached sibling-worktree Metro can't shadow a healthy one.
    const runningPorts = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
    if (runningPorts.length === 0) {
        throw new Error('Metro not found on ports ' +
            ports.join(', ') +
            '. Is the dev server running? Try: npx expo start or npx react-native start');
    }
    const perPort = await Promise.all(runningPorts.map(async (p) => {
        try {
            const raw = await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2);
            const valid = filterValidTargets(raw).filter((t) => {
                try {
                    const { hostname } = new URL(t.webSocketDebuggerUrl);
                    return hostname === '127.0.0.1' || hostname === 'localhost';
                }
                catch {
                    return false;
                }
            });
            return { port: p, targets: valid };
        }
        catch {
            return { port: p, targets: [] };
        }
    }));
    const attached = perPort.filter((pp) => pp.targets.length > 0);
    // selectMetroPort throws AppDetachedError when nothing is attached (preserving
    // the existing catch in status.ts), carrying the full running-port list.
    const { port: metroPort, warning: portWarning } = selectMetroPort(attached, runningPorts, {
        currentPort,
        projectRoot: resolveBridgeProjectRoot() ?? undefined,
        preferredBundleId: filters.preferredBundleId,
        cwdForPort: (p) => cwdForPort(p),
    });
    logger.info('CDP', `Metro selected on port ${metroPort} (running: ${runningPorts.join(', ')})`);
    const validTargets = attached.find((pp) => pp.port === metroPort).targets;
    inferPlatforms(validTargets);
    const { targets: sorted, warning: selectWarning } = selectTarget(validTargets, filters);
    const warning = [portWarning, selectWarning].filter(Boolean).join(' | ') || undefined;
    logger.debug('CDP', `Found ${sorted.length} valid target(s): ${sorted.map((t) => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`);
    return { port: metroPort, targets: sorted, warning };
}
export async function discoverForList(currentPort, portHint) {
    const ports = [...new Set([portHint ?? currentPort, ...resolveDefaultPorts()])];
    // GH #303: prefer a running port that actually has targets over the first
    // running one, so cdp_targets can't inspect a different Metro than discover()
    // selected. No cwd auto-pick needed here — just attached-preference.
    const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
    if (running.length === 0) {
        throw new Error('Metro not found on ports ' + ports.join(', '));
    }
    let chosen = running[0];
    let targets = [];
    for (const p of running) {
        try {
            const valid = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2));
            if (valid.length > 0) {
                chosen = p;
                targets = valid;
                break;
            }
        }
        catch {
            /* try next running port */
        }
    }
    inferPlatforms(targets);
    return { port: chosen, targets };
}
/**
 * GH #303: best-effort enumeration of live Metros for cdp_status diagnostics —
 * decoupled from discover() so it works even on the already-connected path. Fast
 * path (honors the spec's "single-Metro = one lsof"): when only the connected
 * Metro is up, skip per-port fetchTargets + extra lsof and resolve just the
 * connected port's cwd for the mismatch check, omitting the candidates array.
 */
export async function enumerateMetroCandidates(connectedPort, projectRoot) {
    const t0 = performance.now();
    const ports = [...new Set([connectedPort, ...resolveDefaultPorts()])];
    const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
    const tProbe = performance.now();
    if (running.length <= 1) {
        const servingCwd = cwdForPort(connectedPort);
        return { servingCwd, timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe } };
    }
    const candidates = [];
    let servingCwd = null;
    for (const p of running) {
        let attached = false;
        try {
            attached = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS)).length > 0;
        }
        catch {
            /* treat as detached */
        }
        const cwd = cwdForPort(p);
        if (p === connectedPort)
            servingCwd = cwd;
        candidates.push({
            port: p,
            attached,
            cwd,
            isConnected: p === connectedPort,
            matchesProjectRoot: pathMatchesRoot(cwd, projectRoot),
        });
    }
    if (servingCwd === null)
        servingCwd = cwdForPort(connectedPort);
    return {
        candidates,
        servingCwd,
        timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe },
    };
}
