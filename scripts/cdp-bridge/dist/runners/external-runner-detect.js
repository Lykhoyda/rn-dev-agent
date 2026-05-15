import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
const DEFAULT_DAEMON_PATH = join(homedir(), '.agent-device', 'daemon.json');
async function defaultRead() {
    try {
        const raw = await readFile(DEFAULT_DAEMON_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid === 'number' && typeof parsed.port === 'number') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * GH #105 / rn-device iOS-MVP §3.7: detect a globally-installed external
 * XCTest-based runner daemon. Both could compete for the iOS Simulator's
 * automation channel. Returns a warning the caller surfaces at session-open.
 *
 * Returns null when no daemon is detected (common case).
 */
export async function detectLegacyAgentDevice(deps = {}) {
    const read = deps.readDaemonFile ?? defaultRead;
    try {
        const info = await read();
        if (!info)
            return null;
        return {
            message: `rn-device detected a globally-installed external runner daemon ` +
                `(PID ${info.pid}, port ${info.port}). ` +
                `If iOS interactions appear flaky, set RN_DEVICE_KILL_LEGACY=1 ` +
                `to terminate it at session open.`,
            pid: info.pid,
            port: info.port,
        };
    }
    catch {
        return null;
    }
}
