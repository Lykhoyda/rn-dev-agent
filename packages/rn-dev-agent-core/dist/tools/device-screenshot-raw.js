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
 * Failure behavior (updated by GH #136 PR-B): callers on the explicit-platform
 * or raw-only routes HARD-FAIL with an actionable SCREENSHOT_FAILED — falling
 * through to another backend was the wrong-platform regression vector. Only
 * the Android runner-error path still falls back here (see device-list.ts).
 * Since GH #422 this raw path is also the primary iOS pixel backend.
 *
 * Test seams (`_setForTest`, `_resetForTest`) follow the GH #136 picker
 * precedent — allow unit tests to inject resolver/capturer fakes without
 * spawning real `xcrun`/`adb` subprocesses.
 */
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
// GH #422: the single-pick parseSimctlBootedUDID was removed — first-booted
// selection was a silent wrong-device capture once raw became the primary iOS
// path. All resolution goes through parseSimctlBootedAll + exactly-one.
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
    for (const [runtime, list] of Object.entries(runtimes)) {
        // GH #422 hardening: a booted paired watchOS/tvOS sim must not make the
        // single iOS sim look ambiguous to resolveIosUdid, nor be counted as an
        // iOS device.
        if (!runtime.includes('SimRuntime.iOS'))
            continue;
        if (!Array.isArray(list))
            continue;
        for (const device of list) {
            if (device &&
                device.state === 'Booted' &&
                typeof device.udid === 'string' &&
                device.udid.length > 0) {
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
// GH #428: the single-pick parseAdbDevicesEmu was removed — first-booted
// selection was a silent wrong-device capture with several emulators booted and
// no session binding. All resolution goes through parseAdbDevicesEmuAll +
// exactly-one, mirroring the iOS parseSimctlBootedAll hardening from GH #422/#427.
export function parseAdbDevicesEmuAll(stdout) {
    const ids = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('List of devices'))
            continue;
        const match = trimmed.match(EMU_LINE);
        if (match)
            ids.push(match[1]);
    }
    return ids;
}
async function defaultAdbDevicesStdout() {
    const { stdout } = await execFileAsync('adb', ['devices'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
    });
    return stdout;
}
/**
 * GH #428: exactly-one-or-refuse Android emulator resolution, mirroring the iOS
 * resolveIosUdid contract. With several emulators booted and no session UDID,
 * first-pick could silently capture the wrong device — refuse (return null) so
 * the caller hard-fails with an actionable message instead. Callers with a
 * session pass its device id through tryRawScreenshot's preferredDeviceId.
 */
export async function resolveAndroidEmu(probe = defaultAdbDevicesStdout) {
    try {
        const all = parseAdbDevicesEmuAll(await probe());
        return all.length === 1 ? all[0] : null;
    }
    catch {
        return null;
    }
}
const defaultIosResolver = async () => {
    try {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', '-j', 'devices', 'booted'], {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
        });
        // GH #422: raw is the primary iOS pixel path now, so a no-session resolve
        // must be unambiguous — with several booted iOS sims, first-pick was a
        // silent wrong-device capture. Callers with a session pass its UDID.
        const all = parseSimctlBootedAll(stdout);
        return all.length === 1 ? all[0] : null;
    }
    catch {
        return null;
    }
};
/** #210: resolve the booted iOS simulator UDID (reuses the simctl probe used for raw screenshots). null if none booted. */
export async function resolveBootedIosUdid() {
    return defaultIosResolver();
}
const defaultAndroidResolver = () => resolveAndroidEmu();
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
/**
 * GH #428 finding 1: the caller's FINAL path must never be opened until capture
 * succeeds. Staging bytes in a unique sibling temp file (same directory → the
 * rename is an atomic same-filesystem move, never a cross-device EXDEV copy)
 * means a failed/timed-out `adb screencap` can't truncate-then-unlink a file
 * the tool didn't create. The name is dotfile-prefixed and `.rawtmp`-suffixed
 * so a crash leaves an obviously-transient artifact, not a plausible screenshot.
 */
