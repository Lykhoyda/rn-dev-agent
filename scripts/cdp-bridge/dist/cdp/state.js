import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const CDP_ACTIVE_FLAG = join(tmpdir(), 'rn-dev-agent-cdp-active');
const CDP_SESSION_FILE = join(tmpdir(), 'rn-dev-agent-cdp-session.json');
export function resetState(s) {
    s.setState('disconnected');
    s.setHelpersInjected(false);
    s.setBridgeDetected(false);
    s.setBridgeVersion(null);
    s.setConnectedTarget(null);
    s.setConnectedAt(null);
    s.setLogDomainEnabled(false);
    s.setProfilerAvailable(false);
    s.setHeapProfilerAvailable(false);
    s.clearScripts();
}
export function setActiveFlag(port, target) {
    try {
        writeFileSync(CDP_ACTIVE_FLAG, String(process.pid));
    }
    catch { /* best-effort */ }
    try {
        writeFileSync(CDP_SESSION_FILE, JSON.stringify({
            port,
            platform: target?.platform ?? null,
            target: target?.title ?? null,
            pid: process.pid,
            connectedAt: new Date().toISOString(),
        }));
    }
    catch { /* best-effort */ }
}
export function clearActiveFlag() {
    try {
        unlinkSync(CDP_ACTIVE_FLAG);
    }
    catch { /* may not exist */ }
    try {
        unlinkSync(CDP_SESSION_FILE);
    }
    catch { /* may not exist */ }
}
export function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}
