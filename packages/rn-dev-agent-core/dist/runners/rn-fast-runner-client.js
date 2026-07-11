import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readdirSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, } from 'node:fs';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, buildSnapshotVerdict, getCachedMetadata, } from '../fast-runner-ref-map.js';
import { isPortFree } from './free-port.js';
import { withKeyboardGuard } from './keyboard-guard.js';
import { runnerStatePath, readJsonStateFile, writeJsonStateFileAtomic, deleteStateFile, readLegacyTmpState, cleanupLegacyTmpState, } from '../util/secure-state-file.js';
import { RUNNER_PROTOCOL_VERSION, REQUIRED_IOS_COMMANDS, getPluginVersion, classifyRunnerCompatibility, } from './protocol.js';
import { buildRunnerQuiescenceEnv } from './quiescence.js';
import { artifactProvenanceToState, resolveIosRunnerArtifacts } from './runner-artifacts.js';
import { resolveNativeRunnerDir } from './runtime-paths.js';
import { decideRecovery, generateCommandId, isAmbiguousTransportFailure, parseStatusProbeReply, } from './transport-recovery.js';
const DEFAULT_PORT = 22088;
// Warm-launch ready gate. Overridable via RN_FAST_RUNNER_READY_TIMEOUT_MS
// because a cold/slow CI simulator can need well over 30s to install + launch
// + attach the XCUITest runner (device-proven on GitHub macos runners).
export function resolveReadyTimeoutMs() {
    const raw = Number(process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}
const READY_TIMEOUT_MS = resolveReadyTimeoutMs();
// A cold `xcodebuild test` compiles the runner project before launching it; on a
// fresh machine (no prebuilt .xctestrun) that can take several minutes, so the
// ready-signal timeout is widened for the build path.
const BUILD_READY_TIMEOUT_MS = 360_000;
const HTTP_TIMEOUT_MS = 10_000;
const FAST_RUNNER_PROJECT = resolveNativeRunnerDir('rn-fast-runner');
/**
 * Pure function variant: parse an entire stdout buffer in one shot.
 * Exists so unit tests can exercise the parser without juggling
 * stateful chunk feeds. Mirrors what `createReadySignalParser` would
 * produce after one synthetic feed of `buf`.
 */
export function parseReadySignal(buf) {
    const parser = createReadySignalParser();
    return parser.feed(buf);
}
export function createReadySignalParser() {
    let pending = '';
    let seenReady = false;
    let quiescence;
    return {
        feed(chunk) {
            pending += chunk;
            // Process complete lines only; keep the trailing partial line buffered.
            let nl;
            while ((nl = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, nl).replace(/\r$/, '');
                pending = pending.slice(nl + 1);
                // Failure markers may appear anywhere — check first.
                if (line.includes('RN_FAST_RUNNER_LISTENER_FAILED')) {
                    return { error: 'RN_FAST_RUNNER_LISTENER_FAILED' };
                }
                if (line.includes('RN_FAST_RUNNER_PORT_NOT_SET')) {
                    return { error: 'RN_FAST_RUNNER_PORT_NOT_SET' };
                }
                // GH #384: quiescence startup marker precedes LISTENER_READY.
                if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE')) {
                    quiescence = 'active';
                }
                else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED')) {
                    quiescence = 'disabled';
                }
                else if (line.includes('RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE')) {
                    quiescence = 'unavailable';
                }
                if (!seenReady) {
                    if (line.includes('RN_FAST_RUNNER_LISTENER_READY')) {
                        seenReady = true;
                    }
                    continue;
                }
                // After READY, scan for the port. NSLog wraps the marker in a
                // timestamp + process prefix, so match anywhere in the line.
                const portMatch = line.match(/RN_FAST_RUNNER_PORT=(\d+)/);
                if (portMatch) {
                    return {
                        ready: true,
                        port: Number(portMatch[1]),
                        ...(quiescence !== undefined ? { quiescence } : {}),
                    };
                }
            }
            return null;
        },
    };
}
// --- Singleton state ---
let runnerProcess = null;
let runnerState = null;
// Story 04 (#385): capabilities from the last successful /health probe. Warm
// before any mutating verb — ensureRunnerForCommand probes /health ahead of
// every non-screenshot iOS command. Consumed by the settle engine.
let lastKnownCapabilities = [];
export function getFastRunnerCapabilities() {
    return lastKnownCapabilities;
}
export function _resetCapabilitiesForTest() {
    lastKnownCapabilities = [];
}
export function _setFastRunnerStateForTest(state) {
    runnerState = state;
}
// GH #384: announce the runner's quiescence-bypass status on the FIRST
// successful /command after a state acquisition (fresh spawn or adoption),
// so sessions are auditable without polling /health. Consumed by every
// success return in runIOS — currently the type-shim return, the snapshot
// return + its defensive fallback, and the final default return; a new
// success return site must also attach it. A shimmed `type` (resp.ok=false
// at the wire level) defers the announcement to the next command by design.
let quiescenceAnnouncementPending = false;
const QUIESCENCE_STATUSES = new Set(['active', 'disabled', 'unavailable']);
export function _resetQuiescenceAnnouncementForTest(pending) {
    quiescenceAnnouncementPending = pending;
}
function takeQuiescenceAnnouncement() {
    if (!quiescenceAnnouncementPending)
        return null;
    quiescenceAnnouncementPending = false;
    // Persisted state is cast, not validated field-by-field — guard against a
    // tampered/corrupt local state file surfacing an arbitrary string.
    if (!runnerState?.quiescence || !QUIESCENCE_STATUSES.has(runnerState.quiescence))
        return null;
    return { quiescenceBypass: runnerState.quiescence };
}
export function iosStatePath(deviceId) {
    return runnerStatePath(`ios-${deviceId}`);
}
export function parsePersistedRunnerState(raw, pidAlive = defaultProcessAlive) {
    if (!raw || typeof raw !== 'object')
        return null;
    const s = raw;
    if (s.schemaVersion !== 1)
        return null;
    if (typeof s.pid !== 'number' || typeof s.port !== 'number')
        return null;
    if (typeof s.deviceId !== 'string' || typeof s.bundleId !== 'string')
        return null;
    if (!pidAlive(s.pid))
        return null;
    return s;
}
// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state. protocolVersion is synthesized to 0 ("pre-protocol") — the
// health gate then classifies the live runner 'legacy' → reap → relaunch,
// which is exactly the transparent-upgrade path. Never trusted beyond
// pid/port/deviceId.
export function parseLegacyRunnerState(raw, pidAlive = defaultProcessAlive) {
    if (!raw || typeof raw !== 'object')
        return null;
    const s = raw;
    if (typeof s.pid !== 'number' || typeof s.port !== 'number')
        return null;
    if (typeof s.deviceId !== 'string')
        return null;
    if (!pidAlive(s.pid))
        return null;
    return {
        schemaVersion: 1,
        pid: s.pid,
        port: s.port,
        deviceId: s.deviceId,
        bundleId: typeof s.bundleId === 'string' ? s.bundleId : '',
        startedAt: '',
        protocolVersion: 0,
    };
}
// GH #383: lazy per-device adoption replaces the import-time /tmp load. A
// respawned bridge worker rediscovers a live runner the first time it knows
// which device it is talking to (ensureRunnerForCommand / session health /
// startFastRunner / stopFastRunner). Invalid or dead persisted state is
// deleted on sight. Falls back to the legacy /tmp file ONCE so a live
// pre-upgrade runner is discovered rather than orphaned (review amendment);
// a dead legacy file is garbage and is removed immediately.
export function adoptPersistedFastRunnerState(deviceId) {
    if (runnerState || !deviceId)
        return;
    const path = iosStatePath(deviceId);
    const raw = readJsonStateFile(path);
    if (raw !== null) {
        const parsed = parsePersistedRunnerState(raw);
        if (!parsed) {
            deleteStateFile(path);
            return;
        }
        runnerState = parsed;
        quiescenceAnnouncementPending = true;
        return;
    }
    const legacy = readLegacyTmpState('ios');
    if (legacy === null)
        return;
    const parsedLegacy = parseLegacyRunnerState(legacy);
    if (!parsedLegacy) {
        cleanupLegacyTmpState();
        return;
    }
    if (parsedLegacy.deviceId === deviceId) {
        runnerState = parsedLegacy;
        quiescenceAnnouncementPending = true;
    }
}
export function getFastRunnerState() {
    return runnerState;
}
/**
 * Test-only seam: inject a fake runner state so callers (e.g. runIOS)
 * can be unit-tested without spawning xcodebuild. Production code must
 * never call this.
 */
