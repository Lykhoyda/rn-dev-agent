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
