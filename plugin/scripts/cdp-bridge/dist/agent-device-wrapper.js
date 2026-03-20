import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { okResult, failResult } from './utils.js';
const execFile = promisify(execFileCb);
const SESSION_FILE = '/tmp/rn-dev-agent-session.json';
const EXEC_TIMEOUT = 30_000;
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
    try {
        unlinkSync(SESSION_FILE);
    }
    catch { /* ignore */ }
}
export function hasActiveSession() {
    return activeSession !== null;
}
export async function runAgentDevice(cliArgs, opts = {}) {
    const args = [...cliArgs, '--json'];
    if (!opts.skipSession && activeSession) {
        args.push('--session', activeSession.name);
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
        return okResult(parsed.data ?? {});
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
