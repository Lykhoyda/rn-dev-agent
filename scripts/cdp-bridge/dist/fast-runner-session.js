import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
const DEFAULT_PORT = 22088;
const READY_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const STATE_FILE = '/tmp/rn-fast-runner-state.json';
const FAST_RUNNER_PROJECT = join(import.meta.dirname, '..', '..', 'rn-fast-runner');
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
                    return { ready: true, port: Number(portMatch[1]) };
                }
            }
            return null;
        },
    };
}
// --- Singleton state ---
let runnerProcess = null;
let runnerState = null;
try {
    if (existsSync(STATE_FILE)) {
        const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
        try {
            process.kill(raw.pid, 0);
            runnerState = raw;
        }
        catch {
            unlinkSync(STATE_FILE);
        }
    }
}
catch { /* start fresh */ }
export function getFastRunnerState() {
    return runnerState;
}
/**
 * Test-only seam: inject a fake runner state so callers (e.g. rn-fast-runner-client)
 * can be unit-tested without spawning xcodebuild. Production code must never call this.
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
    catch { /* process dead */ }
    runnerState = null;
    try {
        unlinkSync(STATE_FILE);
    }
    catch { /* ignore */ }
    return false;
}
// --- Lifecycle ---
export function startFastRunner(deviceId, bundleId, port = DEFAULT_PORT) {
    if (runnerState)
        return Promise.resolve(runnerState);
    return new Promise((resolve, reject) => {
        const projectPath = join(FAST_RUNNER_PROJECT, 'RnFastRunner', 'RnFastRunner.xcodeproj');
        if (!existsSync(projectPath)) {
            reject(new Error(`RnFastRunner.xcodeproj not found at ${projectPath}.`));
            return;
        }
        const derivedDataPath = join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
        const args = [
            'test-without-building',
            '-project', projectPath,
            '-scheme', 'RnFastRunner',
            '-destination', `platform=iOS Simulator,id=${deviceId}`,
            '-derivedDataPath', derivedDataPath,
            '-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand',
        ];
        const child = spawn('xcodebuild', args, {
            env: {
                ...process.env,
                RN_FAST_RUNNER_PORT: String(port),
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
                port: result.port,
                pid: child.pid,
                deviceId,
                bundleId,
                startedAt: new Date().toISOString(),
            };
            runnerState = state;
            try {
                writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
            }
            catch { /* ignore */ }
            resolve(state);
        };
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', handleChunk);
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', () => { });
        child.on('error', (err) => {
            clearTimeout(timer);
            if (runnerProcess === child) {
                runnerProcess = null;
                runnerState = null;
            }
            reject(new Error(`Failed to spawn xcodebuild: ${err.message}`));
        });
        child.on('exit', (code) => {
            if (runnerProcess === child) {
                runnerProcess = null;
                runnerState = null;
                try {
                    unlinkSync(STATE_FILE);
                }
                catch { /* ignore */ }
            }
            clearTimeout(timer);
            reject(new Error(`xcodebuild exited unexpectedly (code ${code})`));
        });
    });
}
export function stopFastRunner() {
    if (runnerProcess) {
        runnerProcess.kill('SIGTERM');
        runnerProcess = null;
    }
    else if (runnerState?.pid) {
        try {
            process.kill(runnerState.pid, 'SIGTERM');
        }
        catch { /* already dead */ }
    }
    runnerState = null;
    try {
        unlinkSync(STATE_FILE);
    }
    catch { /* ignore */ }
}
// --- HTTP client ---
async function postJSON(path, body) {
    if (!runnerState)
        throw new Error('Fast runner not started');
    const url = `http://[::1]:${runnerState.port}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return await res.json();
    }
    finally {
        clearTimeout(timer);
    }
}
async function postBinary(path) {
    if (!runnerState)
        throw new Error('Fast runner not started');
    const url = `http://[::1]:${runnerState.port}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
        const res = await fetch(url, { method: 'POST', signal: controller.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
    }
    finally {
        clearTimeout(timer);
    }
}
export async function fastTap(x, y, duration) {
    return postJSON('/tap', { x, y, ...(duration != null ? { duration } : {}) });
}
export async function fastType(text) {
    return postJSON('/type', { text });
}
export async function fastSwipe(x1, y1, x2, y2, durationMs) {
    return postJSON('/swipe', { x1, y1, x2, y2, ...(durationMs != null ? { durationMs } : {}) });
}
export async function fastSnapshot(bundleId) {
    return postJSON('/snapshot', bundleId ? { bundleId } : {});
}
export async function fastScreenshot() {
    return postBinary('/screenshot');
}
export async function fastDismissKeyboard() {
    return postJSON('/dismissKeyboard');
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
    const url = `http://[::1]:${port}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok)
            return { ok: false, status: res.status };
        let bodyOk;
        try {
            const body = await res.json();
            bodyOk = body.ok === true;
        }
        catch {
            bodyOk = false;
        }
        return { ok: true, status: res.status, bodyOk };
    }
    finally {
        clearTimeout(timer);
    }
}
function clearStateFile() {
    runnerState = null;
    // M7 review (Gemini): null the child-process handle too. Previously a reap
    // left `runnerProcess` pointing at a dead PID; the on('exit') handler would
    // eventually self-heal, but during the window a concurrent stopFastRunner
    // could signal an already-dead process. Clearing here is defensive.
    runnerProcess = null;
    try {
        unlinkSync(STATE_FILE);
    }
    catch { /* already gone */ }
}
export async function probeFastRunnerLiveness(deps = {}) {
    const getState = deps.getState ?? (() => runnerState);
    const processAlive = deps.processAlive ?? defaultProcessAlive;
    const httpProbe = deps.httpProbe ?? defaultHttpProbe;
    const clearState = deps.clearState ?? clearStateFile;
    const timeoutMs = deps.timeoutMs ?? 2000;
    const state = getState();
    if (!state)
        return 'dead';
    if (!processAlive(state.pid)) {
        clearState();
        return 'dead';
    }
    try {
        const res = await httpProbe(state.port, timeoutMs);
        if (res.ok && res.status === 200 && res.bodyOk === true)
            return 'alive';
        return 'stale';
    }
    catch {
        return 'stale';
    }
}
export async function reapStaleFastRunner(deps = {}) {
    const getState = deps.getState ?? (() => runnerState);
    const processAlive = deps.processAlive ?? defaultProcessAlive;
    const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
    const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
    const clearState = deps.clearState ?? clearStateFile;
    const graceMs = deps.graceMs ?? 500;
    const state = getState();
    if (!state)
        return;
    try {
        sendSignal(state.pid, 'SIGTERM');
    }
    catch { /* already dead */ }
    await sleep(graceMs);
    if (processAlive(state.pid)) {
        try {
            sendSignal(state.pid, 'SIGKILL');
        }
        catch { /* race: died between checks */ }
    }
    clearState();
}
