import { runNative as _runAgentDeviceImpl, hasActiveSession, getActiveSession } from '../agent-device-wrapper.js';
import { detectPlatform } from './platform-utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { fetchFindCandidates, pressCandidate } from './device-interact.js';
import type { FindCandidate } from './device-interact.js';

// GH #136 test seam: production code calls `runAgentDevice` through this
// indirection so unit tests can swap a mock without touching the real
// agent-device CLI subprocess. Production behavior is identity-equivalent
// to the imported function.
let runAgentDeviceFn: typeof _runAgentDeviceImpl = _runAgentDeviceImpl;

export function _setRunAgentDeviceForTest(fn: typeof _runAgentDeviceImpl): void {
  runAgentDeviceFn = fn;
}

export function _resetRunAgentDeviceForTest(): void {
  runAgentDeviceFn = _runAgentDeviceImpl;
}

let fetchCandidatesFn: typeof fetchFindCandidates = fetchFindCandidates;
let pressCandidateFn: typeof pressCandidate = pressCandidate;

export function _setFetchCandidatesForTest(fn: typeof fetchFindCandidates): void {
  fetchCandidatesFn = fn;
}
export function _resetFetchCandidatesForTest(): void {
  fetchCandidatesFn = fetchFindCandidates;
}
export function _setPressCandidateForTest(fn: typeof pressCandidate): void {
  pressCandidateFn = fn;
}
export function _resetPressCandidateForTest(): void {
  pressCandidateFn = pressCandidate;
}

// GH #136 test seam: same pattern as runAgentDeviceFn but for the
// session-presence guard. Lets unit tests force the "session active"
// branch without spinning up an agent-device session.
let hasActiveSessionFn: typeof hasActiveSession = hasActiveSession;

export function _setHasSessionForTest(value: boolean): void {
  hasActiveSessionFn = () => value;
}

export function _resetHasSessionForTest(): void {
  hasActiveSessionFn = hasActiveSession;
}

/**
 * Detect and dismiss the Expo Dev Client server picker.
 *
 * The picker appears after deep links, app restarts, permission changes,
 * or clearState. It's a native screen (not React) so CDP tools can't see it.
 * Uses device_find via agent-device to detect "Development servers" text
 * and tap the first available Metro server entry.
 *
 * Returns:
 *   - { dismissed: true } if picker was found and tapped
 *   - { dismissed: false, reason: '...' } if not detected or no session
 *   - null if no active device session (silent skip)
 */

const PICKER_INDICATORS = [
  'Development servers',
  'DEVELOPMENT SERVERS',
];

export interface PickerResult {
  dismissed: boolean;
  reason: string;
}

export interface PickerOutcome {
  dismissed: boolean;
  reason: string;
  skipped?: boolean;
  platform?: 'ios' | 'android' | null;
}

// GH #136: structural matcher for dev-client picker rows. The picker shows
// rows shaped like `<host>:<port>` — host may be a LAN IPv4 address, an
// Android emulator alias (10.0.2.2), a `.local` mDNS name, or a bare DNS
// hostname. The Metro port (default 8081, configurable) is the most reliable
// signal that we're looking at a server entry vs decorative text. Constraints:
//   - port must be 80..65535 (rejects version-string fragments like `0.76`)
//   - host must look like a real network address (IPv4 quad OR
//     dotted-domain-style with at least one alphabetic label, OR a single
//     bare alphabetic hostname). Rejects `v123:456`, `v1.2.3:1234`, and
//     other version-shape pseudo-hosts that would otherwise leak through.
const PORT_PATTERN = /\b([\w.-]+):(\d{2,5})\b/g;
const IPV4_QUAD_RE = /^\d+\.\d+\.\d+\.\d+$/;
const VERSION_SHAPE_RE = /^v?\d+(\.\d+)*$/i;
const HOSTNAME_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;

function looksLikeNetworkHost(host: string): boolean {
  if (IPV4_QUAD_RE.test(host)) return true;
  if (VERSION_SHAPE_RE.test(host)) return false;
  return HOSTNAME_RE.test(host);
}

export function parsePortPatternEntry(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const match of text.matchAll(PORT_PATTERN)) {
    const host = match[1];
    const portNum = Number.parseInt(match[2], 10);
    if (portNum < 80 || portNum > 65535) continue;
    if (!looksLikeNetworkHost(host)) continue;
    return `${host}:${portNum}`;
  }
  return null;
}

