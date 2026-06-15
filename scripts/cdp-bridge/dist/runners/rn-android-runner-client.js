/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, getCachedMetadata } from '../fast-runner-ref-map.js';
import { findFreePort } from './free-port.js';
const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 22089;
const READY_TIMEOUT_MS = 30_000;
const STATE_FILE = '/tmp/rn-android-runner-state.json';
const INSTRUMENTATION = 'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';
const MAIN_LOOP_CLASS = 'dev.lykhoyda.rndevagent.androidrunner.RnAndroidRunnerInstrumentedTest#mainLoop';
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
let runnerProcess = null;
let runnerState = null;
let fetchImpl = globalThis.fetch;
try {
    if (existsSync(STATE_FILE)) {
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        if (typeof raw.hostPort !== 'number' || typeof raw.devicePort !== 'number') {
            unlinkSync(STATE_FILE); // pre-split state shape → ignore + clear
        }
        else {
            try {
                process.kill(raw.pid, 0);
                runnerState = raw;
            }
            catch {
                unlinkSync(STATE_FILE);
            }
        }
    }
}
catch {
    runnerState = null;
}
export function _setFetchForTest(fn) {
    fetchImpl = fn;
}
export function _setAndroidRunnerStateForTest(state) {
    runnerState = state;
}
export function parseAdbDevicesSerials(stdout) {
    return stdout.split('\n').slice(1)
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
export function isAndroidRunnerAvailable() {
    if (!runnerState)
        return false;
    try {
        process.kill(runnerState.pid, 0);
        return true;
    }
    catch {
        runnerState = null;
        try {
            unlinkSync(STATE_FILE);
        }
        catch { /* already removed */ }
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
    if (!deviceId)
        return true;
    return state.deviceId === deviceId;
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
            const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
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
export async function startAndroidRunner(deviceId, bundleId, devicePort = DEFAULT_PORT) {
    if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId))
        return runnerState;
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
        const capture = (chunk) => { diag = (diag + chunk.toString('utf-8')).slice(-4_000); };
        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        const finishReady = () => {
            if (resolved)
                return;
            resolved = true;
            const state = {
                hostPort,
                devicePort,
                pid: child.pid,
                ...(deviceId ? { deviceId } : {}),
                ...(bundleId ? { bundleId } : {}),
                startedAt: new Date().toISOString(),
            };
            runnerState = state;
            try {
                writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
            }
            catch { /* non-fatal */ }
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
                runnerProcess = null;
                runnerState = null;
                try {
                    unlinkSync(STATE_FILE);
                }
                catch { /* already removed */ }
                if (typeof exitState?.hostPort === 'number') {
                    execFileAsync('adb', buildAdbForwardRemoveArgs(exitState.deviceId, exitState.hostPort))
                        .catch(() => { });
                }
            }
            if (!resolved) {
                resolved = true;
                reject(new Error(`Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`));
            }
        });
        // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
        // ring buffer. /health is true only once the ServerSocket is actually accepting.
        void waitForAndroidRunnerHealth(hostPort).then((healthy) => {
            if (resolved)
                return;
            if (healthy) {
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
    const stoppedState = runnerState;
    runnerProcess?.kill('SIGTERM');
    runnerProcess = null;
    runnerState = null;
    try {
        unlinkSync(STATE_FILE);
    }
    catch { /* already removed */ }
    if (typeof stoppedState?.hostPort === 'number') {
        const resolvedDeviceId = deviceId ?? stoppedState.deviceId;
        try {
            await execFileAsync('adb', buildAdbForwardRemoveArgs(resolvedDeviceId, stoppedState.hostPort));
        }
        catch { /* non-fatal */ }
    }
}
async function postCommand(body) {
    const state = runnerState;
    if (!state)
        throw new Error('rn-android-runner not started');
    // Bound every command so a wedged UIAutomator instrument can't hang the tool
    // indefinitely. type/snapshot/screenshot run long; everything else is fast.
    const slow = body.command === 'type' || body.command === 'snapshot' || body.command === 'screenshot';
    const timeoutMs = slow ? 35_000 : 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
        resp = await fetchImpl(`http://127.0.0.1:${state.hostPort}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
    try {
        return await resp.json();
    }
    catch {
        throw new Error('rn-android-runner returned a non-JSON response body');
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
export async function runAndroid(args) {
    if (args._staleRef) {
        return failResult(`Element at ref ${args._staleRef} no longer hittable - UI re-rendered since snapshot`, 'STALE_REF', {
            cachedMetadata: getCachedMetadata(args._staleRef),
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
    if (args.scale !== undefined)
        body.scale = args.scale;
    if (args.interactiveOnly !== undefined)
        body.interactiveOnly = args.interactiveOnly;
    let resp;
    try {
        await startAndroidRunner(args.deviceId, args.bundleId);
        resp = await postCommand(body);
    }
    catch (err) {
        const m = errMessage(err);
        // GH#243: a connection failure (runner just restarted after a flow, or can't bind
        // its port) must surface as a structured, retryable error — never a bare
        // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a connection
        // failure and is rethrown unchanged.
        if (isAndroidConnectionFailure(m)) {
            return failResult(`rn-android-runner is not reachable: ${m}`, 'RN_ANDROID_RUNNER_DOWN', { hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.' });
        }
        throw err;
    }
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
            return okResult({ typed: true, text: args.text }, { meta: { sideEffectSucceeded: true, runnerTimeoutShim: true } });
        }
        return code ? failResult(message, code) : failResult(message);
    }
    if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
        const data = resp.data;
        if (Array.isArray(data.nodes)) {
            const flat = mapRunnerNodesToFlat(data.nodes);
            updateRefMapFromFlat(flat);
            return okResult({ nodes: flat });
        }
    }
    if (args.command === 'screenshot') {
        const data = resp.data;
        if (!data?.pngBase64)
            return failResult('Android runner screenshot response did not include pngBase64', 'SCREENSHOT_FAILED');
        const outPath = args.outPath ?? `/tmp/rn-android-screenshot-${Date.now()}.png`;
        writeFileSync(outPath, Buffer.from(data.pngBase64, 'base64'));
        return okResult({ path: outPath });
    }
    return okResult(resp.data ?? {});
}
function errMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
export function isAndroidConnectionFailure(message) {
    return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|rn-android-runner not started|did not become ready|Android runner instrumentation exited before readiness|Failed to spawn Android runner instrumentation/i.test(message);
}
