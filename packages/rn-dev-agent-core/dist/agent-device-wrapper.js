import { unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { failResult } from './utils.js';
import { startFastRunner, probeFastRunnerLiveness, probeFastRunnerLivenessDetailed, adoptPersistedFastRunnerState, reapStaleFastRunner, hasBuiltTestProduct, derivedDataPathForRunner, acquireRunnerRebuildLock, releaseRunnerRebuildLock, runnerRebuildBudget, consumePendingFastRunnerArtifactNote, getRunnerPostMortem, } from './runners/rn-fast-runner-client.js';
import { getPluginVersion } from './runners/protocol.js';
import { resolveBootedIosUdid } from './tools/device-screenshot-raw.js';
import { refCenter, getScreenRect, clearRefMap, isRefMapFresh, MAX_REF_MAP_AGE_MS, getCachedSignature, getCachedMetadata, getFreshRefTarget, refreshRef, getLastSnapshotHash, invalidateLastSnapshotHash, } from './fast-runner-ref-map.js';
import { recordNoUiChange, recordUiChange, WEDGED_DISTINCT_TARGETS, WEDGED_RUNTIME_HINT, } from './lifecycle/no-change-tracker.js';
import { resolveBundleId } from './project-config.js';
import { getStateDir, readJsonStateFile, writeJsonStateFileAtomic, } from './util/secure-state-file.js';
/**
 * CDP-015: derive a per-user, per-project session file path. The previous
 * fixed `/tmp/rn-dev-agent-session.json` location bled state across repos,
 * users, and bridge processes on the same host, and was vulnerable to
 * symlink races on multi-tenant systems.
 *
 * Layout:
 *   $XDG_STATE_HOME/rn-dev-agent/session-<projectHash>.json     (Linux/CI)
 *   ~/Library/Application Support/rn-dev-agent/session-<hash>.json (macOS)
 *   ~/.rn-dev-agent/session-<projectHash>.json                  (fallback)
 *
 * `<projectHash>` is sha256(cwd).slice(0, 12) so two checkouts of the same
 * repo at different paths get different session files.
 */
function getSessionFilePath() {
    const projectId = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
    return join(getStateDir(), `session-${projectId}.json`);
}
const SESSION_FILE = getSessionFilePath();
const LEGACY_SESSION_FILE = '/tmp/rn-dev-agent-session.json';
let activeSession = null;
activeSession = readJsonStateFile(SESSION_FILE);
if (!activeSession) {
    // Migrate from the legacy /tmp location if present — one-time best-effort
    // so existing users don't lose their open session on upgrade. We only
    // migrate when the new location has nothing — never overwrite.
    const legacy = readJsonStateFile(LEGACY_SESSION_FILE);
    if (legacy) {
        activeSession = legacy;
        try {
            writeJsonStateFileAtomic(SESSION_FILE, legacy);
        }
        catch {
            /* migration is best-effort */
        }
    }
}
export function getActiveSession() {
    return activeSession;
}
// Story 04 (#385): deterministic session seam for wiring tests — without it,
// runNative falls back to resolveBootedIosUdid(), which shells `xcrun simctl`
// (flaky on CI, machine-dependent locally).
export function _setActiveSessionForTest(session) {
    activeSession = session;
}
export function setActiveSession(info) {
    activeSession = info;
    // CDP-015: atomic write via tmp + rename, restrictive perms (0600 — only
    // the user can read).
    try {
        writeJsonStateFileAtomic(SESSION_FILE, info);
    }
    catch {
        /* ignore — in-memory session is still valid */
    }
}
export function clearActiveSession() {
    activeSession = null;
    clearRefMap();
    recordUiChange();
    try {
        unlinkSync(SESSION_FILE);
    }
    catch {
        /* ignore */
    }
}
// Exported for tests + diagnostics.
export function getSessionFilePathForTest() {
    return SESSION_FILE;
}
// Test-only: reset the in-memory session pointer without touching the on-disk
// file. Tests that exercise paths gated on hasActiveSession() (e.g. the
// HELPERS_NOT_INJECTED → handleDevClientPicker fallback) need this so they
// don't trip over a real session left behind by the developer's live MCP run.
// clearActiveSession() unlinks the file too, which would break that live run.
export function resetActiveSessionInMemoryForTest() {
    activeSession = null;
}
// Test-only: set the in-memory session pointer WITHOUT the on-disk write that
// setActiveSession() performs. Tests that exercise platform-gated paths (e.g.
// the GH #321 cached-find reuse) must not clobber a developer's live MCP
// session file, which is a shared, uid-keyed path.
export function setActiveSessionInMemoryForTest(info) {
    activeSession = info;
}
export function hasActiveSession() {
    return activeSession !== null;
}
const snapshotCache = new Map();
let snapshotAuthorityProvider = null;
export function setSnapshotAuthorityProvider(provider) {
    snapshotAuthorityProvider = provider;
    snapshotCache.clear();
    snapshotCacheDirty = true;
}
function currentSnapshotAuthority(platform) {
    const authority = snapshotAuthorityProvider?.();
    const session = getActiveSession();
    return JSON.stringify(authority ?? {
        platform,
        deviceId: session?.deviceId ?? null,
        appId: session?.appId ?? null,
    });
}
// Live-sim speedup (GH #321): device_find reuses the snapshot it already
// captured instead of re-snapshotting every call — but only while that snapshot
// still faithfully describes the screen. A tap/navigation changes the screen, so
// reuse is gated on TWO conditions: not dirtied by a mutating verb since capture,
// AND within the TTL (coordinate-drift guard, mirrors MAX_REF_MAP_AGE_MS). The
// dirty flag is the load-bearing correctness piece: a fresh-by-time but
// stale-by-content cache would drive a wrong-element tap.
let snapshotCacheDirty = true;
export function cacheSnapshot(platform, nodes) {
    snapshotCache.set(platform, {
        platform,
        authorityScope: currentSnapshotAuthority(platform),
        nodes,
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
    });
    // A fresh snapshot is, by definition, a clean picture of the current screen.
    snapshotCacheDirty = false;
}
export function getCachedSnapshot(platform) {
    const snapshot = snapshotCache.get(platform);
    return snapshot?.authorityScope === currentSnapshotAuthority(platform) ? snapshot : undefined;
}
// Called at the runNative dispatch choke point on any screen-mutating verb
// (tap/press/fill/type/swipe/scroll/back/longpress/pinch/keyboard/drag).
export function markSnapshotDirty() {
    snapshotCacheDirty = true;
}
// True only when the cached snapshot is safe to reuse for targeting: present,
// not invalidated by a mutating verb, and within the freshness budget.
export function isSnapshotCacheValid(platform, maxAgeMs = MAX_REF_MAP_AGE_MS) {
    if (snapshotCacheDirty)
        return false;
    const entry = snapshotCache.get(platform);
    if (!entry)
        return false;
    if (entry.authorityScope !== currentSnapshotAuthority(platform))
        return false;
    return Date.now() - entry.capturedAtMs <= maxAgeMs;
}
export function listCachedSnapshots() {
    return [...snapshotCache.keys()];
}
// Returns the `-s <serial>` args for adb when a specific device/emulator is
// targeted. Prefers the active session's deviceId IFF that session is Android,
// then ANDROID_SERIAL env. Returns an empty array when no target is set (adb
// will pick the only connected device, or fail with "more than one device" if
// multiple exist).
//
// GH #60: prior to this gate, an active iOS session would leak its UDID into
// adb commands (e.g. `device_deeplink platform:"android"` → `adb -s <iOS-UDID>
// not found`) when both iOS and Android were booted simultaneously.
export function getAdbSerial() {
    const session = getActiveSession();
    if (session?.platform === 'android' && session.deviceId)
        return ['-s', session.deviceId];
    if (process.env.ANDROID_SERIAL)
        return ['-s', process.env.ANDROID_SERIAL];
    return [];
}
// --- iOS short-circuit: route every supported command through rn-fast-runner ---
//
// GH #105 / rn-device iOS-MVP §3.1: iOS commands no longer touch agent-device
// (neither the daemon nor the CLI). They go through our own HTTP runner via
// runIOS(). The buildRunIOSArgs() helper translates the legacy CLI argv shape
// (e.g. `['press', '@e3', '--hold-ms', '500']`) into the structured RunIOSArgs
// the new client expects. The legacy daemon + CLI tiers below remain — they
// now serve Android exclusively.
//
// GH #105 iOS-MVP follow-up (post-validation): the original short-circuit
// list left `swipe` / `scroll` / `longpress` / `pinch` / `find` on the
// legacy daemon/CLI path. Live validation showed the daemon respawns the
// upstream AgentDeviceRunner on every such call, which then fights our
// RnFastRunner for focus. Each of these now routes through the runner's
// `/command` endpoint (the Swift `.drag` / `.longPress` / `.pinch` / `.findText`
// handlers). Coordinate-based gestures: the Swift `.swipe` case is tvOS-only;
// iOS coordinate-form swipes/scrolls use `.drag`.
const RN_FAST_RUNNER_COMMANDS = new Set([
    'snapshot',
    'tap',
    'press',
    'fill',
    'type',
    'back',
    'screenshot',
    'keyboard',
    'swipe',
    'scroll',
    'longpress',
    'pinch',
]);
// GH #321: verbs that can change what's on screen, so a cached snapshot can no
// longer be trusted for targeting after one runs. snapshot/screenshot are reads
// and are deliberately absent.
const SNAPSHOT_MUTATING_VERBS = new Set([
    'tap',
    'press',
    'fill',
    'type',
    'back',
    'keyboard',
    'swipe',
    'scroll',
    'drag',
    'longpress',
    'pinch',
]);
export function getCachedScreenRect() {
    return getScreenRect();
}
export function buildRunIOSArgs(cliArgs, bundleId) {
    const cmd = cliArgs[0];
    const positionals = positionalArgs(cliArgs);
    switch (cmd) {
        case 'press':
        case 'tap': {
            const ref = positionals[0];
            if (ref && ref.startsWith('@')) {
                const center = isRefMapFresh() ? refCenter(ref) : null;
                if (!center) {
                    return { command: 'tap', _staleRef: ref, ...(bundleId ? { bundleId } : {}) };
                }
                const target = getFreshRefTarget(ref);
                const built = {
                    command: 'tap',
                    x: center.x,
                    y: center.y,
                    ...(target
                        ? {
                            targetBounds: target.rect,
                            snapshotGeneration: target.snapshotGeneration,
                            keyboardStateAtSnapshot: target.keyboardStateAtSnapshot,
                        }
                        : {}),
                    ...(bundleId ? { bundleId } : {}),
                };
                // Client-only identity must not leak onto the JSON wire or perturb the
                // legacy argv-adapter shape inspected by callers.
                Object.defineProperty(built, '_targetRef', { value: ref, enumerable: false });
                return built;
            }
            const [xS, yS] = positionals;
            const x = Number(xS), y = Number(yS);
            if (Number.isNaN(x) || Number.isNaN(y)) {
                throw new Error(`buildRunIOSArgs: tap requires a @ref or numeric x, y`);
            }
            return { command: 'tap', x, y, ...(bundleId ? { bundleId } : {}) };
        }
        case 'fill':
        case 'type': {
            // The Swift runner's `.type` command focuses an input at x/y AND types
            // in one call (see RnFastRunnerTests+CommandExecution.swift:429-468 —
            // `textInputAt(app:, x:, y:)` falls back to `focusedTextInput`). So no
            // separate tap is needed: pass coords + text together.
            const ref = positionals[0];
            const text = positionals.slice(1).join(' ');
            const delayRaw = optionValue(cliArgs, '--delay-ms');
            const delayMs = delayRaw !== undefined && !Number.isNaN(Number(delayRaw)) ? Number(delayRaw) : undefined;
            const extra = {};
            if (delayMs !== undefined)
                extra.delayMs = delayMs;
            if (cliArgs.includes('--clear-first'))
                extra.clearFirst = true;
            // Story 04 (#385) M2 guard: an explicit --at-x/--at-y pin bypasses @ref
            // re-resolution entirely — device_fill resolves coords ONCE before its
            // pre-tap so the settle's ref-map refresh can't retarget the fill.
            const atX = optionValue(cliArgs, '--at-x');
            const atY = optionValue(cliArgs, '--at-y');
            if (atX !== undefined && atY !== undefined) {
                const px = Number(atX), py = Number(atY);
                if (Number.isFinite(px) && Number.isFinite(py)) {
                    return {
                        command: 'type',
                        x: px,
                        y: py,
                        text,
                        ...extra,
                        ...(bundleId ? { bundleId } : {}),
                    };
                }
            }
            if (ref && ref.startsWith('@')) {
                const center = isRefMapFresh() ? refCenter(ref) : null;
                if (!center) {
                    return {
                        command: 'type',
                        _staleRef: ref,
                        text,
                        ...extra,
                        ...(bundleId ? { bundleId } : {}),
                    };
                }
                return {
                    command: 'type',
                    x: center.x,
                    y: center.y,
                    text,
                    ...extra,
                    ...(bundleId ? { bundleId } : {}),
                };
            }
            return { command: 'type', text, ...extra, ...(bundleId ? { bundleId } : {}) };
        }
        case 'snapshot':
            return { command: 'snapshot', interactiveOnly: true, ...(bundleId ? { bundleId } : {}) };
        case 'back':
            return { command: 'back', ...(bundleId ? { bundleId } : {}) };
        case 'screenshot':
            return { command: 'screenshot', ...(bundleId ? { bundleId } : {}) };
        case 'keyboard':
            // B235/#418: the Swift enum case is keyboardDismiss; 'dismissKeyboard'
            // (the Android wire verb) never decoded on iOS.
            return { command: 'keyboardDismiss', ...(bundleId ? { bundleId } : {}) };
        case 'swipe':
        case 'scroll': {
            // Coordinate-based gesture. The Swift `.swipe` is tvOS-only; iOS
            // coord-form gestures use `.drag`. CLI shapes seen:
            //   ['swipe',  x1, y1, x2, y2, durationMs?]
            //   ['scroll', x1, y1, x2, y2, durationMs?]
            // Direction-form (`['scroll', 'down', amount?]`) cannot reach this
            // path: device-interact converts direction→coords up-front and
            // dispatches the coord shape.
            const [x1S, y1S, x2S, y2S, durationS] = positionals;
            const x1 = Number(x1S), y1 = Number(y1S), x2 = Number(x2S), y2 = Number(y2S);
            if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
                throw new Error(`buildRunIOSArgs: ${cmd} requires four numeric coordinates`);
            }
            const args = {
                command: 'drag',
                x: x1,
                y: y1,
                x2,
                y2,
                ...(bundleId ? { bundleId } : {}),
            };
            if (durationS !== undefined) {
                const n = Number(durationS);
                if (!Number.isNaN(n))
                    args.durationMs = n;
            }
            return args;
        }
        case 'longpress': {
            // CLI shape: ['longpress', x, y, durationMs?]
            const [xS, yS, durationS] = positionals;
            const x = Number(xS), y = Number(yS);
            if (Number.isNaN(x) || Number.isNaN(y)) {
                throw new Error(`buildRunIOSArgs: longpress requires numeric x, y`);
            }
            const args = {
                command: 'longPress',
                x,
                y,
                ...(bundleId ? { bundleId } : {}),
            };
            if (durationS !== undefined) {
                const n = Number(durationS);
                if (!Number.isNaN(n))
                    args.durationMs = n;
            }
            return args;
        }
        case 'pinch': {
            // CLI shape: ['pinch', scale, x?, y?]
            const [scaleS, xS, yS] = positionals;
            const scale = Number(scaleS);
            if (Number.isNaN(scale)) {
                throw new Error(`buildRunIOSArgs: pinch requires numeric scale`);
            }
            const args = {
                command: 'pinch',
                scale,
                ...(bundleId ? { bundleId } : {}),
            };
            if (xS !== undefined && yS !== undefined) {
                const x = Number(xS), y = Number(yS);
                if (!Number.isNaN(x))
                    args.x = x;
                if (!Number.isNaN(y))
                    args.y = y;
            }
            return args;
        }
        default:
            throw new Error(`buildRunIOSArgs: unsupported command "${cmd ?? '<empty>'}"`);
    }
}
function optionValue(cliArgs, flag) {
    const i = cliArgs.indexOf(flag);
    if (i === -1)
        return undefined;
    const value = cliArgs[i + 1];
    return value && !value.startsWith('-') ? value : undefined;
}
// Extract positional args, dropping flag tokens AND their values (`--count 3`,
// `--pattern xy`). A naive `filter(a => !a.startsWith('--'))` strips the flag
// token but keeps its value, which then mis-parses as a trailing positional
// (e.g. count's `3` landing in the swipe duration slot → a 3ms flick).
function positionalArgs(cliArgs) {
    const out = [];
    for (let i = 1; i < cliArgs.length; i++) {
        const a = cliArgs[i];
        if (a.startsWith('-')) {
            const value = cliArgs[i + 1];
            if (value && !value.startsWith('-'))
                i++;
            continue;
        }
        out.push(a);
    }
    return out;
}
export function buildRunAndroidArgs(cliArgs, bundleId) {
    const cmd = cliArgs[0];
    const positionals = positionalArgs(cliArgs);
    const withBundle = bundleId ? { bundleId } : {};
    switch (cmd) {
        case 'press':
        case 'tap': {
            const ref = positionals[0];
            if (ref && ref.startsWith('@')) {
                const center = isRefMapFresh() ? refCenter(ref) : null;
                if (!center)
                    return { command: 'tap', _staleRef: ref, ...withBundle };
                return { command: 'tap', x: center.x, y: center.y, ...withBundle };
            }
            const [xS, yS] = positionals;
            const x = Number(xS), y = Number(yS);
            if (Number.isNaN(x) || Number.isNaN(y)) {
                throw new Error(`buildRunAndroidArgs: tap requires a @ref or numeric x, y`);
            }
            return { command: 'tap', x, y, ...withBundle };
        }
        case 'fill':
        case 'type': {
            const ref = positionals[0];
            const text = positionals.slice(1).join(' ');
            // Story 04 (#385) M2 guard — mirrors buildRunIOSArgs: a --at-x/--at-y pin
            // bypasses @ref re-resolution so a settle-refreshed map can't retarget.
            const atX = optionValue(cliArgs, '--at-x');
            const atY = optionValue(cliArgs, '--at-y');
            if (atX !== undefined && atY !== undefined) {
                const px = Number(atX), py = Number(atY);
                if (Number.isFinite(px) && Number.isFinite(py)) {
                    return { command: 'type', x: px, y: py, text, ...withBundle };
                }
            }
            if (ref && ref.startsWith('@')) {
                const center = isRefMapFresh() ? refCenter(ref) : null;
                if (!center)
                    return { command: 'type', _staleRef: ref, text, ...withBundle };
                return { command: 'type', x: center.x, y: center.y, text, ...withBundle };
            }
            return { command: 'type', text: positionals.join(' '), ...withBundle };
        }
        case 'snapshot':
            return { command: 'snapshot', interactiveOnly: true, ...withBundle };
        case 'back':
            return { command: 'back', ...withBundle };
        case 'screenshot':
            return { command: 'screenshot', outPath: optionValue(cliArgs, '--out'), ...withBundle };
        case 'keyboard':
        case 'dismissKeyboard':
            return { command: 'dismissKeyboard', ...withBundle };
        // `find` is intentionally NOT handled here — `device_find` is a TS orchestrator
        // on Android (mirrors iOS), built on top of runAndroid('snapshot') + findInLatestSnapshot.
        case 'swipe':
        case 'scroll':
        case 'drag': {
            const [x1S, y1S, x2S, y2S, durationS] = positionals;
            const x1 = Number(x1S), y1 = Number(y1S), x2 = Number(x2S), y2 = Number(y2S);
            if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
                throw new Error(`buildRunAndroidArgs: ${cmd} requires four numeric coordinates`);
            }
            const args = { command: 'drag', x1, y1, x2, y2, ...withBundle };
            if (durationS !== undefined) {
                const n = Number(durationS);
                if (!Number.isNaN(n))
                    args.durationMs = n;
            }
            return args;
        }
        case 'longpress': {
            const [target, yOrDuration, durationMaybe] = positionals;
            if (target?.startsWith('@')) {
                const duration = Number(yOrDuration);
                // Final-review fix (#386): mirrors the tap/type cases in this same
                // function (and the iOS builder) — an over-age ref map must be
                // treated as stale so it heals via _staleRef instead of serving a
                // wrong-element long-press from coordinates captured on a screen that
                // may no longer be on-screen.
                const center = isRefMapFresh() ? refCenter(target) : null;
                if (!center) {
                    return {
                        command: 'longPress',
                        _staleRef: target,
                        ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
                        ...withBundle,
                    };
                }
                return {
                    command: 'longPress',
                    x: center.x,
                    y: center.y,
                    ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
                    ...withBundle,
                };
            }
            const x = Number(target), y = Number(yOrDuration);
            if (Number.isNaN(x) || Number.isNaN(y)) {
                throw new Error('buildRunAndroidArgs: longpress requires numeric x, y or a @ref');
            }
            const args = { command: 'longPress', x, y, ...withBundle };
            if (durationMaybe !== undefined) {
                const n = Number(durationMaybe);
                if (!Number.isNaN(n))
                    args.durationMs = n;
            }
            return args;
        }
        case 'pinch': {
            const [scaleS, xS, yS] = positionals;
            const scale = Number(scaleS);
            if (Number.isNaN(scale)) {
                throw new Error('buildRunAndroidArgs: pinch requires numeric scale');
            }
            const args = { command: 'pinch', scale, ...withBundle };
            if (xS !== undefined && yS !== undefined) {
                const x = Number(xS), y = Number(yS);
                if (!Number.isNaN(x))
                    args.x = x;
                if (!Number.isNaN(y))
                    args.y = y;
            }
            return args;
        }
        default:
            throw new Error(`buildRunAndroidArgs: unsupported command "${cmd ?? '<empty>'}"`);
    }
}
// #210: pure decision for the iOS device_* auto-spawn. Cold-build-safe — only auto-starts
// when a prebuilt .xctestrun exists; a missing rig or no device returns an actionable error
// instead of a silent multi-minute xcodebuild.
export function decideRunnerSpawn(input) {
    if (input.liveness === 'alive')
        return { action: 'proceed' };
    if (!input.deviceId) {
        return {
            action: 'error',
            message: 'rn-fast-runner not started and no booted iOS simulator found. Boot a simulator and run `device_snapshot action=open appId=<your.app.id> platform=ios` first.',
        };
    }
    if (!input.prebuilt) {
        return {
            action: 'error',
            message: 'rn-fast-runner not started and not prebuilt. Run `device_snapshot action=open appId=<your.app.id> platform=ios` first (one-time cold build, ~minutes), then retry — or pre-build once with `xcodebuild build-for-testing` (see plugin Prerequisites).',
        };
    }
    return { action: 'spawn', deviceId: input.deviceId };
}
const PROTOCOL_STALE_REASONS = new Set([
    'legacy',
    'protocol-older',
    'protocol-newer',
    'version-skew',
    // GH #418: a respawn can fix a runner PROCESS older than the on-disk
    // artifact; artifact staleness surviving the respawn is handled separately.
    'missing-commands',
]);
// GH #418: the open-path rebuild tier. A respawn reuses the same build
// artifact, so 'missing-commands' can only be fixed by invalidating
// DerivedData and paying the cold rebuild — allowed at device_snapshot
// action=open only, reap-first, serialized behind the checkout-scoped build
// lock, at most once per plugin version (a broken checkout must not loop
// multi-minute builds).
async function rebuildStaleRunnerArtifact(first, deviceId, bundleId, deps) {
    const missing = (first.missingCommands ?? []).join(', ') || 'unknown';
    const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
    const budget = deps.rebuildBudget ?? runnerRebuildBudget;
    if (plugin !== null && budget.alreadyRebuiltFor(plugin)) {
        return {
            ok: false,
            code: 'RUNNER_COMMANDS_STALE',
            message: `rn-fast-runner was already cold-rebuilt once for plugin v${plugin} and still lacks ` +
                `required commands (missing: ${missing}). If that rebuild failed transiently (sim ` +
                `not booted, xcodebuild flake), delete the runner build/commands-rebuild.json marker ` +
                `and re-open to retry; otherwise update or reinstall the plugin.`,
        };
    }
    const acquire = deps.acquireBuildLock ?? acquireRunnerRebuildLock;
    if (!acquire()) {
        return {
            ok: false,
            code: 'RUNNER_COMMANDS_STALE',
            message: 'another session is rebuilding the shared runner artifact — retry this open in a few minutes.',
        };
    }
    const release = deps.releaseBuildLock ?? releaseRunnerRebuildLock;
    try {
        const reap = deps.reap ?? reapStaleFastRunner;
        await reap();
        const invalidate = deps.invalidateArtifact ??
            (() => rmSync(derivedDataPathForRunner(), { recursive: true, force: true }));
        invalidate();
        if (plugin !== null)
            budget.recordRebuild(plugin);
        const ensure = deps.ensure ?? ensureFastRunner;
        // GH #382 (Codex P1): force a source rebuild — a stale prebuilt artifact must
        // not be re-selected here, or the cold rebuild that heals the command surface
        // never runs.
        await ensure(deviceId, bundleId, { forceLocalBuild: true });
    }
    finally {
        release();
    }
    const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
    const rebuilt = await probe();
    if (rebuilt.liveness === 'alive') {
        return { ok: true, note: `runner artifact rebuilt (missing commands: ${missing})` };
    }
    return {
        ok: false,
        code: 'RUNNER_COMMANDS_STALE',
        message: `rn-fast-runner still lacks required commands after a cold rebuild ` +
            `(missing: ${(rebuilt.missingCommands ?? first.missingCommands ?? []).join(', ') || 'unknown'}). ` +
            `The plugin checkout itself may be outdated — update the plugin, then re-open the device session.`,
    };
}
// #210: orchestrate probe → gate → spawn → RE-VERIFY → structured result. ensureFastRunner
// swallows start errors, so the re-probe is what turns a failed spawn into a clean message
// rather than the unstructured postCommand throw downstream (A6, multi-review).
// GH #383: the probe now returns detailed liveness — a protocol/version-stale
// runner is reaped-and-reinstalled transparently (ok + note); a mismatch that
// survives the reinstall surfaces RUNNER_PROTOCOL_MISMATCH (stale prebuilt).
export async function ensureRunnerForCommand(deviceId, bundleId, deps = {}) {
    const probe = deps.probe ?? probeFastRunnerLivenessDetailed;
    const ensure = deps.ensure ?? ensureFastRunner;
    const prebuilt = deps.prebuilt ?? (() => hasBuiltTestProduct(derivedDataPathForRunner()));
    const adopt = deps.adopt ?? adoptPersistedFastRunnerState;
    adopt(deviceId ?? undefined);
    const first = await probe();
    // GH #418: artifact staleness at open — a respawn launches the same stale
    // .xctestrun, so skip it and invalidate up front (multi-LLM review amendment).
    if (first.staleReason === 'missing-commands' && deps.allowArtifactRebuild && deviceId) {
        return rebuildStaleRunnerArtifact(first, deviceId, bundleId, deps);
    }
    const decision = decideRunnerSpawn({ liveness: first.liveness, prebuilt: prebuilt(), deviceId });
    if (decision.action === 'proceed')
        return { ok: true };
    // GH #418 (device-verify finding): open IS the sanctioned cold-build entry —
    // the not-prebuilt refusal exists for mid-flow auto-spawn (#210), and its
    // message directs users to open. With a device present, open must fall
    // through to ensure(), which cold-builds. Without this, any runner death
    // after a cold `xcodebuild test` (which leaves no .xctestrun) bricks opens.
    if (decision.action === 'error' && !(deps.allowArtifactRebuild && deviceId)) {
        // GH #418 (multi-review): a stale runner missing commands surfaces the
        // typed refusal even when nothing is prebuilt — not the generic
        // not-prebuilt message, whose code would be RN_FAST_RUNNER_DOWN.
        if (first.staleReason === 'missing-commands') {
            const missing = (first.missingCommands ?? []).join(', ') || 'unknown';
            return {
                ok: false,
                code: 'RUNNER_COMMANDS_STALE',
                message: `rn-fast-runner artifact lacks required commands (missing: ${missing}). ` +
                    `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) ` +
                    `to rebuild it (cold build, several minutes).`,
            };
        }
        return { ok: false, message: decision.message };
    }
    await ensure(decision.action === 'spawn' ? decision.deviceId : deviceId, bundleId);
    const after = await probe();
    if (after.liveness === 'alive') {
        if (first.staleReason && PROTOCOL_STALE_REASONS.has(first.staleReason)) {
            return {
                ok: true,
                note: first.staleReason === 'missing-commands'
                    ? 'runner upgraded (stale command surface)'
                    : 'runner upgraded (protocol/version mismatch)',
            };
        }
        return { ok: true };
    }
    // GH #418: 'missing-commands' surviving a respawn means the ARTIFACT is
    // stale — mid-flow callers refuse fast (never a silent multi-minute build).
    if (after.staleReason === 'missing-commands') {
        // Open path, dead-runner-spawned-from-stale-prebuilt case: the first
        // probe said 'dead', so the up-front short-circuit couldn't fire — the
        // rebuild tier must still run here or the first open after an upgrade
        // errors and only the SECOND open heals (device-verify finding).
        if (deps.allowArtifactRebuild && deviceId) {
            return rebuildStaleRunnerArtifact(after, deviceId, bundleId, deps);
        }
        const missing = (after.missingCommands ?? []).join(', ') || 'unknown';
        return {
            ok: false,
            code: 'RUNNER_COMMANDS_STALE',
            message: `rn-fast-runner artifact lacks required commands (missing: ${missing}). ` +
                `Re-open the device session (device_snapshot action=open appId=${bundleId} platform=ios) ` +
                `to rebuild it (cold build, several minutes).`,
        };
    }
    if (after.staleReason && PROTOCOL_STALE_REASONS.has(after.staleReason)) {
        return {
            ok: false,
            code: 'RUNNER_PROTOCOL_MISMATCH',
            message: `rn-fast-runner still speaks an incompatible wire protocol after reinstall ` +
                `(runner protocol ${after.runnerProtocolVersion ?? 'none'}, runnerVersion ${after.runnerVersion ?? 'unknown'}). ` +
                `The prebuilt XCUITest artifact is stale — rebuild it: delete the runner build/DerivedData directory ` +
                `and re-open the device session (cold build), or run xcodebuild build-for-testing (see plugin Prerequisites).`,
        };
    }
    return {
        ok: false,
        message: 'rn-fast-runner did not become ready after auto-spawn. Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
    };
}
export async function ensureFastRunner(deviceId, bundleId, 
// GH #382 (Codex P1): recovery forces a source rebuild by bypassing prebuilt.
opts = {}) {
    // M7/Phase-109: probe tri-state liveness instead of the PID-only
    // isFastRunnerAvailable(). A runner whose PID is alive but whose HTTP server
    // has wedged ('stale') must be reaped before a fresh start — otherwise it is
    // reused and every subsequent device_* command burns the full HTTP timeout
    // before failing. /health responds in ms when healthy, so the happy path is
    // cheap; only a wedged runner pays the 2s probe timeout (vs. 10s per command).
    const liveness = await probeFastRunnerLiveness();
    if (liveness === 'alive')
        return;
    if (liveness === 'stale') {
        await reapStaleFastRunner();
    }
    try {
        await startFastRunner(deviceId, bundleId, undefined, opts);
    }
    catch (err) {
        console.error(`Fast runner auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
let _runAgentDeviceOverrideForTest = null;
// GH #110: test-seam fuse. Once any production runAgentDevice call has
// dispatched in this process, refuse to install a new override —
// makes test-pollution-into-prod impossible by construction. The fuse
// is intentionally one-way: tests that need both production and override
// paths in the same suite should use `node --test --test-isolation=process`
// (Node 22 LTS supports this) to get a fresh worker per file. A reset
// seam here would defeat the entire guarantee — any code that could call
// the reset is the same code that could leak the override (Codex review
// conf 90).
let _testSeamFused = false;
let _testSeamFuseBlownBy = null;
export function _setRunAgentDeviceForTest(fn) {
    if (_testSeamFused) {
        throw new Error(`_setRunAgentDeviceForTest: blown fuse — a production runNative ` +
            `call (cliArgs[0]=${JSON.stringify(_testSeamFuseBlownBy)}) already ` +
            `dispatched in this process. The test seam cannot be re-armed at runtime ` +
            `(GH #110 hardening). The most likely cause is a prior test forgot to ` +
            `clear its override in afterEach. Spawn a fresh Node process — e.g. ` +
            `\`node --test --test-isolation=process\` — if you genuinely need to ` +
            `mix production and override paths.`);
    }
    _runAgentDeviceOverrideForTest = fn;
}
// GH #383: tool results are MCP envelopes (JSON text in content[0]) — attach
// meta by re-encoding, defensively. timings_ms is deep-merged so a settle
// timing never clobbers a dispatcher timing (or vice versa).
export function attachMeta(result, patch) {
    try {
        const first = result.content?.[0];
        if (!first || first.type !== 'text')
            return result;
        const envelope = JSON.parse(first.text);
        const prevTimings = (envelope.meta?.timings_ms ?? {});
        const patchTimings = (patch.timings_ms ?? {});
        envelope.meta = {
            ...envelope.meta,
            ...patch,
            ...(Object.keys(prevTimings).length + Object.keys(patchTimings).length > 0
                ? { timings_ms: { ...prevTimings, ...patchTimings } }
                : {}),
        };
        return {
            ...result,
            content: [
                { type: 'text', text: JSON.stringify(envelope) },
                ...result.content.slice(1),
            ],
        };
    }
    catch {
        return result;
    }
}
export function attachMetaNote(result, note) {
    return attachMeta(result, { note });
}
// Story 04 (#385): post-mutation settle at the dispatch choke point. Advisory
// by contract — a settle failure or timeout NEVER turns a succeeded action
// into an error; every path out of here returns the original result (with
// meta.settle attached when the engine ran). Dynamic import keeps the
// wrapper↔settle↔client module graph acyclic at load time.
//
// Story 05 (#386): also returns the raw SettleOutcome (null when settle never
// ran) so callers can inspect hierarchyChanged. A mutating verb that exits
// without a hash observation invalidates the ref-map's last snapshot hash —
// the screen may have changed unobserved, and a later tap comparing against
// the stale baseline would get a WRONG change verdict.
export async function settleAfterMutationWithOutcome(result, ctx, deps = {}) {
    if (result.isError)
        return { result, outcome: null }; // dispatch never landed — baseline keeps
    if (!SNAPSHOT_MUTATING_VERBS.has(ctx.verb))
        return { result, outcome: null };
    if (ctx.settle?.enabled === false) {
        invalidateLastSnapshotHash(); // mutated + settled blind
        return { result, outcome: null };
    }
    try {
        const settle = await import('./lifecycle/settle.js');
        const enabled = deps.enabled ?? settle.settleEnabled;
        if (!enabled(process.env)) {
            invalidateLastSnapshotHash();
            return { result, outcome: null };
        }
        const capabilities = deps.capabilities
            ? deps.capabilities(ctx.platform)
            : ctx.platform === 'ios'
                ? (await import('./runners/rn-fast-runner-client.js')).getFastRunnerCapabilities()
                : (await import('./runners/rn-android-runner-client.js')).getAndroidRunnerCapabilities();
        const probes = deps.probes
            ? deps.probes(ctx.platform, ctx.appId)
            : ctx.platform === 'ios'
                ? settle.buildIosProbes(ctx.appId)
                : settle.buildAndroidProbes(ctx.appId);
        const wait = deps.wait ?? settle.waitForSettle;
        const outcome = await wait({
            platform: ctx.platform,
            capabilities,
            probes,
            ...(ctx.settle?.timeoutMs !== undefined ? { budgetMs: ctx.settle.timeoutMs } : {}),
            ...(ctx.initialSnapshotHash !== undefined
                ? { initialSnapshotHash: ctx.initialSnapshotHash }
                : {}),
        });
        if (outcome.hierarchyChanged === undefined)
            invalidateLastSnapshotHash();
        return {
            result: attachMeta(result, {
                settle: {
                    method: outcome.method,
                    settled: outcome.settled,
                    ...(outcome.hierarchyChanged !== undefined
                        ? { hierarchyChanged: outcome.hierarchyChanged }
                        : {}),
                },
                timings_ms: { settle: outcome.ms },
            }),
            outcome,
        };
    }
    catch {
        invalidateLastSnapshotHash();
        return { result, outcome: null };
    }
}
export async function settleAfterMutation(result, ctx, deps = {}) {
    return (await settleAfterMutationWithOutcome(result, ctx, deps)).result;
}
export function selfHealEnabled(env) {
    const v = env.RN_SELF_HEAL?.trim().toLowerCase();
    return v !== '0' && v !== 'false';
}
const RETRYABLE_TAP_COMMANDS = new Set(['tap', 'longPress']);
// Story 05 (#386): only plain taps/long-presses are retry-eligible. Multi-tap
// gestures (--count/--double-tap) would change semantics on a re-tap; fills
// have their own read-back verification and a retype would duplicate text;
// hold gestures (--hold-ms, from device_press holdMs / device_longpress by ref,
// routed as ['press', ref, '--hold-ms'] → command 'tap') are a deliberate timed
// interaction, so re-dispatching would change the requested action. Genuine
// coordinate long-presses carry duration positionally (command 'longPress', no
// --hold-ms flag) and stay eligible.
export function tapRetryPolicy(cliArgs, builtCommand, x, y, opts) {
    const eligible = RETRYABLE_TAP_COMMANDS.has(builtCommand) &&
        opts.retryIfNoChange !== false &&
        selfHealEnabled(process.env) &&
        !cliArgs.includes('--double-tap') &&
        !cliArgs.includes('--count') &&
        !cliArgs.includes('--hold-ms') &&
        x !== undefined &&
        y !== undefined;
    return { eligible, targetKey: `${builtCommand}@${x},${y}` };
}
// Story 14 (#407): detect whether a raw runner ToolResult carries the
// transport-recovery marker (runIOS/runAndroid attach it on the firstResult
// when an ambiguous send was confirmed via the runner's outcome journal).
function hasConsumedTapRetryBudget(result) {
    try {
        const env = JSON.parse(result.content[0].text);
        return (env.meta?.transportRecovery !== undefined ||
            env.meta?.keyboardGuard === 'auto_dismissed' ||
            env.data?.keyboardGuard === 'auto_dismissed');
    }
    catch {
        return false;
    }
}
function flagNoUiChange(result, targetKey) {
    const distinct = recordNoUiChange(targetKey);
    return attachMeta(result, {
        noUiChange: true,
        ...(distinct >= WEDGED_DISTINCT_TARGETS ? { hint: WEDGED_RUNTIME_HINT } : {}),
    });
}
// Story 05 (#386): settle the first dispatch with change detection; if the
// hierarchy did not change, presume the tap was swallowed and retry EXACTLY
// once (2 attempts total, Maestro's rule). Still unchanged → success with
// meta.noUiChange (a no-op tap is legitimate — the verifier decides). The
// advisory contract holds: nothing here turns a succeeded action into an error.
export async function settleWithRetryIfNoChange(firstResult, dispatch, ctx, policy, deps = {}) {
    const preHash = policy.eligible ? (getLastSnapshotHash() ?? undefined) : undefined;
    const first = await settleAfterMutationWithOutcome(firstResult, { ...ctx, ...(preHash !== undefined ? { initialSnapshotHash: preHash } : {}) }, deps);
    if (!policy.eligible || preHash === undefined || first.result.isError)
        return first.result;
    if (first.outcome?.hierarchyChanged !== false) {
        if (first.outcome?.hierarchyChanged === true)
            recordUiChange();
        return first.result;
    }
    // Story 14 (#407): a transport-recovered send already consumed the ambiguity
    // budget — the runner journal confirmed the mutating gesture executed. The
    // heal layer must not re-fire it, or it would double-dispatch the very tap
    // that transport recovery just resolved. Report noUiChange honestly, no retry.
    if (hasConsumedTapRetryBudget(firstResult)) {
        return flagNoUiChange(first.result, policy.targetKey);
    }
    const second = await dispatch();
    if (second.isError) {
        return flagNoUiChange(attachMeta(first.result, { tapRetried: true }), policy.targetKey);
    }
    const settled = await settleAfterMutationWithOutcome(second, { ...ctx, initialSnapshotHash: preHash }, deps);
    if (settled.outcome?.hierarchyChanged === false) {
        return flagNoUiChange(attachMeta(settled.result, { tapRetried: true }), policy.targetKey);
    }
    if (settled.outcome?.hierarchyChanged === true)
        recordUiChange();
    return attachMeta(settled.result, { tapRetried: true });
}
const MAX_STALE_CANDIDATES = 5;
function staleRefFail(ref, reason, cachedMetadata, candidates = []) {
    const message = reason === 'ambiguous'
        ? `Element at ref ${ref} is stale and re-resolution matched ${candidates.length} elements — refusing to guess-tap`
        : `Element at ref ${ref} no longer hittable — UI re-rendered since snapshot`;
    const hint = reason === 'ambiguous'
        ? 'Multiple elements share the cached identity. The ref-map was refreshed by this call — pick the intended ref from `candidates` and retry.'
        : reason === 'snapshot-failed'
            ? 'Snapshot infrastructure failed during re-resolution. Check cdp_status / reopen the device session, then retry.'
            : 'Element not re-resolvable by identity (it changed or unmounted). Call device_snapshot action=snapshot and re-find the target.';
    return failResult(message, 'STALE_REF', {
        cachedMetadata,
        reResolution: reason,
        candidates: candidates.slice(0, MAX_STALE_CANDIDATES),
        hint,
    });
}
function extractSnapshotNodes(result) {
    if (result.isError)
        return null;
    try {
        const env = JSON.parse(result.content[0].text);
        if (env.ok === false)
            return null;
        return Array.isArray(env.data?.nodes) ? env.data.nodes : null;
    }
    catch {
        return null;
    }
}
// Story 05 (#386): re-resolve a stale @ref by identity instead of refusing.
// The snapshot closure must be the platform's real snapshot (it also refreshes
// the ref-map as a side effect). Signature + metadata are captured BEFORE the
// snapshot replaces the map.
export async function healStaleRef(staleRef, snapshot) {
    const t0 = Date.now();
    const cachedMetadata = getCachedMetadata(staleRef);
    const sig = getCachedSignature(staleRef);
    if (!sig)
        return { kind: 'failed', result: staleRefFail(staleRef, 'no-signature', cachedMetadata) };
    let nodes;
    try {
        nodes = extractSnapshotNodes(await snapshot());
    }
    catch {
        nodes = null;
    }
    if (!nodes)
        return { kind: 'failed', result: staleRefFail(staleRef, 'snapshot-failed', cachedMetadata) };
    const outcome = refreshRef(sig, nodes);
    if (outcome.kind === 'unique') {
        const r = outcome.node.rect;
        return {
            kind: 'healed',
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            newRef: outcome.node.ref,
            ms: Date.now() - t0,
        };
    }
    if (outcome.kind === 'ambiguous') {
        return {
            kind: 'failed',
            result: staleRefFail(staleRef, 'ambiguous', cachedMetadata, outcome.candidates),
        };
    }
    return { kind: 'failed', result: staleRefFail(staleRef, 'absent', cachedMetadata) };
}
export async function runNative(cliArgs, opts = {}) {
    if (_runAgentDeviceOverrideForTest) {
        return _runAgentDeviceOverrideForTest(cliArgs, opts);
    }
    // GH #110: production dispatch reached. Lock the fuse BEFORE any tier
    // selection so a production call that throws downstream still seals
    // the seam (Codex review conf 90).
    if (!_testSeamFused) {
        _testSeamFused = true;
        _testSeamFuseBlownBy = cliArgs[0] ?? '<empty>';
    }
    // GH #321 (live-sim speedup): a screen-mutating verb invalidates the snapshot
    // cache so a subsequent device_find re-snapshots instead of targeting against
    // a now-stale picture of the screen. Marked here, at the single dispatch choke
    // point, so it covers iOS and Android uniformly. snapshot/screenshot don't
    // change the screen and are intentionally excluded.
    if (SNAPSHOT_MUTATING_VERBS.has(cliArgs[0])) {
        markSnapshotDirty();
    }
    // GH #105 iOS-MVP §3.1: iOS short-circuit. Every supported command goes
    // through our rn-fast-runner HTTP client (no daemon, no CLI). The runner
    // is started lazily — if no session has cold-launched it yet, we surface
    // a clear failure so the agent can call device_snapshot action=open.
    const targetPlatform = opts.platform ?? activeSession?.platform;
    if (targetPlatform === 'ios' && !opts.skipSession && RN_FAST_RUNNER_COMMANDS.has(cliArgs[0])) {
        const appId = activeSession?.appId ?? resolveBundleId('ios') ?? undefined;
        // A2/#210: device_screenshot has its own simctl fallback (device-list.ts) — never block
        // it here; the gate is only for verbs that genuinely require the XCUITest runner.
        let upgradeNote;
        if (cliArgs[0] !== 'screenshot') {
            const deviceId = activeSession?.deviceId ?? (await resolveBootedIosUdid());
            const ready = await ensureRunnerForCommand(deviceId ?? null, appId ?? '');
            if (!ready.ok) {
                // GH #382: discard any pending artifact note from a failed start.
                consumePendingFastRunnerArtifactNote();
                return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN', {
                    runnerPostMortem: getRunnerPostMortem(),
                });
            }
            upgradeNote = ready.note ?? consumePendingFastRunnerArtifactNote();
        }
        const { runIOS, captureFastRunnerCommandAuthority, verifyTypeResultAfterSettle } = await import('./runners/rn-fast-runner-client.js');
        let ios = buildRunIOSArgs(cliArgs, appId);
        if (ios.command === 'type' && opts.verifyTypeReadback) {
            ios._verifyExactReadback = opts.verifyTypeReadback;
        }
        let healMeta = null;
        if (ios._staleRef && selfHealEnabled(process.env)) {
            const healed = await healStaleRef(ios._staleRef, () => runIOS({
                command: 'snapshot',
                interactiveOnly: true,
                ...(appId ? { bundleId: appId } : {}),
            }));
            if (healed.kind === 'failed')
                return healed.result;
            const reboundArgs = [...cliArgs];
            reboundArgs[1] = healed.newRef.startsWith('@') ? healed.newRef : `@${healed.newRef}`;
            ios = buildRunIOSArgs(reboundArgs, appId);
            if (ios.command === 'type' && opts.verifyTypeReadback) {
                ios._verifyExactReadback = opts.verifyTypeReadback;
            }
            if (ios._staleRef) {
                return staleRefFail(ios._staleRef, 'absent', getCachedMetadata(ios._staleRef));
            }
            healMeta = {
                reResolved: true,
                reResolvedRef: healed.newRef,
                timings_ms: { reResolve: healed.ms },
            };
        }
        const runnerAuthorityBefore = captureFastRunnerCommandAuthority();
        let result = await runIOS(ios);
        const iosPolicy = tapRetryPolicy(cliArgs, ios.command, ios.x, ios.y, opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {});
        result = await settleWithRetryIfNoChange(result, () => runIOS(ios), {
            platform: 'ios',
            verb: cliArgs[0],
            ...(appId ? { appId } : {}),
            ...(opts.settle ? { settle: opts.settle } : {}),
        }, iosPolicy);
        result = await verifyTypeResultAfterSettle(ios, result, runnerAuthorityBefore);
        if (healMeta)
            result = attachMeta(result, healMeta);
        return upgradeNote ? attachMetaNote(result, upgradeNote) : result;
    }
    // `find` is intentionally NOT in this Set — Android, like iOS, treats `device_find`
    // as a pure-TS orchestrator (snapshot → match → tap) for cross-platform symmetry.
    // UIAutomator's `By.text()` returns regex-match semantics while findInLatestSnapshot
    // returns exact-or-substring; routing through the runner would diverge from iOS (D1217).
    const RN_ANDROID_RUNNER_COMMANDS = new Set([
        'snapshot',
        'tap',
        'press',
        'fill',
        'type',
        'back',
        'screenshot',
        'keyboard',
        'swipe',
        'scroll',
        'drag',
        'longpress',
        'pinch',
    ]);
    // eradicate-agent-device Phase 2 Task 9: when the operator explicitly disables the
    // Android runner (RN_ANDROID_RUNNER=0), return an actionable error instead of
    // silently falling through to NO_NATIVE_ROUTE. There is no agent-device fallback.
    if (targetPlatform === 'android' &&
        process.env.RN_ANDROID_RUNNER === '0' &&
        !opts.skipSession &&
        RN_ANDROID_RUNNER_COMMANDS.has(cliArgs[0])) {
        return failResult('In-tree Android runner is the only device backend; the agent-device fallback was removed (eradicate-agent-device). Unset RN_ANDROID_RUNNER (or set it to anything but "0") to use it.', 'RUNNER_DISABLED');
    }
    if (targetPlatform === 'android' &&
        process.env.RN_ANDROID_RUNNER !== '0' &&
        !opts.skipSession &&
        RN_ANDROID_RUNNER_COMMANDS.has(cliArgs[0])) {
        const appId = activeSession?.appId ?? resolveBundleId('android') ?? undefined;
        // Parity with the iOS short-circuit: ensure the runner is up before dispatch so
        // a cold device_* gets a clear RN_ANDROID_RUNNER_DOWN rather than a buried
        // "fetch failed" from runAndroid's internal catch. screenshot has its own adb
        // fallback (like iOS simctl) — don't gate it on the runner.
        if (cliArgs[0] !== 'screenshot') {
            const { resolveAndroidSerial, startAndroidRunner, consumePendingAndroidUpgradeNote } = await import('./runners/rn-android-runner-client.js');
            const serial = activeSession?.deviceId ?? (await resolveAndroidSerial());
            if (!serial) {
                return failResult('No Android device resolved (none booted, or multiple — pass deviceId / set ANDROID_SERIAL).', 'RN_ANDROID_RUNNER_DOWN');
            }
            try {
                await startAndroidRunner(serial, appId);
            }
            catch (err) {
                // GH #383: discard any note the failed start left pending — a stale
                // note must never attach to a LATER unrelated result.
                consumePendingAndroidUpgradeNote();
                const msg = err instanceof Error ? err.message : String(err);
                // GH #418: a stale command surface mid-flow is a fast refusal — the
                // open path (device_snapshot action=open) is the rebuild entry.
                if (msg.startsWith('RUNNER_COMMANDS_STALE')) {
                    return failResult(msg, 'RUNNER_COMMANDS_STALE');
                }
                // GH #383: a protocol mismatch surviving the reap+reinstall is a distinct,
                // actionable failure — surface it rather than the generic runner-down.
                if (msg.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
                    return failResult(msg, 'RUNNER_PROTOCOL_MISMATCH');
                }
                return failResult(`rn-android-runner did not start: ${msg}`, 'RN_ANDROID_RUNNER_DOWN');
            }
        }
        const { runAndroid, consumePendingAndroidUpgradeNote } = await import('./runners/rn-android-runner-client.js');
        const android = buildRunAndroidArgs(cliArgs, appId);
        let healMeta = null;
        if (android._staleRef && selfHealEnabled(process.env)) {
            const healed = await healStaleRef(android._staleRef, () => runAndroid({
                command: 'snapshot',
                interactiveOnly: true,
                deviceId: activeSession?.deviceId,
                ...(appId ? { bundleId: appId } : {}),
            }));
            if (healed.kind === 'failed')
                return healed.result;
            android.x = healed.x;
            android.y = healed.y;
            delete android._staleRef;
            healMeta = {
                reResolved: true,
                reResolvedRef: healed.newRef,
                timings_ms: { reResolve: healed.ms },
            };
        }
        let result = await runAndroid({ ...android, deviceId: activeSession?.deviceId });
        const androidPolicy = tapRetryPolicy(cliArgs, android.command, android.x, android.y, opts.retryIfNoChange !== undefined ? { retryIfNoChange: opts.retryIfNoChange } : {});
        result = await settleWithRetryIfNoChange(result, () => runAndroid({ ...android, deviceId: activeSession?.deviceId }), {
            platform: 'android',
            verb: cliArgs[0],
            ...(appId ? { appId } : {}),
            ...(opts.settle ? { settle: opts.settle } : {}),
        }, androidPolicy);
        if (healMeta)
            result = attachMeta(result, healMeta);
        const note = consumePendingAndroidUpgradeNote();
        return note ? attachMetaNote(result, note) : result;
    }
    // No native route for this verb (open/close/devices/find are handled by their
    // own native tools; interaction verbs route via the iOS/Android short-circuits
    // above). The agent-device daemon + CLI tiers were removed (eradicate-agent-device).
    return failResult(`No native route for "${cliArgs[0]}". Open a device session (device_snapshot action=open) first, or use the dedicated tool for this verb.`, 'NO_NATIVE_ROUTE');
}
