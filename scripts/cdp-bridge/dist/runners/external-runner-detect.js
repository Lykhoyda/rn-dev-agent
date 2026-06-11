import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export async function detectAndroidExternalRunner(execFileImpl = execFile, serialArgs = []) {
    try {
        // Accept either a callback-style execFile (production default) or an
        // async shim (unit tests). promisify on an async function returns a
        // never-resolving Promise (Node DEP0174), so when the caller passes a
        // function that already returns a Promise, use it directly.
        const bin = 'adb';
        const argv = [...serialArgs, 'shell', 'ps', '-A'];
        const opts = { timeout: 2_000, encoding: 'utf8' };
        const run = execFileImpl === execFile
            ? promisify(execFileImpl)
            : execFileImpl;
        const { stdout } = await run(bin, argv, opts);
        const lines = stdout
            .split('\n')
            .filter((line) => /uiautomator|agent-device|AgentDevice/i.test(line))
            .filter((line) => !/dev\.lykhoyda\.rndevagent\.androidrunner/.test(line));
        if (lines.length === 0)
            return null;
        return {
            platform: 'android',
            code: 'ANDROID_UIAUTOMATOR_COMPETITOR',
            message: 'A competing Android UIAutomator or agent-device process is running. Stop it (or opt out of the in-tree runner with RN_ANDROID_RUNNER=0) to avoid focus and input contention.',
            processLines: lines,
        };
    }
    catch {
        return null;
    }
}
// Validated against live `ps` (2026-06-04): maestro's iOS driver is
// `maestro-driver-iosUITests-Runner` — the `maestro` token catches it, the
// `.xctestrun`, and the java CLI. `WebDriverAgent` is a harmless secondary for
// Appium/WDA-style foreign tools. `XCTRunner` is intentionally NOT matched (too
// generic). The UDID filter is the real defense: the idle maestro-mcp server
// (`java … maestro.cli.AppKt mcp`) carries NO UDID, so scoping excludes it.
const IOS_FOREIGN_RE = /maestro|WebDriverAgent/i;
const RN_FAST_RUNNER_RE = /RnFastRunner/i;
export async function detectIosExternalRunner(execFileImpl = execFile, udid) {
    try {
        const opts = { timeout: 2_000, encoding: 'utf8' };
        const run = execFileImpl === execFile
            ? promisify(execFileImpl)
            : execFileImpl;
        // -ww: unlimited command-column width — macOS ps truncates otherwise, and
        // a UDID sitting mid-path in a long driver command line would be cut off,
        // silently breaking the includes(udid) scoping (GH#186 plan review).
        const { stdout } = await run('ps', ['axww', '-o', 'pid=,command='], opts);
        const lines = stdout
            .split('\n')
            .filter((line) => IOS_FOREIGN_RE.test(line))
            .filter((line) => !RN_FAST_RUNNER_RE.test(line))
            .filter((line) => (udid ? line.includes(udid) : true))
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        if (lines.length === 0)
            return null;
        return {
            platform: 'ios',
            code: 'IOS_XCUITEST_COMPETITOR',
            message: 'A foreign maestro/WebDriverAgent automation session is driving this simulator. ' +
                'Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. ' +
                '(If this is your own maestro flow, it is expected.)',
            processLines: lines,
        };
    }
    catch {
        return null;
    }
}
/**
 * GH#202 Phase 3: decide whether to surface a proactive foreign-runner heads-up
 * on an iOS device-session open. Returns null when there's nothing to say:
 *   - we currently hold the arbiter flow lease (the detected maestro driver is
 *     then our OWN L3 run, not a foreign session), OR
 *   - no foreign process was detected.
 * Informational only — the caller never blocks the open on this.
 */
export function foreignRunnerNotice(detection, flowLeaseHeld) {
    if (flowLeaseHeld)
        return null;
    if (!detection)
        return null;
    return {
        meta: {
            foreignRunner: {
                code: detection.code,
                message: detection.message,
                processLines: detection.processLines,
            },
        },
        warning: `FOREIGN_RUNNER_ACTIVE: ${detection.message}`,
    };
}