export function _setRunnerStateForTest(state) {
    runnerState = state;
}
export function isFastRunnerAvailable() {
    if (!runnerState)
        return false;
    try {
        process.kill(runnerState.pid, 0);
        return true;
    }
    catch {
        /* process dead */
    }
    clearStateFile();
    return false;
}
/**
 * Decide the ordered xcodebuild invocations that start the runner.
 *
 * `test-without-building` is the fast steady-state launch, but it requires a
 * prior `build-for-testing` to have produced a .xctestrun. On a fresh machine
 * that artifact is absent (build/ is gitignored), so the cold path builds it
 * first and then launches warm — making the runner self-install on first use
 * (D1219 follow-up). GH #424: a bare `xcodebuild test` never writes a
 * .xctestrun, so the previous single-invocation cold path left the runner
 * permanently "not prebuilt" and every runner death cost another multi-minute
 * cold build. The build step carries no -only-testing so it produces the same
 * artifact as the documented manual prebuild.
 */
export function resolveRunnerStartPlan(opts) {
    const common = [
        '-project',
        opts.projectPath,
        '-scheme',
        opts.scheme,
        '-destination',
        `platform=iOS Simulator,id=${opts.deviceId}`,
        '-derivedDataPath',
        opts.derivedDataPath,
    ];
    const launch = {
        action: 'test-without-building',
        args: ['test-without-building', ...common, `-only-testing:${opts.onlyTesting}`],
    };
    if (opts.hasBuiltTestProduct)
        return [launch];
    return [{ action: 'build-for-testing', args: ['build-for-testing', ...common] }, launch];
}
/** True when a prior build-for-testing left a .xctestrun under DerivedData. */
export function hasBuiltTestProduct(derivedDataPath) {
    try {
        const productsDir = join(derivedDataPath, 'Build', 'Products');
        if (!existsSync(productsDir))
            return false;
        return readdirSync(productsDir).some((entry) => entry.endsWith('.xctestrun'));
    }
    catch {
        return false;
    }
}
/** #210: the DerivedData path the runner builds into — used to check hasBuiltTestProduct before auto-spawn. */
export function derivedDataPathForRunner() {
    return join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
}
// GH #418 (review amendment): DerivedData is plugin-checkout-scoped while the
// device lock is UDID-scoped, so two projects sharing this checkout could race
// invalidate-vs-build. mkdir is atomic — it is the mutex. Fail-open on fs
// errors (never block a legit session); stale takeover after 15 min.
const REBUILD_LOCK_DIR = join(FAST_RUNNER_PROJECT, 'build', '.rebuild-lock');
const REBUILD_LOCK_STALE_MS = 15 * 60_000;
export function acquireRunnerRebuildLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            mkdirSync(REBUILD_LOCK_DIR, { recursive: false });
            return true;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                return true; // fail-open
            try {
                const age = Date.now() - statSync(REBUILD_LOCK_DIR).mtimeMs;
                if (age < REBUILD_LOCK_STALE_MS)
                    return false;
                rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
            }
            catch {
                return true; // fail-open
            }
        }
    }
    return false;
}
export function releaseRunnerRebuildLock() {
    try {
        rmSync(REBUILD_LOCK_DIR, { recursive: true, force: true });
    }
    catch {
        /* best-effort */
    }
}
// GH #418 (review amendment): at most ONE commands-triggered cold rebuild per
// plugin version — a genuinely-broken checkout must not loop multi-minute
// builds on every open. Lives in build/ (sibling of DerivedData) so the
// invalidation itself can't erase it.
const REBUILD_BUDGET_FILE = join(FAST_RUNNER_PROJECT, 'build', 'commands-rebuild.json');
export const runnerRebuildBudget = {
    alreadyRebuiltFor(pluginVersion) {
        try {
            const parsed = JSON.parse(readFileSync(REBUILD_BUDGET_FILE, 'utf8'));
            return parsed.pluginVersion === pluginVersion;
        }
        catch {
            return false;
        }
    },
    recordRebuild(pluginVersion) {
        try {
            mkdirSync(join(FAST_RUNNER_PROJECT, 'build'), { recursive: true });
            writeFileSync(REBUILD_BUDGET_FILE, JSON.stringify({ pluginVersion, at: new Date().toISOString() }));
        }
        catch {
            /* fail-open */
        }
    },
};
// GH #382: a one-line note ("downloaded prebuilt runner (~4 MB)" / "prebuilt
// runner unavailable ...; building locally") set while startFastRunner resolves
// artifacts. Consumed by the open / mid-flow dispatch paths and attached as a
// meta.note. Mirrors the Android pendingUpgradeNote discipline: the consumer must
// discard it on a failed start so a stale note never leaks onto a later result.
let pendingFastRunnerArtifactNote;
export function consumePendingFastRunnerArtifactNote() {
    const note = pendingFastRunnerArtifactNote;
    pendingFastRunnerArtifactNote = undefined;
    return note;
}
// HONEST_HITTABLE is compiled into the artifact's /health capabilities — its
// absence on a healthy probe is the only artifact-truthful signal that the
// binary predates #395 (protocol/commands are unchanged and runnerVersion is
// env-passed at launch, so every other gate passes). A missing capabilities
// list means the artifact predates capability enumeration entirely and is
// stale for the same reason. Advisory only: a forced rebuild here would break
// the no-silent-multi-minute-xcodebuild contract.
let staleHittableWarned = false;
export function _resetStaleHittableWarnForTest() {
    staleHittableWarned = false;
}
function noteStaleHittableArtifact(capabilities) {
    if (staleHittableWarned || (capabilities ?? []).includes('HONEST_HITTABLE'))
        return;
    if (pendingFastRunnerArtifactNote !== undefined)
        return;
    staleHittableWarned = true;
    pendingFastRunnerArtifactNote =
        'runner artifact predates honest hittable (#395): snapshot hittable values are stale ' +
            '(always false) — delete packages/rn-fast-runner/build/DerivedData and reopen the ' +
            'device session to rebuild, or upgrade the plugin.';
}
// --- Lifecycle ---
/**
 * GH#202: only adopt an existing runner when it is bound to the SAME
 * simulator. The state file path is a fixed constant shared across projects,
 * so a stale state from another project (different deviceId) must never be
 * reused — that would drive the wrong simulator.
 */