// Rows that appear in the dev-client picker but are NOT server entries.
// Used as a deny-list for the first-non-header-row fallback when port-pattern
// matching fails (e.g., picker shows only the manifest name without the URL).
//
// Stored as lowercase strings; lookups normalize input the same way so the
// deny-list is robust against Expo casing/locale shifts (`ENTER URL MANUALLY`
// vs `Enter URL Manually`). HEADER_PATTERNS already use case-insensitive
// regex; this brings the footer check in line with that convention.
const FOOTER_ROWS = new Set([
  'enter url manually',
  'fetch development servers',
  'development servers',
  'connect to a development build',
]);

const HEADER_PATTERNS = [/development servers/i];

/**
 * GH #136: orchestrates the picker matcher fallbacks. Matching priority:
 *   1. A whole-line literal IP match (`localhost`, `127.0.0.1`, `10.0.2.2`)
 *      — preserves the original heuristic for known-good rows. The match
 *      is anchored to a complete trimmed line so a decorative row like
 *      `"Open localhost in browser"` cannot short-circuit the smarter
 *      port-pattern path.
 *   2. Port-pattern via parsePortPatternEntry (catches LAN IPs, .local
 *      hostnames, and DNS names that show up on real-world dev setups).
 *   3. First non-header, non-footer row below the picker title — the row
 *      a user would tap with their finger when the URL is hidden.
 *
 * Returns the literal text to pass to `device_find <text>` for tapping, or
 * null when the snapshot doesn't look like a dev-client picker at all.
 */
export function parseFirstServerEntry(snapshot: string | null | undefined): string | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null;

  const lines = snapshot.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  const literalIps = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
  for (const line of lines) {
    if (literalIps.has(line)) return line;
    if (line.includes(':')) {
      const head = line.split(':', 1)[0];
      if (literalIps.has(head)) return line;
    }
  }

  const portMatch = parsePortPatternEntry(snapshot);
  if (portMatch) return portMatch;

  const headerIdx = lines.findIndex((line) => HEADER_PATTERNS.some((re) => re.test(line)));
  if (headerIdx === -1) return null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!FOOTER_ROWS.has(lines[i].toLowerCase())) return lines[i];
  }
  return null;
}

export async function handleDevClientPicker(): Promise<PickerResult | null> {
  if (!hasActiveSessionFn()) return null;

  // Step 1: Detect if the picker is showing
  for (const indicator of PICKER_INDICATORS) {
    try {
      const findResult = await fetchCandidatesFn(indicator);
      if (findResult.ok && findResult.candidates.length > 0) {
        // Picker detected — try to tap a server entry
        return await dismissPicker();
      }
    } catch {
      continue;
    }
  }

  return { dismissed: false, reason: 'Dev Client picker not detected' };
}

/**
 * GH #136 sub-3: the single guarded seam every on-demand/auto consumer routes
 * through. iOS is short-circuited with an actionable message — we must NOT call
 * handleDevClientPicker() there because its agent-device `find` path respawns
 * the legacy AgentDeviceRunner (D1219). Returns null ONLY for Android + no
 * device session, so the MCP tool can surface a NO_SESSION error.
 */
export async function clearDevClientPickerIfPresent(
  platform?: 'ios' | 'android',
): Promise<PickerOutcome | null> {
  // SessionState.platform is typed `string | undefined`, so narrow it to the
  // valid platforms before it can short-circuit the detectPlatform() fallback.
  const sessionPlatform = getActiveSession()?.platform;
  const resolved = platform ?? (sessionPlatform === 'ios' || sessionPlatform === 'android' ? sessionPlatform : undefined) ?? (await detectPlatform());
  if (resolved === 'ios') {
    return {
      dismissed: false,
      skipped: true,
      platform: 'ios',
      reason: 'iOS Dev Client picker auto-dismiss is not supported yet — select the Metro server manually on the simulator.',
    };
  }
  if (resolved !== 'android') {
    return { dismissed: false, platform: null, reason: 'No iOS/Android device detected.' };
  }
  const res = await handleDevClientPicker();
  if (res === null) return null;
  return { ...res, platform: 'android' };
}

