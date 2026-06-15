/**
 * GH #136 PR-A: raw-command screenshot path for explicit-platform disambiguation.
 *
 * When `device_screenshot` is called with explicit `platform: 'ios' | 'android'`
 * (i.e., the caller actually passed the field, not inferred from CDP target),
 * we bypass agent-device entirely and shell out to `xcrun simctl io` or
 * `adb -s <emu> exec-out screencap -p`. This sidesteps the agent-device CLI's
 * `--platform` routing issue when both an iOS sim and an Android emu are
 * booted simultaneously (the field-reported bug from issue #136 #1).
 *
 * On any failure (resolution fails, command errors), the caller falls through
 * to the existing `runAgentDevice` path — no behavior change for users who
 * don't pass `platform` or who run a single device.
 *
 * Test seams (`_setForTest`, `_resetForTest`) follow the GH #136 picker
 * precedent — allow unit tests to inject resolver/capturer fakes without
 * spawning real `xcrun`/`adb` subprocesses.
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export function parseSimctlBootedUDID(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    }
    catch {
        return null;
    }
    const runtimes = data?.devices;
    if (!runtimes || typeof runtimes !== 'object')
        return null;
    for (const list of Object.values(runtimes)) {
        if (!Array.isArray(list))
            continue;
        for (const device of list) {
            if (device && device.state === 'Booted' && typeof device.udid === 'string' && device.udid.length > 0) {
                return device.udid;
            }
        }
    }
    return null;
}
export function parseSimctlBootedAll(jsonText) {
    let data;
    try {
        data = JSON.parse(jsonText);
    }
    catch {
        return [];
    }
    const runtimes = data?.devices;
    if (!runtimes || typeof runtimes !== 'object')
        return [];
    const udids = [];
    for (const list of Object.values(runtimes)) {
        if (!Array.isArray(list))
            continue;
        for (const device of list) {
            if (device && device.state === 'Booted' && typeof device.udid === 'string' && device.udid.length > 0) {
                udids.push(device.udid);
            }
        }
    }
    return udids;
}
async function defaultSimctlBootedJson() {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    });
    return stdout;
}
export async function resolveIosUdid(explicit, probe = defaultSimctlBootedJson) {
    if (explicit)
        return explicit;
    try {
        const all = parseSimctlBootedAll(await probe());
        return all.length === 1 ? all[0] : undefined;
    }
    catch {
        return undefined;
    }
}
const EMU_LINE = /^(emulator-\d+)\s+device\b/;
export function parseAdbDevicesEmu(stdout) {
    const lines = stdout.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed.startsWith('List of devices'))
            continue;
        const match = trimmed.match(EMU_LINE);
        if (match)
            return match[1];
    }
    return null;
}
const defaultIosResolver = async () => {
    try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
        return parseSimctlBootedUDID(stdout);
    }
    catch {
        return null;
    }
};
/** #210: resolve the booted iOS simulator UDID (reuses the simctl probe used for raw screenshots). null if none booted. */
export async function resolveBootedIosUdid() {
    return defaultIosResolver();
}
const defaultAndroidResolver = async () => {
    try {
        const { stdout } = await execFileAsync('adb', ['devices'], {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
        return parseAdbDevicesEmu(stdout);
    }
    catch {
        return null;
    }
};
// Honor the requested format via the path extension, matching how the
// agent-device path infers format. Writing JPEG bytes into a `.png` file
// (the prior hardcoded `--type=jpeg`) produced a mislabeled image because
// the downstream sips resize only re-encodes `.jpe?g` paths.
export function simctlScreenshotType(path) {
    return /\.png$/i.test(path) ? 'png' : 'jpeg';
}
const defaultIosCapturer = async (udid, path) => {
    try {
        await execFileAsync('xcrun', ['simctl', 'io', udid, 'screenshot', `--type=${simctlScreenshotType(path)}`, path], {
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
        });
        return true;
    }
    catch {
        return false;
    }
};
export function resolveCaptureOutcome(streamFinished, procCode) {
    if (!streamFinished)
        return 'pending';
    if (procCode === null)
        return 'pending';
    return procCode === 0 ? 'success' : 'failure';
}
// Android needs the binary screen bytes piped to a file. execFile can't redirect
// stdout, so spawn directly and pipe to a write stream — no shell, so the path
// is safely passed as a literal filename, not interpolated into a command string.
//
// Two-track settle: success requires BOTH the WriteStream 'finish' event (all
// bytes drained to disk) AND adb's 'close' event with exit code 0. Either
// alone is insufficient: 'finish' before non-zero close = truncated/partial
// file reported as success (deepsec 2026-05-12 finding); 'close' before
// 'finish' = success reported before bytes hit disk (earlier multi-LLM
// review finding). On any failure path, the partial file is unlinked so
// `resizeWithSips` never sees a corrupt artifact.
const defaultAndroidCapturer = async (emuId, path) => new Promise((resolve) => {
    let settled = false;
    let streamFinished = false;
    let procCode = null;
    const proc = spawn('adb', ['-s', emuId, 'exec-out', 'screencap', '-p'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = createWriteStream(path);
    const cleanupPartial = () => {
        try {
            unlinkSync(path);
        }
        catch { /* file may not exist yet — ignore */ }
    };
    const timer = setTimeout(() => {
        if (settled)
            return;
        proc.kill();
        out.destroy();
        cleanupPartial();
        settle(false);
    }, 15_000);
    const settle = (ok) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
    };
    const maybeSettle = () => {
        const outcome = resolveCaptureOutcome(streamFinished, procCode);
        if (outcome === 'pending')
            return;
        if (outcome === 'failure') {
            out.destroy();
            cleanupPartial();
        }
        settle(outcome === 'success');
    };
    proc.stdout.pipe(out);
    out.on('finish', () => { streamFinished = true; maybeSettle(); });
    out.on('error', () => {
        cleanupPartial();
        settle(false);
    });
    proc.on('error', () => {
        out.destroy();
        cleanupPartial();
        settle(false);
    });
    proc.on('close', (code) => { procCode = code; maybeSettle(); });
});
let iosResolver = defaultIosResolver;
let androidResolver = defaultAndroidResolver;
let iosCapturer = defaultIosCapturer;
let androidCapturer = defaultAndroidCapturer;
export function _setForTest(overrides) {
    if (overrides.iosResolver)
        iosResolver = overrides.iosResolver;
    if (overrides.androidResolver)
        androidResolver = overrides.androidResolver;
    if (overrides.iosCapturer)
        iosCapturer = overrides.iosCapturer;
    if (overrides.androidCapturer)
        androidCapturer = overrides.androidCapturer;
}
export function _resetForTest() {
    iosResolver = defaultIosResolver;
    androidResolver = defaultAndroidResolver;
    iosCapturer = defaultIosCapturer;
    androidCapturer = defaultAndroidCapturer;
}
export async function tryRawScreenshot(platform, path) {
    const resolver = platform === 'ios' ? iosResolver : androidResolver;
    const capturer = platform === 'ios' ? iosCapturer : androidCapturer;
    const id = await resolver();
    if (!id)
        return { ok: false, reason: 'no-device' };
    const ok = await capturer(id, path);
    return ok ? { ok: true, path } : { ok: false, reason: 'capture-failed' };
}
