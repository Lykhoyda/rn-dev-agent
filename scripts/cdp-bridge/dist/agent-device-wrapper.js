import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { okResult, failResult } from './utils.js';
import { isFastRunnerAvailable, getFastRunnerState, fastTap, fastType, fastSwipe, fastSnapshot, fastScreenshot, fastDismissKeyboard, startFastRunner, } from './fast-runner-session.js';
import { updateRefMap, refCenter, getScreenRect, hasRefMap, clearRefMap } from './fast-runner-ref-map.js';
const execFile = promisify(execFileCb);
const SESSION_FILE = '/tmp/rn-dev-agent-session.json';
const EXEC_TIMEOUT = 30_000;
const DAEMON_TIMEOUT = 30_000;
let cachedDaemonInfo = null;
function loadDaemonInfo() {
    if (cachedDaemonInfo)
        return cachedDaemonInfo;
    const daemonPath = join(homedir(), '.agent-device', 'daemon.json');
    try {
        if (!existsSync(daemonPath))
            return null;
        const raw = JSON.parse(readFileSync(daemonPath, 'utf-8'));
        if (!raw.port || !raw.token)
            return null;
        cachedDaemonInfo = { port: raw.port, token: raw.token };
        return cachedDaemonInfo;
    }
    catch {
        return null;
    }
}
function extractFlags(args) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--') && arg.length > 2) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags[key] = next;
                i++;
            }
            else {
                flags[key] = true;
            }
        }
        else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}
