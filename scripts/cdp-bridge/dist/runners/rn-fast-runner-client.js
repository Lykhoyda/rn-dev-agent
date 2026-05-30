import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, getCachedMetadata } from '../fast-runner-ref-map.js';
const DEFAULT_PORT = 22088;
const READY_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const STATE_FILE = '/tmp/rn-fast-runner-state.json';
const FAST_RUNNER_PROJECT = join(import.meta.dirname, '..', '..', '..', 'rn-fast-runner');
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
export async function fastSwipe(x1, y1, x2, y2, durationMs) {
    const body = { command: 'drag', x: x1, y: y1, x2, y2 };
    if (durationMs != null)
        body.durationMs = durationMs;
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
async function postCommand(body) {
    const state = runnerState;
    if (!state) {
        throw new Error('rn-fast-runner not started — open a device session first');
    }
    const controller = new AbortController();
    const timeoutMs = commandTimeoutMs(body.command);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetchImpl(`http://127.0.0.1:${state.port}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        return resp.json();
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
    const resp = await postCommand(body);
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
            return okResult({ typed: true, text: args.text }, { meta: { sideEffectSucceeded: true, runnerTimeoutShim: true } });
        }
        if (code) {
            return failResult(message, code);
        }
        return failResult(message);
    }
    // Snapshot post-processing: feed the ref map so future press/fill calls
    // can resolve @refs without a separate fetch.
    if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
        const data = resp.data;
        if (Array.isArray(data.nodes)) {
            const flat = mapRunnerNodesToFlat(data.nodes);
            updateRefMapFromFlat(flat);
            return okResult({ nodes: flat });
        }
        // Defensive fallback: the test seam mocks `{ tree: ... }`. Don't crash.
        return okResult(resp.data);
    }
    return okResult(resp.data ?? {});
}