export function shouldReuseRunner(state, deviceId) {
    return state !== null && state.deviceId === deviceId;
}
// GH #383 (device-caught): xcodebuild only forwards TEST_RUNNER_-prefixed env
// vars to the XCUITest process (prefix stripped), so the plain var alone never
// reaches RunnerEnv.pluginVersion(). Keep both forms — plain for any direct
// launch path, TEST_RUNNER_ for xcodebuild test.
export function buildRunnerVersionEnv(pluginVersion) {
    if (pluginVersion === null)
        return {};
    return {
        RN_PLUGIN_VERSION: pluginVersion,
        TEST_RUNNER_RN_PLUGIN_VERSION: pluginVersion,
    };
}
// xcodebuild only forwards TEST_RUNNER_-prefixed env vars to the XCUITest
// process (prefix stripped). Keep the plain form for any direct launch path.
export function buildRunnerPortEnv(port) {
    const value = String(port);
    return {
        RN_FAST_RUNNER_PORT: value,
        TEST_RUNNER_RN_FAST_RUNNER_PORT: value,
    };
}
/**
 * GH #424: run a build-phase xcodebuild (build-for-testing) to completion.
 * Unlike the launch invocation it exits on its own and emits no READY marker,
 * so success is exit code 0 — the .xctestrun it writes is what makes every
 * later start warm.
 */
