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
// Validated against live `ps` (2026-06-04): identify the executable/process
// structure, not arbitrary prompt text elsewhere in argv. Long-running coding
// agents commonly carry words such as Maestro/WebDriverAgent and a simulator
// UDID in their prompt; token-scanning their complete command line self-matches.
// XCTRunner remains intentionally too generic.
function executableBasename(command) {
    const executable = command.trimStart().split(/\s+/, 1)[0] ?? '';
    return executable.slice(executable.lastIndexOf('/') + 1);
}
export function isIosExternalRunnerProcessLine(line) {
    const match = line.match(/^\s*\d+\s+(.+)$/);
    if (!match)
        return false;
    const command = match[1];
    const executable = executableBasename(command);
    if (/^maestro(?:-driver-iosUITests-Runner)?$/i.test(executable))
        return true;
    if (/^WebDriverAgent(?:Runner)?(?:-Runner)?$/i.test(executable))
        return true;
    if (/^java$/i.test(executable) && /(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i.test(command)) {
        return true;
    }
    if (/^xcodebuild$/i.test(executable) &&
        /(?:maestro[^\s]*|WebDriverAgent[^\s]*)\.xctestrun(?:\s|$)/i.test(command)) {
        return true;
    }
    return false;
}
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
            .filter((line) => isIosExternalRunnerProcessLine(line))
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
