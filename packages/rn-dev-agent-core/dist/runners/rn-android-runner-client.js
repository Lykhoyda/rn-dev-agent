/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, buildSnapshotVerdict, getCachedMetadata, } from '../fast-runner-ref-map.js';
import { findFreePort } from './free-port.js';
import { join } from 'node:path';
import { withKeyboardGuard } from './keyboard-guard.js';
import { runnerStatePath, readJsonStateFile, writeJsonStateFileAtomic, deleteStateFile, readLegacyTmpState, cleanupLegacyTmpState, } from '../util/secure-state-file.js';
import { RUNNER_PROTOCOL_VERSION, MIN_SUPPORTED_RUNNER_PROTOCOL, REQUIRED_ANDROID_COMMANDS, getPluginVersion, classifyRunnerCompatibility, } from './protocol.js';
import { artifactProvenanceToState, resolveAndroidRunnerArtifacts } from './runner-artifacts.js';
import { resolveNativeRunnerDir } from './runtime-paths.js';
import { decideRecovery, generateCommandId, isAmbiguousTransportFailure, parseStatusProbeReply, } from './transport-recovery.js';
import { readProcessBirth } from '../session/process-birth.js';
const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 22089;
const READY_TIMEOUT_MS = 30_000;
const INSTRUMENTATION = 'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';
const MAIN_LOOP_CLASS = 'dev.lykhoyda.rndevagent.androidrunner.RnAndroidRunnerInstrumentedTest#mainLoop';
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
// Self-install (parity with the iOS rn-fast-runner cold build): the in-tree runner
// ships as a Gradle project; its APKs build/install on first use so there's no
// external CLI to install (matches the /setup + /doctor docs).
const RN_ANDROID_RUNNER_DIR = resolveNativeRunnerDir('rn-android-runner');
const GRADLEW = join(RN_ANDROID_RUNNER_DIR, 'gradlew');
const APK_APP = join(RN_ANDROID_RUNNER_DIR, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const APK_TEST = join(RN_ANDROID_RUNNER_DIR, 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk');
const GRADLE_BUILD_TIMEOUT_MS = 600_000; // cold assembleDebug can take minutes on a fresh machine
const ADB_INSTALL_TIMEOUT_MS = 120_000;
export function getAndroidRunnerState() {
    return runnerState;
}
let runnerProcess = null;
let runnerState = null;
let fetchImpl = globalThis.fetch;
let testAuthorityState = false;
export function _setFetchForTest(fn) {
    fetchImpl = fn;
}
export function _setAndroidRunnerStateForTest(state) {
    testAuthorityState = state !== null;
    runnerState = state
        ? {
            ...state,
            instanceId: state.instanceId ?? 'test-runner-instance',
            sessionId: state.sessionId ?? 'test-session',
            claimEpoch: state.claimEpoch ?? 1,
            capability: state.capability ?? 'test-capability'.repeat(3),
        }
        : null;
}
export function androidStatePath(serial) {
    return runnerStatePath(`android-${serial}`);
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
export function parsePersistedAndroidState(raw, pidAlive = defaultProcessAlive) {
    if (!raw || typeof raw !== 'object')
        return null;
    const s = raw;
    if (s.schemaVersion !== 1)
        return null;
    if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number')
        return null;
    if (typeof s.pid !== 'number')
        return null;
    if (!pidAlive(s.pid))
        return null;
    return s;
}
// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state — mirrors parseLegacyRunnerState on iOS. protocolVersion 0 makes
// the reuse-time health gate classify the live runner 'legacy' → reap.
export function parseLegacyAndroidState(raw, pidAlive = defaultProcessAlive) {
    if (!raw || typeof raw !== 'object')
        return null;
    const s = raw;
    if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number')
        return null;
    if (typeof s.pid !== 'number')
        return null;
    if (!pidAlive(s.pid))
        return null;
    return {
        schemaVersion: 1,
        hostPort: s.hostPort,
        devicePort: s.devicePort,
        pid: s.pid,
        ...(typeof s.deviceId === 'string' ? { deviceId: s.deviceId } : {}),
        ...(typeof s.bundleId === 'string' ? { bundleId: s.bundleId } : {}),
        startedAt: '',
        protocolVersion: 0,
    };
}
// Serial-scoped adoption (review amendment: NO 'default' key — an unknown
// serial means no persistence, so two projects driving two different
// unspecified devices can never share a state file).
export function adoptPersistedAndroidState(serial) {
    if (runnerState)
        return;
    if (serial) {
        const path = androidStatePath(serial);
        const raw = readJsonStateFile(path);
        if (raw !== null) {
            const parsed = parsePersistedAndroidState(raw);
            if (!parsed) {
                deleteStateFile(path);
                return;
            }
            runnerState = parsed;
            return;
        }
    }
    const legacy = readLegacyTmpState('android');
    if (legacy === null)
        return;
    const parsedLegacy = parseLegacyAndroidState(legacy);
    if (!parsedLegacy) {
        cleanupLegacyTmpState();
        return;
    }
    if (!serial || !parsedLegacy.deviceId || parsedLegacy.deviceId === serial) {
        runnerState = parsedLegacy;
    }
}
function clearAndroidStateFile() {
    const path = runnerState?.deviceId ? androidStatePath(runnerState.deviceId) : null;
    runnerState = null;
    runnerProcess = null;
    if (path)
        deleteStateFile(path);
}
export function parseAdbDevicesSerials(stdout) {
    return stdout
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .map((l) => /^(\S+)\s+device\b/.exec(l))
        .filter((m) => m !== null)
        .map((m) => m[1]);
}
export async function resolveAndroidSerial(explicit) {
    if (explicit)
        return explicit;
    if (process.env.ANDROID_SERIAL)
        return process.env.ANDROID_SERIAL;
    try {
        const { stdout } = await execFileAsync('adb', ['devices']);
        const serials = parseAdbDevicesSerials(stdout);
        return serials.length === 1 ? serials[0] : undefined;
    }
    catch {
        return undefined;
    }
}
function adbSerialArgs(deviceId) {
    if (deviceId)
        return ['-s', deviceId];
    if (process.env.ANDROID_SERIAL)
        return ['-s', process.env.ANDROID_SERIAL];
    return [];
}
export function buildAdbForwardArgs(deviceId, hostPort, devicePort) {
    return [...adbSerialArgs(deviceId), 'forward', `tcp:${hostPort}`, `tcp:${devicePort}`];
}
export function buildAdbForwardRemoveArgs(deviceId, hostPort) {
    return [...adbSerialArgs(deviceId), 'forward', '--remove', `tcp:${hostPort}`];
}
export function buildInstrumentPortArgs(devicePort) {
    return ['-e', 'RN_ANDROID_RUNNER_PORT', String(devicePort)];
}
export function buildInstrumentVersionArgs(pluginVersion) {
    return pluginVersion ? ['-e', 'RN_PLUGIN_VERSION', pluginVersion] : [];
}
function androidRunnerAuthority(deviceId, appId) {
    const sessionId = (testAuthorityState ? runnerState?.sessionId : undefined) ??
        process.env.RN_DEV_AGENT_SESSION_ID;
    const claimEpoch = (testAuthorityState ? runnerState?.claimEpoch : undefined) ??
        Number(process.env.RN_DEV_AGENT_CLAIM_EPOCH);
    if (!sessionId || !Number.isSafeInteger(claimEpoch) || claimEpoch < 1) {
        throw new Error('SESSION_AUTHORITY_REQUIRED: native runner launch requires a fenced rn-dev-agent session');
    }
    return {
        instanceId: randomUUID(),
        sessionId,
        claimEpoch,
        capability: randomBytes(32).toString('base64url'),
        deviceId,
        appId,
    };
}
export function buildInstrumentAuthorityArgs(authority) {
    return Object.entries({
        RN_RUNNER_INSTANCE_ID: authority.instanceId,
        RN_RUNNER_SESSION_ID: authority.sessionId,
        RN_RUNNER_CLAIM_EPOCH: String(authority.claimEpoch),
        RN_RUNNER_CAPABILITY: authority.capability,
        RN_RUNNER_DEVICE_ID: authority.deviceId,
        RN_RUNNER_APP_ID: authority.appId,
    }).flatMap(([key, value]) => ['-e', key, value]);
}
export function buildAdbInstallArgs(deviceId, apkPath) {
    return [...adbSerialArgs(deviceId), 'install', '-r', apkPath];
}
export function buildGradleAssembleArgs() {
    return [':app:assembleDebug', ':app:assembleDebugAndroidTest'];
}
/**
 * True when `adb shell pm list instrumentation` names our exact `<pkg>/<runner>` id.
 * Anchored to the full id (not the bare package) so a superstring package
 * (`…androidrunner.testfoo`) or a `(target=…)` mention can't false-positive.
 */
export function isInstrumentationRegistered(pmListStdout, instrumentation) {
    const escaped = instrumentation.replace(/[.$*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|:)${escaped}(\\s|$)`, 'm').test(pmListStdout);
}
/** Decide how to provision the runner: reuse (already on device), install the prebuilt
 *  APKs, or cold-build then install (fresh machine — mirrors the iOS cold xcodebuild). */
export function resolveAndroidInstallAction(opts) {
    if (opts.instrumentationRegistered)
        return 'reuse';
    if (opts.apksExist)
        return 'install';
    return 'build-then-install';
}
/**
 * Self-install the in-tree runner on first use (parity with rn-fast-runner's cold build):
 * if the instrumentation isn't registered on the device, install the prebuilt APKs — and
 * if those don't exist yet, cold-build them via Gradle first. Throws an actionable error
 * (surfaced as RN_ANDROID_RUNNER_DOWN by the caller) when the SDK/Gradle/adb step fails.
 */
async function ensureAndroidRunnerInstalled(deviceId, opts = {}) {
    // Fail fast if the target isn't online — never start a multi-minute cold build (or an
    // install) against an offline/absent device. (Codex review: avoid the build-then-fail trap.)
    try {
        const { stdout } = await execFileAsync('adb', [...adbSerialArgs(deviceId), 'get-state'], {
            timeout: 5_000,
        });
        if (stdout.trim() !== 'device')
            throw new Error(`adb state is "${stdout.trim()}"`);
    }
    catch (err) {
        throw new Error(`rn-android-runner: target device not online (adb get-state) — boot the emulator / connect the device. ` +
            `${err instanceof Error ? err.message : String(err)}`);
    }
    let pmOut = '';
    try {
        pmOut = (await execFileAsync('adb', [
            ...adbSerialArgs(deviceId),
            'shell',
            'pm',
            'list',
            'instrumentation',
        ])).stdout;
    }
    catch {
        // adb/pm unavailable → treat as not registered; the install/adb step below surfaces the real error.
    }
    // GH #382: resolve prebuilt APKs (verified cache → release download) before the
    // local Gradle build. When prebuilt, the resolved paths point at the cache and
    // the build-then-install branch is skipped (no gradlew on the user's machine).
    // Fail-open: build-local returns the Gradle output paths (unchanged cold path).
    const artifacts = await resolveAndroidRunnerArtifacts(getPluginVersion(), { appApk: APK_APP, testApk: APK_TEST }, undefined, opts.forceLocalBuild);
    const provenance = artifactProvenanceToState(artifacts.provenance);
    if (artifacts.note)
        pendingUpgradeNote = artifacts.note;
    const action = resolveAndroidInstallAction({
        instrumentationRegistered: !opts.forceReinstall && isInstrumentationRegistered(pmOut, INSTRUMENTATION),
        apksExist: existsSync(artifacts.appApk) && existsSync(artifacts.testApk),
    });
    if (action === 'reuse')
        return provenance;
    if (action === 'build-then-install') {
        try {
            await execFileAsync(GRADLEW, buildGradleAssembleArgs(), {
                cwd: RN_ANDROID_RUNNER_DIR,
                timeout: GRADLE_BUILD_TIMEOUT_MS,
                maxBuffer: 10 * 1024 * 1024,
            });
        }
        catch (err) {
            throw new Error(`rn-android-runner cold build failed (gradlew assembleDebug assembleDebugAndroidTest in ${RN_ANDROID_RUNNER_DIR}). ` +
                `Ensure the Android SDK + a JDK are installed and on PATH. ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    try {
        await execFileAsync('adb', buildAdbInstallArgs(deviceId, artifacts.appApk), {
            timeout: ADB_INSTALL_TIMEOUT_MS,
        });
        await execFileAsync('adb', buildAdbInstallArgs(deviceId, artifacts.testApk), {
            timeout: ADB_INSTALL_TIMEOUT_MS,
        });
    }
    catch (err) {
        throw new Error(`rn-android-runner APK install failed (adb install -r). Is the emulator/device online? ` +
            `${err instanceof Error ? err.message : String(err)}`);
    }
    return provenance;
}
export function isAndroidRunnerAvailable() {
    if (!runnerState)
        return false;
    try {
        process.kill(runnerState.pid, 0);
        return true;
    }
    catch {
        clearAndroidStateFile();
        return false;
    }
}
/**
 * GH#202 parity with iOS shouldReuseRunner: only adopt a live runner when it is
 * bound to the SAME emulator. The state file path is a fixed constant shared
 * across projects/sessions, so a runner bound to emulator-A must never be reused
 * to drive emulator-B (its adb forward + port still point at A — every command
 * would silently hit the wrong device). When no specific deviceId is requested
 * (single-device flow), any live runner is acceptable.
 */
export function shouldReuseAndroidRunner(state, deviceId) {
    if (state === null)
        return false;
    const sessionId = (testAuthorityState ? state.sessionId : undefined) ?? process.env.RN_DEV_AGENT_SESSION_ID;
    const claimEpoch = (testAuthorityState ? state.claimEpoch : undefined) ??
        Number(process.env.RN_DEV_AGENT_CLAIM_EPOCH);
    if (!sessionId ||
        !Number.isSafeInteger(claimEpoch) ||
        state.sessionId !== sessionId ||
        state.claimEpoch !== claimEpoch ||
        typeof state.capability !== 'string' ||
        state.capability.length < 32) {
        return false;
    }
    return typeof deviceId === 'string' && state.deviceId === deviceId;
}
/**
 * GH#243: HTTP-truthful readiness. The runner logs RN_ANDROID_RUNNER_LISTENER_READY,
 * but `adb logcat` replays the ring buffer — a prior runner's ready line (same tag +
 * fixed port) fired readiness before the new ServerSocket bound, so the first
 * post-flow POST /command hit a dead port ("fetch failed"). Poll the runner's own
 * GET /health, which is true only once the socket is accepting. Bounded by timeoutMs
 * (defaults to the cold-start ready budget); never throws — returns false on timeout.
 */
export async function waitForAndroidRunnerHealth(port, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
    const intervalMs = opts.intervalMs ?? HEALTH_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
        try {
            const capability = opts.capability ?? (runnerState?.hostPort === port ? runnerState.capability : undefined);
            const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, {
                signal: controller.signal,
                headers: capability ? { authorization: `Bearer ${capability}` } : {},
            });
            if (resp.ok) {
                const body = (await resp.json());
                if (body?.ok === true)
                    return true;
            }
        }
        catch {
            // server not accepting yet — keep polling
        }
        finally {
            clearTimeout(timer);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
}
// Story 04 (#385): capabilities from the last successful /health probe. Warm
// before any mutating verb — startAndroidRunner probes /health on the reuse
// and readiness paths. Consumed by the settle engine.
let lastKnownCapabilities = [];
export function getAndroidRunnerCapabilities() {
    return lastKnownCapabilities;
}
export function _resetCapabilitiesForTest() {
    lastKnownCapabilities = [];
}
export async function probeAndroidRunnerHealthInfo(port, capabilityOverride) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
        const capability = capabilityOverride ?? (runnerState?.hostPort === port ? runnerState.capability : undefined);
        const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
            headers: capability ? { authorization: `Bearer ${capability}` } : {},
        });
        if (!resp.ok)
            return { reachable: false };
        const body = (await resp.json());
        const capabilities = Array.isArray(body.capabilities)
            ? body.capabilities.filter((c) => typeof c === 'string')
            : undefined;
        // Cache scope: a healthy reply refreshes; an unhealthy reply only clears
        // when it came from the LIVE runner's port — probing a stale/foreign port
        // must not erase capabilities learned from the live runner.
        if (body.ok === true) {
            lastKnownCapabilities = capabilities ?? [];
        }
        else if (runnerState?.hostPort === port) {
            lastKnownCapabilities = [];
        }
        const testIdentity = testAuthorityState && runnerState?.hostPort === port ? runnerState : null;
        return {
            reachable: true,
            ok: body.ok === true,
            ...(typeof body.protocolVersion === 'number'
                ? { protocolVersion: body.protocolVersion }
                : {}),
            ...(typeof body.runnerVersion === 'string' ? { runnerVersion: body.runnerVersion } : {}),
            ...(capabilities !== undefined ? { capabilities } : {}),
            ...(Array.isArray(body.commands)
                ? { commands: body.commands.filter((c) => typeof c === 'string') }
                : {}),
            ...(typeof body.instanceId === 'string'
                ? { instanceId: body.instanceId }
                : testIdentity?.instanceId
                    ? { instanceId: testIdentity.instanceId }
                    : {}),
            ...(typeof body.sessionId === 'string'
                ? { sessionId: body.sessionId }
                : testIdentity?.sessionId
                    ? { sessionId: testIdentity.sessionId }
                    : {}),
            ...(typeof body.claimEpoch === 'number'
                ? { claimEpoch: body.claimEpoch }
                : typeof testIdentity?.claimEpoch === 'number'
                    ? { claimEpoch: testIdentity.claimEpoch }
                    : {}),
            ...(typeof body.deviceId === 'string'
                ? { deviceId: body.deviceId }
                : testIdentity?.deviceId
                    ? { deviceId: testIdentity.deviceId }
                    : {}),
            ...(typeof body.appId === 'string'
                ? { appId: body.appId }
                : testIdentity?.bundleId
                    ? { appId: testIdentity.bundleId }
                    : {}),
        };
    }
    catch {
        if (runnerState?.hostPort === port)
            lastKnownCapabilities = [];
        return { reachable: false };
    }
    finally {
        clearTimeout(timer);
    }
}
// GH #383: set when a mismatched runner was transparently reaped; consumed by
// runNative so the triggering tool result carries meta.note. MUST be cleared
// on the mismatch-reject path too (review amendment) or a later successful
// call would attach a stale "runner upgraded" note.
let pendingUpgradeNote;
export function consumePendingAndroidUpgradeNote() {
    const note = pendingUpgradeNote;
    pendingUpgradeNote = undefined;
    return note;
}
// Review amendment (BLOCKER): a single `am force-stop` of the app package does
// NOT reliably free the device-side UiAutomation slot (#237 — system_server
// keeps it; see release-android-slot.ts:115-128). Reuse the battle-tested
// helper, which stops our runner then force-stops BOTH owned packages.
// Dynamic import because release-android-slot.ts statically imports this
// module — a static back-import would be a cycle.
async function reapMismatchedAndroidRunner(deviceId) {
    const { releaseAndroidInteractionSlot } = await import('./release-android-slot.js');
    await releaseAndroidInteractionSlot(deviceId ? { deviceId } : {});
}
function classifyAndroidHealth(info) {
    return classifyRunnerCompatibility({
        ...(info.protocolVersion !== undefined ? { protocolVersion: info.protocolVersion } : {}),
        ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
        ...(info.commands !== undefined ? { commands: info.commands } : {}),
    }, getPluginVersion(), REQUIRED_ANDROID_COMMANDS);
}
// GH #418: mid-flow refusal + retry-once signal. The message prefix is the
// wire contract — device-session.ts and agent-device-wrapper.ts map it to the
// RUNNER_COMMANDS_STALE ToolErrorCode by startsWith, mirroring
// RUNNER_PROTOCOL_MISMATCH.
export class AndroidCommandsStaleError extends Error {
    missing;
    constructor(missing, bundleId) {
        super(`RUNNER_COMMANDS_STALE: installed rn-android-runner lacks required commands ` +
            `(missing: ${missing.join(', ') || 'unknown'}). Re-open the device session ` +
            `(device_snapshot action=open appId=${bundleId ?? '<your.app.id>'} platform=android) to rebuild it.`);
        this.missing = missing;
    }
}
// GH #418: deleting the APKs is the artifact invalidation — apksExist flips
// false, so resolveAndroidInstallAction returns 'build-then-install' (Gradle).
// The invalidation and the install-action check share RUNNER_APK_PATHS so
// they cannot drift apart.
const RUNNER_APK_PATHS = [APK_APP, APK_TEST];
export function androidRunnerApksExist() {
    return RUNNER_APK_PATHS.every((p) => existsSync(p));
}
export function _androidRunnerApkPathsForTest() {
    return RUNNER_APK_PATHS;
}
export function invalidateAndroidRunnerApks(rm = (p) => rmSync(p, { force: true })) {
    for (const apk of RUNNER_APK_PATHS) {
        try {
            rm(apk);
        }
        catch {
            /* best-effort; the install action check re-reads existsSync */
        }
    }
}
// GH #418: retry-once wrapper for the fresh-open case — the attempt spawns the
// stale installed APK, the post-install verify throws the typed error, and (at
// open only) we invalidate the APKs so the retry Gradle-rebuilds from source.
export async function startAndroidRunner(deviceId, bundleId, devicePort = DEFAULT_PORT, opts = {}) {
    try {
        return await startAndroidRunnerAttempt(deviceId, bundleId, devicePort, opts);
    }
    catch (err) {
        if (opts.allowArtifactRebuild && err instanceof AndroidCommandsStaleError) {
            // Killing the local adb child does NOT free the device-side
            // UiAutomation slot (#237) — reap through the slot-release path so the
            // rebuilt instrumentation can bind.
            await reapMismatchedAndroidRunner(deviceId);
            invalidateAndroidRunnerApks();
            const state = await startAndroidRunnerAttempt(deviceId, bundleId, devicePort, {
                _forceReinstall: true,
                _forceLocalBuild: true,
            });
            pendingUpgradeNote = `runner artifact rebuilt (missing commands: ${err.missing.join(', ') || 'unknown'})`;
            return state;
        }
        throw err;
    }
}
async function startAndroidRunnerAttempt(deviceId, bundleId, devicePort = DEFAULT_PORT, opts = {}) {
    const serial = deviceId ??
        (testAuthorityState ? runnerState?.deviceId : undefined) ??
        (await resolveAndroidSerial());
    if (!serial) {
        throw new Error('DEVICE_AUTHORITY_MISMATCH: Android native runner requires an exact claimed device');
    }
    const authority = androidRunnerAuthority(serial, bundleId ?? '');
    adoptPersistedAndroidState(serial);
    let forceReinstall = opts._forceReinstall === true;
    if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, serial)) {
        const info = await probeAndroidRunnerHealthInfo(runnerState.hostPort);
        if (info.reachable && info.ok) {
            if (info.instanceId !== runnerState.instanceId ||
                info.sessionId !== runnerState.sessionId ||
                info.claimEpoch !== runnerState.claimEpoch ||
                info.deviceId !== runnerState.deviceId ||
                info.appId !== runnerState.bundleId) {
                await reapMismatchedAndroidRunner(deviceId);
                forceReinstall = true;
            }
            else {
                const compat = classifyAndroidHealth(info);
                if (compat.compatible)
                    return runnerState;
                if (compat.reason === 'missing-commands') {
                    // GH #418: reinstalling the SAME APK can't add commands — artifact
                    // staleness. Always throw the typed error: the retry-once wrapper is
                    // the SINGLE rebuild owner (one Gradle build even on a checkout whose
                    // fresh build still misses commands — multi-review advisory); mid-flow
                    // callers surface the typed refusal.
                    throw new AndroidCommandsStaleError(compat.missing ?? [], bundleId);
                }
                // GH #383: a reachable-but-incompatible runner is reaped (force-stop +
                // state clear) and force-reinstalled so the fresh APK supersedes it.
                pendingUpgradeNote = 'runner upgraded (protocol/version mismatch)';
                forceReinstall = true;
                await reapMismatchedAndroidRunner(deviceId);
            }
        }
        // unreachable/unhealthy: fall through — the fresh start below supersedes it.
    }
    // Self-install on first use (no external CLI) — resolve prebuilt (or build/install)
    // the in-tree runner APKs if the instrumentation isn't on the device yet.
    const provenance = await ensureAndroidRunnerInstalled(deviceId, {
        forceReinstall,
        forceLocalBuild: opts._forceLocalBuild === true,
    });
    let hostPort = await findFreePort(devicePort);
    try {
        await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
    }
    catch {
        // host port raced between probe and forward → re-probe once with any free port
        hostPort = await findFreePort(0);
        await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
    }
    return new Promise((resolve, reject) => {
        let resolved = false;
        const child = spawn('adb', [
            ...adbSerialArgs(deviceId),
            'shell',
            'am',
            'instrument',
            '-w',
            '-r',
            ...buildInstrumentPortArgs(devicePort),
            ...buildInstrumentVersionArgs(getPluginVersion()),
            ...buildInstrumentAuthorityArgs(authority),
            '-e',
            'class',
            MAIN_LOOP_CLASS,
            INSTRUMENTATION,
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        runnerProcess = child;
        // GH#243: drain + tail the instrument's own output so a cold-start failure stays
        // debuggable now that logcat is gone, and so an unconsumed stdio:'pipe' can't fill
        // its ~64KB buffer and wedge the child.
        let diag = '';
        const capture = (chunk) => {
            diag = (diag + chunk.toString('utf-8')).slice(-4_000);
        };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        const finishReady = () => {
            if (resolved)
                return;
            resolved = true;
            const state = {
                schemaVersion: 1,
                hostPort,
                devicePort,
                pid: child.pid,
                ...(serial ? { deviceId: serial } : {}),
                ...(bundleId ? { bundleId } : {}),
                startedAt: new Date().toISOString(),
                protocolVersion: RUNNER_PROTOCOL_VERSION,
                ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion() } : {}),
                provenance,
                ...authority,
            };
            const processBirth = readProcessBirth(child.pid);
            if (!processBirth) {
                child.kill('SIGTERM');
                reject(new Error('PROCESS_BIRTH_UNAVAILABLE: native runner process identity could not be proven'));
                return;
            }
            state.processBirth = processBirth.token;
            runnerState = state;
            if (serial) {
                try {
                    writeJsonStateFileAtomic(androidStatePath(serial), state);
                }
                catch {
                    /* non-fatal */
                }
            }
            cleanupLegacyTmpState();
            resolve(state);
        };
        child.on('error', (err) => {
            if (resolved)
                return;
            resolved = true;
            reject(new Error(`Failed to spawn Android runner instrumentation: ${err.message}`));
        });
        child.on('exit', (code) => {
            if (runnerProcess === child) {
                const exitState = runnerState;
                clearAndroidStateFile();
                if (typeof exitState?.hostPort === 'number') {
                    execFileAsync('adb', buildAdbForwardRemoveArgs(exitState.deviceId, exitState.hostPort)).catch(() => {
                        /* best-effort: must never throw from exit handler */
                    });
                }
            }
            if (!resolved) {
                resolved = true;
                reject(new Error(`Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`));
            }
        });
        // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
        // ring buffer. /health is true only once the ServerSocket is actually accepting.
        void waitForAndroidRunnerHealth(hostPort, { capability: authority.capability }).then(async (healthy) => {
            if (resolved)
                return;
            if (healthy) {
                const info = await probeAndroidRunnerHealthInfo(hostPort, authority.capability);
                const compat = classifyAndroidHealth(info);
                if (!compat.compatible) {
                    resolved = true;
                    pendingUpgradeNote = undefined; // review amendment: never report an upgrade that failed
                    child.kill('SIGTERM');
                    if (compat.reason === 'missing-commands') {
                        // GH #418: typed — the wrapper's retry-once invalidates the APKs
                        // at open; mid-flow callers surface RUNNER_COMMANDS_STALE.
                        reject(new AndroidCommandsStaleError(compat.missing ?? [], bundleId));
                        return;
                    }
                    reject(new Error(`RUNNER_PROTOCOL_MISMATCH: installed rn-android-runner speaks protocol ` +
                        `${info.protocolVersion ?? 'none'} (bridge expects ${RUNNER_PROTOCOL_VERSION}). ` +
                        `Rebuild + reinstall the runner APKs: cd ${RN_ANDROID_RUNNER_DIR} && ` +
                        `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest, then adb install -r both APKs.`));
                    return;
                }
                finishReady();
                return;
            }
            resolved = true;
            child.kill('SIGTERM');
            reject(new Error(`Android runner did not become ready within ${READY_TIMEOUT_MS / 1000}s (no /health on port ${hostPort})${diag ? `\n${diag.trim()}` : ''}`));
        });
    });
}
export async function stopAndroidRunner(deviceId) {
    // GH #383 (review amendment): adopt first so a post-respawn stop finds the
    // persisted runner (empty in-memory state would otherwise leak the forward).
    adoptPersistedAndroidState(deviceId ?? undefined);
    const stoppedState = runnerState;
    runnerProcess?.kill('SIGTERM');
    clearAndroidStateFile();
    if (typeof stoppedState?.hostPort === 'number') {
        const resolvedDeviceId = deviceId ?? stoppedState.deviceId;
        try {
            await execFileAsync('adb', buildAdbForwardRemoveArgs(resolvedDeviceId, stoppedState.hostPort));
        }
        catch {
            /* non-fatal */
        }
    }
}
// type/snapshot/screenshot run long; everything else is fast. Hoisted out of the
// old inline postCommand so the recovery wrapper reuses the exact same budget for
// both the original send and the resend (mirrors the iOS commandTimeoutMs helper).
function commandTimeoutMs(command) {
    return command === 'type' || command === 'snapshot' || command === 'screenshot' ? 35_000 : 10_000;
}
// One /command round-trip with no recovery. Bounds the request so a wedged
// UIAutomator instrument can't hang the tool indefinitely. The AbortError→
// RUNNER_TIMEOUT map, the non-JSON-body error (AMBIGUOUS — a reply arrived but
// was garbled, so the command may have executed), and the /command v-stamp check
// all live here so postCommandWithRecovery's catch wraps them.
async function sendCommandOnce(hostPort, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        const capability = runnerState?.hostPort === hostPort ? runnerState.capability : undefined;
        if (!capability) {
            throw new Error('RUNNER_OWNERSHIP_MISMATCH: runner capability is unavailable');
        }
        resp = await fetchImpl(`http://127.0.0.1:${hostPort}/command`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${capability}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    }
    catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`RUNNER_TIMEOUT: rn-android-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms`);
        }
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
    let parsed;
    try {
        parsed = (await resp.json());
    }
    catch {
        throw new Error('rn-android-runner returned a non-JSON response body');
    }
    // GH #383: mirror the iOS /command v-stamp check — a runner hot-swapped to an
    // incompatible wire protocol mid-session is caught here (the reuse gate only
    // runs at start). runAndroid's catch maps this BEFORE isAndroidConnectionFailure.
    if (typeof parsed.v === 'number' &&
        (parsed.v < MIN_SUPPORTED_RUNNER_PROTOCOL || parsed.v > RUNNER_PROTOCOL_VERSION)) {
        throw new Error(`RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge supports v${MIN_SUPPORTED_RUNNER_PROTOCOL}..${RUNNER_PROTOCOL_VERSION}`);
    }
    return parsed;
}
const STATUS_PROBE_TIMEOUT_MS = 2000;
async function probeCommandStatus(hostPort, commandId) {
    try {
        const resp = await sendCommandOnce(hostPort, { command: 'status', commandId }, STATUS_PROBE_TIMEOUT_MS);
        return parseStatusProbeReply(resp, commandId);
    }
    catch {
        return null;
    }
}
// Story 14 (#407): a response lost after send is ambiguous — "never executed"
// vs "executed, response lost". One short status probe against the runner's
// outcome journal resolves it; mutating verbs are NEVER resent, and an
// unresolvable probe falls through to the existing invalidation path (the error
// rethrows and runAndroid's catch maps it to RN_ANDROID_RUNNER_DOWN). Recovery
// info travels in the return value so callers that don't surface meta (the
// settle probes) discard it with the response.
async function postCommandWithRecovery(body) {
    const state = runnerState;
    if (!state)
        throw new Error('rn-android-runner not started');
    const commandId = generateCommandId();
    const timeoutMs = commandTimeoutMs(body.command);
    try {
        return { resp: await sendCommandOnce(state.hostPort, { ...body, commandId }, timeoutMs) };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isAmbiguousTransportFailure(message))
            throw err;
        const decision = decideRecovery(await probeCommandStatus(state.hostPort, commandId), body.command);
        if (decision.action === 'return-recovered') {
            return {
                resp: decision.response,
                recovery: { commandId, outcome: decision.outcome },
            };
        }
        if (decision.action === 'resend-once') {
            const resent = await sendCommandOnce(state.hostPort, { ...body, commandId: generateCommandId() }, timeoutMs);
            return { resp: resent, recovery: { commandId, outcome: 'resent' } };
        }
        throw err;
    }
}
async function postCommand(body) {
    return (await postCommandWithRecovery(body)).resp;
}
export function getAndroidRunnerHostPort() {
    return runnerState?.hostPort ?? null;
}
// Story 04 (#385): thin settle probes. They deliberately skip startAndroidRunner's
// ensure path (runAndroid runs it on EVERY dispatch — a 10-poll snapshot-eq tier
// must not pay 10 ensure round-trips) and pin the forwarded host port captured
// right after the mutating dispatch. If the live runner state has since changed
// (device switch, restart), the probe degrades to null instead of posting to the
// wrong port — the endpoint assumption is CHECKED, not hidden.
export async function androidIsWindowUpdatingProbe(timeoutMs, bundleId, pinnedHostPort) {
    if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort)
        return null;
    try {
        const body = { command: 'isWindowUpdating', timeoutMs };
        if (bundleId)
            body.appBundleId = bundleId;
        const resp = await postCommand(body);
        const updating = resp.data?.updating;
        return resp.ok && typeof updating === 'boolean' ? updating : null;
    }
    catch {
        return null;
    }
}
export async function androidSnapshotNodesViaProbe(bundleId, pinnedHostPort) {
    if (pinnedHostPort !== undefined && runnerState?.hostPort !== pinnedHostPort)
        return null;
    try {
        const body = { command: 'snapshot', interactiveOnly: true };
        if (bundleId)
            body.appBundleId = bundleId;
        const resp = await postCommand(body);
        if (!resp.ok || !resp.data || typeof resp.data !== 'object')
            return null;
        const data = resp.data;
        if (!Array.isArray(data.nodes))
            return null;
        const flat = mapRunnerNodesToFlat(data.nodes);
        updateRefMapFromFlat(flat);
        return flat;
    }
    catch {
        return null;
    }
}
function mapRunnerNodesToFlat(nodes) {
    const out = [];
    let synthCounter = 0;
    for (const n of nodes) {
        if (!n.rect)
            continue;
        const ref = `@e${n.index ?? synthCounter++}`;
        const flat = { ref, type: n.type ?? '', rect: n.rect };
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
export function shouldRecoverAndroidAccessibility(command, response) {
    return (command === 'snapshot' && !response.ok && response.error?.code === 'ACCESSIBILITY_UNAVAILABLE');
}
export async function runAndroid(args) {
    if (args._staleRef) {
        return failResult(`Element at ref ${args._staleRef} no longer hittable - UI re-rendered since snapshot`, 'STALE_REF', {
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
    if (args.x1 !== undefined)
        body.x1 = args.x1;
    if (args.y1 !== undefined)
        body.y1 = args.y1;
    if (args.x2 !== undefined)
        body.x2 = args.x2;
    if (args.y2 !== undefined)
        body.y2 = args.y2;
    if (args.text !== undefined)
        body.text = args.text;
    if (args.exact !== undefined)
        body.exact = args.exact;
    if (args.durationMs !== undefined)
        body.durationMs = args.durationMs;
    if (args.timeoutMs !== undefined)
        body.timeoutMs = args.timeoutMs;
    if (args.scale !== undefined)
        body.scale = args.scale;
    if (args.interactiveOnly !== undefined)
        body.interactiveOnly = args.interactiveOnly;
    let resp;
    let recovery;
    try {
        await startAndroidRunner(args.deviceId, args.bundleId);
        ({ resp, recovery } = await postCommandWithRecovery(withKeyboardGuard(body, args.command, process.env)));
    }
    catch (err) {
        const m = errMessage(err);
        // GH #383: a protocol mismatch (reuse-gate reject, post-start verify, or the
        // /command v-stamp) is a distinct, actionable failure — surface it before the
        // generic connection-failure mapping so it is never mislabeled RN_ANDROID_RUNNER_DOWN.
        if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
            return failResult(m, 'RUNNER_PROTOCOL_MISMATCH', {
                hint: 'The installed runner APK predates this plugin version. Rebuild + reinstall (command in the error), then retry.',
            });
        }
        // GH#243: a connection failure (runner just restarted after a flow, or can't bind
        // its port) must surface as a structured, retryable error — never a bare
        // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a connection
        // failure and is rethrown unchanged.
        if (isAndroidConnectionFailure(m)) {
            return failResult(`rn-android-runner is not reachable: ${m}`, 'RN_ANDROID_RUNNER_DOWN', {
                hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.',
            });
        }
        throw err;
    }
    // A foreground app can survive an inline stop/relaunch while UiAutomation's
    // accessibility connection does not. One instrumentation restart is the
    // smallest recovery: it preserves app state, rebinds accessibility, and
    // retries the read exactly once. A second failure remains explicit.
    let accessibilityRecovery;
    if (shouldRecoverAndroidAccessibility(args.command, resp)) {
        await stopAndroidRunner(args.deviceId);
        await startAndroidRunner(args.deviceId, args.bundleId);
        ({ resp, recovery } = await postCommandWithRecovery(withKeyboardGuard(body, args.command, process.env)));
        if (resp.ok)
            accessibilityRecovery = 'runner-restarted';
    }
    // Story 14 (#407): recovery happened INSIDE postCommandWithRecovery (before the
    // catch above), so an unrecovered ambiguous failure still maps to
    // RN_ANDROID_RUNNER_DOWN — only a resolved recovery reaches here, folded into
    // every result the tool builds.
    const recoveryMeta = {
        ...(recovery ? { transportRecovery: recovery } : {}),
        ...(accessibilityRecovery ? { accessibilityRecovery } : {}),
    };
    if (!resp.ok) {
        const message = resp.error?.message ?? 'Android runner returned !ok with no error';
        const code = resp.error?.code;
        // Mirror the iOS `.type` runner-timeout shim (rn-fast-runner-client.ts:553-562).
        // UIAutomator's `typeText` waits for window-content idle internally even with
        // `Configurator.setWaitForIdleTimeout(0)`. RN apps with Reanimated/RAF active
        // never report idle, so the call resolves with an `InvocationTargetException`
        // wrapping "Could not detect idle state" AFTER the text has already been
        // appended to the field. Live trials (Task 10) confirm the side-effect
        // always succeeds. Treat this specific error shape as success on `.type`
        // and surface a meta marker so callers can audit telemetry.
        if (args.command === 'type' &&
            typeof message === 'string' &&
            (message.includes('Could not detect idle state') ||
                message.includes('window-content-idle') ||
                message.includes('Idle timeout exceeded'))) {
            return okResult({ typed: true, text: args.text }, { meta: { sideEffectSucceeded: true, runnerTimeoutShim: true, ...recoveryMeta } });
        }
        const failExtras = recovery ? { transportRecovery: recovery } : undefined;
        if (code)
            return failResult(message, code, failExtras);
        return failExtras ? failResult(message, failExtras) : failResult(message);
    }
    if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
        const data = resp.data;
        if (Array.isArray(data.nodes)) {
            const flat = mapRunnerNodesToFlat(data.nodes);
            const outcome = updateRefMapFromFlat(flat);
            // GH #409: same capture-quality contract as the iOS client — empty
            // captures report degraded and never clobber last-known-good refs.
            const snapshotVerdict = buildSnapshotVerdict('rn-android-runner', flat.length, outcome);
            return okResult({ nodes: flat }, { meta: { snapshotVerdict, ...recoveryMeta } });
        }
    }
    if (args.command === 'screenshot') {
        const data = resp.data;
        if (!data?.pngBase64)
            return failResult('Android runner screenshot response did not include pngBase64', 'SCREENSHOT_FAILED', recovery ? { transportRecovery: recovery } : undefined);
        const outPath = args.outPath ?? join(tmpdir(), `rn-android-screenshot-${Date.now()}.png`);
        writeFileSync(outPath, Buffer.from(data.pngBase64, 'base64'));
        return okResult({ path: outPath }, Object.keys(recoveryMeta).length ? { meta: recoveryMeta } : undefined);
    }
    return okResult(resp.data ?? {}, Object.keys(recoveryMeta).length ? { meta: recoveryMeta } : undefined);
}
function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export function isAndroidConnectionFailure(message) {
    return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|rn-android-runner not started|did not become ready|Android runner instrumentation exited before readiness|Failed to spawn Android runner instrumentation/i.test(message);
}