function runXcodebuildToExit(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn('xcodebuild', args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderrTail = '';
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`xcodebuild ${args[0]} did not complete within ${timeoutMs / 1000}s (cold build — first run compiles the runner)`));
        }, timeoutMs);
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-2000);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(`Failed to spawn xcodebuild: ${err.message}`));
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0)
                resolve();
            else
                reject(new Error(`xcodebuild ${args[0]} failed (code ${code})${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
        });
    });
}
export async function startFastRunner(deviceId, bundleId, port, 
// GH #382 (Codex P1): the #418 stale-command recovery forces a source rebuild
// by bypassing the prebuilt artifact tier.
opts = {}) {
    adoptPersistedFastRunnerState(deviceId);
    if (shouldReuseRunner(runnerState, deviceId))
        return runnerState;
    const desired = port ?? ((await isPortFree(DEFAULT_PORT)) ? DEFAULT_PORT : 0);
    const projectPath = join(FAST_RUNNER_PROJECT, 'RnFastRunner', 'RnFastRunner.xcodeproj');
    if (!existsSync(projectPath)) {
        throw new Error(`RnFastRunner.xcodeproj not found at ${projectPath}.`);
    }
    // GH #382: resolve a prebuilt artifact (verified cache → release download)
    // before the local build. When prebuilt, derivedDataPath points at the cached
    // DerivedData layout so hasBuiltTestProduct is true and the plan skips
    // build-for-testing — no xcodebuild build on the user's machine. Fail-open:
    // build-local returns the local DerivedData path (unchanged cold path).
    const artifacts = await resolveIosRunnerArtifacts(getPluginVersion(), derivedDataPathForRunner(), undefined, opts.forceLocalBuild);
    const derivedDataPath = artifacts.derivedDataPath;
    if (artifacts.note)
        pendingFastRunnerArtifactNote = artifacts.note;
    const plan = resolveRunnerStartPlan({
        projectPath,
        scheme: 'RnFastRunner',
        deviceId,
        derivedDataPath,
        onlyTesting: 'RnFastRunnerUITests/RnFastRunnerTests/testCommand',
        hasBuiltTestProduct: hasBuiltTestProduct(derivedDataPath),
    });
    for (const step of plan.slice(0, -1)) {
        await runXcodebuildToExit(step.args, BUILD_READY_TIMEOUT_MS);
        if (!hasBuiltTestProduct(derivedDataPath)) {
            throw new Error(`xcodebuild ${step.action} completed but left no .xctestrun under ${derivedDataPath}/Build/Products — unexpected DerivedData layout`);
        }
    }
    const launch = plan[plan.length - 1];
    return new Promise((resolve, reject) => {
        const child = spawn('xcodebuild', launch.args, {
            env: {
                ...process.env,
                ...buildRunnerPortEnv(desired),
                ...buildRunnerVersionEnv(getPluginVersion()),
                ...buildRunnerQuiescenceEnv(process.env),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        runnerProcess = child;
        const parser = createReadySignalParser();
        let resolved = false;
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Fast runner did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
        }, READY_TIMEOUT_MS);
        const handleChunk = (chunk) => {
            if (resolved)
                return;
            const result = parser.feed(chunk);
            if (!result)
                return;
            resolved = true;
            clearTimeout(timer);
            if ('error' in result) {
                reject(new Error(`Fast runner failed to start: ${result.error}`));
                return;
            }
            const state = {
                schemaVersion: 1,
                port: result.port,
                pid: child.pid,
                deviceId,
                bundleId,
                startedAt: new Date().toISOString(),
                protocolVersion: RUNNER_PROTOCOL_VERSION,
                ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion() } : {}),
                provenance: artifactProvenanceToState(artifacts.provenance),
                ...(result.quiescence !== undefined ? { quiescence: result.quiescence } : {}),
            };
            runnerState = state;
            quiescenceAnnouncementPending = true;
            try {
                writeJsonStateFileAtomic(iosStatePath(deviceId), state);
            }
            catch {
                /* ignore */
            }
            cleanupLegacyTmpState();
            resolve(state);
        };
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', handleChunk);
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', handleChunk);
        child.on('error', (err) => {
            clearTimeout(timer);
            if (runnerProcess === child) {
                clearStateFile();
            }
            reject(new Error(`Failed to spawn xcodebuild: ${err.message}`));
        });
        child.on('exit', (code) => {
            if (runnerProcess === child) {
                clearStateFile();
            }
            clearTimeout(timer);
            reject(new Error(`xcodebuild exited unexpectedly (code ${code})`));
        });
    });
}
// GH #383 (review amendment): adoption-aware teardown. A post-respawn stop
// (session close, restart, maestro park) would otherwise no-op against empty
// in-memory state and leak the persisted runner — so adopt first, then reap.
export function stopFastRunner(deviceId) {
    adoptPersistedFastRunnerState(deviceId);
    if (runnerProcess) {
        runnerProcess.kill('SIGTERM');
        runnerProcess = null;
    }
    else if (runnerState?.pid) {
        try {
            process.kill(runnerState.pid, 'SIGTERM');
        }
        catch {
            /* already dead */
        }
    }
    clearStateFile();
}
export async function fastSwipe(x1, y1, x2, y2, durationMs, bundleId) {
    const body = { command: 'drag', x: x1, y: y1, x2, y2 };
    if (durationMs != null)
        body.durationMs = durationMs;
    // Without appBundleId the runner's executeOnMain clears its target and
    // activates the RnFastRunner HOST app — the drag then lands on the host's
    // blank screen (ok:true, zero movement) and steals foreground from the
    // target (#387 Phase B device-proven).
    if (bundleId)
        body.appBundleId = bundleId;
    const resp = await postCommand(body);
    return resp;
}
// --- Health check ---
export async function fastHealthCheck() {
    if (!runnerState)
        return false;
    try {
        const result = await defaultHttpProbe(runnerState.port, 2000);
        return result.ok && result.status === 200 && result.bodyOk === true;
    }
    catch {
        // Preserve the original contract: any network/abort/parse error → false.
        // (The probe helper throws on fetch errors; M7 review caught this regression.)
        return false;
    }
}
function defaultProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function defaultHttpProbe(port, timeoutMs) {
    // Use the same IPv4 loopback as the /command client (postCommand). The prior
    // [::1] here meant the health probe and the command channel could resolve to
    // different stacks, so a healthy IPv4 listener looked dead over IPv6.
    const url = `http://127.0.0.1:${port}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // fetchImpl (not bare fetch) so the _setFetchForTest seam covers the health
        // probe like every other client call — production default is globalThis.fetch.
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok)
            return { ok: false, status: res.status };
        let bodyOk;
        let protocolVersion;
        let runnerVersion;
        let capabilities;
        let commands;
        try {
            const body = (await res.json());
            bodyOk = body.ok === true;
            if (typeof body.protocolVersion === 'number')
                protocolVersion = body.protocolVersion;
            if (typeof body.runnerVersion === 'string')
                runnerVersion = body.runnerVersion;
            if (Array.isArray(body.capabilities)) {
                capabilities = body.capabilities.filter((c) => typeof c === 'string');
            }
            if (Array.isArray(body.commands)) {
                commands = body.commands.filter((c) => typeof c === 'string');
            }
        }
        catch {
            bodyOk = false;
        }
        return {
            ok: true,
            status: res.status,
            bodyOk,
            ...(protocolVersion !== undefined ? { protocolVersion } : {}),
            ...(runnerVersion !== undefined ? { runnerVersion } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
            ...(commands !== undefined ? { commands } : {}),
        };
    }
    finally {
        clearTimeout(timer);
    }
}
function clearStateFile() {
    // GH #383: capture the per-device path before nulling so the right hardened
    // state file is removed (the /tmp singleton is gone).
    const path = runnerState ? iosStatePath(runnerState.deviceId) : null;
    runnerState = null;
    lastKnownCapabilities = [];
    // M7 review (Gemini): null the child-process handle too. Previously a reap
    // left `runnerProcess` pointing at a dead PID; the on('exit') handler would
    // eventually self-heal, but during the window a concurrent stopFastRunner
    // could signal an already-dead process. Clearing here is defensive.
    runnerProcess = null;
    if (path)
        deleteStateFile(path);
}
export async function probeFastRunnerLivenessDetailed(deps = {}) {
    const getState = deps.getState ?? (() => runnerState);
    const processAlive = deps.processAlive ?? defaultProcessAlive;
    const httpProbe = deps.httpProbe ?? defaultHttpProbe;
    const clearState = deps.clearState ?? clearStateFile;
    const timeoutMs = deps.timeoutMs ?? 2000;
    const state = getState();
    if (!state)
        return { liveness: 'dead' };
    if (!processAlive(state.pid)) {
        clearState();
        return { liveness: 'dead' };
    }
    try {
        const res = await httpProbe(state.port, timeoutMs);
        if (!(res.ok && res.status === 200 && res.bodyOk === true)) {
            lastKnownCapabilities = [];
            return { liveness: 'stale', staleReason: 'health' };
        }
        const plugin = deps.pluginVersion !== undefined ? deps.pluginVersion : getPluginVersion();
        const compat = classifyRunnerCompatibility({
            ...(res.protocolVersion !== undefined ? { protocolVersion: res.protocolVersion } : {}),
            ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
            ...(res.commands !== undefined ? { commands: res.commands } : {}),
        }, plugin, REQUIRED_IOS_COMMANDS);
        if (!compat.compatible) {
            lastKnownCapabilities = [];
            return {
                liveness: 'stale',
                staleReason: compat.reason,
                ...(compat.missing !== undefined ? { missingCommands: compat.missing } : {}),
                ...(res.protocolVersion !== undefined
                    ? { runnerProtocolVersion: res.protocolVersion }
                    : {}),
                ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
            };
        }
        lastKnownCapabilities = res.capabilities ?? [];
        noteStaleHittableArtifact(res.capabilities);
        return {
            liveness: 'alive',
            ...(res.protocolVersion !== undefined ? { runnerProtocolVersion: res.protocolVersion } : {}),
            ...(res.runnerVersion !== undefined ? { runnerVersion: res.runnerVersion } : {}),
            ...(res.capabilities !== undefined ? { capabilities: res.capabilities } : {}),
        };
    }
    catch {
        lastKnownCapabilities = [];
        return { liveness: 'stale', staleReason: 'health' };
    }
}
export async function probeFastRunnerLiveness(deps = {}) {
    return (await probeFastRunnerLivenessDetailed(deps)).liveness;
}
export async function reapStaleFastRunner(deps = {}) {
    const getState = deps.getState ?? (() => runnerState);
    const processAlive = deps.processAlive ?? defaultProcessAlive;
    const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const clearState = deps.clearState ?? clearStateFile;
    const graceMs = deps.graceMs ?? 500;
    const state = getState();
    if (!state)
        return;
    try {
        sendSignal(state.pid, 'SIGTERM');
    }
    catch {
        /* already dead */
    }
    await sleep(graceMs);
    if (processAlive(state.pid)) {
        try {
            sendSignal(state.pid, 'SIGKILL');
        }
        catch {
            /* race: died between checks */
        }
    }
    clearState();
}
let fetchImpl = globalThis.fetch;
export function _setFetchForTest(fn) {
    fetchImpl = fn;
}
// Test seam: override the per-command timeout so the abort path can be
// exercised without waiting the full production window.
let httpTimeoutOverrideMs = null;
export function _setHttpTimeoutForTest(ms) {
    httpTimeoutOverrideMs = ms;
}
// `type` and `snapshot` legitimately run long (the runner's typeText
// quiescence shim can sit up to its own 30s main-thread timeout before
// returning the success-shaped message we depend on, and large trees take a
// while to serialize), so they get a window wider than that internal cap.
// Everything else is a fast interaction and must not hang past HTTP_TIMEOUT_MS.
const SLOW_RUNNER_COMMANDS = new Set(['type', 'snapshot', 'screenshot']);
function commandTimeoutMs(command) {
    if (httpTimeoutOverrideMs !== null)
        return httpTimeoutOverrideMs;
    return SLOW_RUNNER_COMMANDS.has(command) ? 35_000 : HTTP_TIMEOUT_MS;
}
async function sendCommandOnce(port, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetchImpl(`http://127.0.0.1:${port}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const parsed = (await resp.json());
        // GH #383: defense-in-depth — the liveness gate already reaps a
        // protocol-mismatched runner, but a runner that flipped protocol mid-session
        // (hot-swapped binary) is caught here on the /command reply's `v` stamp.
        if (typeof parsed.v === 'number' && parsed.v !== RUNNER_PROTOCOL_VERSION) {
            throw new Error(`RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge expects v${RUNNER_PROTOCOL_VERSION}`);
        }
        return parsed;
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`RUNNER_TIMEOUT: rn-fast-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms — listener may be wedged`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}
const STATUS_PROBE_TIMEOUT_MS = 2000;
async function probeCommandStatus(port, commandId) {
    try {
        const resp = await sendCommandOnce(port, { command: 'status', commandId }, STATUS_PROBE_TIMEOUT_MS);
        return parseStatusProbeReply(resp, commandId);
    }
    catch {
        return null;
    }
}
// Story 14 (#407): a response lost after send is ambiguous — "never executed"
// vs "executed, response lost". One short status probe against the runner's
// outcome journal resolves it; mutating verbs are NEVER resent, and an
// unresolvable probe falls through to the existing invalidation path.
// Recovery info travels in the return value so callers that don't surface
// meta (fastSwipe, settle probes) discard it with the response.
async function postCommandWithRecovery(body) {
    const state = runnerState;
    if (!state) {
        throw new Error('rn-fast-runner not started — run `device_snapshot action=open appId=<your.app.id> platform=ios` first (auto-spawns the runner).');
    }
    const commandId = generateCommandId();
    const timeoutMs = commandTimeoutMs(body.command);
    try {
        return { resp: await sendCommandOnce(state.port, { ...body, commandId }, timeoutMs) };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isAmbiguousTransportFailure(message))
            throw err;
        const decision = decideRecovery(await probeCommandStatus(state.port, commandId), body.command);
        if (decision.action === 'return-recovered') {
            return {
                resp: decision.response,
                recovery: { commandId, outcome: decision.outcome },
            };
        }
        if (decision.action === 'resend-once') {
            const resent = await sendCommandOnce(state.port, { ...body, commandId: generateCommandId() }, timeoutMs);
            return { resp: resent, recovery: { commandId, outcome: 'resent' } };
        }
        throw err;
    }
}
async function postCommand(body) {
    return (await postCommandWithRecovery(body)).resp;
}
/**
 * Convert a runner SnapshotNode array (flat, already indexed) → FlatNode[]
 * for the ref-map. Each runner node gets a synthetic ref `@e<index>` so
 * downstream press/fill can target it.
 */
function mapRunnerNodesToFlat(nodes) {
    const out = [];
    let synthCounter = 0;
    for (const n of nodes) {
        if (!n.rect)
            continue;
        const refId = n.index !== undefined ? `e${n.index}` : `e${synthCounter++}`;
        const flat = {
            ref: `@${refId}`,
            type: n.type ?? '',
            rect: n.rect,
        };
        if (n.label !== undefined)
            flat.label = n.label;
        if (n.identifier !== undefined)
            flat.identifier = n.identifier;
        if (n.enabled !== undefined)
            flat.enabled = n.enabled;
        if (n.hittable !== undefined)
            flat.hittable = n.hittable;
        out.push(flat);
    }
    return out;
}
export async function runIOS(args) {
    // STALE_REF sentinel from buildRunIOSArgs(): the caller tried to press/type
    // a @ref but refCenter() returned null. Surface cached metadata so the agent
    // knows what it asked for, plus a hint to call device_snapshot.
    if (args._staleRef) {
        return failResult(`Element at ref ${args._staleRef} no longer hittable — UI re-rendered since snapshot`, 'STALE_REF', {
            cachedMetadata: getCachedMetadata(args._staleRef),
            reResolution: 'self-heal-disabled',
            candidates: [],
            hint: 'Call device_snapshot action=snapshot to refresh refs, then retry the action with the new ref.',
        });
    }
    const body = { command: args.command };
    if (args.bundleId)
        body.appBundleId = args.bundleId;
    if (args.x !== undefined)
        body.x = args.x;
    if (args.y !== undefined)
        body.y = args.y;
    if (args.x2 !== undefined)
        body.x2 = args.x2;
    if (args.y2 !== undefined)
        body.y2 = args.y2;
    if (args.text !== undefined)
        body.text = args.text;
    if (args.durationMs !== undefined)
        body.durationMs = args.durationMs;
    if (args.delayMs !== undefined)
        body.delayMs = args.delayMs;
    if (args.clearFirst !== undefined)
        body.clearFirst = args.clearFirst;
    if (args.direction !== undefined)
        body.direction = args.direction;
    if (args.scale !== undefined)
        body.scale = args.scale;
    if (args.interactiveOnly !== undefined)
        body.interactiveOnly = args.interactiveOnly;
    if (args.compact !== undefined)
        body.compact = args.compact;
    if (args.depth !== undefined)
        body.depth = args.depth;
    if (args.scope !== undefined)
        body.scope = args.scope;
    let resp;
    let recovery;
    try {
        ({ resp, recovery } = await postCommandWithRecovery(withKeyboardGuard(body, args.command, process.env)));
    }
    catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
            return failResult(m, 'RUNNER_PROTOCOL_MISMATCH');
        }
        throw err;
    }
    const recoveryMeta = recovery ? { transportRecovery: recovery } : {};
    const announce = resp.ok ? takeQuiescenceAnnouncement() : null;
    if (!resp.ok) {
        const message = resp.error?.message ?? 'runner returned !ok with no error';
        const code = resp.error?.code;
        // GH #105 iOS-MVP follow-up: XCUIElement.typeText() runs its own internal
        // snapshot/quiescence synchronization that bypasses skipPostEventQuiescence
        // — even with both target resolution AND the typing call wrapped in
        // withTemporaryScrollIdleTimeoutIfSupported, the post-action wait still
        // hits XCTest's 30s mainThreadExecutionTimeout because RN's main thread
        // never reports quiescence (Reanimated keeps it active). Live validation
        // confirms the text DOES land in the field every time. Treat this specific
        // timeout shape as success for the type command and surface a meta marker
        // so callers can audit telemetry. Any other error remains a failure.
        if (args.command === 'type' &&
            typeof message === 'string' &&
            message.includes('main thread execution timed out')) {
            return okResult({ typed: true, text: args.text }, {
                meta: {
                    sideEffectSucceeded: true,
                    runnerTimeoutShim: true,
                    ...announce,
                    ...recoveryMeta,
                },
            });
        }
        const failExtras = recovery ? { transportRecovery: recovery } : undefined;
        if (code) {
            return failResult(message, code, failExtras);
        }
        return failExtras ? failResult(message, failExtras) : failResult(message);
    }
    // Snapshot post-processing: feed the ref map so future press/fill calls
    // can resolve @refs without a separate fetch.
    if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
        const data = resp.data;
        if (Array.isArray(data.nodes)) {
            const flat = mapRunnerNodesToFlat(data.nodes);
            const outcome = updateRefMapFromFlat(flat);
            // GH #409: verdict rendered from the same call that decided whether the
            // ref map was overwritten — an empty capture is reported as degraded and
            // leaves the last-known-good refs bound.
            const snapshotVerdict = buildSnapshotVerdict('rn-fast-runner', flat.length, outcome);
            return okResult({ nodes: flat }, { meta: { ...announce, snapshotVerdict, ...recoveryMeta } });
        }
        // Defensive fallback: the test seam mocks `{ tree: ... }`. Don't crash.
        const fallbackMeta = { ...announce, ...recoveryMeta };
        return okResult(resp.data, Object.keys(fallbackMeta).length ? { meta: fallbackMeta } : undefined);
    }
    const finalMeta = { ...announce, ...recoveryMeta };
    return okResult(resp.data ?? {}, Object.keys(finalMeta).length ? { meta: finalMeta } : undefined);
}