export function rawTempPath(finalPath, uniq) {
    return join(dirname(finalPath), `.${basename(finalPath)}.${uniq}.rawtmp`);
}
// Per-process monotonic suffix — collision-free across rapid successive captures
// without Date.now()/Math.random(), which keeps temp names deterministic in tests.
let captureCounter = 0;
function nextCaptureSuffix() {
    captureCounter += 1;
    return `${process.pid}.${captureCounter}`;
}
const defaultAndroidSpawn = (emuId) => spawn('adb', ['-s', emuId, 'exec-out', 'screencap', '-p'], {
    stdio: ['ignore', 'pipe', 'pipe'],
});
let androidSpawn = defaultAndroidSpawn;
// Android needs the binary screen bytes piped to a file. execFile can't redirect
// stdout, so spawn directly and pipe to a write stream — no shell, so the path
// is safely passed as a literal filename, not interpolated into a command string.
//
// Two-track settle: success requires BOTH the WriteStream 'finish' event (all
// bytes drained to disk) AND adb's 'close' event with exit code 0. Either
// alone is insufficient: 'finish' before non-zero close = truncated/partial
// file reported as success (deepsec 2026-05-12 finding); 'close' before
// 'finish' = success reported before bytes hit disk (earlier multi-LLM
// review finding). Bytes are staged in a temp file (GH #428 finding 1) and
// promoted onto `path` via renameSync only once the outcome is success; every
// failure path unlinks the temp and leaves the caller's path untouched.
export const defaultAndroidCapturer = async (emuId, path) => new Promise((resolve) => {
    let settled = false;
    let streamFinished = false;
    let procCode = null;
    const proc = androidSpawn(emuId);
    const tmp = rawTempPath(path, nextCaptureSuffix());
    const out = createWriteStream(tmp);
    const cleanupTemp = () => {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* temp may not exist yet — ignore */
        }
    };
    const timer = setTimeout(() => {
        if (settled)
            return;
        proc.kill();
        out.destroy();
        cleanupTemp();
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
            cleanupTemp();
            settle(false);
            return;
        }
        // success: promote the staged temp onto the caller's path only now that
        // both the stream drained AND adb exited 0. A rename failure (e.g. cross
        // volume, vanished dir) degrades to capture-failed rather than a partial.
        try {
            renameSync(tmp, path);
            settle(true);
        }
        catch {
            cleanupTemp();
            settle(false);
        }
    };
    proc.stdout.pipe(out);
    out.on('finish', () => {
        streamFinished = true;
        maybeSettle();
    });
    out.on('error', () => {
        // GH #428 finding 3: unpipe + kill the adb child before settling — else it
        // keeps running, blocked writing to a stdout no one is draining.
        proc.stdout.unpipe(out);
        proc.kill();
        cleanupTemp();
        settle(false);
    });
    proc.on('error', () => {
        out.destroy();
        cleanupTemp();
        settle(false);
    });
    proc.on('close', (code) => {
        procCode = code;
        maybeSettle();
    });
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
    if (overrides.androidSpawn)
        androidSpawn = overrides.androidSpawn;
}
export function _resetForTest() {
    iosResolver = defaultIosResolver;
    androidResolver = defaultAndroidResolver;
    iosCapturer = defaultIosCapturer;
    androidCapturer = defaultAndroidCapturer;
    androidSpawn = defaultAndroidSpawn;
}
export async function tryRawScreenshot(platform, path, preferredDeviceId) {
    const resolver = platform === 'ios' ? iosResolver : androidResolver;
    const capturer = platform === 'ios' ? iosCapturer : androidCapturer;
    // GH #422: raw is now the PRIMARY iOS pixel path, so it must inherit the
    // session's device binding — with two booted sims, "first booted" could
    // capture the wrong one. No session → single-booted resolution as before.
    const id = preferredDeviceId ?? (await resolver());
    if (!id)
        return { ok: false, reason: 'no-device' };
    try {
        const ok = await capturer(id, path);
        return ok ? { ok: true, path } : { ok: false, reason: 'capture-failed' };
    }
    catch {
        // Raw is the primary iOS path since GH #422 — a thrown capturer error
        // (fs validation, spawn failure) must honor the result contract.
        return { ok: false, reason: 'capture-failed' };
    }
}