/**
 * GH #136: rewritten to use parseFirstServerEntry against an upfront snapshot.
 * The previous "try literal IPs in turn, then regex-scan" approach missed
 * every LAN-IP-only setup we hit in the field. Exporting for unit tests so
 * the dispatch can be exercised through the runAgentDeviceFn test seam.
 */
export async function dismissPicker(): Promise<PickerResult> {
  // GH #136: re-probe the picker before attempting to tap. Single-server
  // pickers auto-advance on a ~3-5s timer; if the auto-advance fired between
  // detect and dispatch, we don't need to act — return success now. This
  // closes the ~30% race failure documented in #136 issue 3 where Maestro
  // flows hit "unable to find element" errors when the picker auto-advanced
  // before tapOn could fire.
  const stillShowing = await isDevClientPickerShowing();
  if (!stillShowing) {
    return { dismissed: true, reason: 'Dev Client picker auto-advanced before tap' };
  }

  const snapshot = await runAgentDeviceFn(['snapshot', '-i']);
  const snapshotText = snapshot.isError ? '' : (snapshot.content[0]?.text ?? '');
  const target = parseFirstServerEntry(snapshotText);

  if (target) {
    const findResult = await fetchCandidatesFn(target);
    if (findResult.ok && findResult.candidates.length > 0) {
      const pressResult = await pressCandidateFn(findResult.candidates[0] as FindCandidate, 'click');
      if (!pressResult.isError) {
        await waitForBundle();
        return { dismissed: true, reason: `Tapped server entry "${target}"` };
      }
    }
  }

  return {
    dismissed: false,
    reason: 'Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually.',
  };
}

/**
 * GH #136: fast-then-slow cadence. Single-server pickers auto-advance in a
 * few hundred milliseconds; LAN-IP picker tap settles within ~1s. The
 * previous fixed-2s polling burned wall-clock time we don't have to spend.
 *
 *   Phase 1 (0..1000ms):    poll every 100ms — catches auto-advance + fast taps.
 *   Phase 2 (1000..10000ms): poll every 500ms — covers slower bundle loads.
 *
 * Total budget: 10s (was 20s). Empirically the picker is either gone in
 * <2s or stuck in a way no extra polling will fix. Exported for unit tests.
 */
export async function waitForBundle(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const elapsed = Date.now() - start;
    const interval = elapsed < 1_000 ? 100 : 500;
    await new Promise((r) => setTimeout(r, interval));
    const findResult = await fetchCandidatesFn('Development servers');
    if (!findResult.ok || findResult.candidates.length === 0) return; // Picker gone — bundle loaded.
  }
}

/**
 * Quick check: is the Dev Client picker likely showing?
 * Uses device_find without tapping — lighter than full handleDevClientPicker.
 */
export async function isDevClientPickerShowing(): Promise<boolean> {
  if (!hasActiveSessionFn()) return false;

  for (const indicator of PICKER_INDICATORS) {
    try {
      const findResult = await fetchCandidatesFn(indicator);
      if (findResult.ok && findResult.candidates.length > 0) return true;
    } catch {
      continue;
    }
  }

  return false;
}

export function createDismissDevClientPickerHandler(): (
  args: { platform?: 'ios' | 'android' },
) => Promise<ToolResult> {
  return async (args) => {
    const t0 = Date.now();
    const outcome = await clearDevClientPickerIfPresent(args.platform);
    const meta = { timings_ms: { total: Date.now() - t0 } };

    if (outcome === null) {
      return failResult(
        'No device session open. Call device_snapshot action="open" first.',
        'DEV_CLIENT_PICKER_NO_SESSION',
        meta,
      );
    }
    if (outcome.skipped) {
      return warnResult({ dismissed: false, platform: outcome.platform }, outcome.reason, meta);
    }
    if (outcome.dismissed) {
      return okResult({ dismissed: true, reason: outcome.reason, platform: outcome.platform }, { meta });
    }
    if (outcome.reason.toLowerCase().includes('could not find')) {
      return warnResult({ dismissed: false, platform: outcome.platform }, outcome.reason, meta);
    }
    return okResult({ dismissed: false, reason: outcome.reason, platform: outcome.platform }, { meta });
  };
}
