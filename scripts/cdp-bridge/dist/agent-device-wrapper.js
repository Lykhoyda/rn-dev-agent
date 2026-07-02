import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { failResult } from './utils.js';
import { startFastRunner, probeFastRunnerLiveness, probeFastRunnerLivenessDetailed, adoptPersistedFastRunnerState, reapStaleFastRunner, hasBuiltTestProduct, derivedDataPathForRunner, } from './runners/rn-fast-runner-client.js';
import { resolveBootedIosUdid } from './tools/device-screenshot-raw.js';
import { refCenter, getScreenRect, clearRefMap, isRefMapFresh, MAX_REF_MAP_AGE_MS, } from './fast-runner-ref-map.js';
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
        nodes,
        capturedAt: new Date().toISOString(),
        capturedAtMs: Date.now(),
    });
    // A fresh snapshot is, by definition, a clean picture of the current screen.
    snapshotCacheDirty = false;
}
export function getCachedSnapshot(platform) {
    return snapshotCache.get(platform);
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
                return { command: 'tap', x: center.x, y: center.y, ...(bundleId ? { bundleId } : {}) };
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
            return { command: 'dismissKeyboard', ...(bundleId ? { bundleId } : {}) };
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
                const center = refCenter(target);
                if (!center)
                    return { command: 'longPress', _staleRef: target, ...withBundle };
                const duration = Number(yOrDuration);
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
]);
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
    const decision = decideRunnerSpawn({ liveness: first.liveness, prebuilt: prebuilt(), deviceId });
    if (decision.action === 'proceed')
        return { ok: true };
    if (decision.action === 'error')
        return { ok: false, message: decision.message };
    await ensure(decision.deviceId, bundleId);
    const after = await probe();
    if (after.liveness === 'alive') {
        if (first.staleReason && PROTOCOL_STALE_REASONS.has(first.staleReason)) {
            return { ok: true, note: 'runner upgraded (protocol/version mismatch)' };
        }
        return { ok: true };
    }
    if (after.staleReason && PROTOCOL_STALE_REASONS.has(after.staleReason)) {
        return {
            ok: false,
            code: 'RUNNER_PROTOCOL_MISMATCH',
            message: `rn-fast-runner still speaks an incompatible wire protocol after reinstall ` +
                `(runner protocol ${after.runnerProtocolVersion ?? 'none'}, runnerVersion ${after.runnerVersion ?? 'unknown'}). ` +
                `The prebuilt XCUITest artifact is stale — rebuild it: delete scripts/rn-fast-runner/build/DerivedData ` +
                `and re-open the device session (cold build), or run xcodebuild build-for-testing (see plugin Prerequisites).`,
        };
    }
    return {
        ok: false,
        message: 'rn-fast-runner did not become ready after auto-spawn. Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
    };
}
export async function ensureFastRunner(deviceId, bundleId) {
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
        await startFastRunner(deviceId, bundleId);
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
// a meta.note by re-encoding, defensively.
export function attachMetaNote(result, note) {
    try {
        const first = result.content?.[0];
        if (!first || first.type !== 'text')
            return result;
        const envelope = JSON.parse(first.text);
        envelope.meta = { ...envelope.meta, note };
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
            if (!ready.ok)
                return failResult(ready.message, ready.code ?? 'RN_FAST_RUNNER_DOWN');
            upgradeNote = ready.note;
        }
        const { runIOS } = await import('./runners/rn-fast-runner-client.js');
        const ios = buildRunIOSArgs(cliArgs, appId);
        const result = await runIOS(ios);
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
            const { resolveAndroidSerial, startAndroidRunner } = await import('./runners/rn-android-runner-client.js');
            const serial = activeSession?.deviceId ?? (await resolveAndroidSerial());
            if (!serial) {
                return failResult('No Android device resolved (none booted, or multiple — pass deviceId / set ANDROID_SERIAL).', 'RN_ANDROID_RUNNER_DOWN');
            }
            try {
                await startAndroidRunner(serial, appId);
            }
            catch (err) {
                return failResult(`rn-android-runner did not start: ${err instanceof Error ? err.message : String(err)}`, 'RN_ANDROID_RUNNER_DOWN');
            }
        }
        const { runAndroid } = await import('./runners/rn-android-runner-client.js');
        const android = buildRunAndroidArgs(cliArgs, appId);
        return runAndroid({ ...android, deviceId: activeSession?.deviceId });
    }
    // No native route for this verb (open/close/devices/find are handled by their
    // own native tools; interaction verbs route via the iOS/Android short-circuits
    // above). The agent-device daemon + CLI tiers were removed (eradicate-agent-device).
    return failResult(`No native route for "${cliArgs[0]}". Open a device session (device_snapshot action=open) first, or use the dedicated tool for this verb.`, 'NO_NATIVE_ROUTE');
}
