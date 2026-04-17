import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';
import type { HermesTarget } from '../types.js';

export const DISCOVERY_TIMEOUT_MS = 1500;
export const USER_METRO_PORT = process.env.RN_METRO_PORT ? parseInt(process.env.RN_METRO_PORT, 10) : null;
export const DEFAULT_PORTS = [
  ...(USER_METRO_PORT && !isNaN(USER_METRO_PORT) ? [USER_METRO_PORT] : []),
  8081, 8082, 19000, 19006,
];

export async function discoverMetroPort(ports: number[], timeout: number): Promise<number | null> {
  for (const p of ports) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
      const text = await resp.text();
      if (text.includes('packager-status:running')) {
        return p;
      }
    } catch {
      // Port not available, continue scanning
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function fetchTargets(port: number, timeout: number): Promise<HermesTarget[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    return (await resp.json()) as HermesTarget[];
  } catch (err) {
    throw new Error(`Failed to list CDP targets on port ${port}: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

export function filterValidTargets(targets: HermesTarget[]): HermesTarget[] {
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

/**
 * B116 (D639): extract top-level bundle IDs from `xcrun simctl listapps booted`.
 * Output is NeXTSTEP plist; top-level keys are quoted bundle IDs at exactly
 * 4-space indentation, e.g. `    "com.foo.bar" = {`. We match that pattern
 * explicitly so we don't pick up nested keys like GroupContainers entries.
 */
export function parseSimctlListapps(stdout: string): Set<string> {
  const ids = new Set<string>();
  const TOP_LEVEL = /^    "([A-Za-z0-9._-]+)"\s*=\s*\{/;
  for (const line of stdout.split('\n')) {
    const m = line.match(TOP_LEVEL);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function readAndroidPackages(): Set<string> | null {
  try {
    const out = execFileSync('adb', ['shell', 'pm', 'list', 'packages'], {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(
      out.split('\n')
        .map(line => line.replace('package:', '').trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

function readIOSPackages(): Set<string> | null {
  try {
    const out = execFileSync('xcrun', ['simctl', 'listapps', 'booted'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseSimctlListapps(out);
  } catch {
    return null;
  }
}

export interface PlatformInferenceReaders {
  readAndroid?: () => Set<string> | null;
  readIOS?: () => Set<string> | null;
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
export function inferPlatforms(
  targets: HermesTarget[],
  readers: PlatformInferenceReaders = {},
): void {
  const androidPackages = (readers.readAndroid ?? readAndroidPackages)();
  const iosPackages = (readers.readIOS ?? readIOSPackages)();

  for (const t of targets) {
    const desc = t.description ?? '';
    const inAndroid = androidPackages?.has(desc) ?? false;
    const inIOS = iosPackages?.has(desc) ?? false;

    if (inAndroid && !inIOS) {
      t.platform = 'android';
    } else if (inIOS && !inAndroid) {
      t.platform = 'ios';
    } else if (inAndroid && inIOS) {
      // Ambiguous — same bundleId installed on both. Default to iOS but mark
      // for downstream so callers can notice and pass targetId/bundleId filter.
      t.platform = 'ios';
      t.ambiguousPlatform = true;
    } else {
      // No information (adb/simctl both failed, or target bundle unknown) —
      // default to iOS to preserve prior behavior for iOS-only setups.
      t.platform = 'ios';
    }
  }
}

export interface SelectTargetResult {
  targets: HermesTarget[];
  warning?: string;
}

export interface SelectTargetFilters {
  platform?: string;
  /** Exact match against `target.id` — precise selection from cdp_targets output. */
  targetId?: string;
  /** Match against `target.description` — Metro inspector reports bundleId there. */
  bundleId?: string;
  /** Preferred bundleId (auto-selection hint, non-hard-filter). Used to break ties. */
  preferredBundleId?: string;
}

export function selectTarget(
  validTargets: HermesTarget[],
  filtersOrPlatform?: string | SelectTargetFilters,
): SelectTargetResult {
  // Legacy single-string signature kept for back-compat; new callers pass an object.
  const filters: SelectTargetFilters = typeof filtersOrPlatform === 'string'
    ? { platform: filtersOrPlatform }
    : (filtersOrPlatform ?? {});

  let filteredTargets = validTargets;
  const warnings: string[] = [];

  // B111 (D643): explicit targetId hard-fails on no match — silent fallthrough
  // would silently connect the caller to a different target than requested.
  if (filters.targetId) {
    const idMatched = validTargets.filter(t => t.id === filters.targetId);
    if (idMatched.length === 0) {
      return {
        targets: [],
        warning: `targetId "${filters.targetId}" not found. Available ids: ${validTargets.map(t => t.id).join(', ')}`,
      };
    }
    filteredTargets = idMatched;
  }

  // B111 (D643): explicit bundleId hard-fails on no match (case-insensitive).
  // Runs even with 1 target — single non-matching target is still wrong.
  if (filters.bundleId) {
    const bundleLower = filters.bundleId.toLowerCase();
    const bundleMatched = filteredTargets.filter(
      t => (t.description ?? '').toLowerCase() === bundleLower,
    );
    if (bundleMatched.length === 0) {
      return {
        targets: [],
        warning: `bundleId "${filters.bundleId}" not found. Available descriptions: ${filteredTargets.map(t => t.description ?? '?').join(', ')}`,
      };
    }
    filteredTargets = bundleMatched;
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
    } else {
      warnings.push(`Platform filter "${filters.platform}" matched no targets (available: ${filteredTargets.map(t => `${t.description || t.id} [${t.platform ?? '?'}]`).join(', ')}). Connecting to best available target.`);
    }
  }

  // B111 (D643): preferredBundleId is a SOFT filter — auto-selection hint
  // (case-insensitive). Only applied when it narrows without eliminating
  // all candidates. Auto-populated from project-config.ts in connect.ts.
  const prefLower = filters.preferredBundleId?.toLowerCase();
  if (prefLower && filteredTargets.length > 1) {
    const preferred = filteredTargets.filter(
      t => (t.description ?? '').toLowerCase() === prefLower,
    );
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
    if (aPage !== bPage) return bPage - aPage;
    if (prefLower) {
      const aPref = (a.description ?? '').toLowerCase() === prefLower ? 1 : 0;
      const bPref = (b.description ?? '').toLowerCase() === prefLower ? 1 : 0;
      if (aPref !== bPref) return bPref - aPref;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { targets: sorted, warning: warnings.length > 0 ? warnings.join(' | ') : undefined };
}

export interface DiscoveryResult {
  port: number;
  targets: HermesTarget[];
  warning?: string;
}

export async function discover(
  currentPort: number,
  platformFilterOrFilters?: string | SelectTargetFilters,
): Promise<DiscoveryResult> {
  const filters: SelectTargetFilters = typeof platformFilterOrFilters === 'string'
    ? { platform: platformFilterOrFilters }
    : (platformFilterOrFilters ?? {});
  const ports = [...new Set([currentPort, ...DEFAULT_PORTS])];
  const hints: string[] = [];
  if (filters.platform) hints.push(`platform=${filters.platform}`);
  if (filters.targetId) hints.push(`targetId=${filters.targetId}`);
  if (filters.bundleId) hints.push(`bundleId=${filters.bundleId}`);
  if (filters.preferredBundleId) hints.push(`preferredBundleId=${filters.preferredBundleId}`);
  logger.debug('CDP', `Discovering Metro on ports: ${ports.join(', ')}${hints.length ? ` (${hints.join(', ')})` : ''}`);

  const metroPort = await discoverMetroPort(ports, DISCOVERY_TIMEOUT_MS);
  if (!metroPort) {
    throw new Error(
      'Metro not found on ports ' + ports.join(', ') +
      '. Is the dev server running? Try: npx expo start or npx react-native start',
    );
  }
  logger.info('CDP', `Metro found on port ${metroPort}`);

  const raw = await fetchTargets(metroPort, DISCOVERY_TIMEOUT_MS * 2);
  const validTargets = filterValidTargets(raw).filter(t => {
    try {
      const { hostname } = new URL(t.webSocketDebuggerUrl!);
      return hostname === '127.0.0.1' || hostname === 'localhost';
    } catch {
      return false;
    }
  });

  if (validTargets.length === 0) {
    throw new Error(
      'No Hermes debug target found. Is the app running? Is Hermes enabled?',
    );
  }

  inferPlatforms(validTargets);

  const { targets: sorted, warning } = selectTarget(validTargets, filters);

  logger.debug('CDP', `Found ${sorted.length} valid target(s): ${sorted.map(t => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`);

  return { port: metroPort, targets: sorted, warning };
}

export async function discoverForList(
  currentPort: number,
  portHint?: number,
): Promise<{ port: number; targets: HermesTarget[] }> {
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