function sendToDaemon(command, rawArgs, session, timeoutMs = DAEMON_TIMEOUT) {
    const info = loadDaemonInfo();
    if (!info)
        return Promise.reject(new Error('daemon not available'));
    const { positionals, flags } = extractFlags(rawArgs);
    const req = {
        token: info.token,
        session,
        command,
        positionals,
        flags,
    };
    return new Promise((resolve, reject) => {
        const sock = createConnection({ host: '127.0.0.1', port: info.port }, () => {
            sock.write(JSON.stringify(req) + '\n');
        });
        let data = '';
        sock.setEncoding('utf8');
        const timer = setTimeout(() => { sock.destroy(); reject(new Error('daemon timeout')); }, timeoutMs);
        sock.on('data', (chunk) => {
            data += chunk;
            const nl = data.indexOf('\n');
            if (nl !== -1) {
                clearTimeout(timer);
                sock.end();
                try {
                    resolve(JSON.parse(data.slice(0, nl).trim()));
                }
                catch {
                    reject(new Error('invalid daemon response'));
                }
            }
        });
        sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
}
async function runViaDaemon(command, positionals, session) {
    try {
        const resp = await sendToDaemon(command, positionals, session);
        if (resp.ok) {
            return okResult(resp.data ?? {});
        }
        const e = resp.error;
        return failResult(e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
    }
    catch (err) {
        return failResult(`Daemon error: ${err instanceof Error ? err.message : String(err)}`);
    }
}
let activeSession = null;
try {
    const raw = readFileSync(SESSION_FILE, 'utf8');
    activeSession = JSON.parse(raw);
}
catch {
    // No persisted session or invalid JSON — start fresh
}
export function getActiveSession() {
    return activeSession;
}
export function setActiveSession(info) {
    activeSession = info;
    try {
        writeFileSync(SESSION_FILE, JSON.stringify(info), 'utf8');
    }
    catch { /* ignore */ }
}
export function clearActiveSession() {
    activeSession = null;
    clearRefMap();
    try {
        unlinkSync(SESSION_FILE);
    }
    catch { /* ignore */ }
}
export function hasActiveSession() {
    return activeSession !== null;
}
// --- Fast-runner dispatch (highest-priority tier for iOS) ---
const SWIPE_DURATION_MS = 300;
const SCROLL_FRACTION = 0.4;
const FOCUS_DELAY_MS = 100;
function computeSwipeCoords(direction, screen) {
    const cx = Math.round(screen.width / 2);
    const cy = Math.round(screen.height / 2);
    const dy = Math.round(screen.height * SCROLL_FRACTION);
    const dx = Math.round(screen.width * SCROLL_FRACTION);
    switch (direction) {
        case 'down': return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy };
        case 'up': return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy };
        case 'left': return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy };
        case 'right': return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy };
        default: return null;
    }
}
async function tryFastRunner(command, positionals) {
    if (!isFastRunnerAvailable())
        return null;
    const state = getFastRunnerState();
    try {
        switch (command) {
            case 'screenshot': {
                const pngBuffer = await fastScreenshot();
                const tmpPath = `/tmp/rn-fast-screenshot-${Date.now()}.png`;
                writeFileSync(tmpPath, pngBuffer);
                return okResult({ path: tmpPath, method: 'fast-runner' });
            }
            case 'snapshot': {
                const resp = await fastSnapshot(state.bundleId);
                if (!resp.ok)
                    return null;
                return okResult({ ...resp, method: 'fast-runner' });
            }
            case 'keyboard': {
                if (positionals[0] === 'dismiss') {
                    const resp = await fastDismissKeyboard();
                    if (!resp.ok)
                        return null;
                    return okResult({ ...resp, method: 'fast-runner' });
                }
                return null;
            }
            case 'press': {
                if (!hasRefMap())
                    return null;
                const ref = positionals[0];
                if (!ref)
                    return null;
                const center = refCenter(ref);
                if (!center)
                    return null;
                const holdMs = positionals.includes('--hold-ms')
                    ? Number(positionals[positionals.indexOf('--hold-ms') + 1]) / 1000
                    : undefined;
                const resp = await fastTap(center.x, center.y, holdMs);
                if (!resp.ok)
                    return null;
                return okResult({ ...resp, ref, method: 'fast-runner' });
            }
            case 'fill': {
                if (!hasRefMap())
                    return null;
                const ref = positionals[0];
                const text = positionals[1];
                if (!ref || !text)
                    return null;
                const center = refCenter(ref);
                if (!center)
                    return null;
                const tapResp = await fastTap(center.x, center.y);
                if (!tapResp.ok)
                    return null;
                await new Promise(r => setTimeout(r, FOCUS_DELAY_MS));
                const typeResp = await fastType(text);
                if (!typeResp.ok)
                    return null;
                return okResult({ filled: true, ref, length: text.length, method: 'fast-runner' });
            }
            case 'scroll': {
                const screen = getScreenRect();
                if (!screen)
                    return null;
                const direction = positionals[0];
                if (!direction)
                    return null;
                const coords = computeSwipeCoords(direction, screen);
                if (!coords)
                    return null;
                const resp = await fastSwipe(coords.x1, coords.y1, coords.x2, coords.y2, SWIPE_DURATION_MS);
                if (!resp.ok)
                    return null;
                return okResult({ direction, method: 'fast-runner' });
            }
            case 'swipe': {
                const [x1, y1, x2, y2, durationStr] = positionals;
                if (x1 == null || y1 == null || x2 == null || y2 == null)
                    return null;
                const duration = durationStr ? Number(durationStr) : SWIPE_DURATION_MS;
                const resp = await fastSwipe(Number(x1), Number(y1), Number(x2), Number(y2), duration);
                if (!resp.ok)
                    return null;
                return okResult({ method: 'fast-runner' });
            }
            case 'longpress': {
                const [xStr, yStr, durationStr] = positionals;
                if (xStr == null || yStr == null)
                    return null;
                const duration = durationStr ? Number(durationStr) / 1000 : 1.0;
                const resp = await fastTap(Number(xStr), Number(yStr), duration);
                if (!resp.ok)
                    return null;
                return okResult({ method: 'fast-runner' });
            }
            default:
                return null;
        }
    }
    catch {
        return null;
    }
}
export async function ensureFastRunner(deviceId, bundleId) {
    if (isFastRunnerAvailable())
        return;
    try {
        await startFastRunner(deviceId, bundleId);
    }
    catch (err) {
        console.error(`Fast runner auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function cacheRefMapFromResult(result) {
    try {
        const envelope = JSON.parse(result.content[0].text);
        if (envelope.ok && envelope.data?.nodes && Array.isArray(envelope.data.nodes)) {
            updateRefMap(envelope.data.nodes);
        }
    }
    catch { /* not a snapshot response — ignore */ }
}
export async function runAgentDevice(cliArgs, opts = {}) {
    const sessionName = (!opts.skipSession && activeSession) ? activeSession.name : '';
    const isSnapshotCmd = cliArgs[0] === 'snapshot';
    // Fastest path: XCTest fast-runner HTTP (iOS only, ~5-30ms/op)
    // Note: fast-runner snapshots return { tree: ... } (nested XCUIElement dict), not { nodes: [...] }
    // (flat array with @refs). The ref map can only be populated from daemon/CLI snapshots.
    // So we skip fast-runner for snapshot commands when ref map is empty — force daemon/CLI to populate it.
    if (sessionName && activeSession?.platform === 'ios') {
        if (isSnapshotCmd && !hasRefMap()) {
            // Fall through to daemon/CLI to get a nodes-format snapshot that populates the ref map
        }
        else {
            const fastResult = await tryFastRunner(cliArgs[0], cliArgs.slice(1));
            if (fastResult)
                return fastResult;
        }
    }
    // Fast path: direct daemon socket (eliminates ~300ms CLI spawn)
    if (sessionName && loadDaemonInfo()) {
        const command = cliArgs[0];
        const positionals = cliArgs.slice(1);
        try {
            const daemonResult = await runViaDaemon(command, positionals, sessionName);
            if (isSnapshotCmd && !daemonResult.isError)
                cacheRefMapFromResult(daemonResult);
            return daemonResult;
        }
        catch {
            // Daemon unavailable — fall through to CLI
        }
    }
    const args = [...cliArgs, '--json'];
    if (sessionName) {
        args.push('--session', sessionName);
    }
    try {
        const { stdout } = await execFile('agent-device', args, {
            timeout: EXEC_TIMEOUT,
            encoding: 'utf8',
        });
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        }
        catch {
            return failResult(`agent-device returned non-JSON: ${stdout.slice(0, 300)}`);
        }
        if (!parsed.success) {
            const e = parsed.error;
            return failResult(e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
        }
        const cliResult = okResult(parsed.data ?? {});
        if (isSnapshotCmd)
            cacheRefMapFromResult(cliResult);
        return cliResult;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ENOENT') || msg.includes('not found')) {
            return failResult('agent-device CLI not found. Install with: npm install -g agent-device');
        }
        // Detect timeout (SIGTERM from execFile timeout)
        if (typeof err === 'object' && err !== null && 'killed' in err && err.killed) {
            return failResult(`agent-device timed out after ${EXEC_TIMEOUT / 1000}s`);
        }
        // Try to parse JSON from stdout on non-zero exit
        if (typeof err === 'object' && err !== null && 'stdout' in err) {
            const stdout = err.stdout;
            if (stdout) {
                try {
                    const parsed = JSON.parse(stdout);
                    if (parsed.success) {
                        return okResult(parsed.data ?? {});
                    }
                    const e = parsed.error;
                    return failResult(e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
                }
                catch {
                    // Not JSON — fall through
                }
            }
        }
        return failResult(`agent-device error: ${msg}`);
    }
}
